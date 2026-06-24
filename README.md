# FetchSandbox Playground

5 small brownfield apps with planted bugs in real API integrations.
Clone, run, point your agent at it, see whether [FetchSandbox](https://fetchsandbox.com)
catches the bug.

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

## How to send feedback

Tried it? **Open a GitHub issue** at
[github.com/fetchsandbox/playground/issues/new](https://github.com/fetchsandbox/playground/issues/new)
with [FEEDBACK.md](FEEDBACK.md) filled in. Takes 2 minutes.

What we want to learn:
- Did the brain match the right bug pattern?
- Was the receipt URL convincing as proof, or did it feel hand-wavy?
- What did your agent do well / badly?
- What was missing?

Honest negative feedback is more useful than green-checkmark feedback.

## License

MIT — fork it, modify it, plant your own bugs.
