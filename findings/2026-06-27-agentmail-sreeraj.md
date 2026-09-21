# agentmail — 2026-06-27

**Prompt:** `./fetchsandbox we got a fake customer message via the agentmail webhook — audit our integration`

**Agent / IDE:** Claude Code (Opus 4.8), MCP via `.mcp.json` in `apps/agentmail/`.

**Receipt URLs:**

- Before: https://fetchsandbox.com/runs/17a2283450?flow=run_a6e75a89-dd3c-48d1-b029-e5fe7db99931
- After: https://fetchsandbox.com/runs/17a2283450?flow=run_b69ec7e1-26ed-484c-aa06-bca1c5703ada

## What happened
Followed the usual FetchSandbox path by stripping the prefix and calling guide first. The initial confidence was lower than the threshold, was 0.6. Called spec multiple times and accessed source code meanwhile.
Agent actually identified the bug immediately rather than going with the workflow.

Agent identified the issue in `main.py` :  the webhook endpoint accepted `svix_signature` but never called `Webhook.verify()`. Any HTTP client could POST a crafted `message.received` payload and inject arbitrary messages into any ticket thread.

The importspec was not good as there were 3 attempts to find the correct spec, also tried alt spec URLs before finding the correct slug. After importing the specification, it selected the `inbox_create_and_subscribe_webhook` workflow and generated a valid **before** receipt.

The agent updated `main.py` by importing `Webhook` and `WebhookVerificationError` from the Svix SDK. The webhook handler was modified to validate the body of the request using the `svix-id`, `svix-timestamp`, and `svix-signature` headers before handling the payload and returned an HTTP 400 in case of failed validation. The workflow was then re-executed after the fix and **after** receipt was obtained.

As part of the audit, the brain revealed another architectural problem that was not fixed intentionally during this session: the ticket creation provisioned an AgentMail inbox but did not create any webhook subscription scoped by the inbox, which leads to an organization-wide webhook that can receive cross-tenant events.

## Brain quality rating

**8/10**


There were only a low 0.6 confidence at the start, even though the prompt cleatly said webhook there were several attempts to find the correct spec, accessed the source code earlier than what the dispatch convention said. Despite, the workflow was followed and overall control was within the Sandbox. Found the bug instantly.

But the brain managed to select the right specification, chose the appropriate workflow, created before/after URLS of receipt, and checked that the security fix was indeed implemented. Contrary to the Clerk analysis, in this case, the workflow matched the vulnerability and produced useful artifacts.


## Did FetchSandbox earn its place?

**Yes.**

FetchSandbox remained central throughout the investigation. It provided the workflow, produced verifiable before/after receipts, validated the fix through the sandbox, and highlighted an additional architectural weakness regarding inbox-scoped webhook subscriptions that would likely have been missed during a simple local code review.

## What surprised you
1. low initial confidence.
2. several attempts to fingure out the workflow.
3. recovery was good and selected the right workflow (rather than what happend with the clerk).
4. identified an architectural issue (bonus)

