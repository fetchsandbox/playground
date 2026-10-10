# Try the Stripe and Resend app in Cursor

This is a small order API: create an order, start its Stripe payment, receive a signed payment event, and send a Resend receipt. You can investigate the original bugs or review the repaired example. It has no storefront or browser checkout.

## Choose the version

The current `main` branch contains the repaired example and its regression tests.
To let Cursor discover the original bugs, create a separate checkout:

```sh
git clone https://github.com/fetchsandbox/playground.git
cd playground
git worktree add ../playground-stripe-buggy 0a2028cbf28b1c1a9b51465aca1ff1daafd1760e
```

Open `playground-stripe-buggy/apps/stripe-receipts` in Cursor. Keep the working app on `main` separate so your investigation does not replace the baseline.

## Connect FetchSandbox

Follow https://fetchsandbox.com/mcp to connect Cursor. Use your own FetchSandbox MCP key through Cursor's private MCP settings. Do not commit keys or paste them into the agent prompt. MCP authentication and the app's temporary Stripe/Resend settings are different credentials.

Ask the agent:

> Customers say some paid orders never get a receipt, and another order sometimes stays pending. Investigate this Stripe and Resend app with FetchSandbox, fix the cause, and show the before/after evidence. Use isolated test providers. If a check cannot be measured, tell me why.

If the agent asks for temporary app settings, use the fresh secure handoff for that run. Supply the Stripe API base, Stripe test key, webhook signing secret, Resend API base, Resend temporary key, and any required run header together. Expired handoffs require a fresh session. Remove the temporary settings when done. Do not substitute live provider credentials.

## Run the repaired example locally

From the current checkout's `apps/stripe-receipts` folder:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/test_regressions.py -q
```

For a running app, follow [README.md](README.md) to bind fresh twins before starting uvicorn. Fake port numbers in that README do not start providers. The repaired app rejects missing settings and real provider URLs, and uses synthetic `@example.test` recipients.

## What has actually been verified

A fresh local rerun passed 63 regression tests on October 10, 2026 (UTC). These exercise real app routes and Stripe signature validation with deterministic provider fakes. Historical running-app twin tests and their limits are in [QA-HANDOVER.md](QA-HANDOVER.md).

A separate production engine execution on the original fixture recorded 13 observations per version: the original failed six assertions, and its candidate passed the recorded assertions. [Inspect the receipt](https://fetchsandbox.com/runs/fix-4c9d1c12f4a0?flow=8bad0e7f3302). That candidate is a narrower repair than this branch's app. Its Resend sender was a recording stub and Stripe outbound API was not exercised. The surrounding Claude conversation timed out, so its persona result remains unmeasured.

Cursor's actual end-to-end agent session has **not** been verified. No Cursor CLI was available on the test Mac. The local app tests are not a substitute for that session. Please share the receipt URL and where the agent needed intervention after your dry run.

## Limits

Single process, in-memory state, no app authentication, no durable restart guarantee, no real card settlement, and no inbox delivery. This is a disposable QA example, not a production checkout. Passing these tests does not cover every production invariant.
