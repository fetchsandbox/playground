#!/usr/bin/env python3
"""Render/check workflow guides from code, contracts and historical receipts; no provider calls."""
import argparse,collections,json,pathlib,subprocess,sys
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
'support-escalation':'Support needs to combine incident severity, account context and billing health so urgent cases reach the right team with a reviewed customer reply.',
}
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
 lines+=['','## Setup and run','','From the repository root:','','```bash','cd acme-ops','npm ci','npm run check','npm test','npm run bundle',f'WORKFLOW={id} STATE_FILE=.state/{id}.json node --env-file=.env dist/main.mjs','```','','Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).','','The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.','','## FetchSandbox verification','','Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.','','```bash','cd acme-ops','npm run bundle',f'node verify/relay-proof.mjs {id}','```','','This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.','','### Declared scenarios','','| Check | Business behavior | Contract blocker |','|---|---|---|']
 for c in w['checks']:lines.append(f"| `{c['id']}` | {cell(c.get('label',''))} | {cell(c['blocked']['reason']) if c['blocked'] else 'Executable declaration; result comes from a receipt'} |")
 lines+=['','### Saved evidence — historical, not a fresh run','',f"The checked-in receipt records app version `{receipt.get('app_version','unrecorded')}`, verdict **{receipt.get('verdict','unknown')}**, and statuses: "+', '.join(f'**{v} {k}**' for k,v in sorted(counts.items()))+'.', '',f"[Recorded receipt]({receipt['receipt_url']}) · [Saved result]({base}verify/receipts/{id}.json)",'','Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.','','## Source and contract','',f'- [Workflow and business rules]({base}src/workflows/{id}.ts)',f'- [Executable verification contract]({base}verify/contracts/{id}.mjs)',f'- [Shared state, approval and recovery engine]({base}src/kit/engine.ts)','', '<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->','']
 if id=='product-cancellation':lines[-2:-2]=['','See the [optional LoopLabs observation and exact approval adapter](../../acme-ops/LOOPLABS.md).','']
 return '\n'.join(lines)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--check',action='store_true');args=ap.parse_args()
 data=json.loads(subprocess.check_output(['npx','tsx','verify/export-docs.ts'],cwd=ROOT/'acme-ops',text=True));bad=[]
 if {w['id'] for w in data}!=set(WHY):raise SystemExit('Business needs must explicitly cover every workflow definition')
 for w in data:
  path=ROOT/'docs/workflows'/f"{w['id']}.md";content=render(w)
  if args.check:
   if not path.exists() or path.read_text()!=content:bad.append(str(path.relative_to(ROOT)))
  else:path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
 if bad:raise SystemExit('Stale/missing workflow documentation: '+', '.join(bad))
 print(f"{'Checked' if args.check else 'Generated'} {len(data)} business guides; {sum(len(w['agents'])+bool(w['compose']) for w in data)} declared roles; baseline inputs validate against their schemas. No workflow executed.")
if __name__=='__main__':main()
