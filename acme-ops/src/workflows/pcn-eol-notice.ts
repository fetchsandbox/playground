import { z } from "zod";
import { type GitHubIssue, labelNames } from "../providers/work";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, messageId, out, plain, shortHash } from "./shared";

// Engineering org · product-engineering team.
// Trigger: engineering approves a product change or end-of-life. The change
// record lives in GitHub (an issue labelled `pcn`); affected customers come
// from live Stripe subscriptions on the product. Internal follow-up is
// automatic; preparing customer notices and marking the record notified wait
// for approval.

const Input = z.object({
  /** GitHub repository holding change records, "owner/repo". */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** Existing change record; without it the workflow opens one. */
  issueNumber: z.number().int().positive().optional(),
  productId: z.string().regex(/^prod_\w+$/),
  kind: z.enum(["change", "end_of_life"]),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  effectiveDate: z.iso.date(),
  lastTimeBuy: z.iso.date().optional(),
  notifyChannel: ChannelId,
  asanaWorkspace: z.string().min(1).default("acme-eng"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Affected {
  productName: string;
  customers: { customerId: string; email: string; name?: string | null; subscriptions: string[] }[];
}
interface Owners {
  byEmail: Record<string, { contactId: string; owner?: string }>;
}

export const pcnEolNotice: WorkflowDef<Input> = {
  id: "pcn-eol-notice",
  title: "Product change and end-of-life notices",
  org: "Engineering",
  team: "product-engineering",
  description:
    "From an approved product change or end-of-life record in GitHub, find affected customers in Stripe and their owners in HubSpot; post the summary and create owner tasks. Customer notice drafts and marking the record notified wait for approval.",
  input: Input,
  agents: [
    {
      name: "change-record",
      needs: ["github"],
      async run({ input, providers }) {
        if (!input.issueNumber) return { summary: "no record yet: one will be opened", data: { issue: null } };
        const issue = await providers.github!.getIssue(input.repo, input.issueNumber);
        return { summary: `#${issue.number} ${issue.state} [${labelNames(issue).join(", ")}]`, data: { issue } };
      },
    },
    {
      name: "affected-customers",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const [product, prices, subs, customers] = await Promise.all([stripe.getProduct(input.productId), stripe.listPrices(input.productId), stripe.listSubscriptions(), stripe.listCustomers()]);
        const priceIds = new Set(prices.filter((p) => p.product === input.productId).map((p) => p.id));
        const custById = new Map(customers.map((c) => [c.id, c]));
        const byCustomer = new Map<string, string[]>();
        for (const s of subs) {
          if (!["active", "trialing", "past_due", "unpaid"].includes(s.status)) continue;
          // Item price is an object on real Stripe; some backends send only its id.
          const onProduct = (s.items?.data ?? []).some((it) => {
            const p = it.price as unknown;
            return typeof p === "string" ? priceIds.has(p) : (p as { product?: string } | undefined)?.product === input.productId;
          });
          if (onProduct) byCustomer.set(s.customer, [...(byCustomer.get(s.customer) ?? []), s.id]);
        }
        const affected: Affected = {
          productName: product.name,
          customers: [...byCustomer.entries()]
            .map(([customerId, subscriptions]) => ({ customerId, email: custById.get(customerId)?.email?.toLowerCase() ?? "", name: custById.get(customerId)?.name ?? null, subscriptions: subscriptions.sort() }))
            .filter((c) => c.email)
            .sort((a, b) => a.email.localeCompare(b.email)),
        };
        return { summary: `${affected.customers.length} customer(s) on ${product.name}`, data: affected };
      },
    },
    {
      name: "account-owners",
      needs: ["hubspot", "stripe"],
      async run({ input, providers }) {
        // Re-derive the customer list independently so this agent doesn't wait on the other.
        const [prices, subs, customers] = await Promise.all([providers.stripe!.listPrices(input.productId), providers.stripe!.listSubscriptions(), providers.stripe!.listCustomers()]);
        const priceIds = new Set(prices.filter((p) => p.product === input.productId).map((p) => p.id));
        const ids = new Set(subs.filter((s) => (s.items?.data ?? []).some((it) => (typeof it.price === "string" ? priceIds.has(it.price) : it.price?.id && priceIds.has(it.price.id)))).map((s) => s.customer));
        const emails = customers.filter((c) => ids.has(c.id) && c.email).map((c) => c.email!.toLowerCase()).sort();
        const byEmail: Owners["byEmail"] = {};
        for (const email of emails) {
          const c = await providers.hubspot!.findByEmail(email);
          if (c) byEmail[email] = { contactId: c.id, owner: c.properties.hubspot_owner_id ?? undefined };
        }
        return { summary: `${Object.keys(byEmail).length}/${emails.length} owner(s) found`, data: { byEmail } satisfies Owners };
      },
    },
  ],

  plan({ input }, results) {
    const affected = out<Affected>(results, "affected-customers");
    const record = out<{ issue: GitHubIssue | null }>(results, "change-record");
    // Without the customer list there is nobody to notify; without the record (when one was named) nothing is certain.
    if (!affected || (input.issueNumber && !record?.issue)) return [];
    const owners = out<Owners>(results, "account-owners")?.byEmail ?? {};
    const actions: PlannedAction<Input>[] = [];
    const label = input.kind === "end_of_life" ? "End-of-life" : "Product change";
    const dates = `effective ${input.effectiveDate}${input.lastTimeBuy ? `, last-time-buy ${input.lastTimeBuy}` : ""}`;

    if (!input.issueNumber) {
      actions.push({
        id: "github.open_change_record",
        kind: "github.open_change_record",
        provider: "github",
        agent: "change-record",
        gate: "auto",
        summary: { repo: input.repo, title: input.title, labels: ["pcn", input.kind] },
        async execute({ providers }) {
          const i = await providers.github!.createIssue(input.repo, {
            title: `${label}: ${input.title}`,
            body: `${input.summary}\n\nProduct: ${input.productId} (${affected.productName})\nDates: ${dates}\nAffected customers: ${affected.customers.length}`,
            labels: ["pcn", input.kind],
          });
          return { ref: String(i.number) };
        },
      });
    }

    actions.push({
      id: "slack.post_change_summary",
      kind: "slack.post_change_summary",
      provider: "slack",
      agent: "affected-customers",
      gate: "auto",
      summary: { channel: input.notifyChannel, customers: affected.customers.length },
      async execute({ providers }) {
        const text = [`*${label}*: ${plain(input.title, 150)} — ${affected.productName}, ${dates}. ${affected.customers.length} affected customer(s); notices await approval.`, ...affected.customers.map((c) => `• ${c.email}${owners[c.email]?.owner ? ` · owner ${owners[c.email]!.owner}` : " · no owner"}`)].join("\n");
        const m = await providers.slack!.postMessage(input.notifyChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });

    // One task per owner (unowned accounts go to one task for the product team).
    const groups = new Map<string, string[]>();
    for (const c of affected.customers) {
      const o = owners[c.email]?.owner ?? "unassigned";
      groups.set(o, [...(groups.get(o) ?? []), c.email]);
    }
    for (const [owner, emails] of [...groups.entries()].sort()) {
      actions.push({
        id: `asana.owner_task:${shortHash(owner)}`,
        kind: "asana.owner_task",
        provider: "asana",
        agent: "account-owners",
        gate: "auto",
        summary: { owner, accounts: emails },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({
            name: `${label} follow-up (${owner}): ${input.title}`.slice(0, 250),
            notes: `${input.summary}\n\nDates: ${dates}\nAccounts: ${emails.join(", ")}`,
            workspace: input.asanaWorkspace,
            due_on: input.lastTimeBuy ?? input.effectiveDate,
          });
          return { ref: t.gid };
        },
      });
    }

    for (const c of affected.customers) {
      const key = shortHash(c.customerId);
      const first = c.name?.split(" ")[0] ?? "there";
      actions.push({
        id: `gmail.draft_customer_notice:${key}`,
        kind: "gmail.draft_customer_notice",
        provider: "gmail",
        agent: "affected-customers",
        gate: "approval",
        summary: { to: c.email, product: affected.productName, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({
            to: c.email,
            subject: `${label} notice: ${affected.productName}`,
            body: `Hi ${first},\n\nWe're writing about ${affected.productName}, which your account uses.\n\n${input.summary}\n\nEffective date: ${input.effectiveDate}${input.lastTimeBuy ? `\nLast-time-buy date: ${input.lastTimeBuy}` : ""}\n\nYour account team will follow up on next steps.\n\nACME Product Engineering`,
            messageId: messageId(runId, `pcn-${key}`),
          });
          return { ref: d.id };
        },
      });
    }

    // After the notices, mark the change record. It runs last in plan order so it can use the opened issue.
    actions.push({
      id: "github.mark_customers_notified",
      kind: "github.mark_customers_notified",
      provider: "github",
      agent: "change-record",
      gate: "approval",
      summary: { repo: input.repo, issue: input.issueNumber ?? "opened by this run", addLabel: "customers-notified" },
      async execute({ providers, applied }) {
        const n = input.issueNumber ?? Number(applied["github.open_change_record"]?.ref);
        if (!n) throw new Error("no change record to label");
        const current = await providers.github!.getIssue(input.repo, n);
        const labels = [...new Set([...labelNames(current), "customers-notified"])];
        await providers.github!.setLabels(input.repo, n, labels);
        return { ref: String(n), detail: { labels } };
      },
      async reconcile({ providers }, receipt) {
        const i = await providers.github!.getIssue(input.repo, Number(receipt.ref));
        return labelNames(i).includes("customers-notified") ? { status: "match" } : { status: "drift", detail: "customers-notified label removed" };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const affected = out<Affected>(results, "affected-customers");
    return {
      productId: input.productId,
      kind: input.kind,
      effectiveDate: input.effectiveDate,
      lastTimeBuy: input.lastTimeBuy ?? null,
      affectedCustomers: affected?.customers.length ?? null,
      customers: affected?.customers.map((c) => c.email) ?? [],
      recordProvided: !!input.issueNumber,
    };
  },

  catalog: [
    { kind: "github.open_change_record", provider: "github", gate: "auto", description: "Open the change record (issue labelled pcn) when none was given" },
    { kind: "slack.post_change_summary", provider: "slack", gate: "auto", description: "Post the change, dates and affected customers" },
    { kind: "asana.owner_task", provider: "asana", gate: "auto", description: "Create a follow-up task per account owner" },
    { kind: "gmail.draft_customer_notice", provider: "gmail", gate: "approval", description: "Create (not send) the customer notice drafts" },
    { kind: "github.mark_customers_notified", provider: "github", gate: "approval", description: "Label the change record customers-notified" },
  ],
};
