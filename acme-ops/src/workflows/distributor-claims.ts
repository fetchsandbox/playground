import { z } from "zod";
import type { StripeInvoice } from "../providers/stripe";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, money, out, shortHash } from "./shared";

// Finance org · channel-finance team.
// Trigger: a distributor submits ship-and-debit claims (sold below list to an
// end customer, claims back the difference). Each claim is checked against the
// distributor's paid Stripe invoice, the list price and the agreement's maximum
// discount; approved credit is paid as a Stripe customer balance credit after approval.

const Claim = z.object({
  claimId: z.string().min(1).max(80).regex(/^[\w.:-]+$/),
  invoiceId: z.string().regex(/^in_\w+$/),
  productId: z.string().regex(/^prod_\w+$/),
  qty: z.number().int().min(1).max(100_000),
  claimedUnitPriceMinor: z.number().int().min(0),
  endCustomer: z.string().min(1).max(200),
});

const Input = z
  .object({
    distributorEmail: Email,
    claims: z.array(Claim).min(1).max(100),
    agreement: z.object({ maxDiscountPct: z.number().min(0).max(90) }),
    financeChannel: ChannelId,
    approvers: Approvers,
  })
  .refine((v) => new Set(v.claims.map((c) => c.claimId)).size === v.claims.length, "duplicate claimId");
type Input = z.infer<typeof Input>;

interface Ledger {
  customerId?: string;
  currency: string;
  invoices: Record<string, Pick<StripeInvoice, "id" | "customer" | "status" | "amount_due" | "currency"> & { amountPaid: number; lines: { product?: string; quantity: number }[] }>;
  /** Claim ids already credited on this account (from balance transaction descriptions). */
  alreadyPaid: string[];
}
interface PriceList {
  listUnit: Record<string, { unitAmount: number; currency: string }>;
}

export type Decision = "approve" | "partial" | "deny";
export interface ClaimResult {
  claimId: string;
  invoiceId: string;
  productId: string;
  qty: number;
  decision: Decision;
  creditMinor: number;
  reasons: string[];
  /** How the invoice was checked: its line items, or only its paid amount when lines are unavailable. */
  invoiceCheck: "lines" | "amount_only" | "none";
}

/** Pure claim validation. Exported for tests. */
export function decideClaims(input: Input, ledger: Ledger, prices: PriceList): ClaimResult[] {
  const usedPerInvoice = new Map<string, number>();
  return input.claims.map((c) => {
    const reasons: string[] = [];
    const base = { claimId: c.claimId, invoiceId: c.invoiceId, productId: c.productId, qty: c.qty };
    const deny = (why: string, check: ClaimResult["invoiceCheck"] = "none"): ClaimResult => ({ ...base, decision: "deny", creditMinor: 0, reasons: [why], invoiceCheck: check });
    if (ledger.alreadyPaid.includes(c.claimId)) return deny("already credited");
    const inv = ledger.invoices[c.invoiceId];
    if (!inv) return deny("invoice not found");
    if (!ledger.customerId || inv.customer !== ledger.customerId) return deny("invoice belongs to another customer");
    if (inv.status !== "paid") return deny(`invoice is ${inv.status}, not paid`);
    const list = prices.listUnit[c.productId];
    if (!list) return deny("no active list price for product");
    let check: ClaimResult["invoiceCheck"];
    if (inv.lines.length) {
      check = "lines";
      const qtyOnInvoice = inv.lines.filter((l) => l.product === c.productId).reduce((n, l) => n + l.quantity, 0);
      const used = usedPerInvoice.get(`${c.invoiceId}|${c.productId}`) ?? 0;
      if (qtyOnInvoice === 0) return deny("product not on invoice", check);
      if (used + c.qty > qtyOnInvoice) return deny(`claims ${used + c.qty} units, invoice has ${qtyOnInvoice}`, check);
      usedPerInvoice.set(`${c.invoiceId}|${c.productId}`, used + c.qty);
    } else {
      // Line items unavailable: the claimed units at list price must at least fit inside what was paid.
      check = "amount_only";
      const used = usedPerInvoice.get(c.invoiceId) ?? 0;
      if (used + list.unitAmount * c.qty > inv.amountPaid) return deny(`claimed units exceed the paid amount of ${money(inv.amountPaid, inv.currency)}`, check);
      usedPerInvoice.set(c.invoiceId, used + list.unitAmount * c.qty);
      reasons.push("invoice lines unavailable: checked against paid amount");
    }
    if (c.claimedUnitPriceMinor >= list.unitAmount) return { ...base, decision: "deny", creditMinor: 0, reasons: ["sold at or above list: nothing to claim"], invoiceCheck: check };
    const floor = Math.ceil(list.unitAmount * (1 - input.agreement.maxDiscountPct / 100));
    const effective = Math.max(c.claimedUnitPriceMinor, floor);
    const creditMinor = (list.unitAmount - effective) * c.qty;
    if (effective > c.claimedUnitPriceMinor) {
      reasons.push(`discount capped at ${input.agreement.maxDiscountPct}% (floor ${money(floor, list.currency)})`);
      return { ...base, decision: "partial", creditMinor, reasons, invoiceCheck: check };
    }
    return { ...base, decision: "approve", creditMinor, reasons, invoiceCheck: check };
  });
}

export const distributorClaims: WorkflowDef<Input> = {
  id: "distributor-claims",
  title: "Distributor rebate and point-of-sale claims",
  org: "Finance",
  team: "channel-finance",
  description:
    "Validate a distributor's ship-and-debit claims against its paid Stripe invoices, list prices and agreement; post the decisions, draft the reply, and pay approved credit as a Stripe balance credit after approval.",
  input: Input,
  agents: [
    {
      name: "invoice-ledger",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const customer = await stripe.findCustomerByEmail(input.distributorEmail);
        const ids = [...new Set(input.claims.map((c) => c.invoiceId))].sort();
        const invoices: Ledger["invoices"] = {};
        for (const id of ids) {
          try {
            const inv = await stripe.getInvoice(id);
            invoices[id] = {
              id: inv.id,
              customer: inv.customer,
              status: inv.status,
              amount_due: inv.amount_due,
              currency: inv.currency ?? "usd",
              amountPaid: (inv as StripeInvoice & { amount_paid?: number }).amount_paid ?? 0,
              lines: (inv.lines?.data ?? []).map((l) => ({ product: l.price?.product, quantity: l.quantity ?? 0 })).filter((l) => l.product),
            };
          } catch (err) {
            if ((err as { status?: number }).status !== 404) throw err;
          }
        }
        let alreadyPaid: string[] = [];
        if (customer) {
          const txns = (await stripe.listBalanceTransactions(customer.id)) as { description?: string | null }[];
          alreadyPaid = txns.flatMap((t) => /claim:([\w.:-]+)/.exec(t.description ?? "")?.[1] ?? []);
        }
        const data: Ledger = { customerId: customer?.id, currency: Object.values(invoices)[0]?.currency ?? "usd", invoices, alreadyPaid };
        return { summary: `${customer ? `distributor ${customer.id}` : "distributor not in Stripe"}; ${Object.keys(invoices).length}/${ids.length} invoice(s) found`, data };
      },
    },
    {
      name: "price-list",
      needs: ["stripe"],
      async run({ input, providers }) {
        const prices = await providers.stripe!.listPrices();
        const listUnit: PriceList["listUnit"] = {};
        for (const pid of new Set(input.claims.map((c) => c.productId))) {
          // List price = the product's lowest-period active price (monthly before yearly).
          const p = prices.filter((x) => x.product === pid && x.unit_amount != null).sort((a, b) => (a.unit_amount ?? 0) - (b.unit_amount ?? 0))[0];
          if (p) listUnit[pid] = { unitAmount: p.unit_amount!, currency: p.currency };
        }
        return { summary: `${Object.keys(listUnit).length} product price(s)`, data: { listUnit } satisfies PriceList };
      },
    },
    {
      name: "distributor-account",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.distributorEmail);
        return { summary: c ? `HubSpot contact ${c.id}` : "not in HubSpot", data: { contactId: c?.id, company: c?.properties.company ?? undefined, owner: c?.properties.hubspot_owner_id ?? undefined } };
      },
    },
  ],

  plan({ input }, results) {
    const ledger = out<Ledger>(results, "invoice-ledger");
    const prices = out<PriceList>(results, "price-list");
    // No decisions without both the invoices and the price list.
    if (!ledger || !prices) return [];
    const decided = decideClaims(input, ledger, prices);
    const total = decided.reduce((n, d) => n + d.creditMinor, 0);
    const cur = ledger.currency;
    const actions: PlannedAction<Input>[] = [];
    const count = (d: Decision) => decided.filter((x) => x.decision === d).length;
    const lines = decided.map((d) => `• ${d.claimId} ${d.decision.toUpperCase()} ${money(d.creditMinor, cur)}${d.reasons.length ? ` — ${d.reasons.join("; ")}` : ""}`);

    actions.push({
      id: "slack.post_claims_summary",
      kind: "slack.post_claims_summary",
      provider: "slack",
      agent: "claims-validator",
      gate: "auto",
      summary: { channel: input.financeChannel, claims: decided.length, approvedCredit: money(total, cur) },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(
          input.financeChannel,
          [`*Distributor claims* — ${input.distributorEmail}: ${count("approve")} approved, ${count("partial")} partial, ${count("deny")} denied; credit ${money(total, cur)} awaiting approval.`, ...lines].join("\n"),
        );
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    actions.push({
      id: "gmail.draft_claim_decisions",
      kind: "gmail.draft_claim_decisions",
      provider: "gmail",
      agent: "claims-validator",
      gate: "auto",
      summary: { to: input.distributorEmail, claims: decided.length, sent: false },
      async execute({ providers, runId }) {
        const d = await providers.gmail!.createDraft({
          to: input.distributorEmail,
          subject: `Your claim submission: ${count("approve") + count("partial")} accepted, ${count("deny")} declined`,
          body: `Hello,\n\nWe reviewed ${decided.length} claim(s):\n\n${lines.join("\n")}\n\nAccepted credit of ${money(total, cur)} will be applied to your account balance once finance approves it.\n\nACME Channel Finance`,
          messageId: messageId(runId, "claims"),
        });
        return { ref: d.id };
      },
    });
    if (total > 0 && ledger.customerId) {
      const paid = decided.filter((d) => d.creditMinor > 0);
      const claimKeys = paid.map((d) => `claim:${d.claimId}`).join(" ");
      actions.push({
        id: `stripe.credit_claims:${shortHash(paid.map((d) => d.claimId).join(","))}`,
        kind: "stripe.credit_claims",
        provider: "stripe",
        agent: "claims-validator",
        gate: "approval",
        summary: { customerId: ledger.customerId, credit: money(total, cur), claims: paid.map((d) => d.claimId) },
        async execute({ providers, runId }) {
          const t = await providers.stripe!.creditBalance(ledger.customerId!, total, cur, `ACME distributor claims ${claimKeys}`.slice(0, 350), `claims-${runId}`);
          return { ref: t.id, detail: { amount: total } };
        },
        async reconcile({ providers }, receipt) {
          const txns = (await providers.stripe!.listBalanceTransactions(ledger.customerId!)) as { id: string; amount: number }[];
          const t = txns.find((x) => x.id === receipt.ref);
          if (!t) return { status: "missing", detail: "balance credit not found" };
          return t.amount === -total ? { status: "match" } : { status: "drift", detail: `amount ${t.amount}, expected ${-total}` };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const ledger = out<Ledger>(results, "invoice-ledger");
    const prices = out<PriceList>(results, "price-list");
    if (!ledger || !prices) return { evaluated: false, reason: "invoices or price list could not be read" };
    const decided = decideClaims(input, ledger, prices);
    return {
      evaluated: true,
      approved: decided.filter((d) => d.decision === "approve").length,
      partial: decided.filter((d) => d.decision === "partial").length,
      denied: decided.filter((d) => d.decision === "deny").length,
      creditMinor: decided.reduce((n, d) => n + d.creditMinor, 0),
      invoiceCheck: [...new Set(decided.map((d) => d.invoiceCheck))].sort().join(","),
      claims: decided,
    };
  },

  catalog: [
    { kind: "slack.post_claims_summary", provider: "slack", gate: "auto", description: "Post claim decisions to the finance channel" },
    { kind: "gmail.draft_claim_decisions", provider: "gmail", gate: "auto", description: "Create (not send) the decisions email to the distributor" },
    { kind: "stripe.credit_claims", provider: "stripe", gate: "approval", description: "Credit the approved amount to the distributor's Stripe balance" },
  ],
};
