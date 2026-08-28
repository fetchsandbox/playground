# FetchSandbox Playground

> **Open-source test project for [FetchSandbox](https://fetchsandbox.com).**
> Brownfield apps with planted bugs in real API integrations — plus a
> greenfield app to wire an integration from scratch. Run them
> against your agent, write up what you found, open a PR. Merged PRs
> appear on your GitHub contribution graph and in the
> [contributors](https://github.com/fetchsandbox/playground/graphs/contributors)
> list.

Clone, run, point your agent at it, see whether FetchSandbox catches the bug.

**👉 New here? Start with [TESTING.md](TESTING.md)** — a 20-minute, two-task test drive (prove a fresh integration + catch a planted bug).

## What's in here

| App | Stack |
|---|---|
| [apps/stripe](apps/stripe) | FastAPI + Stripe SDK |
| [apps/resend](apps/resend) | FastAPI + Resend webhooks |
| [apps/clerk](apps/clerk) | FastAPI + Clerk auth |
| [apps/agentmail](apps/agentmail) | FastAPI + AgentMail |
| [apps/surge](apps/surge) | FastAPI + Surge messaging |
| [apps/descope](apps/descope) | FastAPI + Descope agentic auth |
| [apps/descope-onboarding](apps/descope-onboarding) | FastAPI + Descope (greenfield — auth is a placeholder) |
| [apps/hubspot](apps/hubspot) | FastAPI + HubSpot CRM v3 |

Every app except `apps/descope-onboarding` is a brownfield integration with a
planted bug — what the bug is, is for you (and your agent) to discover.
`apps/descope-onboarding` is the greenfield case: nothing is broken there, the
task is to wire the integration from scratch.

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
./fetchsandbox something's off with our stripe integration — investigate, fix it, and prove it.
```

The agent will call FetchSandbox's brain, pick a workflow, run it, and
hand back a receipt URL. That's the proof artifact.

Each app's README describes what the app does and how to run it.

## Send us back what you saw

1. **Fork the repo:** [github.com/fetchsandbox/playground/fork](https://github.com/fetchsandbox/playground/fork) (one click).
2. After running the demo, paste this to your agent:

   ```
   save my session as a findings markdown file at findings/<today's date>-<app>-<my-github-username>.md, commit on a new branch named for me, push to my fork.
   ```

   The agent writes the file from the session it just ran and pushes the branch to your fork.
3. **Open a PR** from your fork against `main` on this repo.

Prefer to do it by hand? Copy [FINDINGS_TEMPLATE.md](FINDINGS_TEMPLATE.md)
into `findings/` in your fork, fill it in, commit, push, PR.

Honest "it didn't work" is more useful than a green-checkmark write-up.

Merged PRs appear on your GitHub contribution graph and on the
[contributors](https://github.com/fetchsandbox/playground/graphs/contributors)
page.

## License

MIT — fork it, modify it, plant your own bugs.
