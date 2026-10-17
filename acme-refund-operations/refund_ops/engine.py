"""Six specialist roles, persistent evidence, approval, refund and customer resolution."""
import copy, hashlib, json, os, re, time, uuid
from decimal import Decimal, InvalidOperation
from . import VERSION
from . import observability, presentation
from .policy import assess, digest
from .providers import ProviderFailure
from .store import Busy

ROLES=[('intake','Acme Customer Support','Resolve the requester, original purchase and refund request.'),
       ('purchase_research','Acme Revenue Operations','Verify payment ownership, purchase age, disputes and prior refunds.'),
       ('product_inventory','Acme Product Operations','Read SKU/catalog and trusted merchant return or usage evidence.'),
       ('policy_research','Acme Refund Assurance','Retrieve and cite versioned company/product policies; summarize evidence.'),
       ('billing_policy','Acme Finance Operations','Decide eligibility and authorization; reconcile and execute the original-payment refund.'),
       ('customer_handoff','Acme Customer Support','Send the measured outcome in Gmail and the original Slack thread.')]

class Engine:
    def __init__(self,store,providers,policies,approvers,now=None):
        self.store,self.p,self.policies,self.approvers=store,providers,policies,set(approvers);self.now=now or time.time
    def describe(self):
        catalog,source=self.policies.catalog()
        return {'workflow':'acme-refund-operations','title':'Acme Refund Eligibility and Resolution','version':VERSION,
                'organization':'Acme Corporation','department':'Customer Service and Revenue Operations','owner':'Raj',
                'owner_team':'Refund Assurance','environment':'production','synthetic_demo':True,'live_money_enabled':False,
                'description':'Purchase and product/policy research, eligibility, automatic or manager-approved test refund, and customer resolution.',
                'agents':[{'id':n,'owner_organization':o,'description':d} for n,o,d in ROLES],
                'policy_source':source,'policy_version':catalog['version'],'policy_documents':[catalog['company'],*catalog['product_policies']],
                'products':catalog['products'],'commands':['describe','policies','start','status','decide','resume'],
                'execution_controls':{'eligibility_before_approval':True,'approval_from_pct':20,'maximum_cumulative_pct':70,'approval_hours':24,'durable_state':'DynamoDB'},
                'looplabs_integration':'No LoopLabs-specific runtime dependency or enforcement hook.'}
    def status(self,case_id):
        r=self.store.get('CASE#'+case_id)
        if not r:raise KeyError('Case not found')
        # Only owner-authenticated API exposes this full case; logs remain redacted.
        return {**{k:v for k,v in r.items() if k not in ['pk','lease_owner','lease_until']},'refund_reference':presentation.reference(r)}
    def start(self,request):
        request=copy.deepcopy(request)
        if request.get('requestText'):
            text=request['requestText'];pi=re.search(r'\bpi_[A-Za-z0-9]+\b',text);pct=re.search(r'(\d+(?:\.\d{1,2})?)\s*%',text)
            if not pi or not pct:raise ValueError('Include the original payment reference and refund percentage, e.g. refund pi_… 20%')
            request.setdefault('paymentIntent',pi.group());request.setdefault('requestedPct',pct.group(1))
        required=['caseId','customerEmail','paymentIntent','requestedPct']
        if any(not request.get(k) for k in required):raise ValueError('Required: caseId, customerEmail, paymentIntent, requestedPct')
        if not re.fullmatch(r'[\w.-]{1,120}',request['caseId']):raise ValueError('Invalid caseId')
        if not re.fullmatch(r'pi_[A-Za-z0-9]+',request['paymentIntent']):raise ValueError('Invalid payment reference')
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',request['customerEmail']):raise ValueError('Invalid customer email')
        request['customerEmail']=request['customerEmail'].lower()
        try:pct=Decimal(str(request['requestedPct']))
        except InvalidOperation:raise ValueError('Refund percentage must be a number') from None
        if not pct.is_finite() or pct<=0 or pct>100 or pct.as_tuple().exponent < -2:raise ValueError('Refund percentage must be greater than 0 and at most 100, with at most two decimals')
        request['requestedPct']=str(pct);request.pop('requestText',None)
        key='CASE#'+request['caseId'];identity={k:request[k] for k in ['customerEmail','paymentIntent','requestedPct']}
        row={'case_id':request['caseId'],'run_id':'refund-'+uuid.uuid4().hex,'trace_id':f'{int(self.now()):08x}'+uuid.uuid4().hex[:24],'root_span_id':uuid.uuid4().hex[:16],'input':request,'request_hash':digest(identity),
             'created_at':int(self.now()),'updated_at':int(self.now()),'phase':'NEW','events':[],'notifications':{},'agents':[],
             'ttl':int(self.now())+30*86400,'deployment_version':VERSION,'attempt':0}
        if not self.store.create(key,row):
            old=self.store.get(key)
            if old['request_hash']!=row['request_hash']:raise ValueError('Existing case has different purchase or amount; do not change an approved action')
            return self.status(request['caseId'])
        return self.drive(request['caseId'])
    def drive(self,case_id,decision=None,user=None):
        key='CASE#'+case_id
        if not self.store.get(key):raise KeyError('Case not found')
        owner=uuid.uuid4().hex;self.store.lock(key,owner);self.r=self.store.get(key);self.key,self.owner=key,owner
        self.p.event=self.event;self.p.span=lambda name:observability.span(self.r,name);self.r['attempt']+=1
        payment_key=None
        try:
            if self.r['phase'] in ['COMPLETED','DECLINED','REJECTED','EXPIRED']:
                self.notify(self.r['phase']);return self.status(case_id)
            if decision:
                if user not in self.approvers:raise PermissionError('Only a configured Acme refund manager can decide')
                if self.r['phase']!='AWAITING_APPROVAL':raise ValueError('Case is not awaiting approval')
                if self.now()>=self.r['approval_expires_at']:
                    self.r['phase']='EXPIRED';self.event('approval_expired',agent='billing_policy');self.notify('EXPIRED');return self.status(case_id)
                if decision not in ['approve','reject']:raise ValueError('Invalid approval decision')
                self.r['approval']={'decision':decision,'actor':user,'at':int(self.now()),'snapshot_hash':self.r['assessment']['snapshot_hash']}
                self.event('approval_approved' if decision=='approve' else 'approval_rejected',agent='billing_policy',actor_id=user)
                if decision=='reject':self.r['phase']='REJECTED';self.notify('REJECTED');return self.status(case_id)
            elif self.r['phase']=='AWAITING_APPROVAL':return self.status(case_id)
            if not self.r.get('started'):
                self.r['started']=True;self.event('workflow_started',agent='intake',trigger_channel=self.r['input'].get('channel','api'))
            self.stage('intake',lambda:{'request_verified_for_processing':True})
            payment_key='PAYMENT#'+self.r['input']['paymentIntent'];self.store.lock(payment_key,owner)
            reservation=self.store.get(payment_key)
            if reservation.get('pending_case') and reservation['pending_case']!=case_id:
                self.r['phase']='HELD';self.r['hold_reason']='Another refund case has an unresolved financial action for this payment';self.event('action_withheld',agent='billing_policy',reason='unresolved_payment_action');return self.status(case_id)
            # A recorded provider effect is reconciled, never calculated into another refund.
            if self.r.get('refund'):
                self.resolve_refund(payment_key);return self.status(case_id)
            payment=self.stage('purchase_research',lambda:self.p.purchase(self.r['input']['paymentIntent'],self.r['input']['customerEmail']))
            crm=self.p.crm(self.r['input']['customerEmail']);self.r['crm']=crm
            catalog,source=self.policies.catalog();self.event('policy_evidence_retrieved',agent='policy_research',source=source,version=catalog['version'],sha256=digest(catalog))
            if not catalog.get('synthetic_demo') or catalog.get('organization')!='Acme Corporation':raise ValueError('Unapproved policy catalog')
            sku=payment.get('metadata',{}).get('acme_sku');product=next((p for p in catalog['products'] if p['sku']==sku),None)
            if not product:raise ValueError('Authoritative product policy mapping missing')
            self.r['product']={'name':product['name'],'sku':product['sku']}
            self.r['policy_display']={k:catalog['company'][k] for k in ['approval_from_pct','max_refund_pct','version']}
            order,order_source=self.policies.order(payment['id'])
            self.stage('product_inventory',lambda:{'sku':sku,'inventory_status':product['inventory_status'],'order_evidence':order_source})
            terms=next((t for t in catalog['product_policies'] if t['id']==product['policy_id']),None)
            if not terms:raise ValueError('Applicable product policy is missing')
            research=self.stage('policy_research',lambda:self.p.research({'product':product,'company_policy':catalog['company'],'product_policy':terms,
                'purchase_facts':{'paid_minor':payment['amount_received'],'currency':payment['currency'],'created':payment['created'],'already_refunded_minor':payment['refund_committed']}}))
            self.r['research']=research;self.r['policy_source']=source
            assessment=self.stage('billing_policy',lambda:assess(payment,product,catalog['company'],terms,order,self.r['input']['requestedPct'],self.now()))
            previous=self.r.get('assessment');self.r['assessment']=assessment
            self.event('policy_evaluated',agent='billing_policy',decision=assessment['decision'],reasons=assessment['reasons'],policy_evidence=assessment['evidence'])
            if assessment['decision']=='hold':self.r['phase']='HELD';self.r['hold_reason']='Missing or conflicting merchant evidence';self.notify('HELD');return self.status(case_id)
            if assessment['decision']=='decline':self.r['phase']='DECLINED';self.notify('DECLINED');return self.status(case_id)
            approved=self.r.get('approval',{}).get('decision')=='approve'
            if approved and self.r['approval']['snapshot_hash']!=assessment['snapshot_hash']:
                self.r.pop('approval',None);self.r.pop('approval_message',None);approved=False;self.event('approval_invalidated',agent='billing_policy',reason='purchase_or_policy_evidence_changed')
            if assessment['decision']=='approval' and not approved:
                self.r['phase']='AWAITING_APPROVAL';self.r['approval_expires_at']=int(self.now())+86400;self.save()
                self.event('approval_requested',agent='billing_policy',amount_minor=assessment['amount_minor'],policy_hash=assessment['snapshot_hash'])
                self.approval_card();self.notify('AWAITING_APPROVAL');return self.status(case_id)
            # Persist the business operation BEFORE the provider call. Stable idempotency identity survives process death.
            self.r['refund']={'state':'intent','amount_minor':assessment['amount_minor'],'currency':assessment['currency'],'created_at':int(self.now()),'case_id':case_id}
            self.save();self.store.save(payment_key,{**reservation,'pending_case':case_id},owner)
            self.resolve_refund(payment_key);return self.status(case_id)
        except (PermissionError,KeyError):raise
        except Exception as exc:
            if isinstance(exc,Busy):raise
            self.r['phase']='HELD';self.r['hold_reason']=str(exc)[:250] if isinstance(exc,(ValueError,ProviderFailure)) else 'Evidence or provider processing requires review'
            self.event('workflow_held',agent=self.p.agent,reason=self.r['hold_reason']);self.notify('HELD');return self.status(case_id)
        finally:
            self.save()
            if payment_key:self.store.unlock(payment_key,owner)
            self.store.unlock(key,owner)
    def resolve_refund(self,payment_key):
        self.p.agent='billing_policy';op=self.r['refund'];pi=self.r['input']['paymentIntent'];case_id=self.r['case_id']
        if op.get('provider_id'):
            r=self.p.refund_get(op['provider_id'])
        else:
            payment=self.p.purchase(pi,self.r['input']['customerEmail'])
            matches=[x for x in payment['refunds'] if x.get('metadata',{}).get('acme_refund_case')==case_id]
            if len(matches)>1:raise ValueError('Multiple refund records found; manual reconciliation required')
            if matches:r=matches[0]
            else:
                if self.now()-op['created_at']>=23*3600:raise ValueError('Uncertain operation exceeds safe automatic retry window; reconcile manually')
                # Confirm enough balance even if unrelated refunds were created outside this workflow.
                if op['amount_minor']>payment['amount_received']-payment['refund_committed']:raise ValueError('Refundable balance changed before execution')
                catalog,_=self.policies.catalog();order,_=self.policies.order(pi)
                product=next(x for x in catalog['products'] if x['sku']==payment.get('metadata',{}).get('acme_sku'))
                terms=next(x for x in catalog['product_policies'] if x['id']==product['policy_id'])
                current=assess(payment,product,catalog['company'],terms,order,self.r['input']['requestedPct'],self.now())
                if current['snapshot_hash']!=self.r['assessment']['snapshot_hash'] or not current['eligible']:raise ValueError('Policy or purchase evidence changed; refund execution held')
                self.save()  # Fencing check immediately before the money-moving call.
                r=self.p.refund(pi,int(op['amount_minor']),case_id,op['currency'])
        if r.get('payment_intent')!=pi or int(r.get('amount',-1))!=int(op['amount_minor']) or r.get('currency')!=op['currency']:
            raise ValueError('Provider refund does not match the approved action')
        op.update(provider_id=r['id'],state=r['status']);self.save()
        if r['status']=='succeeded':self.r['phase']='COMPLETED';self.notify('COMPLETED')
        elif r['status'] in ['failed','canceled']:self.r['phase']='REFUND_FAILED';self.notify('REFUND_FAILED')
        else:self.r['phase']='REFUND_PENDING';self.notify('REFUND_PENDING')
        reservation=self.store.get(payment_key)
        # Known provider reference can now be included in Stripe's committed balance on other cases.
        self.store.save(payment_key,{**reservation,'pending_case':None},self.owner)
        self.event('workflow_outcome',agent='billing_policy',outcome=self.r['phase'],provider_reference=r['id'])
    def stage(self,name,fn):
        self.p.agent=name
        with observability.span(self.r,'agent.'+name):
            self.event('agent_started',agent=name);value=fn()
        if name not in self.r['agents']:self.r['agents'].append(name)
        self.event('agent_completed',agent=name);return value
    def approval_card(self):
        if self.r.get('approval_message'):return
        channel=os.getenv('REFUND_MANAGER_CHANNEL') or self.r['input'].get('slackChannel')
        if not channel:return
        a=self.r['assessment'];self.r['approval_message']='intent';self.save()
        product,company=self.presentation_sources()
        text=presentation.approval(self.r,product,company)
        blocks=[{'type':'section','text':{'type':'mrkdwn','text':text}}, {'type':'actions','elements':[
            {'type':'button','text':{'type':'plain_text','text':'Approve refund'},'style':'primary','action_id':'acme_refund_approve','value':self.r['case_id']},
            {'type':'button','text':{'type':'plain_text','text':'Decline refund'},'style':'danger','action_id':'acme_refund_reject','value':self.r['case_id']}]}]
        thread=self.r['input'].get('slackThread') if channel==self.r['input'].get('slackChannel') else None
        r=self.p.slack(channel,text,thread,blocks);self.r['approval_message']=r['ts'];self.r['approval_channel']=channel
        if channel==self.r['input'].get('slackChannel') and not self.r['input'].get('slackThread'):self.r['input']['slackThread']=r['ts']
        self.save()
    def notify(self,outcome):
        self.p.agent='customer_handoff';self.event('agent_started',agent='customer_handoff')
        case_id=self.r['case_id'];a=self.r.get('assessment',{});op=self.r.get('refund',{})
        product,company=self.presentation_sources();view=presentation.render(self.r,outcome,product,company)
        for destination in ['email','slack']:
            if destination=='slack' and not self.r['input'].get('slackChannel'):continue
            key=outcome+':'+destination;prev=self.r['notifications'].get(key)
            if prev and prev.get('state') in ['sent','uncertain']:continue
            self.r['notifications'][key]={'state':'uncertain'};self.save();self.event('customer_output_prepared',agent='customer_handoff',channel=destination,outcome=outcome)
            try:
                if destination=='email':
                    ref=self.p.mail(self.r['input']['customerEmail'],view['subject'],view['email'],case_id+':'+key,self.r['input'].get('gmailThread'),self.r['input'].get('gmailMessageId'))['id']
                else:ref=self.p.slack(self.r['input']['slackChannel'],presentation.render(self.r,outcome,product,company)['slack'],self.r['input'].get('slackThread'))['ts']
                self.r['notifications'][key]={'state':'sent','provider_reference':ref};self.save();self.event('customer_output_sent',agent='customer_handoff',channel=destination,outcome=outcome,provider_reference=ref)
            except ProviderFailure as exc:
                self.r['notifications'][key]={'state':'uncertain' if exc.uncertain else 'failed'};self.save();self.event('customer_output_withheld',agent='customer_handoff',channel=destination,outcome=outcome)
        # Updating a known Slack message is retry-safe; remove stale approval buttons.
        approval_ts=self.r.get('approval_message')
        if outcome!='AWAITING_APPROVAL' and approval_ts and approval_ts!='intent' and (self.r.get('approval_display_state')!=outcome or self.r.get('approval_display_revision')!=presentation.REVISION):
            display=presentation.resolved_card(self.r,outcome,product,company)
            try:
                self.p.slack_update(self.r.get('approval_channel') or self.r['input']['slackChannel'],approval_ts,display)
                self.r['approval_display_state']=outcome;self.r['approval_display_revision']=presentation.REVISION;self.save()
            except ProviderFailure:self.event('approval_status_update_withheld',agent='customer_handoff',outcome=outcome)
        if 'customer_handoff' not in self.r['agents']:self.r['agents'].append('customer_handoff')
        self.event('agent_completed',agent='customer_handoff')
    def presentation_sources(self):
        product=self.r.get('product',{});company=self.r.get('policy_display',{})
        if not product or not company:
            try:
                catalog,_=self.policies.catalog()
                product=product or next((p for p in catalog['products'] if p['sku']==self.r.get('assessment',{}).get('sku')), {})
                company=company or catalog['company']
            except Exception:pass  # Presentation lookup must not invent a refund or block an existing outcome.
        return product,company
    def save(self):
        self.r['updated_at']=int(self.now());self.store.save(self.key,self.r,self.owner)
    def event(self,event,**fields):
        item={'event':event,'event_id':str(uuid.uuid4()),'run_id':self.r['run_id'],'case_id':self.r['case_id'],'trace_id':self.r['trace_id'],
              'refund_reference':presentation.reference(self.r),'span_id':observability.span_id(self.r['root_span_id']),'attempt':self.r['attempt'],'timestamp':int(self.now()*1000),'deployment_version':VERSION,**fields}
        self.r['events']=(self.r['events']+[item])[-180:];self.save();print(json.dumps(item,default=str),flush=True)
