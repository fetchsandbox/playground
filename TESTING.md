# Test drive — 20 minutes, no accounts or keys

Thanks for kicking the tires. You'll use the **FetchSandbox MCP** from your IDE
to run two real tasks against a Descope integration, then tell us what you saw.
No Descope account, no API keys — everything runs against FetchSandbox's hosted
sandboxes.

For enterprise workflows, use the [business catalog](docs/WORKFLOWS.md) and [verification guide](docs/VERIFICATION.md). This exercise is separate from their saved receipts.

## Setup

1. **Fork + clone** this repo, open it in **Cursor** or **Claude Code** (or any
   MCP-capable editor).
2. Each app has a `.mcp.json` already wired to FetchSandbox. Confirm the
   `fetchsandbox` server is **connected** (in Claude Code: `/mcp`).

> Follow the current [MCP setup/authentication instructions](https://fetchsandbox.com/mcp). FetchSandbox authentication may be required; this is separate from obtaining live provider credentials. Record setup blockers rather than treating them as app failures.

## Task 1 — Fresh integration (greenfield)

**App:** [`apps/descope-onboarding`](apps/descope-onboarding) — "Acme Notes",
a tiny app with a placeholder login and no real auth yet.

Paste to your agent:

```
./fetchsandbox I'm adding Descope OTP sign-up to this app — prove the Descope OTP + session flow in the sandbox before writing any code, then propose the diff. I'll decide whether to apply.
```

**What to watch for:**
- Did it **prove the flow first** — run the workflow, hand back a **receipt URL** — *before* writing any code?
- Did it surface useful **compliance notes** (verify the session JWT, handle refresh, one-time OTP)?
- Was the proposed diff sane for this app?

## Task 2 — Find the bug (brownfield)

**App:** [`apps/descope`](apps/descope) — "Agent Gateway", where AI agents
exchange a Descope access key for a scoped session. Something in this
integration is wrong. Go in cold — don't read ahead, don't guess: let the agent
investigate and see what it turns up.

Paste to your agent:

```
./fetchsandbox something's off with this descope integration — investigate it, fix whatever is wrong, and prove it.
```

**What to watch for:**
- Did it **investigate the actual code** rather than assume a failure mode?
- Did it **reproduce** what it claims is wrong, instead of just asserting it?
- Did it **prove it with a receipt URL** *before* writing any fix code?
- Does the proof show **buggy vs fixed** on **Descope routes** (`/v1/...`)?
- If it found nothing, did it say so honestly — or invent something?

## What we most want to know (be blunt)

- Did `npx fetchsandbox-mcp` actually **connect and call tools cleanly** in *your* IDE?
- Did it **catch the bug** / **prove the integration**, or fall flat?
- Anything **broken, confusing, slow, or fake**?

Honest "it didn't work" is far more useful to us than green checkmarks.

## Send it back

Copy [`FINDINGS_TEMPLATE.md`](FINDINGS_TEMPLATE.md) into `findings/<your-name>.md`,
fill it in (paste your agent's session, the receipt URLs, and your honest
reactions), then **open a PR**. That's your report — and merged PRs show up on
your GitHub contribution graph + the contributors list. 🙏

If something blocks you completely (MCP won't connect, a step errors out), stop
and open the PR with what you got. A partial report is still gold.
