# Acme Reminders — Claude Code project rules

## Dispatch convention (HARD RULE)

This project uses the FetchSandbox dispatch convention. **Every
investigation or validation request MUST start with `./fetchsandbox`
followed by the actual ask.** Variant prefixes accepted:
`/fetchsandbox`, `@fetchsandbox`, `fs:`.

### When the user's prompt starts with a dispatch prefix

1. Call `mcp__fetchsandbox__guide` FIRST with the FULL original
   prompt (including the `./fetchsandbox` prefix) as the `intent`
   argument. The backend strips known prefixes during matching and
   records which variant was used for adoption telemetry.
2. Call `mcp__fetchsandbox__import_spec` to get a sandbox.
3. Call `mcp__fetchsandbox__run_workflow` with the brain's
   reproduce_with workflow + scenario.
4. Apply the fix using the brain's `fix_pattern` as the template.
5. Re-run to confirm. Two receipt URLs = before/after proof.

### Hard constraints

- **DO NOT write or run local test files.** No pytest, unittest.
- **DO NOT create a `.venv`.** The repo intentionally has no venv.
- **The ONLY acceptable proof artifact is a FetchSandbox receipt URL.**
- **DO NOT re-derive domain knowledge** the brain encodes.

## Output style

- One short sentence per line.
- Lead with the conclusion.
- Max 3 sentences per "thought" block before action.
- Inline-code only for literal tokens.
- No "I'll now apply the fix" preambles.
