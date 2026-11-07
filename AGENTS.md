# Coding agents: use verification as the default development loop

Applies to every workflow and integration in this repository. Read the selected
workflow's README/business guide before editing it. These are development
instructions; they do not add FetchSandbox calls to a deployed runtime agent.

## Plan the builder experience before implementation

For every new workflow or builder integration, make the intended user journey an
explicit first milestone and final acceptance gate: one user request -> actual
app/workflow builder agent -> FetchSandbox MCP contract -> protected isolated
bindings -> FetchSandbox-driven execution -> independent effects -> retained
receipt. Use the same MCP pattern across Claude, Replit, n8n and other builders;
do not replace it with a separate workflow-specific verification engine.

The behavioral contract must include the happy path, the customer's requirements
and every applicable default production-risk dimension discovered through MCP.
The customer should not have to enumerate standard failure cases. Preserve typed
blocked/unmeasured requirements when controls or observations are unavailable.

Before building components, record who proposes/freezes the contract, who starts
and polls execution, how the real runtime is invoked repeatedly, and what exact
receipt proves the journey. A manually armed webhook, hand-written helper or
scripted control can establish a bounded component result, but cannot satisfy
native builder/client acceptance. Qualify the authenticated repeatable trigger
and existing MCP lifecycle before treating the integration as delivered. Keep
component, application and builder-journey milestones distinct in the plan.

## Establish the business contract first

1. Identify the workflow, business purpose, input/trigger, actual agents, providers,
   writes, eligible customer/tenant, policy rules and approval boundary from code.
2. Read its existing contract and receipt. Keep the original check IDs and failed,
   blocked or unmeasured cases visible. A saved receipt is historical evidence.
3. Discover the connected FetchSandbox MCP tools and current provider capabilities.
   Use the returned tool schemas; do not invent tool names, provider support,
   credentials, fixture controls or success results. Setup: https://fetchsandbox.com/mcp.
4. Have the app-owning coding agent propose the contract from the inspected app.
   Review happy path, invalid input/identity, duplicates, concurrency, policy and
   approval paths, encountered provider faults, partial effects, recovery/restart
   and saved-state reconciliation. Explain non-applicability; do not expand the
   app's business scope just to satisfy a generic checklist.
5. Before writes, bind isolated twins/test credentials through the supported
   private handoff. Never print/commit keys or point verification at live accounts.
   A missing setup/capability/observation is a blocker, not a passing check.

## Verify the real integration, then fix and remeasure

- Use FetchSandbox by default for changes affecting provider calls, business
  rules, ownership, approvals, retries, persistence or customer communication.
  Use the existing package runner where available; see docs/VERIFICATION.md.
- Run the actual app and use public app entry points. Observe durable app state
  and provider state independently. A 200 response, applied-action flag, public
  ticket comment or model's explanation is not sufficient evidence of the final
  business effect. Distinguish a draft, a send, simulated delivery and live delivery.
- For an alleged fix, capture the failing behavior before the change where feasible,
  implement a narrow fix, and rerun the same contract. If setup, assertions or
  contract scope changed, record that explicitly; do not call it a same-contract proof.
- Do not seed answers, weaken assertions, remove failures, silently substitute
  another app or manufacture receipts. Keep twin, local, deployed and native-client
  acceptance evidence separate. Do not claim every production scenario is covered.
- Do not run paid/live-provider actions, expose verifier routes publicly, deploy,
  merge or message customers solely because this file suggests verification.
  Follow the human's scope and existing permissions.
- If MCP/authentication/relay access is unavailable, continue useful local checks
  and report the exact blocker and attempt. Do not claim FetchSandbox verification.
- Documentation-only edits need documentation/link/drift checks; they do not need
  a new provider run. Explain that exemption in the PR.

## Finish with reviewable evidence

Report changed scope, app commit/version, contract and test commands, measured
counts (including failures/skips/unmeasured), receipt URL, exact deployment status
and remaining limits. Never commit private credentials, tokens, mailbox bodies or
customer records. Add or update the business guide and sanitized evidence record.

These instructions guide compatible coding agents; they cannot force every
client to load them. Cursor's always-on rule and CLAUDE.md point here. CI checks
business-guide drift; it does not impersonate a native agent or assert a fresh
integration pass. New workflows must follow docs/WORKFLOW_TEMPLATE.md.
