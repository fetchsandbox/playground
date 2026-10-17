"""AgentCore HTTP contract. Invocation authentication is IAM SigV4, not public app tokens."""
import json, os, secrets, tempfile
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from .engine import Engine
from .providers import Providers,PolicyRepository
from .store import DynamoStore,MemoryStore,Busy

if os.getenv('CONFIG_SECRET_ARN'):
    import boto3
    config=json.loads(boto3.client('secretsmanager').get_secret_value(SecretId=os.environ['CONFIG_SECRET_ARN'])['SecretString'])
    for key,value in config.items():os.environ.setdefault(key,str(value))
app=FastAPI(title='Acme Refund Eligibility and Resolution',docs_url=None,redoc_url=None)
store=DynamoStore(os.environ['DYNAMODB_TABLE']) if os.getenv('DYNAMODB_TABLE') else MemoryStore()
policies=PolicyRepository(bucket=os.getenv('POLICY_BUCKET'),root=os.getenv('POLICY_DIR','policies'))

def engine():return Engine(store,Providers(),policies,os.environ.get('APPROVER_USER_IDS','').split(','))

@app.get('/ping')
def ping():return {'status':'Healthy'}

@app.post('/invocations')
def invoke(command:dict):
    try:
        e=engine();action=command.get('action')
        if action=='slack_intake':
            from .intake import slack_intake
            return slack_intake(e,command['event'])
        if action=='poll_email':
            from .intake import email_intake
            return email_intake(engine)
        if action=='describe':return e.describe()
        if action=='policies':
            catalog,source=policies.catalog();return {'source':source,'catalog':catalog}
        if action=='prepare_test_case' and os.getenv('ACME_LOCAL_VERIFY')=='true':
            return prepare_test_case(command)
        if action=='start':return e.start(command.get('input',command))
        if action=='status':return e.status(command['caseId'])
        if action=='resume':return e.drive(command['caseId'])
        if action=='decide':return e.drive(command['caseId'],command['decision'],command['userId'])
        raise ValueError('Unsupported action')
    except PermissionError as exc:raise HTTPException(403,str(exc))
    except KeyError:raise HTTPException(404,'Requested case or required record not found')
    except Busy as exc:raise HTTPException(409,str(exc))
    except ValueError as exc:raise HTTPException(400,str(exc))

# Evidence surface for controlled FetchSandbox twin tests. Never enabled in AgentCore deployment.
if os.getenv('ACME_LOCAL_VERIFY')=='true':
    from fastapi import Request
    @app.get('/verify/runs/{run}/cases/{case}/runs')
    def verify_runs(run:str,case:str,request:Request):
        check_verifier(request)
        rows=[]
        for key,value in getattr(store,'data',{}).items():
            if key.startswith('CASE#') and value.get('input',{}).get('proofRun')==run and value.get('input',{}).get('proofCase')==case:
                row={k:v for k,v in value.items() if k not in ['pk','lease_owner','lease_until']}
                payment=evidence_payment(value['input']['paymentIntent']);row['provider_refund_count']=len(payment['refunds']);row['provider_refunded_minor']=sum(int(r['amount']) for r in payment['refunds'] if r['status']=='succeeded')
                sent=value.get('notifications',{}).get('COMPLETED:email',{}).get('provider_reference')
                row['customer_email_provider_seen']=False
                if sent:
                    mail=Providers().request('gmail','GET','/gmail/v1/users/me/messages/'+sent,params={'format':'metadata'})
                    row['customer_email_provider_seen']=mail.get('id')==sent and 'SENT' in mail.get('labelIds',[])
                rows.append(row)
        return {'runs':rows}

    def check_verifier(request):
        expected=os.getenv('FETCHSANDBOX_VERIFIER_TOKEN','')
        if not expected or not secrets.compare_digest(request.headers.get('authorization',''),'Bearer '+expected):raise HTTPException(401,'Unauthorized verifier')
    def evidence_payment(pi):
        p=Providers();listing=p.request('stripe','GET','/v1/refunds',params={'payment_intent':pi,'limit':100})
        return {'refunds':listing.get('data',[])}
    def prepare_test_case(command):
        from urllib.parse import urlparse
        from .policy import digest
        # Explicit local twin fixture preparation. Not available in AgentCore or real-provider deployments.
        for provider in ['STRIPE','GMAIL','HUBSPOT','SLACK']:
            if urlparse(os.getenv(provider+'_BASE_URL','')).hostname not in ['fetchsandbox.com','api.fetchsandbox.com']:raise HTTPException(403,'Fixture preparation requires FetchSandbox twins')
        p=Providers();tag=command['tag'];sku=command.get('sku','ACME-EDGE-100');email='refund-'+digest(tag)[:12]+'@example.test'
        c=p.request('stripe','POST','/v1/customers',data={'email':email,'name':'Acme refund disposable twin fixture'})
        pi=p.request('stripe','POST','/v1/payment_intents',data={'amount':10000,'currency':'usd','customer':c['id'],'payment_method':'pm_card_visa','confirm':'true','metadata[acme_sku]':sku})
        # The merchant order/inspection record is test data; eligibility still reads it through the actual repository.
        global policies
        if not policies.root or str(policies.root).startswith('/private/tmp/') is False:
            folder=Path(tempfile.mkdtemp(prefix='acme-refund-twin-policies-',dir='/private/tmp'));folder.chmod(0o700)
            (folder/'catalog.json').write_text((policies.root/'catalog.json').read_text());policies=PolicyRepository(root=folder)
        (policies.root/'orders').mkdir(exist_ok=True)
        (policies.root/'orders'/ (pi['id']+'.json')).write_text(json.dumps({'payment_intent':pi['id'],'sku':sku,'return_status':'received_inspected','return_condition':'resalable','usage_pct':5}))
        return {'paymentIntent':pi['id'],'customerEmail':email,'fixture_provider':'FetchSandbox twins','merchant_return_evidence':'synthetic inspected-return fixture'}
