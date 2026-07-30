date / hours: 2026-07-30 / ~1.5h
tested today (specs / apps / flows): stripe-paddle / Apex Billing / accept_payment, refunds_succeeded

worked well:
- Both planted bugs found from code read when guide returned confidence 0
- Bug 2 (double-charge guard) proven live — real 400 from running app after webhook activation
- submit_proof attached app-layer before/after to a receipt URL
- Stripe sandbox workflows (accept_payment, refunds_succeeded) ran clean

broke (one block per issue):
- prompt i typed: ./fetchsandbox there are few bugs in this app, i want to find them and fix, give me fetchsandbox receipt
- spec / app: stripe-paddle / Apex Billing
- expected vs what happened: guide should match a bug pattern and route to the right workflow. Got confidence 0, no spec candidates, no matched_bug_pattern — fell back to manual code read
- receipt URL (if any): none from guide
- severity: S2 major

- prompt i typed: (pay endpoint called against FetchSandbox Stripe proxy)
- spec / app: stripe / Apex Billing /subscriptions/{id}/pay
- expected vs what happened: Stripe SDK should call through FetchSandbox sandbox proxy. Got SSL error (Netskope TLS intercept), then 401 unknown API key — proxy requires FetchSandbox-issued credentials, not sk_test_demo
- receipt URL (if any): none
- severity: S2 major

- prompt i typed: (stripe-webhook fired to activate subscription)
- spec / app: stripe-paddle / Apex Billing /stripe-webhook
- expected vs what happened: webhook should verify signature and process event. Got 500 — Stripe SDK v9+ StripeObject dropped .get() method, code called obj.get("subscription", "") which blew up
- receipt URL (if any): none
- severity: S2 major

friction / confusing / slow:
- Stripe sandbox receipts (accept_payment, refunds_succeeded) looked like proof but tested the wrong layer — Stripe API directly, not the app endpoints. Took a user callout to surface this
- submit_proof graded self_reported because FetchSandbox can't reach localhost — no path to a green receipt without a deployed URL or real sk_test_... key
- Stripe SDK v9+ breaking change (StripeObject.get() removed) not caught until runtime

did the agent PROVE before claiming a fix? (Y/N per task):
- Bug 2 (double-charge guard): Y — live 400 from running app
- Bug 1 (key mismatch): N — self-reported, no independent verification
