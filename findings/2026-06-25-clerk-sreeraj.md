# clerk — 2026-06-25
## Prompt (verbatim from PROTOCOL.md)
> ./fetchsandbox we suspect anyone can call /api/admin/users with a forged token — audit the clerk integration.
## Tool-call sequence
1. mcp__fetchsandbox__guide(intent="we suspect anyone can call /api/admin/users with a forged token — audit the clerk integration")
2. Brain requested clarification on auth surface (user_only / team / invite_flow)
3. User selected "team"
4. mcp__fetchsandbox__import_spec(spec="clerk")
5. Attempted Clerk spec import (404)
6. Web search for Clerk OpenAPI specification
7. Fetch(clerk/openapi-specs repository)
8. Fetch(clerk/openapi-specs/tree/main/bapi)
9. mcp__fetchsandbox__import_spec(...) retry
10. Brain selected org_management workflow
11. Workflow lookup failed ("No org_management workflow")
12. Fallback to user_signup workflow
13. Read(main.py)
14. Update(main.py) — replaced JWT decode logic
15. mcp__fetchsandbox__run_workflow(...) (re-run after fix)
## What the brain returned
- spec: clerk
- workflow: org_management (initial selection)
- scenario: None
- intent_class: debug
- bug_pattern matched: None
- confidence: 0.85
## Receipt URLs surfaced
- before: https://fetchsandbox.com/runs/4790984f6d?flow=run_69701449-963d-4175-a5b6-0159920b04a8
- after: https://fetchsandbox.com/runs/4790984f6d?flow=run_067991a2-8a4d-41e4-9f8c-1ef315d62aee
## What the agent identified as the bug
"jwt.decode(..., options={'verify_signature': False}) — signature was never checked on any endpoint. Anyone could mint a JWT with {'public_metadata': {'role': 'admin'}} and access GET /api/admin/users."
## What the agent's fix was
Replaced:
```python
jwt.decode(token, options={"verify_signature": False})
```
with:
```python
jwt.decode(token, CLERK_JWT_PUBLIC_KEY, algorithms=["RS256"])
```
The agent also recommended replacing the placeholder public key with Clerk's JWKS endpoint and caching the key appropriately.
## Brain quality rating (1-10)
5/10
Justification:
The brain correctly identified the Clerk spec and eventually contributed to producing before/after receipts. The agent ultimately found the correct vulnerability and applied an appropriate fix.
However, several issues reduced the value of the brain's contribution:
- The prompt explicitly referenced an admin endpoint and forged-token access, yet the brain could not infer the correct auth surface and required user clarification.
- The brain correctly selected the org_management workflow for an RBAC/admin-access investigation, but that workflow was not available in the workflow catalog, forcing a fallback to user_signup.
- The workflow eventually executed was user_signup, which is poorly aligned with a forged-token privilege-escalation audit.
- The vulnerability was discovered primarily through source-code inspection rather than through a security-focused workflow or scenario.
- The generated receipt validates workflow execution but does not directly demonstrate successful exploitation or prevention of the forged-token attack.
## Did FetchSandbox earn its place in this session?
Partial
FetchSandbox was consulted first and remained involved throughout the session. It provided routing, spec loading, and receipts.
However, the brain was not able to infer the auth surface from the prompt and requested clarification from the user. It then correctly selected the org_management workflow, but that workflow was not available and it fell back to user_signup. The vulnerability was ultimately identified through code inspection rather than a dedicated security scenario.
## Specific suggestion for the brain.yaml for this spec
- id: jwt_signature_unverified
- symptoms:
  - forged JWT grants admin access
  - anyone can call admin endpoint
  - role claims trusted from token
  - JWT verification disabled
  - privilege escalation via Clerk session
- reproduce_with workflow + scenario:
  - workflow: org_management
  - scenario: forged_token
- check_for items:
  - verify_signature disabled
  - algorithms not restricted
  - role claims trusted without verification
  - issuer validation missing
  - audience validation missing
  - webhook signature verification missing
## What surprised you
Despite the prompt clearly describing a forged-token privilege-escalation issue, the brain didnt infer the auth surface from the prompt, requested clarification, correctly selected org_management, but had to fall back to user_signup because the workflow was unavailable, and finally relied on the local source-code inspection to find the vulnerability.