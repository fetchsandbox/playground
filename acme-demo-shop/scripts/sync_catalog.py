"""Operator-only Stripe TEST product catalog publish. Never reads a client-supplied catalog."""
import argparse,json,sys,time
import boto3,httpx
from botocore.exceptions import ClientError
p=argparse.ArgumentParser();p.add_argument('--refund-outputs',required=True);a=p.parse_args();o=json.load(open(a.refund_outputs))['AcmeRefundOperations'];s=boto3.Session(profile_name='fetchsandbox',region_name='us-west-2');s3=s.client('s3');c=json.loads(s.client('secretsmanager').get_secret_value(SecretId=o['SecretArn'])['SecretString']);assert c['STRIPE_API_KEY'].startswith(('sk_test_','rk_test_'));http=httpx.Client(timeout=30,headers={'Authorization':'Bearer '+c['STRIPE_API_KEY']},trust_env=False)
def stripe(method,path,**kw):
 r=http.request(method,'https://api.stripe.com'+path,**kw);r.raise_for_status();return r.json()
cat=json.loads(s3.get_object(Bucket=o['PolicyBucket'],Key='catalog.json')['Body'].read());mapping={'version':cat['version'],'products':{},'native_hubspot_product_catalog':'blocked_existing_credential_403','updated_at':int(time.time())}
for p in cat['products']:
 key='acme-demo-'+p['sku'];products=stripe('GET','/v1/products',params={'limit':100})['data'];product=next((x for x in products if x.get('metadata',{}).get('acme_demo_shop')=='true' and x.get('metadata',{}).get('acme_sku')==p['sku']),None)
 data={'name':p['name'],'description':p.get('description','Fictional Acme demonstration product; Stripe test mode only.'),'metadata[acme_demo_shop]':'true','metadata[acme_sku]':p['sku'],'metadata[policy_id]':p['policy_id'],'metadata[catalog_version]':cat['version']}
 if product:product=stripe('POST','/v1/products/'+product['id'],data=data)
 else:product=stripe('POST','/v1/products',data=data,headers={'Idempotency-Key':key})
 lookup=key+'-'+str(p['unit_amount_minor'])+'-'+p['currency'];prices=stripe('GET','/v1/prices',params={'lookup_keys[]':lookup})['data']
 price=prices[0] if prices else stripe('POST','/v1/prices',data={'product':product['id'],'unit_amount':p['unit_amount_minor'],'currency':p['currency'],'lookup_key':lookup,'metadata[acme_sku]':p['sku'],'metadata[acme_demo_shop]':'true'},headers={'Idempotency-Key':lookup})
 assert price['unit_amount']==p['unit_amount_minor'] and price['currency']==p['currency'] and price['product']==product['id'] and not price['livemode']
 mapping['products'][p['sku']]={'stripe_product':product['id'],'price_id':price['id'],'amount_minor':p['unit_amount_minor'],'currency':p['currency']}
s3.put_object(Bucket=o['PolicyBucket'],Key='commerce/catalog.json',Body=json.dumps(mapping).encode(),ContentType='application/json');print(json.dumps(mapping,indent=2))
