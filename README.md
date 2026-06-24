# FetchSandbox Playground

> **Open-source test project for [FetchSandbox](https://fetchsandbox.com).**
> 5 brownfield apps with planted bugs in real API integrations. Run them
> against your agent, write up what you found, open a PR. Merged PRs
> appear on your GitHub contribution graph and in the
> [contributors](https://github.com/fetchsandbox/playground/graphs/contributors)
> list.

Clone, run, point your agent at it, see whether FetchSandbox catches the bug.

## What's in here

| App | Stack | What's broken |
|---|---|---|
| [apps/stripe](apps/stripe) | FastAPI + Stripe SDK | Webhook dedup uses the wrong header — same event gets processed 2–3x on retry. |
| [apps/resend](apps/resend) | FastAPI + Resend webhooks | Handler only listens for `email.delivered`. Bounces + complaints silently dropped; users stay "active" after bouncing. |
| [apps/clerk](apps/clerk) | FastAPI + Clerk auth | Session token validation skipped on one endpoint. |
| [apps/agentmail](apps/agentmail) | FastAPI + AgentMail | Inbox webhook handler ignores `message.received` events when the body has attachments. |
| [apps/surge](apps/surge) | FastAPI + Surge messaging | Outbound SMS retry on rate-limit hits an off-by-one and re-sends to the wrong number. |

Each app is ~50–150 lines of Python, runs locally in seconds.

## How to run

Pick an app, e.g. stripe:

```bash
git clone https://github.com/fetchsandbox/playground.git
cd playground/apps/stripe
pip install -r requirements.txt
uvicorn main:app --reload
```

Open the project in [Cursor](https://cursor.com), [Claude Code](https://docs.anthropic.com/claude/docs/claude-code),
or any MCP-capable editor. The `.mcp.json` in each app folder is already
wired to FetchSandbox.

Then ask your agent:

```
./fetchsandbox we have a stripe webhook bug — payments getting marked paid 2-3 times. fix it with proof.
```

The agent will call FetchSandbox's brain, pick a workflow, run it, and
hand back a receipt URL. That's the proof artifact.

Each app's README has the suggested prompt + expected outcome.

## How to contribute findings

1. **Fork** the repo on GitHub.
2. **Create a branch** named for yourself, e.g. `jane-doe/stripe`.
3. **Copy** [FINDINGS_TEMPLATE.md](FINDINGS_TEMPLATE.md) into the
   `findings/` folder. Name your file using the pattern:
   ```
   findings/<YYYY-MM-DD>-<app>-<your-github-username>.md
   ```
   e.g. `findings/2026-06-24-stripe-jane-doe.md`.
4. **Fill it in** with the prompt, the agent's tool-call sequence, the
   receipt URLs you got back (or "none" if the agent never produced any),
   the bug + fix, and an honest 1–10 rating of the brain. See
   [findings/EXAMPLE-2026-06-24-stripe-example-contributor.md](findings/EXAMPLE-2026-06-24-stripe-example-contributor.md)
   for the shape.
5. **Open a PR** against `main`. Once merged it shows up on your GitHub
   contribution graph and on the
   [contributors](https://github.com/fetchsandbox/playground/graphs/contributors)
   page.

**Filename pattern matters** — the `<date>-<app>-<username>` shape makes
contributor diversity visible at a glance and keeps date/app/author
searchable. PRs that don't follow the pattern will be asked to rename
before merge.

What we want to learn:
- Did the brain match the right bug pattern?
- Was the receipt URL convincing as proof, or did it feel hand-wavy?
- What did your agent do well / badly?
- What was missing?

**Honest negative findings are more valuable than green-checkmark ones.**
If your session failed or the receipt was misleading, write that up — that's
the most useful PR you can ship.

## License

MIT — fork it, modify it, plant your own bugs.
