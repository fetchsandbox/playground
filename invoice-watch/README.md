# invoice-watch

BDK playground agent: **Gmail invoice → Google Calendar cancel reminder + Slack alert**.

## Flow

1. Trigger from a pasted email, a Slack mention, or the `poll-invoices` schedule.
2. Extract merchant, amount, renewal / cancel-by dates.
3. Dedupe with `check_invoice_processed` / `record_processed_invoice` (`ctx.host.kv`).
4. Create a Calendar reminder and post a Slack message via Cursor account MCP connectors.

## Setup

```bash
cd invoice-watch
npm install
npx @cursor/bdk login
```

In the Cursor MCP dashboard, connect **Gmail**, **Google Calendar**, and **Slack**.

Optional inbound Slack bot (channel mounts idle without tokens):

```bash
npx @cursor/bdk slack create --dir . --name "Invoice Watch"
```

## Run

```bash
npx @cursor/bdk validate --dir .
npx @cursor/bdk info --dir . --json
npx @cursor/bdk dev --dir .
# Playground: http://127.0.0.1:3000/playground
```

Sample prompt (also seeded at `bot/sandbox/workspace/sample-invoice.txt`):

```text
Process this subscription invoice: create a cancel reminder and Slack alert.

From: billing@notion.so
Subject: Your Notion invoice for $29.00
Body: Invoice INV-1001. Amount $29.00 USD. Next renewal 2026-11-15.
```

### Dry-run

Stub write tools (authored + MCP writes) while keeping reads live:

```bash
npx @cursor/bdk run --dir . --dry-run --message "Dry-run: process sample-invoice.txt and show Calendar + Slack payloads."
```

Use this path before pointing FetchSandbox twins at the same workflow.

## Schedules

`bot/schedules/poll-invoices.md` runs every 4 hours in production serve /
hosted deploys. Under `--dev`, dispatch manually:

```bash
curl -X POST http://127.0.0.1:3000/invoice-watch/v1/dev/schedules/poll-invoices
```

## Checks

```bash
npm run check
npx @cursor/bdk eval --dir . --list
npx @cursor/bdk eval --dir . --tag smoke
```
