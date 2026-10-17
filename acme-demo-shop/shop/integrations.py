import base64,hashlib,hmac,json,time
from email.message import EmailMessage
from decimal import Decimal
import httpx
from botocore.exceptions import ClientError
from .core import ShopError,money,VERSION

def plain(v):
 if isinstance(v,Decimal):return int(v) if v==int(v) else float(v)
 raise TypeError()
class Repository:
 def __init__(self,s3,bucket):self.s3,self.bucket=s3,bucket
 def read(self,key):return json.loads(self.s3.get_object(Bucket=self.bucket,Key=key)['Body'].read())
 def catalog(self):return self.read('catalog.json')
 def mapping(self):return self.read('commerce/catalog.json')
 def order(self,pi):return self.read('orders/'+pi+'.json')
 def ensure_order(self,r):
  record={'payment_intent':r['payment_intent'],'sku':r['sku'],'quantity':1,'amount_minor':int(r['amount_minor']),'currency':r['currency'],'shop_order':r['pk'],'return_status':'not_received','return_condition':'not_inspected','synthetic_demo':True,'evidence_owner':'Acme Demo Merchant Simulator','source':'Stripe test checkout confirmed; return has NOT been received or inspected.','catalog_version':r['catalog_version']}
  try:self.s3.put_object(Bucket=self.bucket,Key='orders/'+r['payment_intent']+'.json',Body=json.dumps(record).encode(),ContentType='application/json',IfNoneMatch='*')
  except ClientError as e:
   if e.response['Error']['Code'] not in ['PreconditionFailed','ConditionalRequestConflict']:raise
 def simulate(self,r,scenario):
  record=self.order(r['payment_intent']);record.update(evidence_owner='Acme Demo Merchant Simulator',source='Explicit customer-selected SYNTHETIC merchant scenario; not a physical inspection or real usage meter.',simulation=scenario,simulated_at=int(time.time()))
  if scenario=='return_inspected':record.update(return_status='received_inspected',return_condition='resalable')
  else:record['usage_pct']=5 if scenario=='usage_low' else 35
  self.s3.put_object(Bucket=self.bucket,Key='orders/'+r['payment_intent']+'.json',Body=json.dumps(record).encode(),ContentType='application/json')

class Provider:
 def __init__(self,credentials,agent,arn,mail_secret=None):
  self.c,self.agent,self.arn=credentials,agent,arn;self.http=httpx.Client(timeout=20,trust_env=False);self.token=None
  if not self.c['STRIPE_API_KEY'].startswith(('sk_test_','rk_test_')):raise RuntimeError('Only a test Stripe key is allowed')
 def request(self,provider,method,path,**kw):
  base={'stripe':'https://api.stripe.com','hubspot':'https://api.hubapi.com','gmail':'https://gmail.googleapis.com'}[provider]
  token=self.google() if provider=='gmail' else self.c[{'stripe':'STRIPE_API_KEY','hubspot':'HUBSPOT_ACCESS_TOKEN'}[provider]]
  headers={'Authorization':'Bearer '+token,**kw.pop('headers',{})}
  # Operation-only logs: no email addresses, bodies, access tokens or checkout URLs.
  response=self.http.request(method,base+path,headers=headers,**kw)
  print(json.dumps({'event':'shop_tool_result','provider':provider,'method':method,'operation':path.split('?')[0].split('/search')[0] if method=='GET' else '/'.join(path.split('/')[:5]),'status':response.status_code,'version':VERSION}))
  if response.status_code>=300:
   error=ShopError('A connected system could not complete this step. The saved order can be retried.',503);error.provider_status=response.status_code;raise error
  return response.json() if response.content else {}
 def google(self):
  if self.token:return self.token
  r=self.http.post('https://oauth2.googleapis.com/token',data={'grant_type':'refresh_token','client_id':self.c['GOOGLE_CLIENT_ID'],'client_secret':self.c['GOOGLE_CLIENT_SECRET'],'refresh_token':self.c['GOOGLE_REFRESH_TOKEN']});r.raise_for_status();self.token=r.json()['access_token'];return self.token
 def mail(self,to,subject,text,identity):
  m=EmailMessage();m['From']='Acme Operations <operations@fetchsandbox.com>';m['To']=to;m['Reply-To']='operations@fetchsandbox.com';m['Subject']=subject;m['Message-ID']='<acme-shop-'+hashlib.sha256(identity.encode()).hexdigest()+'@fetchsandbox.com>';m.set_content(text)
  return self.request('gmail','POST','/gmail/v1/users/me/messages/send',json={'raw':base64.urlsafe_b64encode(m.as_bytes()).decode()})
 def customer(self,email,owner):
  rows=self.request('stripe','GET','/v1/customers',params={'email':email,'limit':1})['data']
  if rows:return rows[0]['id']
  return self.request('stripe','POST','/v1/customers',data={'email':email,'description':'Acme public demo shop verified customer','metadata[acme_demo_shop]':'true'},headers={'Idempotency-Key':'acme-shop-customer-'+owner})['id']
 def customer_get(self,id):return self.request('stripe','GET','/v1/customers/'+id)
 def checkout(self,r,customer,base):
  return self.request('stripe','POST','/v1/checkout/sessions',data={'mode':'payment','customer':customer,'client_reference_id':r['pk'],'line_items[0][price]':r['price_id'],'line_items[0][quantity]':1,'payment_method_types[]':'card','success_url':base+'/?order='+r['pk']+'&checkout={CHECKOUT_SESSION_ID}','cancel_url':base+'/?order='+r['pk']+'&cancelled=1','payment_intent_data[metadata][acme_sku]':r['sku'],'payment_intent_data[metadata][acme_shop_order]':r['pk'],'metadata[acme_demo_shop]':'true','metadata[order_id]':r['pk']},headers={'Idempotency-Key':'acme-shop-checkout-'+r['pk']})
 def checkout_get(self,id):return self.request('stripe','GET','/v1/checkout/sessions/'+id)
 def payment(self,id):return self.request('stripe','GET','/v1/payment_intents/'+id)
 def refunds(self,id):
  rows=[];params={'payment_intent':id,'limit':100}
  while True:
   result=self.request('stripe','GET','/v1/refunds',params=params);rows.extend(result['data'])
   if not result.get('has_more'):return rows
   params['starting_after']=result['data'][-1]['id']
 def crm_sync(self,r):
  contact=self.request('hubspot','POST','/crm/v3/objects/contacts/search',json={'filterGroups':[{'filters':[{'propertyName':'email','operator':'EQ','value':r['email']}]}],'limit':1})['results']
  if contact:cid=contact[0]['id']
  else:
   try:cid=self.request('hubspot','POST','/crm/v3/objects/contacts',json={'properties':{'email':r['email'],'lifecyclestage':'customer'}})['id']
   except ShopError:
    found=self.request('hubspot','POST','/crm/v3/objects/contacts/search',json={'filterGroups':[{'filters':[{'propertyName':'email','operator':'EQ','value':r['email']}]}],'limit':1})['results']
    if not found:raise
    cid=found[0]['id']
  r['hubspot_contact']=cid
  name='Acme Demo Shop · '+r['pk'];description='SYNTHETIC DEMO / STRIPE TEST MODE\nProduct: '+r['product_name']+'\nSKU: '+r['sku']+'\nOriginal amount: '+money(r['amount_minor'])+'\nSuccessful refunds: '+money(r.get('refunded_minor',0))+'\nPending refunds: '+money(r.get('refund_pending_minor',0))+'\nNet after successful refunds: '+money(int(r['amount_minor'])-int(r.get('refunded_minor',0)))+'\nCatalog version: '+r['catalog_version']+'\nPayment: '+r['payment_intent']+'\nNative HubSpot product/line-item catalog: unavailable with existing credential (403). Product facts are recorded here.'
  props={'dealname':name,'amount':str(Decimal(r['amount_minor'])/100),'pipeline':'default','dealstage':'closedwon','description':description}
  if not r.get('hubspot_deal'):
   matches=self.request('hubspot','POST','/crm/v3/objects/deals/search',json={'filterGroups':[{'filters':[{'propertyName':'dealname','operator':'EQ','value':name}]}],'limit':2})['results']
   if len(matches)>1:raise ShopError('Multiple CRM records require review.',409)
   if matches:r['hubspot_deal']=matches[0]['id']
   elif r.get('crm_create_intent'):
    # A lost create response must be resolved through provider readback, never blindly replayed.
    raise ShopError('CRM creation is uncertain and requires readback.',503)
   else:
    r['crm_create_intent']=True;self.save_intent(r)
    try:r['hubspot_deal']=self.request('hubspot','POST','/crm/v3/objects/deals',json={'properties':props})['id'];self.save_intent(r)
    except ShopError as exc:
     if getattr(exc,'provider_status',500)<500:
      r.pop('crm_create_intent',None);self.save_intent(r)
     raise
  self.request('hubspot','PATCH','/crm/v3/objects/deals/'+r['hubspot_deal'],json={'properties':props})
  self.request('hubspot','PUT','/crm/v4/objects/deals/'+r['hubspot_deal']+'/associations/default/contacts/'+cid)
 def invoke(self,payload):
  result=self.agent.invoke_agent_runtime(agentRuntimeArn=self.arn,qualifier='DEFAULT',runtimeSessionId='acme-shop-'+hashlib.sha256((VERSION+str(time.time()//3600)).encode()).hexdigest(),contentType='application/json',payload=json.dumps(payload).encode());return json.loads(result['response'].read())
 def refund_start(self,case,email,pi,pct):
  r=self.invoke({'action':'start','input':{'caseId':case,'customerEmail':email,'paymentIntent':pi,'requestedPct':pct,'channel':'shop','slackChannel':self.c['SHOP_MANAGER_CHANNEL']}})
  return self.safe_refund(r)
 def refund_status(self,case):
  try:return self.safe_refund(self.invoke({'action':'status','caseId':case}))
  except ClientError as exc:
   if exc.response.get('ResponseMetadata',{}).get('HTTPStatusCode')==404:return None
   raise
 def safe_refund(self,r):
  if 'phase' not in r:raise ShopError('Refund processing needs review.',503)
  return {'phase':r['phase'],'reference':r.get('refund_reference'),'amount_minor':r.get('assessment',{}).get('amount_minor'),'reason':r.get('hold_reason'),'assessment_reasons':r.get('assessment',{}).get('reasons',[]),'approval_expires_at':r.get('approval_expires_at')}
 def webhook(self,body,signature,secret):
  try:
   if not secret:raise ValueError()
   parts={}
   for x in signature.split(','):
    k,v=x.split('=',1);parts.setdefault(k,[]).append(v)
   timestamp=int(parts['t'][0]);expected=hmac.new(secret.encode(),str(timestamp).encode()+b'.'+body,hashlib.sha256).hexdigest()
   if abs(time.time()-timestamp)>300 or not any(hmac.compare_digest(expected,x) for x in parts['v1']):raise ValueError()
   event=json.loads(body)
   if event.get('livemode'):raise ValueError()
   return event
  except Exception:raise ShopError('Invalid Stripe webhook signature.',400)
