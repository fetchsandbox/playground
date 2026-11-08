# C10: denied operations and retained-evidence privacy

C10 was measured against the real published n8n pilot and its protected
adapter. The other 13 check definitions are preserved. This is an application
transport change, not a backend deployment or a new workflow verification engine.

## Boundary and implementation

The previous adapter permitted GET and POST independently of the provider path.
It also inherited fetch's default redirect following and accepted any first-party
URL prefix as a twin binding. The new `provider-transport.ts` maps the methods
and paths actually used by this workflow, requires the exact first-party
`/sandbox/<id>` namespace shape, and uses `redirect: 'error'` without retries.
Issued twin credentials remain private. The adapter's `/io` calls this policy
before a provider fetch. The native n8n workflow is unchanged.

Seven C10 requests exercise forbidden methods, foreign/absolute URLs, path
traversal and unsupported write paths through the actual managed-relay adapter.
An eighth request exercises an unknown adapter route. Each request expects a
rejection; the existing engine independently reads all five provider collections
and requires zero effects for the unique C10 lead. App state must also stay empty.
These are eight concrete requests, not exhaustive egress or SSRF coverage.
The redirect refusal and malformed-binding cases are locally tested settings;
this run does not inject a native provider 3xx response.

When adding a new provider operation, extend the method/path mapping with its
positive case and nearby denied cases. Preserve exact issued twin bindings,
redirect refusal, and zero-effect assertions; do not restore a provider-wide
GET/POST allowance to make a new feature pass.

## Evidence privacy and its separate audit

Denied bodies contain clearly dummy authorization, API-key, password, cookie and
route-token values, plus one dummy key-shaped string. A public non-sensitive
marker must survive capture, so simply dropping the entire body cannot pass the
audit. `audit-c10.mjs` reviews the retained owner snapshot and the anonymous
summary for those markers and explicit masks. It also scans supplied actual
credential values without printing them. Never feed real customer data into this
probe. No additional endpoint or scenario-specific workflow answer is introduced.

This artifact audit is separate from the engine's denied-operation verdict. It
does not establish removal of arbitrary PII, all secret formats, requester
identity, multi-tenant isolation, or native SaaS parity. Those boundaries must
remain explicit. C6 and C9/C11/C12 are outside this change.

## Validation status

Local suite: 494 tests passed across 68 files; TypeScript passed. Includes the
existing application suite, positive operation routes, denied route/method/URL
cases, fixed-destination/no-redirect transport and failing artifact-audit controls.
The [before-change receipt](https://fetchsandbox.com/runs/1e60267e46?flow=vr_27fa4a86e4c24df693f8f7bd954b2659)
records nine checks passed and five unmeasured. C10 expected HTTP 400 but received
HTTP 200 for the first `GET /chat.postMessage` request through `/io`. The engine
classified that mismatch as unmeasured, not a failed/violated verdict. C10 stopped
there; its remaining actions and zero-provider-effect assertions did not run.
Do not call the whole receipt passing. The [before observation](evidence/2026-11-07-c10-before-observation.json)
retains that distinction. All four owned twins were deleted and the retained
snapshot remained readable. The [corrected receipt](https://fetchsandbox.com/runs/deb9b73db1?flow=vr_5617af5dac3549c28afe4240d9317813)
records **10 passed, 0 failed, 4 unmeasured; overall inconclusive**. All seven
forbidden operations returned 400 and the unknown route returned 404. C10 app
state stayed empty and its five independent provider-collection zero-effect
assertions passed. All 50 provider-state assertions in this run passed; the
other nine executable checks passed again. C6, C9, C11 and C12 remain unmeasured.
The checks hash is identical in the before/after receipts:
`82c80ae5d20febaa34f44dd7f59dabfbe4f88c18a3590e840342845c59e79c3c`.
The prior C7/C4 receipt had C10 blocked; these are a new frozen before/after
contract, not retroactive changes to that historical receipt.

The separate artifact audit passed for both actual retained documents: seven
non-sensitive markers remained, dummy secret fields/key-shaped value were masked,
and none of seven supplied credential values appeared. Anonymous summary access
returned 200 and anonymous full-proof access returned 401. The first audit attempt
failed because the auditor expected a nested run ID instead of the anonymous
summary's top-level `flow_run_id`. That schema assumption was corrected, then the
actual audit and local regression gates were rerun. This was an audit setup
failure, not an observed secret leak. See the
[after observation](evidence/2026-11-07-c10-after-observation.json).

Native n8n remained on `0397f00d-f536-4975-935b-fb705b780055`, independently
observed in execution 241. Its actual export hash is
`28dd4054ebe1986ff2d4e232baa0d70898a6efa3f5f7d3740300514bd13712d4`.
Old adapter bundle: `14c04b61f0858e24f954796bf5b691efe57173ae9676f098211c60ef2f299ddb`.
Corrected bundle: `6ae831332940c4a124405cbfdbed61c2a82d42d54b77169c3030d822cff5180f`.
No backend release was deployed. The temporary changed adapter was measured with
the real cloud workflow, then stopped; a fresh proof must restart its transports.
Four owned twins were deleted with HTTP 200, retained snapshot returned 200,
private temporary bindings were removed and ports 8097/4040 were closed.
