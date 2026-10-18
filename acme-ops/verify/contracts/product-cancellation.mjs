import { createHash } from "node:crypto";
import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start } from "./lib.mjs";

// Each case uses its own customer and requester-owned Zendesk ticket. Stripe customers, subscriptions and payments are seeded per
// check by seed() below (customer cxl-<check>@cancel.test), so no two checks
// share a subscription. Square's twin has active location LKZQE8ZN3GSKR.
const TICKET = 2001;
const CHANNEL = "C0BILLING01";
const LOCATION = "LKZQE8ZN3GSKR";
const APPROVER = "U_CX_LEAD";

const email = (caseId) => `cxl-${caseId.replaceAll("_", "-")}@cancel.test`;
const request = (caseId, over = {}) => ({
  stage: "request",
  channel: "email",
  customer: { email: email(caseId), name: "Robin Example" },
  ticketId: TICKET,
  message: "Please cancel my subscription, we no longer need it.",
  opsChannel: CHANNEL,
  giftCardLocationId: LOCATION,
  approvers: [APPROVER],
  ...over,
});
const choice = (caseId, method, over = {}) => ({ stage: "refund_choice", customer: { email: email(caseId) }, ticketId: TICKET, choice: method, opsChannel: CHANNEL, giftCardLocationId: LOCATION, approvers: [APPROVER], ...over });
const req = (caseId, over) => start(caseId, request(caseId, over), { runId: `${caseId.replaceAll("_", "-")}-req-{{run_id}}` });
const pick = (caseId, method, n = 1) => start(caseId, choice(caseId, method), { runId: `${caseId.replaceAll("_", "-")}-choice${n}-{{run_id}}` });

const cancelled = [action("zendesk.acknowledge", "applied"), action("zendesk.policy_note", "applied"), action("stripe.cancel_subscription", "applied"), action("zendesk.refund_offer", "applied"), action("slack.post_case", "applied")];

function faulted(id, name, provider, scenario, assertions, input = request(id)) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

/** Which Stripe fixture each check needs (product kind). */
const FIXTURES = {
  baseline: "pro",
  store_credit_end_to_end: "pro",
  original_payment_end_to_end: "pro",
  gift_card_end_to_end: "pro",
  second_refund_refused: "pro",
  method_not_offered_clarified: "credit_only",
  contract_exception_parked: "contract",
  exception_approved: "contract",
  exception_rejected: "contract",
  approve_by_stranger_refused: "contract",
  restart_while_parked: "contract",
  no_refund_due: "non_refundable",
  large_refund_needs_approval: "annual",
  duplicate_start: "pro",
  concurrent_start: "pro",
  stripe_auth_failure: "pro",
  zendesk_rate_limited: "pro",
  square_auth_failure: "pro",
  slack_rate_limited: "pro",
  phone_request_opens_ticket: "pro",
  choice_read_from_customer_reply: "pro",
  prorated_credit_tier: "aged_annual",
  store_credit_readback: "pro",
  gift_card_balance_readback: "pro",
  customer_email_delivery: "pro",
};

export const checks = [
  check("baseline", "An in-policy email request is acknowledged, researched, cancelled and answered with a refund offer on the ticket", [req("baseline")], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), ...cancelled.map((a) => runs([a])))),
  check(
    "store_credit_end_to_end",
    "The customer's store-credit choice credits their Stripe balance once and confirms on the ticket",
    [req("store_credit_end_to_end"), pick("store_credit_end_to_end", "store_credit")],
    // Two runs (request, choice): the run count keeps all() from merging the conditions into one run.
    all(runs([], 2), runs([action("stripe.cancel_subscription", "applied")]), runs([eq("phase", "DONE"), action("stripe.issue_store_credit", "applied", 1, [eq("attempts", 1)]), action("zendesk.refund_confirmation", "applied")])),
  ),
  check(
    "original_payment_end_to_end",
    "The original-payment choice refunds the payment intent in Stripe, and reconcile reads the refund back",
    [req("original_payment_end_to_end"), pick("original_payment_end_to_end", "original_payment"), command("reconcile", 2)],
    runs([eq("phase", "DONE"), action("stripe.refund_original_payment", "applied", 1, [eq("reconciled", "match")]), action("zendesk.refund_confirmation", "applied")]),
  ),
  check(
    "gift_card_end_to_end",
    "The gift-card choice creates and activates a Square gift card and sends its number on the ticket",
    [req("gift_card_end_to_end"), pick("gift_card_end_to_end", "gift_card")],
    runs([eq("phase", "DONE"), action("square.issue_gift_card", "applied", 1, [eq("attempts", 1)]), action("zendesk.gift_card_number", "applied")]),
  ),
  check(
    "second_refund_refused",
    "A second refund choice on the same cancellation pays nothing",
    [req("second_refund_refused"), pick("second_refund_refused", "store_credit"), pick("second_refund_refused", "original_payment", 2)],
    all(runs([action("stripe.issue_store_credit", "applied")]), runs([action("stripe.refund_original_payment", null)], 0), runs([], 3)),
  ),
  check(
    "method_not_offered_clarified",
    "Choosing a refund method the product's terms don't allow asks the customer again and refunds nothing",
    [req("method_not_offered_clarified"), pick("method_not_offered_clarified", "original_payment")],
    all(runs([action("zendesk.clarify_choice", "applied")]), runs([action("stripe.refund_original_payment", null)], 0)),
  ),
  check(
    "contract_exception_parked",
    "A cancellation inside a contract commitment is acknowledged and parked for approval; nothing is cancelled",
    [req("contract_exception_parked")],
    runs([eq("phase", "AWAITING_APPROVAL"), action("zendesk.acknowledge", "applied"), action("stripe.cancel_subscription", "pending_approval"), action("zendesk.refund_offer", "pending_approval")]),
  ),
  check("exception_approved", "The CX lead's approval cancels the contract subscription and sends the offer", [req("exception_approved"), command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("stripe.cancel_subscription", "applied", 1, [eq("attempts", 1)]), action("zendesk.refund_offer", "applied")])),
  check("exception_rejected", "A rejected exception cancels nothing and tells the customer nothing automatically", [req("exception_rejected"), command("decide", 1, { decision: "reject", userId: APPROVER })], runs([eq("phase", "REJECTED"), action("stripe.cancel_subscription", "rejected"), action("zendesk.refund_offer", "rejected")])),
  check("approve_by_stranger_refused", "Someone who is not an approver cannot approve an exception", [req("approve_by_stranger_refused"), command("decide", 1, { decision: "approve", userId: "U_AGENT" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), action("stripe.cancel_subscription", "pending_approval")])),
  check("no_refund_due", "A non-refundable product is cancelled and confirmed with no refund offer; the ticket is solved", [req("no_refund_due")], runs([eq("phase", "DONE"), action("stripe.cancel_subscription", "applied"), action("zendesk.cancellation_confirmed", "applied"), noAction("zendesk.refund_offer")])),
  check(
    "large_refund_needs_approval",
    "A refund above the auto-refund limit waits for approval and is issued once approved",
    [req("large_refund_needs_approval"), pick("large_refund_needs_approval", "original_payment"), command("decide", 2, { decision: "approve", userId: APPROVER })],
    runs([eq("phase", "DONE"), action("stripe.refund_original_payment", "applied", 1, [eq("gate", "approval"), eq("attempts", 1)])]),
  ),
  check("unknown_customer_not_cancelled", "A request from an address with no Stripe customer cancels nothing and is routed to a person", [req("unknown_customer_not_cancelled")], runs([agent("policy-research", "failed"), noAction("stripe.cancel_subscription"), action("zendesk.policy_note", "applied"), action("slack.post_case", "applied")])),
  check("duplicate_start", "A re-delivered request cancels once", [req("duplicate_start"), req("duplicate_start")], runs([action("stripe.cancel_subscription", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four simultaneous deliveries of one request cancel once", [{ ...req("concurrent_start"), concurrency: 4 }], runs([action("stripe.cancel_subscription", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A request with a malformed subscription id is rejected before any agent runs", [start("invalid_input_rejected", request("invalid_input_rejected", { subscriptionId: "12345" }), { expectStatus: 400 })], runs([], 0)),
  faulted("stripe_auth_failure", "Without Stripe nothing is cancelled; the customer is still acknowledged and a person is alerted", "stripe", "auth_failure", [agent("policy-research", "failed"), noAction("stripe.cancel_subscription"), action("zendesk.acknowledge", "applied"), action("slack.post_case", "applied")]),
  faulted("zendesk_rate_limited", "Zendesk rate limiting fails the ticket updates only; the in-policy cancellation still happens", "zendesk", "rate_limited", [action("stripe.cancel_subscription", "applied"), action("zendesk.acknowledge", "failed"), eq("outcome", "partial")]),
  faulted("square_auth_failure", "With the gift card system down, gift cards are not offered; the cancellation and offer go ahead", "square", "auth_failure", [agent("gift-card-desk", "failed"), action("stripe.cancel_subscription", "applied"), action("zendesk.refund_offer", "applied")]),
  faulted("slack_rate_limited", "Slack rate limiting fails the case post only", "slack", "rate_limited", [action("slack.post_case", "failed"), action("stripe.cancel_subscription", "applied")]),
  check("restart_while_parked", "An exception parked for approval survives a real runtime restart and cancels once when approved afterwards", [req("restart_while_parked"), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("stripe.cancel_subscription", "applied", 1, [eq("attempts", 1)])])),
  check("phone_request_opens_ticket", "A phone request without a ticket opens one in Zendesk and works on it", [req("phone_request_opens_ticket", {channel:"phone", ticketId:undefined})], runs([eq("phase","DONE"), action("zendesk.create_ticket","applied"), action("stripe.cancel_subscription","applied")])),
  // These cases contain request AND refund_choice records. Stage-specific fields
  // are absent on the other stage; count=1 still requires a real matching value.
  check("choice_read_from_customer_reply", "The refund method is read from a new requester-authored reply after the offer", [req("choice_read_from_customer_reply"), {provider_input:{provider:"zendesk",method:"PUT",path:"/api/v2/tickets/2001.json",body:{ticket:{comment:{body:"2",public:true,author_id:1001}}}}}, pick("choice_read_from_customer_reply",undefined)], all(runs([],2), runs([action("stripe.issue_store_credit","applied"),{select:"output.refundMethod",equals:"store_credit",required:false}]))),
  check("prorated_credit_tier", "A 45-day-old annual payment gets the unused share as store credit", [req("prorated_credit_tier"),pick("prorated_credit_tier","store_credit")], all(runs([],2),runs([{select:"output.refundOffer.tier",equals:"prorated_credit",required:false},{select:"output.refundOffer.amountMinor",equals:4295,required:false}]),runs([{select:"output.refundMinor",equals:4295,required:false},action("stripe.issue_store_credit","applied")]))),
  check("store_credit_readback", "Reconciliation retrieves the saved Stripe customer credit ledger entry", [req("store_credit_readback"),pick("store_credit_readback","store_credit"),command("reconcile",2)], runs([action("stripe.issue_store_credit","applied",1,[eq("reconciled","match")])])),
  check("gift_card_balance_readback", "Reconciliation reads the loaded Square gift-card balance", [req("gift_card_balance_readback"),pick("gift_card_balance_readback","gift_card"),command("reconcile",2)], runs([action("square.issue_gift_card","applied",1,[eq("reconciled","match")])])),
  check("customer_email_delivery", "Public replies reach the correct customer in the Zendesk twin's simulated mailbox (not live SMTP)", [req("customer_email_delivery"),pick("customer_email_delivery","original_payment")], runs([action("stripe.refund_original_payment","applied"),action("zendesk.refund_confirmation","applied")])),
];

const PRICES = { pro: { amount: 4900, interval: "month" }, credit_only: { amount: 4900, interval: "month" }, contract: { amount: 9900, interval: "month" }, non_refundable: { amount: 4900, interval: "month" }, annual: { amount: 120000, interval: "year" }, aged_annual: {amount:4900,interval:"year"} };
const PRODUCT_META = {
  pro: {},
  credit_only: { acme_refund_methods: "store_credit,gift_card" },
  contract: { acme_cancellation: "contract", acme_min_term_months: "12" },
  non_refundable: { acme_refundable: "false" },
  annual: {},
  aged_annual: {},
};

/** One Stripe customer + subscription + paid payment intent per check, on the session's Stripe twin. */
async function seed(legs, log, context) {
  const leg = legs.stripe;
  const call = async (path, form) => {
    const res = await fetch(`${leg.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const prices = {};
  for (const [kind, p] of Object.entries(PRICES)) {
    const meta = Object.fromEntries(Object.entries(PRODUCT_META[kind]).map(([k, v]) => [`metadata[${k}]`, v]));
    const product = await call("/v1/products", { name: `ACME ${kind.replace("_", " ")} plan`, ...meta });
    prices[kind] = (await call("/v1/prices", { product: product.id, unit_amount: String(p.amount), currency: "usd", "recurring[interval]": p.interval })).id;
  }
  const out = {};
  for (const [caseId, kind] of Object.entries(FIXTURES)) {
    const cus = await call("/v1/customers", { email: email(caseId), name: "Robin Example" });
    const sub = await call("/v1/subscriptions", { customer: cus.id, "items[0][price]": prices[kind] });
    const pi = await call("/v1/payment_intents", { amount: String(PRICES[kind].amount), currency: "usd", customer: cus.id, confirm: "true", payment_method: "pm_card_visa", "metadata[subscription_id]": sub.id });
    if (pi.status !== "succeeded" || !pi.latest_charge) throw new Error(`seed payment for ${caseId} is ${pi.status}`);
    out[caseId] = { customer: cus.id, subscription: sub.id, paymentIntent: pi.id, kind };
  }
  const zd = async (method,path,body) => {
    const r=await fetch(legs.zendesk.base_url+path,{method,headers:{authorization:`Bearer ${legs.zendesk.api_key}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const data=await r.json();if(!r.ok)throw new Error(`Zendesk fixture ${method} ${path}: ${r.status}`);return data;
  };
  const fingerprint = value => createHash("sha256").update(value.toLowerCase()).digest("hex");
  const providerCheck=(provider,collection,where,count=1)=>({provider,collection,assertion:{select:"records[*]",required:true,count,where}});
  for(const check of checks) {
    if(check.id!=="phone_request_opens_ticket") {
      const {ticket}=await zd("POST","/api/v2/tickets.json",{ticket:{subject:`Synthetic cancellation ${check.id}`,external_id:`fixture-${check.id}`,requester:{email:email(check.id),name:"Robin Example"},comment:{body:"Please cancel my subscription.",public:false},tags:["synthetic_cancellation"]}});
      for(const a of check.actions) {
        if(a.body?.input?.ticketId===TICKET)a.body.input.ticketId=ticket.id;
        if(a.provider_input) {a.provider_input.path=`/api/v2/tickets/${ticket.id}.json`;a.provider_input.body.ticket.comment.author_id=ticket.requester_id;}
      }
      if(out[check.id])out[check.id].ticket=ticket.id;
    }
    if(["store_credit_end_to_end","second_refund_refused","choice_read_from_customer_reply","store_credit_readback","prorated_credit_tier"].includes(check.id)) {
      const amount=check.id==="prorated_credit_tier"?4295:4900;
      check.provider_assertions=[providerCheck("stripe","customer_balance_transactions",[eq("customer",out[check.id].customer),eq("amount",-amount),eq("ending_balance",-amount),eq("currency","usd")]),providerCheck("stripe","customers",[eq("id",out[check.id].customer),eq("balance",-amount)])];
    }
    if(["gift_card_end_to_end","gift_card_balance_readback"].includes(check.id)) {
      check.provider_assertions=[providerCheck("square","gift_cards",[eq("id","{{step2.actions.1.ref}}"),eq("state","ACTIVE"),eq("balance_money.amount",4900),eq("balance_money.currency","USD")]),providerCheck("zendesk","simulated_email_deliveries",[eq("recipient_fingerprint",fingerprint(email(check.id))),eq("delivery_mode","simulated_mailbox"),{select:"body",required:true,contains:"Your gift card number is "},{select:"body",required:true,contains:"{{step2.actions.1.detail.ganLast4}}"}])];
    }
    if(check.id==="phone_request_opens_ticket") check.provider_assertions=[providerCheck("zendesk","tickets",[eq("id","{{step1.actions.0.ref}}"),eq("requester_id","{{step1.actions.0.detail.requesterId}}")])];
    if(check.id==="customer_email_delivery") check.provider_assertions=[providerCheck("zendesk","simulated_email_deliveries",[eq("recipient_fingerprint",fingerprint(email(check.id))),eq("delivery_mode","simulated_mailbox"),eq("status","delivered"),{select:"body",required:true,contains:"We've refunded $49.00"},{select:"body",required:true,contains:"That completes your cancellation."}])];

  }
  const aged=out.prorated_credit_tier;
  const stamp=Math.floor(Date.now()/1000)-45*86400;
  const result=await context.mcp.call("validate_integration",{session_id:context.sessionId,fixtures:{id:"cancellation-aged-purchase-45-days",steps:[{spec:"stripe",method:"POST",path:"/__fetchsandbox/fixtures/time",body:{resource:"payment_intents",id:aged.paymentIntent,field:"created",value:stamp}},{spec:"stripe",method:"GET",path:`/v1/payment_intents/${aged.paymentIntent}`,assertion:{select:"created",equals:String(stamp),count:1,required:true}}]}});
  if(!result.fixture?.ready)throw new Error(`Aged purchase setup not ready: ${JSON.stringify(result).slice(0,500)}`);
  log("aged purchase fixture", result.fixture.flow_run_id);
  log("seed", Object.keys(out).length, "customers, each with a subscription and a succeeded payment intent");
  return out;
}

export default {
  workflow: "product-cancellation",
  providers: ["stripe", "zendesk", "square", "slack"],
  seed,
  context: {
    goal: "Prove the product-cancellation AgentCore runtime: cancellation request (Zendesk ticket) → parallel ticket context, Stripe policy research, Square gift-card availability → acknowledgement, policy note, cancellation (exceptions gated), refund offer; the customer's choice → Stripe refund, Stripe store credit or Square gift card (large refunds gated) → confirmation on the ticket.",
    workflow: "POST /invocations {action:start, input.stage:request} researches and cancels or parks an exception; {action:start, input.stage:refund_choice} issues the chosen refund; {action:decide} approves or rejects gated actions. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  scope_review: checks.map(c => ({check_id:c.id,classification:"in_scope",reason:"Cancellation runtime behavior.",evidence:["acme-ops/src/workflows/product-cancellation.ts"]})),
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "unknown_customer_not_cancelled"],
    schema_and_value_boundaries: ["invalid_input_rejected", "method_not_offered_clarified"],
    amount_currency_quantity: ["large_refund_needs_approval", "prorated_credit_tier"],
    duplicate_replay: ["duplicate_start", "second_refund_refused"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "A refund choice is checked against the cancellation recorded on the Stripe subscription, never against the trigger alone; offers expire after 30 days (local tests).",
    delayed_or_missing_events: "The customer's reply arrives as its own trigger; nothing waits on a provider event.",
    provider_auth_and_scopes: ["stripe_auth_failure", "square_auth_failure"],
    rate_limit_server_error_timeout: ["zendesk_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "Ticket comments are found by their reference marker before posting, and the refund state on the subscription is written before money moves; covered by local tests.",
    partial_effects_and_recovery: ["zendesk_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["original_payment_end_to_end", "store_credit_readback", "gift_card_balance_readback"],
    cancellation_refund_entitlements: ["store_credit_end_to_end", "original_payment_end_to_end", "gift_card_end_to_end", "exception_approved", "exception_rejected", "no_refund_due"],
    data_and_privacy_boundaries: "Customer-facing replies are code-written templates; the gift card number goes only to the ticket, never to run state or Slack (local tests).",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/product-cancellation.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,zendesk,square,slack}.ts"],
};
