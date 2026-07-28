# Descope OTP Sandbox Findings — 2026-07-23

**Sandbox run:** https://fetchsandbox.com/runs/e0a579f709?flow=run_306cd8b5-184c-47c6-aaf5-31a27a9fd022
**Workflow:** `otp_signup_email`
**Result:** PASS — 3/3 steps in 165ms

## Steps proven

| # | Call | Outcome |
|---|------|---------|
| 1 | `otp.sign_up_or_in(EMAIL, email)` | OTP dispatched |
| 2 | `otp.verify_code(EMAIL, email, code)` | Returns `sessionToken` + `refreshSessionToken` |
| 3 | `validate_session(session_jwt)` | Returns claims, `sub` stable user ID |

## What was fixed

- Replaced `POST /signup` (trusted email verbatim, returned fake token) with two real endpoints:
  - `POST /auth/send` — `sign_up_or_in`, handles both new and returning users
  - `POST /auth/verify` — OTP verification, returns real JWTs
- Replaced `_current_user` stub (trusted raw Bearer as user ID) with `validate_session()` SDK call
- `_NOTES` now keyed by `claims["sub"]` instead of a forgeable string

## No bugs caught — happy path only

The guide returned `matched_bug_pattern: null`. No failure scenario was reproduced.
No retry/replay or token-reuse edge cases were exercised.

## Gaps / not tested

- OTP code expiry / replay (what happens if the same code is submitted twice)
- Expired `sessionJwt` path — `validate_session` rejects it, but there's no refresh flow wired
- SMS OTP (only email tested)
- `DESCOPE_PROJECT_ID` missing at startup — app will crash at import time with a clear env var error, which is fine
