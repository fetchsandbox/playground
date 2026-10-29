#!/usr/bin/env python3
"""Render/check workflow guides from code, contracts and historical receipts; no provider calls."""
import argparse,collections,datetime,json,pathlib,re,subprocess,sys
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit,parse_qs
ROOT=pathlib.Path(__file__).resolve().parents[1]
WHY={
'account-takeover-containment':'IT Security needs to contain a suspected account takeover within minutes, holding money movement and removing admin access, without locking a customer organization out of its last admin or acting on an unreadable directory.',
'user-access-review':'IT Security needs quarterly access certifications that auditors accept: every entitlement decided by its owner, nobody certifying themselves, unreviewed admin access removed, and evidence that cannot be edited after the fact.',
'access-jml':'IT needs to grant the correct employee access and remove it when employment changes, while keeping privileged changes under human control.',
'ai-support-triage':'Support needs every new ticket triaged in seconds with a language model, without letting the model lower an outage priority, promise money, or send a reply a person should have checked.',
'change-management-gate':'Platform Engineering needs every production change checked against incidents, monitors and freezes, approved by someone other than its author when required, and rolled back automatically when it degrades the service.',
'churn-risk-sweep':'Customer Success needs an explainable shortlist of accounts to contact before renewal, using billing, CRM, support and inbox evidence instead of one isolated score.',
'collections-credit-hold':'Finance needs consistent overdue-invoice follow-up while protecting disputed accounts from an inappropriate credit hold.',
'compliance-docs':'Quality needs to answer product-document requests using the approved library, and route missing evidence to a person before sharing externally.',
'visa-and-leave-expiry':'HR must never let a work authorization lapse unnoticed or lose track of someone returning from leave, months after the date was first recorded.',
'payroll-anomaly-review':'Payroll must catch payments to people who have left and unexplained pay jumps before money moves, without making everyone else wait for their pay.',
'delivery-exception':'Customers should hear about a late or lost parcel from us before they have to ask, and get a replacement without a fight, exactly once.',
'inventory-replenishment':'Supply chain needs stock reordered before it runs out, in the quantities suppliers accept, without double-ordering, and needs to know when a supplier is late.',
'customer-kyc-rescreen':'Compliance must catch partners who become sanctioned after onboarding, stop their payouts before money moves, avoid re-reviewing the same false positives, and meet the SAR filing deadline.',
'usage-true-up':'Billing must invoice every committed-use customer for what they used beyond their contract, exactly once, with notice and a chance to dispute, and never guess when a contract is incomplete.',
'treasury-payment-approval':'Treasury must never send money on one person\'s say-so, to an unverified or sanctioned beneficiary, twice, or after the value date has been missed, and must know the next day if a payment came back.',
'support-sla-breach':'Support leaders need every unanswered ticket chased before its first-response target, breaches surfaced the moment they happen, and enterprise customers escalated to on-call, without duplicate alerts from overlapping sweeps.',
'purchase-request-to-po':'Finance needs every purchase approved by the right people for its amount and budget, never by the requester, with a purchase order raised exactly once and nothing bought from a held or sanctioned vendor.',
'crm-billing-sync':'RevOps needs the CRM to show what billing actually charges, without a sync job ever silently overwriting the wrong account or rewriting the whole customer base after an upstream glitch.',
'consent-propagation':'Marketing and privacy must honour an opt-out everywhere it is used, never let a delayed event undo a newer choice, and prove the change took effect in every system.',
'dsar-export':'Privacy teams must answer every access request completely and within the statutory deadline, with identity confirmed and the export reviewed by a second person before anything leaves the company.',
'contract-intake':'Legal needs routine NDAs signed the same day without a lawyer, every deviation reviewed by one, unsigned envelopes cleaned up, and renewal notice dates never missed.',
'cross-border-refund':'Customer Experience needs to refund international customers in the currency they paid, only to the customer who paid, with currency-aware limits and without letting ticket text decide the amount.',
'customer-data-sweep':'RevOps needs a nightly data-quality sweep over thousands of billing records that never acts on a partial read and never rewrites thousands of records because of one bad rule.',
'distributor-claims':'Channel Finance needs to compare requested distributor credits with the actual paid invoices, list prices and agreement before paying them.',
'duplicate-charge-remediation':'Finance needs to refund customers who were charged twice by a billing incident, quickly and at scale, without refunding a disputed or ambiguous payment and with human approval above set limits.',
'employee-offboarding':'People Operations needs every departure handled on time: final pay by the work state\'s legal deadline, access removed at the end of the last day, equipment back, and a rescission undone cleanly.',
'export-screening':'Trade Compliance needs to hold shipment when party or item screening is unclear rather than treating an unavailable check as clearance.',
'failed-payment-dunning':'Finance needs to recover failed subscription payments with a predictable, never-repeating reminder ladder, and to cancel only after a person agrees.',
'field-service-dispatch':'Service needs to coordinate technician time, contract coverage and site communication before committing an uncovered or after-hours visit.',
'incident-comms':'IT Operations needs to identify affected customers and keep responders informed without sending an unreviewed outage statement.',
'invoice-three-way-match':'Accounts Payable needs every supplier bill matched to what was ordered and received before it is paid, with people spending time only on real exceptions and duplicates never paid twice.',
'lead-routing-sla':'Sales needs every inbound lead in front of the right rep within minutes, fairly distributed, with untouched leads reassigned automatically instead of going cold.',
'license-reclaim':'IT Asset Management needs to recover unused seats after a warning and grace period, with approval before removing access.',
'month-end-close':'Controllership needs the books closed on schedule: cash reconciled to the bank, journals proposed and approved by a controller, and the period locked only after sign-off, with a trail auditors accept.',
'onboarding-kickoff':'Sales needs a reliable closed-won handoff that connects CRM, billing, support and kickoff preparation without silently creating a second subscription.',
'order-status':'Customer Experience needs to answer delivery questions from billing and fulfillment records, and obtain approval before changing a promised date.',
'order-to-cash':'Operations needs every paid storefront order booked in the ERP before a label is bought, shipped once, and tracked for the customer, holding anything unpaid or incomplete.',
'paid-order-provisioning':'Sales needs to grant product access the moment an order is paid, and never for an order that was not paid in full, was refunded or disputed, or whose payment event was forged, replayed, delayed or lost.',
'partner-payout-run':'Finance needs to pay every partner their monthly commission exactly once, even when a payment response is lost or the run is re-triggered, with approval for large transfers and no automation beyond a hard ceiling.',
'pcn-eol-notice':'Product Engineering needs to identify customers affected by a product change or retirement and coordinate reviewed customer notices.',
'privacy-erasure':'Legal needs to honor data deletion requests across every system before the statutory deadline, while keeping records the law requires and never deleting for an unverified requester.',
'product-cancellation':'Customer Experience needs to acknowledge cancellation requests, evaluate subscription terms, obtain exceptions where required, and let the correct customer choose an eligible refund method.',
'returns-warranty':'Customer Experience needs to establish purchase and warranty eligibility before arranging a return or issuing a credit.',
'revenue-reconciliation':'Finance needs to detect differences between payment, CRM and support approval records before applying corrective writes.',
'rfq-quote':'Sales needs a priced response to an RFQ using catalog and customer evidence, with discount approval before finalizing a quote.',
'security-questionnaire':'IT Security needs to answer from approved material and flag missing answers rather than inventing a compliance claim.',
'service-renewals':'Customer Success needs advance notice of expiring service contracts and coordinated renewal follow-up, with review for policy-level price changes.',
'supplier-ncr':'Supplier Quality needs an accountable corrective-action process after a failed inspection, including supplier follow-up and review scheduling.',
'supplier-bank-change':'Accounts Payable needs to stop payment fraud through supplier bank-detail changes: nothing is paid to new details until a callback to the number on file and two different people have verified them.',
'vulnerability-remediation':'Application Security needs every known vulnerability tracked to its severity deadline, escalated when late, and accepted as risk only by someone outside the owning team, for a limited time.',
'external-sharing-audit':'Security needs to know that no payroll file, customer export or passport scan sits behind a public link with no expiry, in either document store, and needs it fixed without breaking links people rely on or overriding a fix someone already made.',
'support-escalation':'Support needs to combine incident severity, account context and billing health so urgent cases reach the right team with a reviewed customer reply.',
}

# Provider -> (environment variables, notes). Names match acme-ops/src/providers/index.ts.
PROVIDER_ENV={
'stripe':('`STRIPE_API_KEY` (restricted key)','Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes.'),
'hubspot':('`HUBSPOT_API_KEY` (private-app token)','Custom contact properties must exist before the workflow writes them.'),
'gmail':('`GMAIL_API_KEY` (OAuth access token)','Customer mail is created as drafts.'),
'calendar':('`GOOGLE_CALENDAR_API_KEY` (OAuth access token)',''),
'slack':('`SLACK_API_KEY` (bot token, `chat:write`)','Invite the bot to every channel the input names.'),
'zendesk':('`ZENDESK_SUBDOMAIN` + `ZENDESK_API_KEY` (OAuth token, or API token with `ZENDESK_EMAIL`)',''),
'asana':('`ASANA_API_KEY` (personal access token)',''),
'workos':('`WORKOS_API_KEY`',''),
'github':('`GITHUB_API_KEY` (fine-grained token)','Sends `X-GitHub-Api-Version: 2022-11-28`.'),
'twilio':('`TWILIO_API_KEY` (auth token) + `TWILIO_ACCOUNT_SID`','HTTP Basic auth.'),
'twilio_verify':('`TWILIO_VERIFY_API_KEY` + `TWILIO_ACCOUNT_SID` + `TWILIO_VERIFY_SERVICE_SID`','HTTP Basic auth.'),
'pagerduty':('`PAGERDUTY_API_KEY` + `PAGERDUTY_FROM_EMAIL`','`Token token=` auth; `From` is required for writes.'),
'notion':('`NOTION_API_KEY` (integration token)','Share the database with the integration. Sends `Notion-Version: 2022-06-28`.'),
'box':('`BOX_API_KEY` (access token)','Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double.'),
'screening':('`TRADE_GOV_API_KEY` (developer.trade.gov subscription key)','Sent as the `subscription-key` header.'),
'square':('`SQUARE_API_KEY`',''),
'openai':('`OPENAI_API_KEY` (+ optional `OPENAI_MODEL`)','Model output is validated in code and never trusted for money or access decisions.'),
'shopify':('`SHOPIFY_BASE_URL` (`https://<shop>.myshopify.com`) + `SHOPIFY_API_KEY` (Admin API access token)','Admin API version `2026-01`; override with `SHOPIFY_API_VERSION`.'),
'netsuite':('`NETSUITE_BASE_URL` (`https://<account>.suitetalk.api.netsuite.com`) + `NETSUITE_API_KEY` (OAuth 2.0 access token)','Tokens expire after 60 minutes; refresh them outside the runtime.'),
'easypost':('`EASYPOST_API_KEY`','HTTP Basic auth.'),
'plaid':('`PLAID_CLIENT_ID` + `PLAID_SECRET` (+ `PLAID_BASE_URL` for sandbox)','Credentials travel in the request body.'),
'gusto':('`GUSTO_API_KEY` + `GUSTO_COMPANY_ID`','Pinned to `X-Gusto-API-Version: 2026-06-15`; override with `GUSTO_API_VERSION`.'),
'datadog':('`DATADOG_API_KEY` + `DATADOG_APP_KEY`',''),
'docusign':('`DOCUSIGN_BASE_URL` (your account\'s base URI) + `DOCUSIGN_API_KEY` (access token) + `DOCUSIGN_ACCOUNT_ID`',''),
'dropbox':('`DROPBOX_API_KEY` (OAuth access token; + `DROPBOX_PATH_ROOT` for a team space)','RPC calls go to `api.dropboxapi.com`, uploads and downloads to `content.dropboxapi.com`.'),
'moderntreasury':('`MODERN_TREASURY_API_KEY` + `MODERN_TREASURY_ORGANIZATION_ID`','HTTP Basic auth.'),
}
# What must already exist in the provider accounts. Workflows not listed need only the identifiers in their input.
PREREQS={
'consent-propagation':['HubSpot contact properties (single-line text): `acme_consent_marketing_email`, `acme_consent_sale_or_share`, `acme_consent_profiling`, `acme_consent_last_event`.','A HubSpot email subscription type for marketing; its id is the input `marketingSubscriptionId`.'],
'crm-billing-sync':['HubSpot contact properties (single-line text): `acme_stripe_customer_id`, `acme_plan`, `acme_mrr`, `acme_billing_status`.','Stripe customers in scope carry `metadata.acme_segment` equal to the input `segment`.'],
'customer-data-sweep':['Stripe customers in scope carry `metadata.acme_segment` equal to the input `segment`.'],
'customer-kyc-rescreen':['Stripe Connect accounts in scope carry `metadata.acme_program`. The platform must be allowed to set their payout schedule (platform controls or loss liability).'],
'usage-true-up':['A Stripe billing meter (its id is the input `meterId`) receiving usage events.','Each committed-use subscription carries `metadata.acme_committed_units`, `metadata.acme_overage_price` (a price id) and optionally `metadata.acme_billing_email`.'],
'visa-and-leave-expiry':['A Notion database with columns `Employee` (title), `Email` (email), `Manager email` (email), `Type` (select: `work_authorization`, `leave`), `Document` (select), `Date` (date) and `Status` (select: `active`, `renewed`, `returned`, `closed`, `reverification_overdue`), shared with the integration.','A Notion webhook or automation that calls `start` with the page id when a row changes.'],
'support-sla-breach':['Zendesk tickets in scope carry the input `scopeTag`; enterprise customers carry `enterpriseTag` (default `tier_enterprise`).','A PagerDuty service for support on-call.'],
'supplier-bank-change':['NetSuite vendor custom fields: `custentity_acme_payment_hold` (checkbox), `custentity_acme_hold_reason`, `custentity_acme_bank_last4`, `custentity_acme_bank_token`, `custentity_acme_bank_changed_at`.','A Twilio Verify service, a Plaid link to the new account, and a developer.trade.gov subscription key.'],
'purchase-request-to-po':['NetSuite vendor custom fields `custentity_acme_payment_hold` (checkbox) and `custentity_acme_hold_reason`.','Department budgets come from your planning system through the input.'],
'order-to-cash':['A NetSuite customer whose email matches the Shopify order, and NetSuite items whose external ids are the Shopify SKUs.'],
'inventory-replenishment':['For each planned SKU: its Shopify variant id, NetSuite item id and supplier (vendor) id, passed in the input.'],
'invoice-three-way-match':['NetSuite vendor bills pending approval, linked to their purchase orders and item receipts.'],
'month-end-close':['A Plaid link to the operating bank account that receives Stripe payouts, and NetSuite accounting periods named as in the input `periodName`.'],
'lead-routing-sla':['HubSpot owners listed as reps in the input pods. Leads use the standard properties `country`, `numberofemployees` and `hs_email_domain`.'],
'change-management-gate':['A GitHub repository using deployments, a PagerDuty service and the Datadog monitors named in the input.'],
'vulnerability-remediation':['Dependabot alerts enabled on the repositories in the input.'],
'contract-intake':['A Box file for the contract, an OpenAI key, and a DocuSign account.'],
'dsar-export':['A restricted Box folder for exports (input `exportFolderId`).'],
'delivery-exception':['An EasyPost tracker webhook that calls `start` with the tracker id and its Shopify order id.'],
'treasury-payment-approval':['Modern Treasury internal (originating) and verified external (receiving) accounts.'],
'payroll-anomaly-review':['A Gusto company with regular payrolls; reviewers named in the input.'],
'employee-offboarding':['The employee\'s Gusto, WorkOS and GitHub identities, passed in the input.'],
'user-access-review':['The WorkOS organizations and GitHub organization in the input, and an Asana workspace for evidence.'],
'external-sharing-audit':['A Box token that can see the policy\'s root folders, and a Dropbox token for the account to audit (team-wide Dropbox audits need a team admin token per member, not included).','A weekly schedule (or an on-demand trigger) that calls `start` with an audit id such as `SHARE-2026-W44`; security approvers in the input or `APPROVER_USER_IDS`.','Your sensitive-name patterns, exempt folders and maximum public-link age in the policy.'],
'failed-payment-dunning':['A Stripe `invoice.payment_failed` webhook (or the daily sweep) that calls `start`.'],
}
def operations(w):
 provs=[]
 for a in w['agents']:
  for p in a['providers']:
   if p not in provs:provs.append(p)
 for a in w['actions']:
  if a['provider'] not in provs:provs.append(a['provider'])
 lines=['','## Providers, credentials and operations','','Put these in the runtime\'s private `.env` locally, or in the stack\'s Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.','','| Provider | Environment | Notes |','|---|---|---|']
 for p in provs:
  env,note=PROVIDER_ENV.get(p,(f'`{p.upper()}_API_KEY`',''))
  lines.append(f'| {p} | {env} | {cell(note)} |')
 pre=PREREQS.get(w['id'])
 if pre:lines+=['','**Set up in the provider accounts first:**','']+[f'- {x}' for x in pre]
 signals=[a for a in w['actions'] if a['description'].startswith('Signal:')]
 if signals:
  lines+=['','**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:','','```json','{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }','```','','Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.','']
  lines+=[f'- `{a["kind"]}`: {a["description"][len("Signal:"):].strip()}' for a in signals]
 if w.get('tickEvery'):lines+=['',f'**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{{"action":"tick"}}` on the schedule `{w["tickEvery"]}` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.']
 if w.get('audit'):lines+=['','**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.']
 if w.get('policy'):lines+=policy_section(w['policy'])
 return lines
def policy_rows(schema,values,prefix=''):
 rows=[]
 for k,prop in (schema.get('properties') or {}).items():
  path=f'{prefix}{k}';v=(values or {}).get(k)
  if prop.get('type')=='object' and prop.get('properties') and isinstance(v,dict):
   if prop.get('description'):rows.append((path,'',prop['description']))
   rows+=policy_rows(prop,v,path+'.')
  else:rows.append((path,json.dumps(v,ensure_ascii=False),prop.get('description','')))
 return rows
def policy_section(p):
 lines=['','## Configurable policy','',f"Every limit, deadline, routing rule and folder layout lives in [`{p['file']}`](../../{p['file']}), not in the code. The workflow validates it at startup against its schema and refuses to start on an invalid value. Each run records the policy version it started under and keeps it until it finishes.",'','Override per deployment without a code change: `POLICY_FILE=/path/override.json` (a mounted file) and/or `POLICY_JSON=\'{...}\'` (an environment value or secret). Objects merge key by key; lists and values replace. On AWS: `cdk deploy -c policyFile:<workflow>=override.json`. `{"action":"describe"}` returns the effective values, their version and the JSON Schema.','','| Setting | Default | Meaning |','|---|---|---|']
 lines+=[f'| `{k}` | {cell(f"`{v}`" if v else "")} | {cell(d)} |' for k,v,d in policy_rows(p['schema'],p['values'])]
 return lines
def cell(v):return str(v).replace('|','\\|').replace('\n',' ')
def render(w):
 id=w['id'];receipt=w['receipt'];counts=collections.Counter(c['status'] for c in receipt.get('checks',[]));base='../../acme-ops/'
 roles=[*w['agents'],*([{'name':w['compose'],'providers':[]}] if w['compose'] else [])]
 lines=[f"# {w['title']}",'', '## Business need','',WHY[id],'',w['business'],'',f"Demo organization: **Acme Corporation**. Department: **{w['department']}**. Owning team: **{w['team']}**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.",'','## Trigger and result','', 'The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.','', '```json',json.dumps(w['example'],indent=2),'```','', 'The customer/operator result is determined by the actions below. A `gmail.draft_*` action creates a draft; it does not prove that email was sent or received. A public ticket comment does not establish live inbox delivery.','', '## Agents and responsibilities','', '| Role | Required provider clients |','|---|---|']
 schema=w['input'];variants=schema.get('oneOf',schema.get('anyOf',[schema]))
 inputs=['## Input contract','','These top-level fields come from the runtime schema. Nested shape and conditional rules are demonstrated in the example and enforced by the linked source.','']
 for n,variant in enumerate(variants):
  if len(variants)>1:inputs += [f'### Input variant {n+1}','']
  inputs += ['| Field | Required | Type / allowed values |','|---|---|---|']
  for name,field in variant.get('properties',{}).items():
   typ=field.get('type','conditional');values=field.get('enum');details=str(typ)+((' / '+', '.join(map(str,values))) if values else (' / '+str(field['const']) if 'const' in field else ''))
   inputs.append(f"| `{name}` | {'yes' if name in variant.get('required',[]) else 'no/default'} | {cell(details)} |")
  inputs.append('')
 index=lines.index('## Agents and responsibilities');lines[index:index]=inputs
 for a in roles:lines.append(f"| `{a['name']}` | {', '.join(a['providers']) or 'No direct provider requirement; uses input or prior agent results'} |")
 lines += ['',f"**{len(roles)} declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.",'','## Policies, writes and approval boundaries','','Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.','','| Action | Provider | Gate | Business effect |','|---|---|---|---|']
 for a in w['actions']:lines.append(f"| `{a['kind']}` | {a['provider']} | **{a['gate']}** | {cell(a['description'])} |")
 lines+=operations(w)
 lines+=['','## Setup and run','','From the repository root:','','```bash','cd acme-ops','npm ci','npm run check','npm test','npm run bundle',f'WORKFLOW={id} STATE_FILE=.state/{id}.json node --env-file=.env dist/main.mjs','```','','Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).','','The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.','','## FetchSandbox verification','','Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.','','```bash','cd acme-ops','npm run bundle',f'node verify/relay-proof.mjs {id}','```','','This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.','','### Declared scenarios','','| Check | Business behavior | Contract blocker |','|---|---|---|']
 for c in w['checks']:lines.append(f"| `{c['id']}` | {cell(c.get('label',''))} | {cell(c['blocked']['reason']) if c['blocked'] else 'Executable declaration; result comes from a receipt'} |")
 lines+=['','### Saved evidence — historical, not a fresh run','',f"The checked-in receipt records app version `{receipt.get('app_version','unrecorded')}`, verdict **{receipt.get('verdict','unknown')}**, and statuses: "+', '.join(f'**{v} {k}**' for k,v in sorted(counts.items()))+'.', '',f"[Recorded receipt]({receipt['receipt_url']}) · [Saved result]({base}verify/receipts/{id}.json)",'','Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.','','## Source and contract','',f'- [Workflow and business rules]({base}src/workflows/{id}.ts)',f'- [Executable verification contract]({base}verify/contracts/{id}.mjs)',f'- [Shared state, approval and recovery engine]({base}src/kit/engine.ts)','', '<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->','']
 if id=='product-cancellation':lines[-2:-2]=['','See the [optional LoopLabs observation and exact approval adapter](../../acme-ops/LOOPLABS.md).','']
 return '\n'.join(lines)
def render_catalog_receipts(content, workflow_ids):
 # Use the same business-doc owner for table numbering and audited receipt links.
 index=json.loads((ROOT/'docs/evidence/workflow-catalog-receipts.json').read_text())
 entries=index['workflows']
 lines=content.splitlines();start=next(i for i,line in enumerate(lines) if line in (
  '| Workflow | Department / team | Roles | Business guide |',
  '| S.no | Workflow | Department / team | Roles | Business guide | Latest known FetchSandbox run |'))
 end=start+2
 while end<len(lines) and lines[end].startswith('|'):end+=1
 rendered=['| S.no | Workflow | Department / team | Roles | Business guide | Latest known FetchSandbox run |',
  '|---:|---|---|---:|---|---|'];seen=[]
 for n,line in enumerate(lines[start+2:end],1):
  cells=[v.strip() for v in line.strip('|').split('|')]
  if len(cells)==6:cells=cells[1:5]
  if len(cells)!=4:raise SystemExit('Malformed workflow catalog row')
  match=re.search(r'workflows/([^/)]+)\.md',cells[-1])
  if not match:raise SystemExit('Catalog row missing business guide')
  id=match.group(1);seen.append(id);entry=entries.get(id)
  if not entry or entry.get('http')!=200:raise SystemExit('Missing accessible receipt audit for '+id+'; build/verify or record the precise blocker first')
  version=entry.get('app_version',{}).get('value','')
  parsed=urlsplit(entry['receipt_url'])
  if entry.get('workflow')!=id or not version.startswith('acme-ops-'+id+'-') or parsed.scheme!='https' or parsed.netloc!='fetchsandbox.com' or not parsed.path.startswith('/runs/') or not parse_qs(parsed.query).get('flow'):raise SystemExit('Receipt identity/URL mismatch for '+id)
  if not entry.get('check_ids') or sum(entry.get('counts',{}).values())!=len(entry['check_ids']):raise SystemExit('Incomplete receipt audit for '+id)
  date=datetime.datetime.fromisoformat(entry['snapshot_at'].replace('Z','+00:00')).astimezone(ZoneInfo('America/Los_Angeles')).date()
  labels={'held':'passed','violated':'failed','unmeasured':'not checked'}
  counts=entry['counts']
  if set(counts)-set(labels):raise SystemExit('Unknown receipt status for '+id)
  label=str(date)+' · '+', '.join(str(counts[k])+' '+labels[k] for k in labels if counts.get(k))
  rendered.append('| '+str(n)+' | '+' | '.join(cells)+' | ['+label+']('+entry['receipt_url']+') |')
 if len(set(seen))!=len(seen) or set(seen)!=set(workflow_ids):raise SystemExit('Catalog definitions/receipt rows differ')
 result='\n'.join(lines[:start]+rendered+lines[end:])+'\n'
 totals=collections.Counter(entries[id]['verdict'] for id in seen)
 if set(totals)-{'verified','failing','inconclusive'}:raise SystemExit('Unknown receipt verdict')
 summary=f"All {len(seen)} main-table workflows have accessible receipts: **{totals['verified']} verified within their\nrecorded scope, {totals['failing']} with failed checks, and {totals['inconclusive']} with checks that could not all be\nverified**."
 return re.sub(r'All \d+ main-table workflows have accessible receipts: \*\*.*?verified\*\*\.',lambda _:summary,result,flags=re.S)

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--check',action='store_true');args=ap.parse_args()
 data=json.loads(subprocess.check_output(['npx','tsx','verify/export-docs.ts'],cwd=ROOT/'acme-ops',text=True));bad=[]
 if {w['id'] for w in data}!=set(WHY):raise SystemExit('Business needs must explicitly cover every workflow definition')
 for w in data:
  path=ROOT/'docs/workflows'/f"{w['id']}.md";content=render(w)
  if args.check:
   if not path.exists() or path.read_text()!=content:bad.append(str(path.relative_to(ROOT)))
  else:path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
 catalog=ROOT/'docs/WORKFLOWS.md';rendered=render_catalog_receipts(catalog.read_text(),[w['id'] for w in data])
 if args.check:
  if catalog.read_text()!=rendered:bad.append('docs/WORKFLOWS.md')
 else:catalog.write_text(rendered)
 if bad:raise SystemExit('Stale/missing workflow documentation: '+', '.join(bad))
 print(f"{'Checked' if args.check else 'Generated'} {len(data)} business guides; {sum(len(w['agents'])+bool(w['compose']) for w in data)} declared roles; baseline inputs validate against their schemas. No workflow executed.")
if __name__=='__main__':main()
