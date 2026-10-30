# Owner-reviewed pergola ad publishing

Acme Corporation's Marketing / creative-operations team needs an owner to review
one exact ad before publishing it. The demonstration creates a **PAUSED** Meta ad
object in FetchSandbox. It does not launch a live campaign, pass Meta review,
deliver impressions or incur ad spend. Configure a named owner (Raj for the Acme
demo) and actual reviewer identities when deploying.

Two deterministic logical roles read the creative and prepare a publication
request. No LLM drafting, generated image or autonomous-agent evaluation is
established. The creative and ad set are fictional seeded records. The current
shared AgentCore runtime, provider clients, durable state and approval protocol
remain the execution owners; this is not a new workflow engine.

## Decision and recovery

1. Read the exact creative from the Meta twin. Check its business account and the
   selected ad set against `AD_PUBLISHING_POLICY_JSON`.
2. Save a review containing the creative snapshot, policy version/hash, account,
   title, ad set and required PAUSED state. Do not write an ad before approval.
3. At execution, re-read the creative and current policy. Changed evidence stops
   the write. Save durable publication intent before the only creation request.
4. If the response is lost, a later resume lists and independently reads provider
   state. Exactly one matching record can recover the result. No match, several
   matches, incomplete pagination or failed lookup leave the action unresolved;
   no second creation is permitted.

Meta-side idempotency has not been established. An `Idempotency-Key` header is
not treated as a guarantee. A database transaction/outbox cannot atomically commit
an external platform effect. Ad names are not unique keys; ambiguity is held.
There remains a race between checking a mutable upstream creative and the remote
write; this example does not claim provider-enforced compare-and-swap.

The optional stale-claim recovery hook performs reads only. It never releases an
old uncertain claim and repeats the write. Workflows without this hook retain
their existing behavior. A provider may have accepted an operation even when the
app reports `DONE` / `partial`; final acceptance requires action status and
independent provider read-back, not the phase or HTTP status alone.

## Policy and configuration

```json
{"version":"acme-ads-2026-10-30","organization":"Acme","account":"act_1001","adsets":["2001"],"status":"PAUSED"}
```

Keep this policy in operator-managed configuration or the workflow's private AWS
secret. Agents read the saved policy; they cannot change it through the input.
The explicit input contains organization, requester email, creativeId, adsetId
and a human-readable title. Use a distinct title/reference for independently
approved test cases; never assume Meta enforces name uniqueness.

Set `WORKFLOW=ad-creative-publishing`, `APPROVER_USER_IDS`, `META_BASE_URL` and
`META_API_KEY`. The executable demo refuses live Meta bindings: its base URL must
be a FetchSandbox sandbox or the local FetchSandbox fixture. It cannot spend from
a real ad account. `STATE_FILE` supports local saved state; `DYNAMODB_TABLE`
provides the existing native runtime store.

When the reviewed LoopLabs adapter is configured, the ordinary native `decide`
command is refused for this workflow. The signed shared-approval bridge binds
tenant, deployment, epoch, exact review revision, policy and reviewer. This is
authenticated server/HMAC approval, not device-bound proof of a human passkey
ceremony. The model, ordinary application callers and reviewers must not receive
provider, worker or signing credentials. Named API reviewer values alone are not
evidence of a human click or enterprise separation of duties.

## Run and verify

```sh
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=ad-creative-publishing STATE_FILE=.state/ad-publishing.json node --env-file=.env dist/main.mjs
```

Use only private environment files, an isolated provider binding and a configured
reviewer. The executable contract is
[`verify/contracts/ad-creative-publishing.mjs`](verify/contracts/ad-creative-publishing.mjs).
The existing runner is:

```sh
node verify/relay-proof.mjs ad-creative-publishing
```

That command creates isolated FetchSandbox test resources; it is not an AWS
deployment or a live Meta action. Maintainer evaluations must use the existing
disposable-account/key lifecycle and verified cleanup rather than a founder key.
The runner's process restart uses SIGKILL and the same saved state. A paused
worker restart is distinct from a crash during the external write.

## Evidence boundaries

Local unit tests exercise wrong owner/business/ad set, changed policy/creative,
stale external revision, rejection, replay, accepted response loss, ambiguous and
missing read-back, and a fixture representing an old in-flight claim. Local tests
are not hosted MCP or native-agent acceptance. Saved receipts must identify the
exact app revision and preserve deliberately broken runs separately. Do not count
Meta scope rejections or missing setup as passing business publication.

Meta contract provenance is the official Business SDK26.0.2, source commit
`efd8423a2e595ea8d4c04eb824ce113f2f1d68cd`, plus one live invalid-token read probe.
The authored FetchSandbox projection covers three Graph operations only. Real
Meta app permissions, OAuth consent, positive creation parity, review/delivery,
billing, revocation races, device signatures, an actual LangGraph adapter and the
prospect's Vault code remain outside this proof.
