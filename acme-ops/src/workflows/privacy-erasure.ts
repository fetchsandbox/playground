import { z } from "zod";
import { FatalError, ProviderError } from "../kit/errors";
import type { AgentResults, PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, out, shortHash } from "./shared";

// Legal · privacy-ops.
// Trigger: a data subject request to erase personal data (GDPR Art. 17 / CCPA).
// Discovery runs in parallel across systems; every deletion waits for approval.

export const DEADLINE_DAYS = { gdpr: 30, ccpa: 45 } as const;
/** Roles whose removal needs a security sign-off on top of the privacy approval. */
const PRIVILEGED = new Set(["admin", "owner", "billing-admin", "finance-admin", "it-admin", "security-admin"]);

const Input = z.object({
  requestId: z.string().regex(/^[\w.-]{3,64}$/, "request id like DSR-2026-0042"),
  subject: z.object({ email: Email, name: z.string().max(200).optional() }),
  regulation: z.enum(["gdpr", "ccpa"]),
  receivedAt: z.iso.datetime(),
  /** How the requester proved they are the data subject. "none" erases nothing. */
  verification: z.object({ method: z.enum(["email_link", "account_login", "id_document", "none"]), verifiedBy: z.string().min(1).max(100) }),
  privacyChannel: ChannelId,
  /** Asana workspace (or project) that keeps the request record. */
  dsarWorkspace: z.string().min(1).default("acme-privacy"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Crm {
  contactId: string | null;
}
interface Billing {
  customerId: string | null;
  liveSubscriptions: string[];
  openInvoices: string[];
  alreadyErased: boolean;
}
interface Identity {
  userId: string | null;
  privilegedRoles: string[];
}

export type Decision = { system: "hubspot" | "stripe" | "workos"; action: "erase" | "anonymize" | "retain" | "none" | "unknown"; reason: string };
interface Plan {
  verified: boolean;
  deadline: string;
  daysLeft: number;
  complete: boolean;
  decisions: Decision[];
  subjectRef: string;
}

/** Placeholder written over the Stripe customer's email (the customer itself stays for tax records). */
export const erasedEmail = (requestId: string) => `erased+${shortHash("dsr", requestId).slice(0, 12)}@privacy.acme.invalid`;

/** What happens in each system. Pure; `undefined` means discovery failed for that system. */
export function decide(crm: Crm | undefined, billing: Billing | undefined, identity: Identity | undefined): Decision[] {
  const out: Decision[] = [];
  out.push(
    !crm
      ? { system: "hubspot", action: "unknown", reason: "CRM could not be searched" }
      : crm.contactId
        ? { system: "hubspot", action: "erase", reason: "marketing and sales record: no retention duty" }
        : { system: "hubspot", action: "none", reason: "no contact" },
  );
  if (!billing) out.push({ system: "stripe", action: "unknown", reason: "billing could not be searched" });
  else if (!billing.customerId) out.push({ system: "stripe", action: "none", reason: "no customer" });
  else if (billing.alreadyErased) out.push({ system: "stripe", action: "none", reason: "already anonymized" });
  else if (billing.liveSubscriptions.length) out.push({ system: "stripe", action: "retain", reason: `active subscription ${billing.liveSubscriptions.join(", ")}: cancel before erasure` });
  else if (billing.openInvoices.length) out.push({ system: "stripe", action: "retain", reason: `outstanding invoice ${billing.openInvoices.join(", ")}: legal claim` });
  else out.push({ system: "stripe", action: "anonymize", reason: "invoices kept for tax retention; personal details removed" });
  out.push(
    !identity
      ? { system: "workos", action: "unknown", reason: "directory could not be searched" }
      : identity.userId
        ? { system: "workos", action: "erase", reason: identity.privilegedRoles.length ? `account holds ${identity.privilegedRoles.join(", ")}: security must confirm` : "login account" }
        : { system: "workos", action: "none", reason: "no account" },
  );
  return out;
}

const verb: Record<Decision["action"], string> = { erase: "deleted", anonymize: "anonymized", retain: "kept", none: "nothing held", unknown: "still being checked" };
const systemName: Record<Decision["system"], string> = { hubspot: "CRM (HubSpot)", stripe: "billing (Stripe)", workos: "login account" };

export const privacyErasure: WorkflowDef<Input> = {
  id: "privacy-erasure",
  title: "Privacy erasure request (GDPR / CCPA)",
  org: "Legal",
  team: "privacy-ops",
  description:
    "Find a data subject's records in HubSpot, Stripe and the WorkOS directory in parallel, decide per system (erase, anonymize, or retain under a legal hold such as an active subscription or unpaid invoice), record the request against its statutory deadline, and, after approval, delete the CRM contact, anonymize the billing customer and delete the login account, then draft the response to the requester. Unverified requests erase nothing.",
  input: Input,
  agents: [
    {
      name: "crm-records",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.subject.email);
        return { summary: c ? `HubSpot contact ${c.id}` : "no HubSpot contact", data: { contactId: c?.id ?? null } satisfies Crm };
      },
    },
    {
      name: "billing-records",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const cus = await stripe.findCustomerByEmail(input.subject.email);
        if (!cus) return { summary: "no Stripe customer", data: { customerId: null, liveSubscriptions: [], openInvoices: [], alreadyErased: false } satisfies Billing };
        const [subs, invoices] = await Promise.all([stripe.listSubscriptions(cus.id), stripe.listInvoices(cus.id, "open")]);
        const data: Billing = {
          customerId: cus.id,
          liveSubscriptions: subs.filter((s) => s.customer === cus.id && !["canceled", "incomplete_expired"].includes(s.status)).map((s) => s.id),
          openInvoices: invoices.filter((i) => i.customer === cus.id && i.status === "open").map((i) => i.id),
          alreadyErased: !!cus.metadata?.acme_erased,
        };
        return { summary: `${cus.id}: ${data.liveSubscriptions.length} live subscription(s), ${data.openInvoices.length} open invoice(s)`, data };
      },
    },
    {
      name: "identity-records",
      needs: ["workos"],
      async run({ input, providers }) {
        const wo = providers.workos!;
        const u = await wo.findUserByEmail(input.subject.email);
        if (!u) return { summary: "no directory account", data: { userId: null, privilegedRoles: [] } satisfies Identity };
        const roles = (await wo.listMemberships(u.id)).map((m) => m.role?.slug ?? "").filter((r) => PRIVILEGED.has(r));
        return { summary: `WorkOS user ${u.id}${roles.length ? ` (${roles.join(", ")})` : ""}`, data: { userId: u.id, privilegedRoles: roles } satisfies Identity };
      },
    },
  ],

  compose: {
    name: "erasure-plan",
    async run({ input, startedAt }, results) {
      const p = planFrom(input, startedAt.getTime(), results);
      return { summary: `${p.verified ? "verified" : "UNVERIFIED"}; ${p.decisions.map((d) => `${d.system}=${d.action}`).join(", ")}; due ${p.deadline.slice(0, 10)}`, data: p };
    },
  },

  plan({ input }, results) {
    const p = out<Plan>(results, "erasure-plan");
    if (!p) return [];
    const crm = out<Crm>(results, "crm-records");
    const billing = out<Billing>(results, "billing-records");
    const identity = out<Identity>(results, "identity-records");
    const act = (s: Decision["system"]) => p.decisions.find((d) => d.system === s)!;
    const actions: PlannedAction<Input>[] = [];

    // The record and the channel post carry a hash, never the requester's address.
    const notes = [
      `${input.regulation.toUpperCase()} erasure request ${input.requestId}, received ${input.receivedAt.slice(0, 10)}, due ${p.deadline.slice(0, 10)} (${p.daysLeft} day(s) left).`,
      `Data subject ref ${p.subjectRef}. Verification: ${input.verification.method} by ${input.verification.verifiedBy}.`,
      ...p.decisions.map((d) => `- ${systemName[d.system]}: ${d.action} (${d.reason})`),
      p.verified ? (p.complete ? "Erasures wait for approval." : "Discovery incomplete: the request stays open until every system is checked.") : "Not verified: nothing will be erased until identity is confirmed.",
    ];
    actions.push({
      id: "asana.dsar_record",
      kind: "asana.dsar_record",
      provider: "asana",
      agent: "erasure-plan",
      gate: "auto",
      summary: { requestId: input.requestId, deadline: p.deadline.slice(0, 10), verified: p.verified },
      async execute({ providers }) {
        const t = await providers.asana!.createTask({ name: `${input.requestId}: ${input.regulation.toUpperCase()} erasure, due ${p.deadline.slice(0, 10)}`, notes: notes.join("\n"), workspace: input.dsarWorkspace, due_on: p.deadline.slice(0, 10) });
        return { ref: t.gid };
      },
      async reconcile({ providers }, receipt) {
        const t = await providers.asana!.getTask(receipt.ref);
        return t.name?.startsWith(input.requestId) ? { status: "match" } : { status: "drift", detail: `task is now "${t.name}"` };
      },
    });

    if (!p.verified) {
      actions.push({
        id: "gmail.draft_verification_request",
        kind: "gmail.draft_verification_request",
        provider: "gmail",
        agent: "erasure-plan",
        gate: "auto",
        summary: { requestId: input.requestId, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({
            to: input.subject.email,
            subject: `Your data deletion request ${input.requestId}`,
            body: `Hello,\n\nWe received a request to delete the personal data we hold about this email address. Before we delete anything we need to confirm the request came from you: please reply from this address or sign in to your ACME account and confirm the request there.\n\nACME Privacy Team`,
            messageId: messageId(runId, "dsr-verify"),
          });
          return { ref: d.id };
        },
      });
    } else {
      if (act("hubspot").action === "erase" && crm?.contactId) {
        const id = crm.contactId;
        actions.push({
          id: "hubspot.erase_contact",
          kind: "hubspot.erase_contact",
          provider: "hubspot",
          agent: "erasure-plan",
          gate: "approval",
          summary: { requestId: input.requestId, contact: id, method: "gdpr-delete (permanent)" },
          async execute({ providers }) {
            await providers.hubspot!.gdprDelete(id);
            return { ref: id };
          },
          async reconcile({ providers }) {
            try {
              await providers.hubspot!.get(id);
            } catch (err) {
              if (err instanceof ProviderError && err.status === 404) return { status: "match", detail: "contact no longer exists" };
              throw err;
            }
            return { status: "drift", detail: "contact still exists after erasure" };
          },
        });
      }
      if (act("stripe").action === "anonymize" && billing?.customerId) {
        const id = billing.customerId;
        const placeholder = erasedEmail(input.requestId);
        actions.push({
          id: "stripe.anonymize_customer",
          kind: "stripe.anonymize_customer",
          provider: "stripe",
          agent: "erasure-plan",
          gate: "approval",
          summary: { requestId: input.requestId, customer: id, keeps: "invoices and payments (tax retention)" },
          async execute({ providers }) {
            const stripe = providers.stripe!;
            // Re-check the hold at write time: a subscription started since discovery blocks erasure.
            const live = (await stripe.listSubscriptions(id)).filter((s) => s.customer === id && !["canceled", "incomplete_expired"].includes(s.status));
            if (live.length) throw new FatalError(`${id} has an active subscription again (${live[0]!.id}); erasure held`);
            const c = await stripe.anonymizeCustomer(id, placeholder, { acme_erased: input.requestId });
            return { ref: c.id };
          },
          async reconcile({ providers }) {
            const c = await providers.stripe!.getCustomer(id);
            return c.email === placeholder ? { status: "match" } : { status: "drift", detail: "customer carries personal data again" };
          },
        });
      }
      if (act("workos").action === "erase" && identity?.userId) {
        const id = identity.userId;
        actions.push({
          id: "workos.delete_user",
          kind: "workos.delete_user",
          provider: "workos",
          agent: "erasure-plan",
          gate: "approval",
          summary: { requestId: input.requestId, user: id, privilegedRoles: identity.privilegedRoles },
          async execute({ providers }) {
            await providers.workos!.deleteUser(id);
            return { ref: id };
          },
          async reconcile({ providers }) {
            try {
              await providers.workos!.getUser(id);
            } catch (err) {
              if (err instanceof ProviderError && err.status === 404) return { status: "match", detail: "account no longer exists" };
              throw err;
            }
            return { status: "drift", detail: "account still exists after erasure" };
          },
        });
      }
      if (p.complete) {
        const erasures = ["hubspot.erase_contact", "stripe.anonymize_customer", "workos.delete_user"].filter((id) => actions.some((a) => a.id === id));
        const body = [
          "Hello,",
          "",
          `We have completed your request ${input.requestId} to delete your personal data:`,
          ...p.decisions.map((d) => `- ${systemName[d.system]}: ${verb[d.action]}${d.action === "retain" || d.action === "anonymize" ? ` (${d.reason})` : ""}`),
          "",
          p.decisions.some((d) => d.action === "retain") ? "Where we have kept data, the law requires us to; we'll delete it once that reason ends." : "Nothing else is held about you.",
          "",
          "ACME Privacy Team",
        ].join("\n");
        actions.push({
          id: "gmail.draft_completion",
          kind: "gmail.draft_completion",
          provider: "gmail",
          agent: "erasure-plan",
          gate: erasures.length ? "approval" : "auto",
          summary: { requestId: input.requestId, sent: false, after: erasures },
          async execute({ providers, runId, applied }) {
            // The response never claims a deletion that didn't happen.
            const missing = erasures.filter((id) => !applied[id]);
            if (missing.length) throw new FatalError(`erasure not done yet: ${missing.join(", ")}`);
            const d = await providers.gmail!.createDraft({ to: input.subject.email, subject: `Your data deletion request ${input.requestId} is complete`, body, messageId: messageId(runId, "dsr-done") });
            return { ref: d.id };
          },
        });
      }
    }

    const text = `:lock: ${input.requestId} (${input.regulation.toUpperCase()}, due ${p.deadline.slice(0, 10)}, ${p.daysLeft}d left) subject ${p.subjectRef}: ${p.verified ? p.decisions.map((d) => `${d.system} ${d.action}`).join(", ") : "NOT VERIFIED, nothing erased"}${p.verified && !p.complete ? "; discovery incomplete" : ""}${p.daysLeft < 7 ? " :warning: deadline close" : ""}.`;
    actions.push({
      id: "slack.post_dsr",
      kind: "slack.post_dsr",
      provider: "slack",
      agent: "erasure-plan",
      gate: "auto",
      summary: { channel: input.privacyChannel, requestId: input.requestId },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.privacyChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const p = out<Plan>(results, "erasure-plan");
    if (!p) return { decision: "not decided" };
    return { verified: p.verified, complete: p.complete, deadline: p.deadline, daysLeft: p.daysLeft, subjectRef: p.subjectRef, decisions: Object.fromEntries(p.decisions.map((d) => [d.system, d.action])) };
  },

  catalog: [
    { kind: "asana.dsar_record", provider: "asana", gate: "auto", description: "Request record with deadline and per-system decisions (no personal data)" },
    { kind: "gmail.draft_verification_request", provider: "gmail", gate: "auto", description: "Draft asking an unverified requester to confirm" },
    { kind: "hubspot.erase_contact", provider: "hubspot", gate: "approval", description: "Permanently delete the CRM contact (GDPR delete)" },
    { kind: "stripe.anonymize_customer", provider: "stripe", gate: "approval", description: "Remove personal details from the billing customer; invoices stay for tax retention" },
    { kind: "workos.delete_user", provider: "workos", gate: "approval", description: "Delete the login account" },
    { kind: "gmail.draft_completion", provider: "gmail", gate: "approval", description: "Draft the response to the requester, only after the erasures went through" },
    { kind: "slack.post_dsr", provider: "slack", gate: "auto", description: "Request status in the privacy channel (hashed subject)" },
  ],
};

function planFrom(input: Input, now: number, results: AgentResults): Plan {
  const decisions = decide(out<Crm>(results, "crm-records"), out<Billing>(results, "billing-records"), out<Identity>(results, "identity-records"));
  const deadline = Date.parse(input.receivedAt) + DEADLINE_DAYS[input.regulation] * 86_400_000;
  return {
    verified: input.verification.method !== "none",
    deadline: new Date(deadline).toISOString(),
    daysLeft: Math.floor((deadline - now) / 86_400_000),
    complete: !decisions.some((d) => d.action === "unknown"),
    decisions,
    subjectRef: shortHash("subject", input.subject.email).slice(0, 12),
  };
}
