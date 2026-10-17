# descope-onboarding — 2026-07-28

**Agent / IDE:** Claude Code (Sonnet 4.6)

---

**date / hours:** 2026-07-28 / ~0.5h

**tested today (specs / apps / flows):**
- apps/descope-onboarding (greenfield warm-up)
- Flows: OTP signup (email), session refresh, JWT signature validation

---

**worked well:**
- After a second round, correctly produced a real before/after with divergent results — forged alg:none token returns 200 (broken) vs 401 (fixed)
  - Before (broken): https://fetchsandbox.com/runs/d2639048a4?flow=run_620c016c-e421-4595-aae5-3f083ed2e490
  - After (fixed): https://fetchsandbox.com/runs/d2639048a4?flow=run_d731bec3-dfd0-462c-abe9-b5a4c67da34d
- Final diff was sane: replaced fake token with real OTP + verify + validate_and_refresh_session

---

**broke:**

- prompt i typed: `./fetchsandbox prove the descope OTP + session flow before writing any code and generate the fetchsandbox receipt URL`
- spec / app: apps/descope-onboarding
- expected vs what happened: expected it to test the app's actual (broken) code and show a failure. instead it ran the Descope API flow in the sandbox independently — returned all 200s / ✅ even though the app still had a broken placeholder. receipts looked like proof but weren't testing the app at all. had to do a second round to get a real before/after
- receipt URL (if any): https://fetchsandbox.com/runs/d2639048a4?flow=run_8be68858-3783-44d4-b405-c4a67c635f67 and https://fetchsandbox.com/runs/d2639048a4?flow=run_ca79bfa2-171f-4720-84c9-55b2bae5959a (both green, both false signal)
- severity: S2 major

---

- prompt i typed: `./fetchsandbox so the code here dont has any bug`
- spec / app: apps/descope-onboarding
- expected vs what happened: investigate the broken placeholder, reproduce failure with a receipt, then propose fix. instead confidence 0, read code, jumped straight to implementing — no broken-state receipt until user challenged it after the fact
- receipt URL (if any): none at time of fix
- severity: S2 major

---

- prompt i typed: `./fetchsandbox so the code here dont has any bug`
- spec / app: apps/descope-onboarding
- expected vs what happened: coach validates code against sandbox spec and returns result. instead coach surfaced a mid-run triage question, user declined, flow died with no recovery or re-route
- receipt URL (if any): none
- severity: S3 minor

---

**friction / confusing / slow:**
- first receipts looked like real proof but were testing the Descope API in isolation, not the app code — a user would stop here thinking they're done
- coach asking a triage question mid-flow with no context on why it needs the answer — felt like a dead end
- before-receipt in the second round only appeared after user challenge, not proactively

---

**did the agent PROVE before claiming a fix?**
- greenfield warm-up (first round): N — returned green receipts that weren't testing the broken app code
- bug fix (second round): N — wrote code first, proper before/after came only after user challenge

---

**confidence today: 2/5** — the first receipts were false signal (all green on a broken app), and the fix loop skipped the broken-state proof until challenged; needed two rounds and user pushback to get honest before/after
