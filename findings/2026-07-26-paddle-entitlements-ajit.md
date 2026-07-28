# Paddle 03-entitlements — 2026-07-26

**Prompt:** ./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code

**Agent / IDE:** Claude Code

**Receipt URLs:**
- Before fix (subscription_lifecycle 7/7): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_5d72860e-3275-456d-94e6-fede11a27335
- After fix (subscription_lifecycle 7/7 + proof attached): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_f7ea340f-ad11-41e2-bd41-6734cf437af8

**What happened:**

End-to-end audit of `main.py`. The Paddle lifecycle workflow ran 7/7 at the
API layer, but code inspection + proof probes found 4 bugs in the webhook
handler and entitlement gate.

**Four bugs fixed in `main.py`:**

1. **Wrong status on `subscription.created`** — was hardcoding `"created"` as
   the status; fixed to `data.get("status", "active")`. A subscription that
   Paddle creates with `status: "active"` (no trial) was stored as `"created"`,
   making `GET /entitlements/{id}` return `entitled: false` indefinitely.

2. **Missing `subscription.trialing` handler** — Paddle fires this event for
   trial subscriptions; without a handler, trialing subs were never tracked in
   memory. Added handler that upserts with `status: "trialing"`.

3. **Entitlement excludes trialing users** — the gate checked `status != "active"`
   only. Trialing users have full product access and should be entitled. Fixed
   to `status not in ("active", "trialing")`.

4. **Out-of-order `subscription.activated` silently dropped** — the handler
   guarded with `if sid in subscriptions`, so an `activated` event arriving
   before `created` (Paddle doesn't guarantee ordering) was a no-op. Fixed to
   upsert: fetch existing record or build a minimal one, set status, and write
   back — safe regardless of delivery order.

**Honest limits before you ship:**
- No persistence across restarts — subscriptions dict is in-memory only.
- No webhook signature verification — any caller can POST to `/webhook`.
- No deduplication — duplicate `subscription.activated` events will double-upsert (harmless here, but a signal to add idempotency keys).
- No `subscription.updated` handler — status changes (paused, past_due) won't be reflected.
