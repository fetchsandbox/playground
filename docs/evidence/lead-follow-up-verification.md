# Lead follow-up — verification status

**Pacific date:** 2026-11-14  
**App path:** `acme-ops` workflow `lead-follow-up`  
**Branch work:** HubSpot contact+Deal, Gmail send with Message-ID reconcile, three confirmation lookups, Calendar gated on confirmed email, Slack completion/handoff.

## Agreed contract (app-authored)

Executable contract: [`acme-ops/verify/contracts/lead-follow-up.mjs`](../../acme-ops/verify/contracts/lead-follow-up.mjs).

| Check ID | Expected business outcome |
|---|---|
| `baseline` | Contact upserted, one Deal, one email, calendar booked, Slack completion; handoff skipped |
| `duplicate_start` / `concurrent_start` / `refired_lead_adopts_deal` | One Deal and one email per leadId |
| `invalid_input_rejected` | Bad email → HTTP 400, no agents |
| `reconcile_contact_and_deal` | HubSpot read-back matches |
| `hubspot_auth_failure` | No CRM writes; Slack blocked-step notice |
| `gmail_auth_failure` / `gmail_direct_send_rejected` | Deal may exist; no calendar |
| `gmail_lost_send_response` | Timeout recovered via Message-ID; still one email + calendar |
| `calendar_rate_limited` | Email confirmed; calendar fails; Slack handoff |
| `slack_not_in_channel` | Calendar applied; completion post fails (partial) |
| `restart_while_waiting` | Restart preserves run; completes |
| `live_inbox_delivery` | **Blocked** — twin Sent read-back ≠ real inbox |
| `gmail_lookup_unavailable_no_resend` | **Blocked / local-only** — needs twin send-count observer |

Providers discovered via FetchSandbox MCP `0.7.30`: `hubspot`, `gmail`, `google-calendar`, `slack`. Applicable faults used above include `deal_accepted_response_loss`, `direct_send_accepted_response_loss`, `direct_send_rejected`, `auth_failure`, `rate_limited`, `not_in_channel`.

## What actually ran

| Layer | Result |
|---|---|
| Local vitest `test/lead-follow-up.test.ts` | **9 passed** (fake-world twins) |
| FetchSandbox MCP tool discovery | **19 tools** observed (`validate_integration`, `manage_tunnel`, `install_test_credentials`, …) |
| Anonymous `validate_integration` session | Twins created; matrix listed; `authenticated_session: false` |
| Protected `application_context` / suite execute | **Blocked** — device auth required (`FETCHSANDBOX_API_KEY` / `~/.fetchsandbox/credentials.json` missing) |
| `node verify/relay-proof.mjs lead-follow-up` | **Not run** — same auth blocker |

## Receipt

No owned FetchSandbox receipt URL yet. Anonymous sessions cannot be upgraded; after sign-in a **fresh** owned session must run `relay-proof.mjs`.

## Remaining limits

- No live HubSpot / Gmail / Calendar / Slack customer traffic (by request).
- Twin email proof ≠ SMTP inbox delivery (`live_inbox_delivery` blocked).
- Catalog / generated business guide omitted until a saved receipt exists (`export-docs` skips workflows without `verify/receipts/<id>.json`).
