import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { NetSuiteVendor } from "../providers/commerce";
import { Approvers, ChannelId, Email, messageId, money, out, plain, shortHash } from "./shared";

// Finance · accounts-payable.
// Trigger: a request to change a supplier's bank details (supplier portal,
// email or phone). Bank-detail changes are the most common payment-fraud
// route, so the change is never applied on the request's word:
//   1. payments to the supplier are held at once;
//   2. AP calls the phone number ON FILE (never one in the request) and the
//      supplier reads back a one-time code: a signal from an AP verifier who
//      is not the person who submitted the change;
//   3. bank ownership is matched to the supplier's legal name (Plaid) and the
//      supplier is re-screened against sanctions lists;
//   4. a treasury approver who is neither the submitter nor the callback
//      verifier approves (two-person rule);
//   5. only then is the change applied, the hold released and the supplier's
//      contact on file told that their bank details changed.
// A rejection, a missed deadline or a sanctions hit leaves the old bank
// details in place; the hold is released (the real supplier keeps being paid)
// unless the supplier is sanctioned. Every step is in a hash-chained audit trail.

export const POLICY = {
  callbackDays: 5,
  approvalDays: 7,
  /** Plaid name-match score below which the change needs a second look (still approvable). */
  minNameScore: 70,
  /** Changes this soon after the vendor was created, or after the previous change, are red flags. */
  newVendorDays: 30,
  recentChangeDays: 90,
  /** Bills due this soon are "money at risk" in the alert. */
  billsDueDays: 14,
} as const;

const Input = z.object({
  changeId: z.string().regex(/^BC-[\w-]{3,40}$/, "change id like BC-2026-0042"),
  vendorId: z.string().regex(/^\d{1,12}$/, "NetSuite vendor internal id"),
  /** The AP user who entered the request. */
  submittedBy: z.string().min(1),
  source: z.enum(["supplier_portal", "email", "phone"]),
  /** Sender address when the request came by email. */
  requestEmail: Email.optional(),
  newBank: z.object({
    accountName: z.string().min(1).max(140),
    last4: z.string().regex(/^\d{4}$/),
    /** Vault token for the full account details; the runtime never sees them. */
    vaultToken: z.string().regex(/^tok_[\w-]{6,80}$/),
    /** Plaid Link access token from the supplier portal, when the supplier linked the account. */
    plaidAccessToken: z.string().regex(/^access-[\w-]{6,120}$/).optional(),
  }),
  /** AP staff who may confirm the callback. */
  verifiers: z.array(z.string().min(1)).min(1).max(50),
  apChannel: ChannelId,
  securityChannel: ChannelId,
  apWorkspace: z.string().min(1).default("acme-ap"),
  /** Treasury approvers. */
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  createdMs: number | null;
  onHold: boolean;
  holdReason: string | null;
  bankLast4: string | null;
  lastChangeMs: number | null;
  billsDueMinor: number;
  billsDue: number;
}
export interface Ownership {
  provided: boolean;
  bestScore: number | null;
  maskMatches: boolean;
}
export interface Screening {
  hits: { name: string; source: string }[];
}
export interface Assessment {
  mode: "verify" | "blocked" | "sanctioned" | "no_change";
  reason: string;
  flags: string[];
  risk: "low" | "elevated" | "high";
}

const DAY = 86_400_000;

/** Red flags and the path the change takes. Pure. */
export function assess(input: Input, vendor: Vendor | undefined, ownership: Ownership | undefined, screening: Screening | undefined, now: number): Assessment {
  const flags: string[] = [];
  if (!vendor) return { mode: "blocked", reason: "vendor record could not be read", flags, risk: "high" };
  if (!screening) return { mode: "blocked", reason: "sanctions screening unavailable; nothing changes until it is", flags, risk: "high" };
  if (screening.hits.length) return { mode: "sanctioned", reason: `possible sanctions match: ${screening.hits.map((h) => `${h.name} (${h.source})`).join("; ")}`, flags: ["sanctions"], risk: "high" };
  if (vendor.bankLast4 === input.newBank.last4) return { mode: "no_change", reason: "the account on file already ends in these digits", flags, risk: "low" };
  if (!vendor.phone) return { mode: "blocked", reason: "no phone number on file to call back; AP must verify by hand", flags: ["no_phone_on_file"], risk: "high" };
  const domain = (e: string | null | undefined) => e?.split("@")[1]?.toLowerCase() ?? null;
  if (input.source === "email" && input.requestEmail && domain(input.requestEmail) !== domain(vendor.email)) flags.push(`request came from ${domain(input.requestEmail)}, vendor email is ${domain(vendor.email) ?? "unknown"}`);
  if (vendor.createdMs !== null && now - vendor.createdMs < POLICY.newVendorDays * DAY) flags.push("vendor created less than 30 days ago");
  if (vendor.lastChangeMs !== null && now - vendor.lastChangeMs < POLICY.recentChangeDays * DAY) flags.push("bank details changed in the last 90 days");
  if (!ownership?.provided) flags.push("account ownership not verified (no Plaid link)");
  else if (ownership.bestScore === null || ownership.bestScore < POLICY.minNameScore) flags.push(`account holder name match ${ownership.bestScore ?? "unknown"} < ${POLICY.minNameScore}`);
  else if (!ownership.maskMatches) flags.push("linked account doesn't end in the requested digits");
  if (vendor.billsDue > 0) flags.push(`${vendor.billsDue} bill(s) due within ${POLICY.billsDueDays} days (${money(vendor.billsDueMinor, "usd")})`);
  const risk = flags.length >= 3 ? "high" : flags.length ? "elevated" : "low";
  return { mode: "verify", reason: "verify by callback and two-person approval", flags, risk };
}

export const supplierBankChange: WorkflowDef<Input> = {
  id: "supplier-bank-change",
  title: "Supplier bank-detail change",
  org: "Finance",
  team: "accounts-payable",
  description:
    "Verify a supplier bank-detail change before any payment uses it: hold payments, call back the number on file, match account ownership, re-screen sanctions, then two-person approval; on rejection the old details stay. Hash-chained audit trail.",
  input: Input,
  audit: true,
  tickEvery: "rate(15 minutes)",
  agents: [
    {
      name: "vendor-record",
      needs: ["netsuite"],
      async run({ input, providers, startedAt }) {
        const ns = providers.netsuite!;
        const v: NetSuiteVendor = await ns.getVendor(input.vendorId);
        const until = new Date(startedAt.getTime() + POLICY.billsDueDays * DAY).toISOString().slice(0, 10);
        const bills = await ns.suiteql<{ amount: string | number }>(`SELECT foreigntotal AS amount FROM transaction WHERE type = 'VendBill' AND entity = ${Number(input.vendorId)} AND BUILTIN.CF(status) = 'VendBill:A' AND duedate <= TO_DATE('${until}', 'YYYY-MM-DD')`);
        const data: Vendor = {
          id: v.id,
          name: v.legalName || v.companyName || `vendor ${v.id}`,
          email: v.email ?? null,
          phone: v.phone ?? null,
          createdMs: v.dateCreated ? Date.parse(v.dateCreated) : null,
          onHold: !!v.custentity_acme_payment_hold,
          holdReason: v.custentity_acme_hold_reason ?? null,
          bankLast4: v.custentity_acme_bank_last4 ?? null,
          lastChangeMs: v.custentity_acme_bank_changed_at ? Date.parse(v.custentity_acme_bank_changed_at) : null,
          billsDueMinor: bills.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0),
          billsDue: bills.length,
        };
        return { summary: `${data.name}: bank •••${data.bankLast4 ?? "?"}, ${data.billsDue} bill(s) due soon`, data };
      },
    },
    {
      name: "bank-ownership",
      needs: ["plaid", "netsuite"],
      async run({ input, providers }) {
        if (!input.newBank.plaidAccessToken) return { summary: "no Plaid link", data: { provided: false, bestScore: null, maskMatches: false } satisfies Ownership };
        const v = await providers.netsuite!.getVendor(input.vendorId);
        const accounts = await providers.plaid!.identityMatch(input.newBank.plaidAccessToken, v.legalName || v.companyName || "");
        const best = accounts.reduce<number | null>((m, a) => (a.nameScore !== null && (m === null || a.nameScore > m) ? a.nameScore : m), null);
        const data: Ownership = { provided: true, bestScore: best, maskMatches: accounts.some((a) => a.mask === input.newBank.last4) };
        return { summary: `name score ${best ?? "?"}${data.maskMatches ? "" : ", mask mismatch"}`, data };
      },
    },
    {
      name: "sanctions",
      needs: ["screening", "netsuite"],
      async run({ input, providers }) {
        const v = await providers.netsuite!.getVendor(input.vendorId);
        const hits = (await providers.screening!.search(v.legalName || v.companyName || "")).filter((h) => (h.score ?? 100) >= 90).map((h) => ({ name: h.name, source: h.source }));
        return { summary: `${hits.length} hit(s)`, data: { hits } satisfies Screening };
      },
    },
  ],

  compose: {
    name: "assessment",
    async run({ input, startedAt }, results) {
      const a = assess(input, out<Vendor>(results, "vendor-record"), out<Ownership>(results, "bank-ownership"), out<Screening>(results, "sanctions"), startedAt.getTime());
      return { summary: `${a.mode} (${a.risk}): ${a.reason}`, data: a };
    },
  },

  plan({ input, startedAt, runId }, results) {
    const a = out<Assessment>(results, "assessment");
    const vendor = out<Vendor>(results, "vendor-record");
    if (!a) return [];
    const ns = "netsuite" as const;
    const at = (days: number) => new Date(startedAt.getTime() + days * DAY).toISOString();
    const actions: PlannedAction<Input>[] = [];
    const ids = { hold: `netsuite.hold_payments:${input.vendorId}`, call: `twilio.callback:${input.changeId}`, confirm: `ap.confirm_callback:${input.changeId}`, approve: `treasury.approve:${input.changeId}`, apply: `netsuite.apply_bank_change:${input.changeId}`, release: `netsuite.release_hold:${input.vendorId}`, notify: `gmail.notify_vendor:${input.changeId}` };
    const holdReason = `bank change ${input.changeId}`;

    if (a.mode === "verify" || a.mode === "sanctioned") {
      actions.push({
        id: ids.hold,
        kind: "netsuite.hold_payments",
        provider: ns,
        agent: "assessment",
        gate: "auto",
        summary: { vendor: input.vendorId, reason: a.mode === "sanctioned" ? "sanctions" : holdReason },
        async execute({ providers }) {
          // Never overwrite another investigation's hold (its reason is how it gets released).
          const cur = await providers.netsuite!.getVendor(input.vendorId);
          if (cur.custentity_acme_payment_hold && cur.custentity_acme_hold_reason && cur.custentity_acme_hold_reason !== holdReason) throw new SkipAction(`already held for "${cur.custentity_acme_hold_reason}"`);
          await providers.netsuite!.updateVendor(input.vendorId, { custentity_acme_payment_hold: true, custentity_acme_hold_reason: a.mode === "sanctioned" ? `sanctions review ${input.changeId}` : holdReason });
          return { ref: input.vendorId };
        },
        async reconcile({ providers }) {
          const v = await providers.netsuite!.getVendor(input.vendorId);
          return v.custentity_acme_payment_hold ? { status: "match" } : { status: "drift", detail: "payment hold is off" };
        },
      });
    }

    if (a.mode === "verify" && vendor) {
      actions.push({
        id: ids.call,
        kind: "twilio.callback",
        provider: "twilio_verify",
        agent: "assessment",
        gate: "auto",
        // The number on file, never one from the request.
        summary: { to: `•••${vendor.phone!.slice(-4)}`, channel: "call" },
        async execute({ providers }) {
          const v = await providers.twilio_verify!.start(vendor.phone!, "call");
          return { ref: v.sid, detail: { status: v.status } };
        },
      });
      actions.push({
        id: ids.confirm,
        kind: "ap.confirm_callback",
        provider: ns,
        agent: "assessment",
        gate: "auto",
        summary: { change: input.changeId, deadline: at(POLICY.callbackDays) },
        awaitSignal: { from: input.verifiers, notFrom: [input.submittedBy], deadline: at(POLICY.callbackDays), onDeadline: "reject" },
        after: [ids.call],
        async execute({ signal }) {
          return { ref: input.changeId, detail: { confirmedBy: signal?.by } };
        },
      });
      actions.push({
        id: ids.approve,
        kind: "treasury.approve",
        provider: ns,
        agent: "assessment",
        gate: "auto",
        summary: { change: input.changeId, risk: a.risk, flags: a.flags.length },
        awaitSignal: { from: input.approvers, notFrom: [input.submittedBy], distinctFrom: [ids.confirm], deadline: at(POLICY.approvalDays), onDeadline: "reject" },
        requires: [ids.confirm],
        async execute({ signal }) {
          return { ref: input.changeId, detail: { approvedBy: signal?.by } };
        },
      });
      actions.push({
        id: ids.apply,
        kind: "netsuite.apply_bank_change",
        provider: ns,
        agent: "assessment",
        gate: "auto",
        summary: { vendor: input.vendorId, newLast4: input.newBank.last4, oldLast4: vendor.bankLast4 },
        requires: [ids.confirm, ids.approve],
        async execute({ providers }) {
          // Re-read: someone may have frozen the vendor or applied another change since.
          const v = await providers.netsuite!.getVendor(input.vendorId);
          if (v.custentity_acme_hold_reason && v.custentity_acme_hold_reason !== holdReason) throw new FatalError(`vendor is now held for "${v.custentity_acme_hold_reason}"`);
          await providers.netsuite!.updateVendor(input.vendorId, { custentity_acme_bank_token: input.newBank.vaultToken, custentity_acme_bank_last4: input.newBank.last4, custentity_acme_bank_changed_at: new Date().toISOString() });
          return { ref: input.vendorId, detail: { last4: input.newBank.last4 } };
        },
        async reconcile({ providers }) {
          const v = await providers.netsuite!.getVendor(input.vendorId);
          return v.custentity_acme_bank_last4 === input.newBank.last4 ? { status: "match" } : { status: "drift", detail: `bank on file ends ${v.custentity_acme_bank_last4}` };
        },
      });
      actions.push({
        id: ids.release,
        kind: "netsuite.release_hold",
        provider: ns,
        agent: "assessment",
        gate: "auto",
        summary: { vendor: input.vendorId },
        after: [ids.apply],
        async execute({ providers }) {
          // Release only our own hold; another investigation's hold stays.
          const v = await providers.netsuite!.getVendor(input.vendorId);
          if (v.custentity_acme_hold_reason !== holdReason) throw new SkipAction(`hold now belongs to "${v.custentity_acme_hold_reason ?? "nobody"}"`);
          await providers.netsuite!.updateVendor(input.vendorId, { custentity_acme_payment_hold: false, custentity_acme_hold_reason: null });
          return { ref: input.vendorId };
        },
      });
      if (vendor.email) {
        actions.push({
          id: ids.notify,
          kind: "gmail.notify_vendor",
          provider: "gmail",
          agent: "assessment",
          gate: "auto",
          summary: { to: "vendor email on file", sent: false },
          requires: [ids.apply],
          async execute({ providers }) {
            const d = await providers.gmail!.createDraft({ to: vendor.email!, subject: `Your bank details with ACME were changed (${input.changeId})`, body: `Hello,\n\nAt your request we changed the bank account ACME pays you into to the account ending in ${input.newBank.last4}. If you did not ask for this, call your ACME accounts payable contact on the number you already have for us. Do not reply to this email with bank details.\n\nACME Accounts Payable`, messageId: messageId(runId, `bank-${input.changeId}`) });
            return { ref: d.id };
          },
        });
      }
    }

    const record = [
      `Bank change ${input.changeId} for vendor ${input.vendorId}${vendor ? ` (${plain(vendor.name, 80)})` : ""}: ${a.mode}, risk ${a.risk}.`,
      `Requested via ${input.source} by ${input.submittedBy}; new account •••${input.newBank.last4}${vendor?.bankLast4 ? `, replacing •••${vendor.bankLast4}` : ""}.`,
      a.flags.length ? `Red flags: ${a.flags.join("; ")}.` : "No red flags.",
      a.mode === "verify" ? `Callback to the number on file within ${POLICY.callbackDays} days, then treasury approval by a second person within ${POLICY.approvalDays} days.` : `Reason: ${a.reason}.`,
    ];
    actions.push({
      id: "asana.change_record",
      kind: "asana.change_record",
      provider: "asana",
      agent: "assessment",
      gate: "auto",
      summary: { change: input.changeId, mode: a.mode },
      async execute({ providers }) {
        const t = await providers.asana!.createTask({ name: `${input.changeId}: supplier bank change (${a.mode})`, notes: record.join("\n"), workspace: input.apWorkspace });
        return { ref: t.gid };
      },
    });
    const alert = a.mode === "sanctioned" || a.risk === "high" || a.mode === "blocked";
    actions.push({
      id: "slack.post_change",
      kind: "slack.post_change",
      provider: "slack",
      agent: "assessment",
      gate: "auto",
      summary: { channel: alert ? input.securityChannel : input.apChannel, mode: a.mode },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(alert ? input.securityChannel : input.apChannel, `${alert ? ":rotating_light:" : ":bank:"} ${record.slice(0, 3).join(" ")}`);
        return { ref: m.ts };
      },
    });
    // The outcome, once both people have decided (or the deadlines passed).
    if (a.mode === "verify") {
      actions.push({
        id: "slack.post_outcome",
        kind: "slack.post_outcome",
        provider: "slack",
        agent: "assessment",
        gate: "auto",
        summary: { channel: input.apChannel },
        after: [ids.apply, ids.release],
        async execute({ providers, statuses }) {
          const applied = statuses[ids.apply] === "applied";
          const m = await providers.slack!.postMessage(applied ? input.apChannel : input.securityChannel, `${applied ? ":white_check_mark:" : ":no_entry:"} ${input.changeId}: ${applied ? `new bank details •••${input.newBank.last4} in effect` : "change NOT applied (callback or approval missing or rejected); payments continue to the account on file"}.`);
          return { ref: m.ts, detail: { applied } };
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const a = out<Assessment>(results, "assessment");
    if (!a) return { mode: "not decided" };
    return { mode: a.mode, risk: a.risk, reason: a.reason, flags: a.flags };
  },

  catalog: [
    { kind: "netsuite.hold_payments", provider: "netsuite", gate: "auto", description: "Hold payments to the supplier while the change is verified" },
    { kind: "twilio.callback", provider: "twilio_verify", gate: "auto", description: "Call the phone number on file with a one-time code" },
    { kind: "ap.confirm_callback", provider: "netsuite", gate: "auto", description: "Signal: an AP verifier (not the submitter) confirms the supplier read back the code" },
    { kind: "treasury.approve", provider: "netsuite", gate: "auto", description: "Signal: a treasury approver who is neither the submitter nor the verifier approves" },
    { kind: "netsuite.apply_bank_change", provider: "netsuite", gate: "auto", description: "Apply the vault-tokenised bank details, only after both signals" },
    { kind: "netsuite.release_hold", provider: "netsuite", gate: "auto", description: "Release this change's payment hold (never another investigation's)" },
    { kind: "gmail.notify_vendor", provider: "gmail", gate: "auto", description: "Draft a change notice to the supplier's email on file" },
    { kind: "asana.change_record", provider: "asana", gate: "auto", description: "Change record with red flags" },
    { kind: "slack.post_change", provider: "slack", gate: "auto", description: "AP or security alert, then the outcome" },
    { kind: "slack.post_outcome", provider: "slack", gate: "auto", description: "Outcome once decided" },
  ],
};

export const changeIds = (changeId: string, vendorId: string) => ({ confirm: `ap.confirm_callback:${changeId}`, approve: `treasury.approve:${changeId}`, apply: `netsuite.apply_bank_change:${changeId}`, hold: `netsuite.hold_payments:${vendorId}`, release: `netsuite.release_hold:${vendorId}`, tag: shortHash(changeId) });
