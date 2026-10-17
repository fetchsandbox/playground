import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import { Approvers, ChannelId, Email, messageId, money, out, plain } from "./shared";

// Customer Experience · cx-service.
// Trigger: a "where is my order" email or ticket. ACME's order is its Stripe
// invoice; the warehouse tracks fulfillment as an Asana task whose id is kept
// in the invoice metadata (`fulfillment_task_gid`), due date = promise date.

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const Input = z.object({
  customer: z.object({ email: Email, name: z.string().max(200).optional() }),
  invoiceId: z.string().regex(/^in_\w+$/, "Stripe invoice id like in_123"),
  question: z.string().max(4000).default(""),
  /** Promise date used when the order has no fulfillment task yet. */
  promisedOn: IsoDate.optional(),
  /** Revised promise date proposed when the order is late. */
  revisedPromiseOn: IsoDate.optional(),
  ownerChannel: ChannelId,
  warehouseWorkspace: z.string().min(1).default("acme-warehouse"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Order {
  customerId: string;
  invoiceId: string;
  number: string;
  status: string;
  amountMinor: number;
  currency: string;
}
interface Fulfillment {
  scheduled: boolean;
  taskGid?: string;
  promisedOn?: string;
  shipped: boolean;
}
export type OrderState = "shipped" | "on_time" | "late" | "unscheduled" | "unknown";
interface Answer {
  state: OrderState;
  promisedOn?: string;
  revisedPromiseOn?: string;
  reply: { subject: string; body: string; draftedBy: string };
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export function orderState(f: Fulfillment | undefined, today: string): OrderState {
  if (!f) return "unknown";
  if (!f.scheduled) return "unscheduled";
  if (f.shipped) return "shipped";
  return f.promisedOn && f.promisedOn < today ? "late" : "on_time";
}

async function invoiceFor(input: Input, providers: Providers) {
  const stripe = providers.stripe!;
  const customer = await stripe.findCustomerByEmail(input.customer.email);
  if (!customer) throw new FatalError(`no Stripe customer for ${input.customer.email}`);
  const inv = await stripe.getInvoice(input.invoiceId);
  if (inv.customer !== customer.id) throw new FatalError(`invoice ${input.invoiceId} does not belong to ${input.customer.email}`);
  return inv;
}

export const orderStatus: WorkflowDef<Input> = {
  id: "order-status",
  title: "Order status and expedite",
  org: "Customer Experience",
  team: "cx-service",
  description:
    "Answer \"where is my order\" from the Stripe invoice and the warehouse's Asana fulfillment task: schedule unscheduled orders, draft the reply, alert the owner on late orders. Changing the promise date waits for approval.",
  input: Input,
  agents: [
    {
      name: "order-lookup",
      needs: ["stripe"],
      async run({ input, providers }) {
        const inv = await invoiceFor(input, providers);
        const data: Order = { customerId: inv.customer, invoiceId: inv.id, number: inv.number ?? inv.id, status: inv.status, amountMinor: inv.amount_due, currency: inv.currency ?? "usd" };
        return { summary: `${data.number} ${data.status} ${money(data.amountMinor, data.currency)}`, data };
      },
    },
    {
      name: "fulfillment",
      needs: ["stripe", "asana"],
      async run({ input, providers }) {
        const inv = await invoiceFor(input, providers);
        const gid = inv.metadata?.fulfillment_task_gid;
        if (!gid) return { summary: "no fulfillment task yet", data: { scheduled: false, shipped: false } satisfies Fulfillment };
        const t = await providers.asana!.getTask(gid);
        const data: Fulfillment = { scheduled: true, taskGid: gid, promisedOn: t.due_on ?? undefined, shipped: t.completed === true };
        return { summary: data.shipped ? "shipped" : `promised ${data.promisedOn ?? "undated"}`, data };
      },
    },
    {
      name: "account-owner",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.customer.email);
        return { summary: c ? `HubSpot contact ${c.id}` : "not in HubSpot", data: { found: !!c, ownerId: c?.properties.hubspot_owner_id ?? null } };
      },
    },
  ],

  compose: {
    name: "status-composer",
    async run({ input, drafter, startedAt }, results) {
      const order = out<Order>(results, "order-lookup");
      const f = out<Fulfillment>(results, "fulfillment");
      const state = order ? orderState(f, day(startedAt)) : "unknown";
      const promisedOn = state === "unscheduled" ? (input.promisedOn ?? day(addDays(startedAt, 14))) : f?.promisedOn;
      const revisedPromiseOn = state === "late" ? (input.revisedPromiseOn ?? day(addDays(startedAt, 7))) : undefined;
      const first = input.customer.name?.split(" ")[0] ?? "there";
      const ref = order?.number ?? input.invoiceId;
      const line: Record<OrderState, string> = {
        shipped: `Your order ${ref} has shipped.`,
        on_time: `Your order ${ref} is on track to ship by ${promisedOn}.`,
        late: `Your order ${ref} is running behind its ${promisedOn} ship date. We're confirming a new date with the warehouse and will update you shortly.`,
        unscheduled: `Your order ${ref} is scheduled to ship by ${promisedOn}.`,
        unknown: `We're checking on order ${ref} and will follow up shortly.`,
      };
      const reply = await drafter.draft({
        task: "order-status",
        instructions: "Draft a short reply to a customer asking about their order. State the status given; never promise a date other than the one in the facts.",
        facts: { firstName: first, order: ref, status: state, promisedOn: promisedOn ?? null, customerQuestion: input.question.slice(0, 2000) },
        fallback: { subject: `Re: order ${ref}`, body: `Hi ${first},\n\n${line[state]}\n\nACME Customer Experience` },
      });
      const data: Answer = { state, promisedOn, revisedPromiseOn, reply };
      return { summary: `${state}${promisedOn ? ` (${promisedOn})` : ""}`, data };
    },
  },

  plan({ input }, results) {
    const order = out<Order>(results, "order-lookup");
    const f = out<Fulfillment>(results, "fulfillment");
    const a = out<Answer>(results, "status-composer");
    if (!a || !order) return [];
    const actions: PlannedAction<Input>[] = [];

    if (a.state === "unscheduled") {
      actions.push({
        id: "asana.schedule_fulfillment",
        kind: "asana.schedule_fulfillment",
        provider: "asana",
        agent: "status-composer",
        gate: "auto",
        summary: { invoice: order.number, promisedOn: a.promisedOn },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({ name: `Ship ${order.number} for ${input.customer.email}`, notes: `Stripe invoice ${order.invoiceId}`, workspace: input.warehouseWorkspace, due_on: a.promisedOn });
          return { ref: t.gid, detail: { due_on: a.promisedOn } };
        },
        async reconcile({ providers }, receipt) {
          const t = await providers.asana!.getTask(receipt.ref);
          return t.due_on === a.promisedOn ? { status: "match" } : { status: "drift", detail: `due ${t.due_on}, expected ${a.promisedOn}` };
        },
      });
      actions.push({
        id: "stripe.link_fulfillment",
        kind: "stripe.link_fulfillment",
        provider: "stripe",
        agent: "status-composer",
        gate: "auto",
        summary: { invoice: order.invoiceId, metadata: "fulfillment_task_gid" },
        async execute({ providers, applied }) {
          const gid = applied["asana.schedule_fulfillment"]?.ref;
          if (!gid) throw new FatalError("no fulfillment task: asana.schedule_fulfillment did not apply");
          await providers.stripe!.http.request("POST", `/v1/invoices/${encodeURIComponent(order.invoiceId)}`, { form: { "metadata[fulfillment_task_gid]": gid } });
          return { ref: order.invoiceId, detail: { fulfillment_task_gid: gid } };
        },
        async reconcile({ providers, applied }) {
          const inv = await providers.stripe!.getInvoice(order.invoiceId);
          return inv.metadata?.fulfillment_task_gid === applied["asana.schedule_fulfillment"]?.ref ? { status: "match" } : { status: "drift", detail: "invoice points at another task" };
        },
      });
    }

    actions.push({
      id: "gmail.draft_status_reply",
      kind: "gmail.draft_status_reply",
      provider: "gmail",
      agent: "status-composer",
      gate: "auto",
      summary: { to: input.customer.email, state: a.state, draftedBy: a.reply.draftedBy, sent: false },
      async execute({ providers, runId }) {
        const d = await providers.gmail!.createDraft({ to: input.customer.email, subject: a.reply.subject, body: a.reply.body, messageId: messageId(runId, "status") });
        return { ref: d.id };
      },
    });

    if (a.state === "late" && f?.taskGid) {
      const taskGid = f.taskGid;
      actions.push({
        id: "slack.alert_late_order",
        kind: "slack.alert_late_order",
        provider: "slack",
        agent: "status-composer",
        gate: "auto",
        summary: { channel: input.ownerChannel, invoice: order.number, promisedOn: a.promisedOn },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(
            input.ownerChannel,
            `:hourglass: Order ${order.number} for ${input.customer.email} missed its ${a.promisedOn} ship date. Proposed new date ${a.revisedPromiseOn} is waiting for approval.${input.question ? ` Customer asked: "${plain(input.question, 200)}"` : ""}`,
          );
          return { ref: m.ts, detail: { channel: m.channel } };
        },
      });
      actions.push({
        id: "asana.revise_promise_date",
        kind: "asana.revise_promise_date",
        provider: "asana",
        agent: "status-composer",
        gate: "approval",
        summary: { invoice: order.number, from: a.promisedOn, to: a.revisedPromiseOn },
        async execute({ providers }) {
          const t = await providers.asana!.updateTask(taskGid, { due_on: a.revisedPromiseOn });
          await providers.asana!.comment(taskGid, `Promise date moved from ${a.promisedOn} to ${a.revisedPromiseOn} (customer notified).`);
          return { ref: taskGid, detail: { due_on: t.due_on ?? a.revisedPromiseOn } };
        },
        async reconcile({ providers }) {
          const t = await providers.asana!.getTask(taskGid);
          return t.due_on === a.revisedPromiseOn ? { status: "match" } : { status: "drift", detail: `due ${t.due_on}, expected ${a.revisedPromiseOn}` };
        },
      });
      actions.push({
        id: "gmail.draft_revised_date",
        kind: "gmail.draft_revised_date",
        provider: "gmail",
        agent: "status-composer",
        gate: "approval",
        summary: { to: input.customer.email, revisedPromiseOn: a.revisedPromiseOn, sent: false },
        async execute({ providers, runId }) {
          const first = input.customer.name?.split(" ")[0] ?? "there";
          const d = await providers.gmail!.createDraft({
            to: input.customer.email,
            subject: `Re: order ${order.number}: new ship date`,
            body: `Hi ${first},\n\nYour order ${order.number} will now ship by ${a.revisedPromiseOn}. We're sorry for the delay.\n\nACME Customer Experience`,
            messageId: messageId(runId, "revised"),
          });
          return { ref: d.id };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const a = out<Answer>(results, "status-composer");
    const order = out<Order>(results, "order-lookup");
    return { invoice: order?.number ?? input.invoiceId, state: a?.state ?? "unknown", promisedOn: a?.promisedOn ?? null, revisedPromiseOn: a?.revisedPromiseOn ?? null };
  },

  catalog: [
    { kind: "asana.schedule_fulfillment", provider: "asana", gate: "auto", description: "Create the warehouse fulfillment task for an unscheduled order" },
    { kind: "stripe.link_fulfillment", provider: "stripe", gate: "auto", description: "Record the fulfillment task on the invoice metadata" },
    { kind: "gmail.draft_status_reply", provider: "gmail", gate: "auto", description: "Create (not send) the status reply draft" },
    { kind: "slack.alert_late_order", provider: "slack", gate: "auto", description: "Alert the owner channel about a late order" },
    { kind: "asana.revise_promise_date", provider: "asana", gate: "approval", description: "Move the promise date on the fulfillment task" },
    { kind: "gmail.draft_revised_date", provider: "gmail", gate: "approval", description: "Create (not send) the revised-date draft" },
  ],
};
