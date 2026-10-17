"""Deterministic unit tests using explicit provider doubles, not live/twin proof."""
import copy,json,time
from pathlib import Path
import pytest
from refund_ops.engine import Engine
from refund_ops.store import MemoryStore
from refund_ops.providers import ProviderFailure
from refund_ops.policy import assess

NOW=int(time.time())
CAT=json.loads((Path(__file__).parents[1]/'policies/catalog.json').read_text())
class Policies:
    def __init__(self):self.cat=copy.deepcopy(CAT);self.order_data={'payment_intent':'pi_demo','sku':'ACME-EDGE-100','return_status':'received_inspected','return_condition':'resalable','usage_pct':5}
    def catalog(self):return copy.deepcopy(self.cat),{'uri':'unit-double://catalog','s3_version_id':'unit-v1'}
    def order(self,pi):return copy.deepcopy(self.order_data),{'uri':'unit-double://orders/'+pi}
class Providers:
    def __init__(self):
        self.payment={'id':'pi_demo','customer':'cus_demo','amount_received':100000,'status':'succeeded','created':NOW-86400,'currency':'usd','metadata':{'acme_sku':'ACME-EDGE-100'},'livemode':False,'refunds':[],'refund_committed':0};self.writes=[];self.emails=[];self.posts=[];self.updates=[];self.event=lambda *a,**k:None;self.agent='intake';self.crash=False;self.mail_failure=None;self.pending=False
    def purchase(self,pi,email):
        if email!='customer@example.test':raise ValueError('Purchase does not belong to the requesting customer')
        p=copy.deepcopy(self.payment);p['refund_committed']=sum(x['amount'] for x in p['refunds'] if x['status'] not in ['failed','canceled']);return p
    def crm(self,email):return {'found':True,'contact_id':'crm_demo'}
    def research(self,facts):return {'method':'unit-double','summary':'Company C3 and product P1 apply.'}
    def refund(self,pi,amount,case,currency):
        r={'id':'re_'+str(len(self.writes)+1),'payment_intent':pi,'amount':amount,'currency':currency,'status':'pending' if self.pending else 'succeeded','metadata':{'acme_refund_case':case}}
        self.writes.append(r);self.payment['refunds'].append(copy.deepcopy(r))
        if self.crash:raise SystemExit('simulated process death after provider commit')
        return r
    def refund_get(self,ref):return next(copy.deepcopy(x) for x in self.payment['refunds'] if x['id']==ref)
    def mail(self,*args):
        if self.mail_failure:raise self.mail_failure
        self.emails.append(args);return {'id':'mail_'+str(len(self.emails))}
    def slack(self,*args):self.posts.append(args);return {'ts':str(len(self.posts))}
    def slack_update(self,*args):self.updates.append(args);return {'ts':args[1]}
@pytest.fixture
def setup():
    store=MemoryStore();p=Providers();pol=Policies();clock=[NOW]
    def engine():return Engine(store,p,pol,['RAJ'],now=lambda:clock[0])
    return engine,p,pol,clock

def request(pct=15,case='CASE-1',**extra):return {'caseId':case,'customerEmail':'customer@example.test','paymentIntent':'pi_demo','requestedPct':pct,**extra}

@pytest.mark.parametrize('pct,phase',[(0.01,'COMPLETED'),(19.99,'COMPLETED'),(20,'AWAITING_APPROVAL'),(70,'AWAITING_APPROVAL'),(70.01,'DECLINED'),(100,'DECLINED')])
def test_boundaries(setup,pct,phase):
    e,p,_,_=setup;r=e().start(request(pct));assert r['phase']==phase;assert len(p.writes)==(1 if phase=='COMPLETED' else 0)

def test_approval_then_customer_outcome_and_same_thread(setup):
    e,p,_,_=setup;r=e().start(request(20,slackChannel='D_DEMO',slackThread='123.456',channel='slack'))
    assert not p.writes and r['phase']=='AWAITING_APPROVAL'
    r=e().drive('CASE-1','approve','RAJ');assert r['phase']=='COMPLETED' and len(p.writes)==1
    assert any('refund of $200.00 USD' in m[2] and 'is complete' in m[2] for m in p.emails);assert all(x[2]=='123.456' for x in p.posts)
    assert set(r['agents'])=={'intake','purchase_research','product_inventory','policy_research','billing_policy','customer_handoff'}

def test_reject_notifies_without_refund(setup):
    e,p,_,_=setup;e().start(request(20));r=e().drive('CASE-1','reject','RAJ');assert r['phase']=='REJECTED' and not p.writes
    assert 'declined' in p.emails[-1][2]

def test_expiry_no_financial_action(setup):
    e,p,_,clock=setup;e().start(request(20));clock[0]+=86401;r=e().drive('CASE-1','approve','RAJ');assert r['phase']=='EXPIRED' and not p.writes

def test_unknown_manager_cannot_decide(setup):
    e,p,_,_=setup;e().start(request(20))
    with pytest.raises(PermissionError):e().drive('CASE-1','approve','OTHER')
    assert not p.writes

def test_policy_changed_after_approval_requires_reassessment(setup):
    e,p,pol,_=setup;e().start(request(20));pol.cat['company']['version']='new-version';r=e().drive('CASE-1','approve','RAJ')
    assert r['phase']=='AWAITING_APPROVAL' and not p.writes and not r.get('approval')

def test_purchase_ownership(setup):
    e,p,_,_=setup;r=e().start(request(customerEmail='other@example.test'));assert r['phase']=='HELD' and not p.writes

def test_outside_window(setup):
    e,p,_,_=setup;p.payment['created']=NOW-31*86400;r=e().start(request());assert r['phase']=='DECLINED' and not p.writes

def test_return_evidence_missing_holds(setup):
    e,p,pol,_=setup;pol.order_data['return_status']='not_received';r=e().start(request());assert r['phase']=='HELD' and not p.writes

def test_unpaid_and_disputed(setup):
    e,p,_,_=setup;p.payment['status']='processing';p.payment['disputed']=True;r=e().start(request());assert r['phase']=='DECLINED' and not p.writes

def test_no_policy_mapping_holds(setup):
    e,p,_,_=setup;p.payment['metadata']['acme_sku']='UNKNOWN';r=e().start(request());assert r['phase']=='HELD' and not p.writes

def test_nonrefundable_service(setup):
    e,p,pol,_=setup;p.payment['metadata']['acme_sku']='ACME-CAL-SVC';pol.order_data['sku']='ACME-CAL-SVC';r=e().start(request());assert r['phase']=='DECLINED' and not p.writes

@pytest.mark.parametrize('usage,expected',[(None,'HELD'),(10,'COMPLETED'),(11,'DECLINED')])
def test_software_policy_evidence(setup,usage,expected):
    e,p,pol,_=setup;p.payment['metadata']['acme_sku']='ACME-MONITOR-PRO';pol.order_data.update(sku='ACME-MONITOR-PRO',usage_pct=usage);r=e().start(request());assert r['phase']==expected

def test_duplicate_case_and_changed_amount(setup):
    e,p,_,_=setup;e().start(request());r=e().start(request());assert r['phase']=='COMPLETED' and len(p.writes)==1
    with pytest.raises(ValueError):e().start(request(16))

def test_cumulative_cap_no_split_bypass(setup):
    e,p,_,_=setup
    for n in range(4):assert e().start(request(15,'C-'+str(n)))['phase']=='COMPLETED'
    assert e().start(request(15,'C-5'))['phase']=='DECLINED' and len(p.writes)==4

def test_restart_after_commit_reconciles_without_second_refund(setup):
    e,p,_,_=setup;p.crash=True
    with pytest.raises(SystemExit):e().start(request())
    assert len(p.writes)==1
    p.crash=False;r=e().drive('CASE-1');assert r['phase']=='COMPLETED' and len(p.writes)==1

def test_other_case_held_until_uncertain_action_resolved(setup):
    e,p,_,_=setup;p.crash=True
    with pytest.raises(SystemExit):e().start(request())
    p.crash=False;r=e().start(request(10,'CASE-2'));assert r['phase']=='HELD' and len(p.writes)==1

def test_pending_is_not_claimed_success(setup):
    e,p,_,_=setup;p.pending=True;r=e().start(request());assert r['phase']=='REFUND_PENDING';assert 'has not confirmed completion yet' in p.emails[-1][2]
    p.payment['refunds'][0]['status']='succeeded';r=e().drive('CASE-1');assert r['phase']=='COMPLETED' and len(p.writes)==1

def test_notification_uncertainty_does_not_repeat_money_or_email(setup):
    e,p,_,_=setup;p.mail_failure=ProviderFailure('gmail',uncertain=True);r=e().start(request());assert r['phase']=='COMPLETED'
    assert r['notifications']['COMPLETED:email']['state']=='uncertain';p.mail_failure=None;e().drive('CASE-1');assert len(p.writes)==1 and not p.emails

def test_known_notification_failure_retries_only_notification(setup):
    e,p,_,_=setup;p.mail_failure=ProviderFailure('gmail',429);r=e().start(request());assert r['phase']=='COMPLETED'
    p.mail_failure=None;e().drive('CASE-1');assert len(p.writes)==1 and len(p.emails)==1

@pytest.mark.parametrize('pct',[0,-1,101,'NaN','0.001','not-a-number','Infinity'])
def test_invalid_percentage(setup,pct):
    e,p,_,_=setup
    with pytest.raises(ValueError):e().start(request(pct))
    assert not p.writes


def test_approval_card_sent_to_manager_not_customer_channel(setup,monkeypatch):
    e,p,_,_=setup;monkeypatch.setenv('REFUND_MANAGER_CHANNEL','D_MANAGER')
    r=e().start(request(20,slackChannel='D_CUSTOMER',slackThread='123.456'))
    cards=[x for x in p.posts if len(x)>3 and x[3]]
    assert len(cards)==1 and cards[0][0]=='D_MANAGER' and cards[0][2] is None
    assert r['input']['slackThread']=='123.456' and not p.writes
    e().drive('CASE-1','approve','RAJ')
    assert any(x[0]=='D_CUSTOMER' and x[2]=='123.456' and 'Refund completed' in x[1] for x in p.posts)


def test_final_outcome_replaces_approval_buttons_without_second_refund(setup):
    e,p,_,_=setup;e().start(request(20,slackChannel='D_DEMO',slackThread='123.456'))
    e().drive('CASE-1','approve','RAJ');assert len(p.updates)==2 and 'Processing refund' in p.updates[0][2] and 'Approved by <@RAJ>' in p.updates[1][2]
    e().drive('CASE-1');assert len(p.updates)==2 and len(p.writes)==1

def test_unknown_case_does_not_create_an_orphan_lease(setup):
    e,_,_,_=setup;engine=e()
    with pytest.raises(KeyError):engine.drive('UNKNOWN')
    assert engine.store.data=={}


def test_customer_message_identity_is_unique_per_case_and_stable_on_resume(setup):
    e,p,_,_=setup;e().start(request(15,'FIRST'));e().start(request(15,'SECOND'))
    assert len(p.emails)==2 and p.emails[0][3]!=p.emails[1][3]
    assert p.emails[0][3]=='FIRST:COMPLETED:email'
    e().drive('FIRST');assert len(p.emails)==2

def test_processing_card_precedes_revalidation_and_provider_effect(setup):
    e,p,_,_=setup;e().start(request(20,slackChannel='D_DEMO'))
    purchase=p.purchase
    def checking(pi,email):
        assert p.updates and 'Processing refund' in p.updates[0][2]
        assert 'confirmed outcome' in p.updates[0][2]
        return purchase(pi,email)
    p.purchase=checking
    r=e().drive('CASE-1','approve','RAJ')
    assert r['phase']=='COMPLETED' and len(p.writes)==1
    assert 'Refund completed' in p.updates[-1][2]

def test_untrusted_or_expired_decision_never_displays_processing(setup):
    e,p,_,clock=setup;e().start(request(20,slackChannel='D_DEMO'))
    with pytest.raises(PermissionError):e().drive('CASE-1','approve','OTHER')
    assert not p.updates
    clock[0]+=86401;e().drive('CASE-1','approve','RAJ')
    assert not any('Processing refund' in x[2] for x in p.updates) and not p.writes

def test_processing_display_failure_does_not_repeat_or_block_refund(setup):
    e,p,_,_=setup;e().start(request(20,slackChannel='D_DEMO'));update=p.slack_update
    def failing(*args):
        if 'Processing refund' in args[2]:raise ProviderFailure('slack unavailable')
        return update(*args)
    p.slack_update=failing
    r=e().drive('CASE-1','approve','RAJ');assert r['phase']=='COMPLETED' and len(p.writes)==1
    e().drive('CASE-1');assert len(p.writes)==1
