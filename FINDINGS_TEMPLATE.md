# Findings Template

Copy this file to `findings/<YYYY-MM-DD>-<app>-<your-github-username>.md`,
fill it in, commit on a branch named for yourself, open a PR.

Example: `findings/2026-06-24-stripe-jane-doe.md` on branch `jane-doe/stripe`.

The filename pattern matters — it makes contributor diversity visible at a
glance and keeps date/app/author searchable.

---

# <app> — <YYYY-MM-DD>

## Prompt you sent

> ./fetchsandbox ...

## Agent / IDE

(Claude Code / Cursor / Cline / Windsurf / Codex / other — model + version if you know them)

## Tool-call sequence

What your agent did, in order. Brief is fine — 5–10 lines.

1.
2.
3.

## What the brain returned (mcp__fetchsandbox__guide)

- spec:
- workflow:
- scenario:
- intent_class:
- bug_pattern matched:
- confidence:

## Receipt URLs surfaced

- before:
- after:

(If none surfaced, write "none" — that itself is signal.)

## What the agent identified as the bug

In your agent's own words, then your translation if the wording is dense.

## What the agent's fix was

Concrete diff or 2–3 bullet description.

## Brain quality rating (1–10)

Score + 2–3 sentences. Honest negative ratings are more useful than
green-checkmark ratings.

## Did FetchSandbox earn its place in this session?

Yes / Partial / No — with one paragraph of justification. Would a plain
grep + read + edit have reached the same answer without it?

## Specific suggestion for brain.yaml for this spec

(Optional but appreciated.)

- id:
- symptoms:
- reproduce_with workflow + scenario:
- check_for items:

## What surprised you

(Optional but appreciated. The unexpected stuff is often the most valuable.)
