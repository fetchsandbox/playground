import base64,json,os,traceback
from decimal import Decimal
from http.cookies import SimpleCookie
from pathlib import Path
import boto3
from botocore.config import Config
from .core import Shop,ShopError,VERSION
from .integrations import Repository,Provider,plain
from .storage import Store
SESSION='__Host-acme-session'
def dependencies():
 session=boto3.Session();secret=session.client('secretsmanager');c=json.loads(secret.get_secret_value(SecretId=os.environ['PROVIDER_SECRET_ARN'])['SecretString']);auth=json.loads(secret.get_secret_value(SecretId=os.environ['AUTH_SECRET_ARN'])['SecretString']);c['SHOP_MANAGER_CHANNEL']=os.environ['MANAGER_CHANNEL']
 db=Store(session.resource('dynamodb').Table(os.environ['SHOP_TABLE']));p=Provider(c,session.client('bedrock-agentcore',config=Config(read_timeout=90,retries={'max_attempts':0})),os.environ['REFUND_RUNTIME_ARN']);p.save_intent=db.save
 shop=Shop(db,p,Repository(session.client('s3'),os.environ['POLICY_BUCKET']),auth['pepper']);return shop,auth

def response(status,data,cookies=None,html=False):
 return {'statusCode':status,'headers':{'content-type':'text/html; charset=utf-8' if html else 'application/json','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com"},'cookies':cookies or [],'body':data if html else json.dumps(data,default=plain)}

def handler(event,context):
 try:
  if event.get('action')=='reconcile':return dependencies()[0].reconcile()
  headers={k.lower():v for k,v in event.get('headers',{}).items()};method=event.get('requestContext',{}).get('http',{}).get('method','GET');path=event.get('rawPath','/')
  if method=='GET' and path in ['/','/app.js','/style.css']:
   file={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[path];r=response(200,(Path(__file__).parent.parent/'public'/file).read_text(),html=True);r['headers']['content-type']={'/':'text/html; charset=utf-8','/app.js':'application/javascript','/style.css':'text/css'}[path];return r
  shop,auth=dependencies();raw=event.get('body','').encode();raw=base64.b64decode(raw) if event.get('isBase64Encoded') else raw
  if len(raw)>16000:raise ShopError('Request is too large.',413)
  if method=='POST' and path=='/api/stripe/webhook':
   data=shop.p.webhook(raw,headers.get('stripe-signature',''),auth.get('stripe_webhook_secret',''))
   if data['type'] in ['checkout.session.completed','checkout.session.async_payment_succeeded']:
    obj=data['data']['object']
    if obj.get('metadata',{}).get('acme_demo_shop')=='true':shop.fulfill(obj['client_reference_id'],obj['id'])
   return response(200,{'received':True})
  host=event.get('requestContext',{}).get('domainName','')
  if method=='POST' and (headers.get('x-acme-shop')!='1' or (headers.get('origin') and headers['origin']!='https://'+host)):raise ShopError('Request origin is not allowed.',403)
  body=json.loads(raw) if raw else {}
  if method=='GET' and path=='/api/catalog':return response(200,shop.catalog())
  if method=='POST' and path=='/api/auth/request':return response(200,shop.request_code(body.get('email',''),event.get('requestContext',{}).get('http',{}).get('sourceIp','unknown')))
  if method=='POST' and path=='/api/auth/verify':
   token=shop.verify(body.get('challenge',''),body.get('code',''));return response(200,{'signed_in':True},[SESSION+'='+token+'; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800'])
  if method=='POST' and path=='/api/auth/logout':return response(200,{'signed_out':True},[SESSION+'=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'])
  cookies=SimpleCookie();cookies.load('; '.join(event.get('cookies',[])) or headers.get('cookie',''));session=shop.session(cookies[SESSION].value if SESSION in cookies else '')
  if method=='GET' and path=='/api/me':return response(200,{'email':session['email'],'version':VERSION})
  if method=='GET' and path=='/api/orders':return response(200,shop.orders(session))
  if method=='POST' and path=='/api/checkout':
   if not host:raise ShopError('Public shop host is not configured.',503)
   return response(200,shop.checkout(session,body.get('sku'),body.get('request_id'),'https://'+host))
  parts=path.strip('/').split('/')
  if method=='POST' and len(parts)==4 and parts[:2]==['api','orders']:
   oid,action=parts[2:]
   if action=='refresh':return response(200,shop.refresh(session['owner'],oid))
   if action=='simulate':return response(200,shop.simulate(session,oid,body.get('scenario')))
   if action=='refund':return response(200,shop.refund(session,oid,body.get('percentage'),body.get('request_id')))
  raise ShopError('Page not found.',404)
 except ShopError as e:return response(e.status,{'error':e.message})
 except Exception as e:
  print(json.dumps({'event':'shop_request_failed','type':type(e).__name__,'request_id':getattr(context,'aws_request_id',None),'version':VERSION}))
  return response(503,{'error':'This step could not finish. Your saved order is retained; use Refresh to check it before retrying.'})
