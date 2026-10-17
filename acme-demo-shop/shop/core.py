"""Public test shop: verified owners, authoritative payments, explicit simulation, resumable sync."""
import hashlib,hmac,json,re,secrets,time,uuid
from decimal import Decimal

VERSION='acme-shop-1.0.1'
class ShopError(Exception):
 def __init__(self,message,status=400):self.message,self.status=message,status

def digest(s):return hashlib.sha256(s.encode()).hexdigest()
def money(n):return f'${int(n)/100:,.2f} USD'
def email(value):
 v=str(value).strip().lower()
 if len(v)>254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',v):raise ShopError('Enter a valid email address.')
 return v

class Shop:
 def __init__(self,store,provider,repo,pepper,now=time.time):self.db,self.p,self.repo,self.pepper,self.now=store,provider,repo,pepper,now
 def hash(self,s):return hmac.new(self.pepper.encode(),s.encode(),hashlib.sha256).hexdigest()
 def catalog(self):
  c=self.repo.catalog();mapping=self.repo.mapping()
  return {'version':c['version'],'demo':True,'products':[{**p,'policy':next(x for x in c['product_policies'] if x['id']==p['policy_id']),'available':p['sku'] in mapping['products']} for p in c['products']],'company_policy':c['company'],'application_version':VERSION}
 def rate(self,key,limit):
  day=int(self.now()//86400);n=self.db.increment('RATE#'+self.hash(key)+'#'+str(day),int((day+2)*86400))
  if n>limit:raise ShopError('Demo limit reached. Please try again tomorrow.',429)
 def request_code(self,address,ip):
  address=email(address);self.rate('otp-ip:'+ip,8);self.rate('otp-email:'+address,4);self.rate('otp-global',60)
  challenge=secrets.token_urlsafe(24);code=f'{secrets.randbelow(1000000):06d}';self.db.put({'pk':'OTP#'+self.hash(challenge),'email':address,'code_hash':self.hash(challenge+code),'ttl':int(self.now())+600,'attempts':0})
  self.p.mail(address,'Your Acme demo shop sign-in code','Your Acme demo shop sign-in code is '+code+'.\n\nIt expires in 10 minutes. This signs you into a synthetic product demo; no real money is involved. If you did not request it, ignore this email.','auth-'+challenge)
  return {'challenge':challenge,'message':'Check your email for a six-digit sign-in code.'}
 def verify(self,challenge,code):
  key='OTP#'+self.hash(str(challenge));r=self.db.get(key)
  if not r or r['ttl']<=self.now() or r.get('used'):raise ShopError('This sign-in code expired. Request a new code.',401)
  tries=self.db.increment(key,r['ttl'],'attempts')
  if tries>5 or not hmac.compare_digest(r['code_hash'],self.hash(str(challenge)+str(code))):raise ShopError('The sign-in code is incorrect or expired.',401)
  if not self.db.consume(key):raise ShopError('This sign-in code has already been used.',401)
  token=secrets.token_urlsafe(32);self.db.put({'pk':'SESSION#'+self.hash(token),'email':r['email'],'owner':self.hash(r['email']),'ttl':int(self.now())+8*3600})
  return token
 def logout(self,token):self.db.delete('SESSION#'+self.hash(token or ''))
 def event(self,name,r):
  print(json.dumps({'event':name,'order_id':r['pk'],'sku':r.get('sku'),'timestamp':int(self.now()),'version':VERSION}))
 def session(self,token):
  r=self.db.get('SESSION#'+self.hash(token or ''))
  if not r or r['ttl']<=self.now():raise ShopError('Sign in to view your orders.',401)
  return r
 def order(self,owner,oid):
  if not re.fullmatch(r'ORD-[A-F0-9]{12}',str(oid)):raise ShopError('Order not found.',404)
  r=self.db.get(oid)
  if not r or r.get('owner')!=owner:raise ShopError('Order not found.',404)
  return r
 def checkout(self,session,sku,request_id,base):
  if not re.fullmatch(r'[a-zA-Z0-9-]{16,80}',str(request_id)):raise ShopError('A purchase request identifier is required.')
  c=self.repo.catalog();p=next((x for x in c['products'] if x['sku']==sku and x['inventory_status']=='active'),None)
  if not p:raise ShopError('This product is not available.')
  mapping=self.repo.mapping()['products'].get(sku)
  if not mapping or mapping['amount_minor']!=p['unit_amount_minor']:raise ShopError('The product catalog is being synchronized. Please try later.',503)
  oid='ORD-'+self.hash(session['owner']+request_id)[:12].upper();existing=self.db.get(oid)
  if existing and existing['sku']!=sku:raise ShopError('This purchase request already belongs to another product.',409)
  if not existing:
   self.rate('checkout-owner:'+session['owner'],6);self.rate('checkout-global',100)
   self.db.create({'pk':oid,'owner':session['owner'],'email':session['email'],'sku':sku,'product_name':p['name'],'amount_minor':p['unit_amount_minor'],'currency':p['currency'],'catalog_version':c['version'],'price_id':mapping['price_id'],'shop_url':base,'created_at':int(self.now()),'ttl':int(self.now())+30*86400,'state':'CHECKOUT_PENDING','sync_state':'not_paid','syncpk':'SYNC','due':int(self.now())+60})
  with self.db.lease(oid) as r:
   if r.get('checkout_url'):return {'order_id':oid,'url':r['checkout_url']}
   customer=self.p.customer(session['email'],session['owner'])
   result=self.p.checkout(r,customer,base)
   if result.get('livemode'):raise ShopError('Live payments are disabled.',503)
   r.update(checkout_id=result['id'],checkout_url=result['url']);self.db.save(r)
  return {'order_id':oid,'url':result['url']}
 def fulfill(self,oid,checkout_id=None):
  with self.db.lease(oid) as r:
   sid=r.get('checkout_id')
   if not sid or (checkout_id and checkout_id!=sid):raise ShopError('Checkout does not match this order.',409)
   checkout=self.p.checkout_get(sid)
   if checkout.get('livemode') or checkout.get('client_reference_id')!=oid:raise ShopError('Checkout identity did not match.',409)
   if checkout.get('payment_status')!='paid':
    r['due']=int(self.now())+600;self.db.save(r);return r
   pi=self.p.payment(checkout['payment_intent'])
   if pi.get('livemode') or pi['status']!='succeeded' or pi['amount_received']!=r['amount_minor'] or pi['currency']!=r['currency'] or pi.get('metadata',{}).get('acme_sku')!=r['sku'] or pi.get('metadata',{}).get('acme_shop_order')!=oid:raise ShopError('Payment did not match the saved order. Contact demo support.',409)
   cust=self.p.customer_get(pi['customer'])
   if cust.get('email','').lower()!=r['email']:raise ShopError('Payment customer did not match.',409)
   r.update(state='PAID',payment_intent=pi['id'],stripe_customer=pi['customer']);self.db.save(r)
   # Merchant evidence is created only after independently reading a settled Stripe payment.
   self.repo.ensure_order(r)
   self.event('shop_payment_verified',r)
   self.sync(r)
   return r
 def sync(self,r):
  if r.get('state')!='PAID':return
  refunds=self.p.refunds(r['payment_intent']);r['refunded_minor']=sum(int(x['amount']) for x in refunds if x['status']=='succeeded');r['refund_pending_minor']=sum(int(x['amount']) for x in refunds if x['status'] not in ['succeeded','failed','canceled'])
  try:
   self.p.crm_sync(r);r['sync_state']='synced';r.pop('sync_error',None)
  except Exception:
   r['sync_state']='needs_retry';r['sync_error']='HubSpot purchase update needs retry.'
  if not r.get('confirmation'):
   r['confirmation']='uncertain';self.db.save(r)
   try:
    response=self.p.mail(r['email'],'Acme demo purchase confirmed — '+r['product_name'],'Hi,\n\nYour test purchase is confirmed.\n\nProduct: '+r['product_name']+'\nAmount: '+money(r['amount_minor'])+'\nOrder: '+r['pk']+'\n\nThis is a synthetic Acme demo. No real money moved.\n\nView your order: '+r.get('shop_url','')+'/?order='+r['pk']+'\nSign in with this email address to simulate a return and request a refund.\n\nAcme Operations',r['pk']+':purchase')
    r['confirmation']='sent';r['confirmation_reference']=response['id']
   except Exception:r['confirmation']='uncertain'
  r['due']=int(self.now())+60;self.db.save(r);self.event('shop_order_'+r['sync_state'],r)
 def refresh(self,owner,oid):
  r=self.order(owner,oid)
  if r.get('checkout_id'):self.fulfill(oid)
  return self.public_order(self.order(owner,oid))
 def public_order(self,r):
  evidence=self.repo.order(r['payment_intent']) if r.get('payment_intent') else None
  case=self.p.refund_status(r['refund_case']) if r.get('refund_case') else None
  return {k:r.get(k) for k in ['sku','product_name','amount_minor','currency','state','sync_state','sync_error','refunded_minor','refund_pending_minor','confirmation','created_at','payment_intent']}|{'order_id':r['pk'],'return_status':evidence.get('return_status') if evidence else None,'usage_pct':evidence.get('usage_pct') if evidence else None,'refund':case}
 def orders(self,session):return {'orders':[self.public_order(r) for r in self.db.orders(session['owner'])]}
 def simulate(self,session,oid,scenario):
  r=self.order(session['owner'],oid)
  if r.get('state')!='PAID':raise ShopError('Complete the test purchase first.',409)
  allowed={'return_inspected','usage_low','usage_high'}
  if scenario not in allowed:raise ShopError('Choose a supported demo scenario.')
  c=self.repo.catalog();product=next(x for x in c['products'] if x['sku']==r['sku'])
  if (scenario=='return_inspected')!=(product['type']=='hardware'):raise ShopError('This scenario does not apply to this product.')
  if product['type']=='service':raise ShopError('Completed calibration services remain non-refundable.')
  self.repo.simulate(r,scenario);self.event('shop_synthetic_merchant_scenario',r)
  return self.public_order(r)
 def refund(self,session,oid,pct,request_id):
  r=self.order(session['owner'],oid)
  if r.get('state')!='PAID':raise ShopError('Complete the test purchase first.',409)
  if not re.fullmatch(r'[a-zA-Z0-9-]{16,80}',str(request_id)):raise ShopError('A refund request identifier is required.')
  try:v=Decimal(str(pct))
  except Exception:raise ShopError('Enter a refund percentage from 0.01 to 100.')
  if not v.is_finite() or v<=0 or v>100 or v.as_tuple().exponent < -2:raise ShopError('Enter a refund percentage from 0.01 to 100, with at most two decimals.')
  self.rate('refund-owner:'+session['owner'],15)
  with self.db.lease(oid) as r:
   previous=self.p.refund_status(r['refund_case']) if r.get('refund_case') else None
   if previous and previous['phase'] in ['AWAITING_APPROVAL','REFUND_PENDING','REFUND_FAILED']:raise ShopError('A refund request already needs a decision or review. Follow its existing approval.',409)
   case='SHOP-'+self.hash(oid+request_id)[:24];r['refund_case']=case;self.db.save(r)
   result=self.p.refund_start(case,r['email'],r['payment_intent'],str(v));self.event('shop_refund_requested',r)
   self.sync(r)
   return result
 def reconcile(self):
  count=0
  for r in self.db.due(int(self.now())):
   try:self.fulfill(r['pk']);count+=1
   except Exception:
    r['due']=int(self.now())+120;self.db.patch_due(r)
  return {'checked':count}
