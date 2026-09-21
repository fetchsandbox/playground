# descope-onboarding — 2026-07-24

**Prompt:** `./fetchsandbox go to descope app and do task 1 add login and prove it before writing the code`

**Agent / IDE:** opencode (deepseek-v4-flash-free)

**Receipt URLs:**
- OTP flow proof: https://fetchsandbox.com/runs/e0a579f709?flow=run_00fbc6ed-cc40-4911-8514-13709f6741de

**What happened:**

Called `guide` with the full prompt. Resolved to `spec=descope`, `workflow=otp_signup_email` at confidence 0.85. Asked two follow-up questions (auth_method=otp, session_model=jwt_jwks). Called `quickrun` directly with `spec_slug=descope` + `workflow_name=otp_signup_email` — passed 3/3 steps in 69ms. Receipt URL proves the Descope OTP sign-up flow works end-to-end (send code → verify → session JWT).

Only then wrote the code diff:
- Replaced placeholder `POST /signup` (returned `"INSECURE-PLACEHOLDER-TOKEN"`) with real Descope OTP via SDK
- Added `POST /verify` endpoint to verify OTP code and return `sessionJwt` + `refreshJwt`
- Replaced `_current_user` (trusted token verbatim as user id) with `descope_client.validate_session()`
- Added `descope==1.7.0` to `requirements.txt`

**Score:** 10/10 — guide routed correctly, quickrun produced a receipt URL, code written only after sandbox proof.