import contextlib,copy,hmac,hashlib,json,re,time
from unittest.mock import Mock
import pytest
from shop.core import Shop,ShopError
from shop.integrations import Provider
class Store:
 def __init__(self):self.rows={}
 def get(self,k):return copy.deepcopy(self.rows.get(k))
 def put(self,r):self.rows[r['pk']]=copy.deepcopy(r)
 def create(self,r):self.rows.setdefault(r['pk'],copy.deepcopy(r))
 def save(self,r):self.put(r)
 def increment(self,k,ttl,field='count'):
  r=self.rows.setdefault(k,{'pk':k});r[field]=r.get(field,0)+1;r['ttl']=ttl;return r[field]
 def consume(self,k):
  if self.rows[k].get('used'):return False
  self.rows[k]['used']=True;return True
 @contextlib.contextmanager
 def lease(self,k):yield self.get(k)
 def orders(self,owner):return [self.get(k) for k,r in self.rows.items() if r.get('owner')==owner and k.startswith('ORD-')]
 def due(self,now):return [self.get(k) for k,r in self.rows.items() if r.get('due',now+1)<=now]
 def patch_due(self,r):self.rows[r['pk']]['due']=r['due']
class Repo:
 def __init__(self):self.evidence={};self.c={'version':'v1','products':[{'sku':'SKU1','name':'Gateway','unit_amount_minor':100000,'currency':'usd','inventory_status':'active','type':'hardware','policy_id':'POL1'}],'product_policies':[{'id':'POL1'}],'company':{}}
 def catalog(self):return copy.deepcopy(self.c)
 def mapping(self):return {'products':{'SKU1':{'price_id':'price_1','amount_minor':100000}}}
 def ensure_order(self,r):self.evidence.setdefault(r['payment_intent'],{'return_status':'not_received'})
 def order(self,pi):return copy.deepcopy(self.evidence[pi])
 def simulate(self,r,scenario):self.evidence[r['payment_intent']]['return_status']='received_inspected'
class Fake:
 def __init__(self):self.mails=[];self.created=[];self.paid=False;self.crm_calls=[];self.refund_calls=[];self.refund_rows=[];self.case=None;self.fail_crm=False;self.fail_mail=False
 def mail(self,email,subject,body,identity):
  self.mails.append({'email':email,'body':body,'identity':identity})
  if self.fail_mail:raise TimeoutError()
  return {'id':'mail_'+str(len(self.mails))}
 def customer(self,*args):return 'cus_1'
 def customer_get(self,id):return {'email':'a@example.test'}
 def checkout(self,r,customer,base):self.created.append(copy.deepcopy(r));self.oid=r['pk'];return {'id':'cs_test_one','url':'https://checkout.stripe.com/test','livemode':False}
 def checkout_get(self,id):return {'id':id,'livemode':False,'payment_status':'paid' if self.paid else 'unpaid','client_reference_id':self.oid,'payment_intent':'pi_1'}
 def payment(self,id):return {'id':id,'livemode':False,'status':'succeeded','amount_received':100000,'currency':'usd','customer':'cus_1','metadata':{'acme_sku':'SKU1','acme_shop_order':self.oid}}
 def refunds(self,pi):return self.refund_rows
 def crm_sync(self,r):
  self.crm_calls.append(copy.deepcopy(r))
  if self.fail_crm:raise TimeoutError()
  r['hubspot_deal']='deal_1'
 def refund_start(self,case,email,pi,pct):self.refund_calls.append((case,email,pi,pct));self.case={'phase':'AWAITING_APPROVAL','reference':'RF-TEST'};return self.case
 def refund_status(self,case):return self.case
@pytest.fixture
def c():
 db=Store();p=Fake();repo=Repo();s=Shop(db,p,repo,'secret',now=lambda:100000);u={'email':'a@example.test','owner':s.hash('a@example.test')};return s,p,repo,db,u

def checkout(c):
 s,p,repo,db,u=c;return s.checkout(u,'SKU1','a-valid-request-key','https://demo.test')['order_id']
def paid(c):
 oid=checkout(c);s,p,repo,db,u=c;p.paid=True;s.fulfill(oid);return oid

def test_otp_one_use_and_private_session(c):
 s,p,repo,db,u=c;r=s.request_code('A@example.test','ip');code=re.search(r'\b\d{6}\b',p.mails[-1]['body'])[0];token=s.verify(r['challenge'],code);assert s.session(token)['email']=='a@example.test'
 with pytest.raises(ShopError):s.verify(r['challenge'],code)
 assert 'code' not in r and 'email' not in r

def test_wrong_otp_attempts_and_expiry(c):
 s,p,repo,db,u=c;r=s.request_code('a@example.test','ip');code=re.search(r'\b\d{6}\b',p.mails[-1]['body'])[0]
 for i in range(6):
  with pytest.raises(ShopError):s.verify(r['challenge'],'wrong')
 with pytest.raises(ShopError):s.verify(r['challenge'],code)
 s.now=lambda:200000
 with pytest.raises(ShopError):s.verify(r['challenge'],code)

def test_auth_limits_and_invalid_session(c):
 s,p,repo,db,u=c
 for i in range(4):s.request_code('a@example.test','ip')
 with pytest.raises(ShopError) as e:s.request_code('a@example.test','ip')
 assert e.value.status==429
 with pytest.raises(ShopError):s.session('forged')

def test_checkout_retry_reuses_provider_session(c):
 oid=checkout(c);s,p,repo,db,u=c;again=s.checkout(u,'SKU1','a-valid-request-key','https://demo.test');assert again['order_id']==oid and len(p.created)==1

def test_unpaid_session_cannot_create_paid_evidence(c):
 oid=checkout(c);s,p,repo,db,u=c;s.fulfill(oid);assert db.get(oid)['state']=='CHECKOUT_PENDING' and repo.evidence=={} and not p.crm_calls and not p.mails;assert db.get(oid)['due']>100000

@pytest.mark.parametrize('bad',[{'livemode':True},{'amount_received':1},{'currency':'eur'},{'status':'processing'},{'metadata':{'acme_sku':'WRONG'}},{'customer':'wrong'}])
def test_mismatched_payment_does_not_fulfill(c,bad):
 oid=checkout(c);s,p,repo,db,u=c;p.paid=True;original=p.payment;p.payment=lambda id:original(id)|bad
 if 'customer' in bad:p.customer_get=lambda id:{'email':'attacker@example.test'}
 with pytest.raises(ShopError):s.fulfill(oid)
 assert repo.evidence=={} and not p.crm_calls

def test_wrong_checkout_identity_rejected(c):
 oid=checkout(c);s,p,repo,db,u=c
 with pytest.raises(ShopError):s.fulfill(oid,'cs_other')
 assert repo.evidence=={}

def test_purchase_sync_repeatable_and_returns_not_automatically_approved(c):
 oid=paid(c);s,p,repo,db,u=c;s.fulfill(oid);assert len(p.mails)==1 and db.get(oid)['state']=='PAID' and db.get(oid)['sync_state']=='synced';assert repo.order('pi_1')['return_status']=='not_received'

def test_crm_failure_retains_paid_order_then_reconciles(c):
 s,p,repo,db,u=c;p.fail_crm=True;oid=paid(c);assert db.get(oid)['sync_state']=='needs_retry' and db.get(oid)['state']=='PAID';p.fail_crm=False;s.fulfill(oid);assert db.get(oid)['sync_state']=='synced' and len(p.mails)==1

def test_lost_mail_response_not_replayed(c):
 s,p,repo,db,u=c;p.fail_mail=True;oid=paid(c);s.fulfill(oid);assert len(p.mails)==1 and db.get(oid)['confirmation']=='uncertain'

def test_other_customer_cannot_read_simulate_or_refund(c):
 oid=paid(c);s,p,repo,db,u=c;other={'owner':'other','email':'other@example.test'}
 for fn in [lambda:s.refresh(other['owner'],oid),lambda:s.simulate(other,oid,'return_inspected'),lambda:s.refund(other,oid,'20','a-refund-request-key')]:
  with pytest.raises(ShopError) as e:fn()
  assert e.value.status==404
 assert not p.refund_calls

def test_simulator_explicit_and_does_not_call_refund(c):
 oid=paid(c);s,p,repo,db,u=c;s.simulate(u,oid,'return_inspected');assert repo.order('pi_1')['return_status']=='received_inspected' and not p.refund_calls
 with pytest.raises(ShopError):s.simulate(u,oid,'invented')

def test_refund_uses_verified_owner_and_saved_payment(c):
 oid=paid(c);s,p,repo,db,u=c;r=s.refund(u,oid,'20','a-refund-request-key');assert r['phase']=='AWAITING_APPROVAL';assert p.refund_calls[0][1:]==('a@example.test','pi_1','20')
 with pytest.raises(ShopError):s.refund(u,oid,'20','another-refund-key')
 assert len(p.refund_calls)==1

@pytest.mark.parametrize('pct',['NaN','Infinity','0','-1','101','1.111','garbage'])
def test_refund_boundaries(c,pct):
 oid=paid(c);s,p,repo,db,u=c
 with pytest.raises(ShopError):s.refund(u,oid,pct,'a-refund-request-key')
 assert not p.refund_calls

def test_balance_reconciles_provider_fact_not_request_percentage(c):
 oid=paid(c);s,p,repo,db,u=c;p.refund_rows=[{'amount':20000,'status':'succeeded'},{'amount':5000,'status':'pending'},{'amount':999,'status':'failed'}];s.fulfill(oid);assert db.get(oid)['refunded_minor']==20000 and db.get(oid)['refund_pending_minor']==5000;assert p.crm_calls[-1]['refunded_minor']==20000

def test_webhook_requires_secret_signature_and_current_timestamp():
 p=Provider({'STRIPE_API_KEY':'sk_test_dummy'},Mock(),'arn');body=json.dumps({'type':'checkout.session.completed','livemode':False}).encode();t=int(time.time());sig=hmac.new(b'whsec_test',str(t).encode()+b'.'+body,hashlib.sha256).hexdigest();assert p.webhook(body,f't={t},v1={sig}','whsec_test')['livemode'] is False
 for header,secret in [(f't={t},v1={sig}',''),(f't={t},v1=wrong','whsec_test'),(f't={t-301},v1={sig}','whsec_test')]:
  with pytest.raises(ShopError):p.webhook(body,header,secret)

def test_live_key_rejected():
 with pytest.raises(RuntimeError):Provider({'STRIPE_API_KEY':'sk_live_dummy'},Mock(),'arn')

def test_logout_revokes_server_session(c):
 s,p,repo,db,u=c;db.delete=lambda key:db.rows.pop(key,None);r=s.request_code('a@example.test','ip');code=re.search(r'\b\d{6}\b',p.mails[-1]['body'])[0];token=s.verify(r['challenge'],code);s.logout(token)
 with pytest.raises(ShopError):s.session(token)

def test_http_owner_boundary_and_csrf(c,monkeypatch):
 from shop import handler
 s,p,repo,db,u=c;monkeypatch.setattr(handler,'dependencies',lambda:(s,{}))
 event={'rawPath':'/api/orders','requestContext':{'http':{'method':'GET','sourceIp':'ip'},'domainName':'demo.test'},'headers':{}}
 assert handler.handler(event,Mock())['statusCode']==401
 event.update(rawPath='/api/auth/request',body=json.dumps({'email':'a@example.test'}));event['requestContext']['http']['method']='POST';event['headers']={'x-acme-shop':'1','origin':'https://attacker.test'}
 assert handler.handler(event,Mock())['statusCode']==403
 event['headers']['origin']='https://demo.test';event['body']='[]';assert handler.handler(event,Mock())['statusCode']==400
 event['body']='not-json';assert handler.handler(event,Mock())['statusCode']==400

def test_crm_lost_create_response_recovers_without_second_create():
 import httpx
 provider=Provider({'STRIPE_API_KEY':'sk_test_dummy','HUBSPOT_ACCESS_TOKEN':'dummy'},Mock(),'arn');provider.save_intent=lambda r:None
 calls=[];created=False
 def handle(request):
  nonlocal created
  path=request.url.path;calls.append((request.method,path))
  if path.endswith('contacts/search'):return httpx.Response(200,json={'results':[{'id':'contact1'}]})
  if path.endswith('deals/search'):return httpx.Response(200,json={'results':[{'id':'deal1'}] if created else []})
  if path.endswith('/deals') and request.method=='POST':created=True;raise httpx.ReadTimeout('lost response')
  return httpx.Response(200,json={})
 provider.http=httpx.Client(transport=httpx.MockTransport(handle));r={'pk':'ORD-DEADBEEF0123','email':'a@example.test','product_name':'Gateway','sku':'SKU','amount_minor':100000,'payment_intent':'pi_fake','catalog_version':'v1'}
 with pytest.raises(httpx.ReadTimeout):provider.crm_sync(r)
 provider.crm_sync(r)
 assert r['hubspot_deal']=='deal1' and calls.count(('POST','/crm/v3/objects/deals'))==1
