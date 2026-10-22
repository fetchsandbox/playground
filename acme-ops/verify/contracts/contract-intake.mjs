import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for contract intake (LLM clause extraction under a
// code playbook, Kit v2 signals and timers). Box, OpenAI, Asana and Slack have
// FetchSandbox twins; DocuSign doesn't ("Unknown providers"). The checks state
// what a real model and a real e-signature service must make the runtime do;
// the receipt shows which of these FetchSandbox can support today.
const LEGAL = "C0LEGAL0001";
const input = (c, over = {}) => ({ contractId: `CTR-${c.replaceAll("_", "-")}`.slice(0, 44), boxFileId: "1", type: "nda", counterparty: { name: "Northwind", signerName: "Kim Lee", signerEmail: "kim@northwind.example" }, acmeSigner: { name: "Pat Legal", email: "pat@acme.example" }, requester: "U_SALES_REP", lawyers: ["U_LAWYER", "U_SALES_REP"], legalChannel: LEGAL, ...over });
const intake = (c, over) => start(c, input(c, over));
const id = (c, k) => `${k}:${input(c).contractId}`;

export const checks = [
  check("baseline", "An incoming contract is reviewed and the outcome posted to legal", [intake("baseline")], runs([action("slack.post_intake", "applied")])),
  check("text_extracted_from_box", "Box provides the document's extracted text", [intake("text_extracted_from_box")], runs([agent("clause-extraction", "ok")])),
  check("model_extracts_clauses", "The model returns the NDA's clauses as schema-valid JSON (a standard NDA is clean)", [intake("model_extracts_clauses")], runs([eq("output.mode", "clean")])),
  check("clean_nda_sent_for_signature", "A clean NDA is sent for signature without a lawyer", [intake("clean_nda_sent_for_signature")], runs([action(id("clean_nda_sent_for_signature", "docusign.send"), "applied")])),
  check("unusable_answer_goes_to_lawyer", "An unusable model answer is never trusted: a lawyer reviews", [intake("unusable_answer_goes_to_lawyer")], runs([eq("output.mode", "review"), action(id("unusable_answer_goes_to_lawyer", "legal.approve"), "awaiting_signal")])),
  check("requester_cannot_approve", "The person who asked for the contract can't approve its deviations", [intake("requester_cannot_approve", { type: "msa" }), command("signal", 1, { actionId: id("requester_cannot_approve", "legal.approve"), value: "approve", userId: "U_SALES_REP" }, 403)], runs([action(id("requester_cannot_approve", "legal.approve"), "awaiting_signal")])),
  check("msa_lawyer_approval_sends", "A lawyer's approval of an MSA sends it for signature", [intake("msa_lawyer_approval_sends", { type: "msa" }), command("signal", 1, { actionId: id("msa_lawyer_approval_sends", "legal.approve"), value: "approve", userId: "U_LAWYER" })], runs([action(id("msa_lawyer_approval_sends", "docusign.send"), "applied")])),
  check("unsigned_envelope_voided", "An envelope unsigned after 30 days is voided (needs clock control)", [intake("unsigned_envelope_voided"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(id("unsigned_envelope_voided", "docusign.void_if_unsigned"), "applied")])),
  check("openai_overloaded_goes_to_lawyer", "When the model is overloaded, a lawyer reviews instead", [intake("openai_overloaded_goes_to_lawyer")], all(runs([agent("clause-extraction", "failed"), eq("output.mode", "review")])), { fault: { provider: "openai", scenario: "model_overloaded", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed contract id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), contractId: "nda for northwind" }, { expectStatus: 400 })], runs([], 0)),
];

export default {
  workflow: "contract-intake",
  providers: ["box", "openai", "asana", "slack"],
  context: {
    goal: "Prove the contract-intake AgentCore runtime: a counterparty NDA or MSA in Box → extracted text → OpenAI clause extraction (JSON, fenced contract text) → code playbook (governing law, NDA term, liability cap, forbidden clauses, every MSA to a lawyer) → clean NDAs to DocuSign, deviations to a lawyer who isn't the requester; signature chased on day 3 and 7, voided after 30 days; renewal reminder once signed.",
    workflow: "POST /invocations {action:start}; {action:signal} for legal approval; {action:tick} fires chases, voiding and the renewal reminder. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["requester_cannot_approve"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unusable_answer_goes_to_lawyer"],
    amount_currency_quantity: "Liability caps are compared as multiples of fees by code (local tests).",
    duplicate_replay: "Envelopes are found by external id before sending (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: "A signed or declined envelope stops the chase (local tests).",
    delayed_or_missing_events: ["unsigned_envelope_voided"],
    provider_auth_and_scopes: ["openai_overloaded_goes_to_lawyer"],
    rate_limit_server_error_timeout: ["openai_overloaded_goes_to_lawyer"],
    accepted_effect_response_loss: "Envelope creation is looked up by external id first.",
    partial_effects_and_recovery: ["msa_lawyer_approval_sends"],
    restart_and_durability: "Timers survive restarts (Kit v2 tests).",
    reconciliation: "Envelope status is re-read before each timed step.",
    cancellation_refund_entitlements: ["clean_nda_sent_for_signature"],
    data_and_privacy_boundaries: ["text_extracted_from_box", "model_extracts_clauses"],
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/contract-intake.ts", "acme-ops/test/contract-intake.test.ts"],
};
