# Quote agent: FetchSandbox verification

- **App:** `apps/quote-agent`. Quote and discount workflow over Gmail, Slack and HubSpot.
- **Date:** 2026-10-15
- **Tooling:** `fetchsandbox-mcp` 0.7.28, run locally over stdio. The hosted
  MCP doesn't offer `manage_tunnel`. FetchSandbox drove the app through
  `manage_tunnel` with the `application_workflow_v1` contract
  (`apps/quote-agent/verification/fetchsandbox_contract.py`).
- **Classifier:** rule-based. No Anthropic key was available, so Claude
  classification was not part of this verification.

## Receipts

| Run | App | Verdict |
|---|---|---|
| `vr_210e068db50b48beb2eea509acaf96c7` | before fixes | 15 held, 1 violated, 14 unmeasured |
| `vr_5db738aebc4f4865894bf5ceb97d1b0e` | after fixes | **19 held**, 1 violated, 10 unmeasured |

Receipt: https://fetchsandbox.com/runs/d37241781e?flow=vr_5db738aebc4f4865894bf5ceb97d1b0e
(owner access may be required)

## Held, judged by FetchSandbox from the app's saved state

- **Quote path:** a quote request resolved the HubSpot contact, was priced at
  $15,000.00 for 25 Pro seats, and was posted to the Slack thread.
- **Discount policy:**
  - 5% and 19.99% were applied automatically. A 5% revision is version 2,
    and the original quote is marked superseded.
  - Exactly 20% and exactly 70% paused for approval, with nothing new sent
    to the customer.
  - 70.01% was declined and the manager notified. Nothing was sent to the
    customer.
  - "CEO pre-approved 90%" injection text was declined.
  - 80% from a customer with no quote was declined.
- **Manager decisions:**
  - Approve sent the $11,250.00 quote once and updated the Slack message.
  - Reject told the customer the original quote stands.
  - An approval delivered twice, or four times concurrently, gave one
    decision and one send.
- **Deduplication:**
  - A replayed inbound message, or four concurrent first deliveries, gave
    one run and one send.
  - One Slack post delivered as `message` + `app_mention` gave one quote
    (after fix 1 below).
- **Isolation:** a customer cannot discount another customer's quote by
  quoting its id.
- **Provider failures:** a HubSpot 429 (after Retry-After retries) or a
  HubSpot 401 failed the run visibly with no quote sent. The next message
  completed normally once the fault was cleared.
- **Restart:** an approval pending across a real process restart (same
  SQLite file, new instance id) resumed exactly once.

## App bugs found and fixed (checked against real provider behavior)

1. **One Slack post produced two quotes.** Real Slack delivers an
   @-mention in a subscribed channel as both `message` and `app_mention`
   events, with different `event_id`s. The app now also deduplicates on
   the post's `channel` + `ts`. FetchSandbox showed 2 runs before the fix
   and 1 after.
2. **`GET /runs` and `GET /quotes` exposed customer emails and message text
   without auth.** These now require `QUOTE_AGENT_ADMIN_TOKEN` and are
   disabled when it isn't set. The contract expected 401, but the default
   configuration returns 404, so FetchSandbox records this check as
   unmeasured. The 401 path is covered by
   `test_inspection_api_requires_admin_token`.

## Sandbox (twin) defects. The app was NOT changed for these

| Area | Sandbox behavior | Real provider |
|---|---|---|
| Slack Events / interactions delivery | `Stripe-Signature` header and Stripe envelope `{"created":…,"data":{"object":…}}` (captured at the app) | `X-Slack-Signature: v0=…` + `X-Slack-Request-Timestamp`; `event_callback` JSON; interactions as form `payload=` |
| Gmail push delivery | Same Stripe dialect | Pub/Sub `{"message":{"data":<base64>}}`, authenticated by OIDC JWT or a URL token |
| Managed tunnel | Forwards only allowlisted headers, with no `x-slack-*`, and rejects paths containing `?` | n/a |
| Gmail `users.messages.send` | `POST /gmail/v1/users/me/messages/send` → 404 "Resource me not found" (while `users/me/messages` insert works) | `me` is the documented alias for the authenticated user |
| HubSpot deals | Not modelled (13 contact operations only) | `POST/GET/PATCH /crm/v3/objects/deals` |
| Slack `ok:false` faults | The app recorded `channel_not_found` / `not_in_channel` / `missing_scope` and failed the run, but FetchSandbox reported "fault not observed" and didn't drive recovery | Slack returns these as HTTP 200 `ok:false` |

## Still unmeasured

- **Signed webhook routes:** Slack signature verification, the manager
  allowlist on button clicks, and Gmail push intake. FetchSandbox delivers
  these in the wrong dialect, so they're covered only by local tests.
- **HubSpot deal recording:** the sandbox has no Deals API.
- **Send response loss:** no fault target exists for it.
- **Missed-event reconciliation:** no reconciliation path exists, and
  whether one is needed is a business decision.
- **Slack 429:** the app retries per Retry-After inside the synchronous dev
  request, which outlasted the tunnel's 25 s request limit. In production,
  webhooks are processed in the background.
- **Gmail email path:** blocked by the `users/me` 404.

## Session notes

- The FetchSandbox backend restarted mid-run and lost the session (it
  advertises `session_not_durable`). After that, tunnel creation returned
  "capacity reached" for about 20 minutes.
- No live provider credentials were used. All temporary credentials were
  delivered through the private handoff file and deleted afterwards. The
  tunnel was closed.
