"""Separate refund delivery worker; no LoopLabs dependency or shared quote state."""
import boto3,json,os,uuid
from datetime import datetime,timezone
from botocore.config import Config

def handler(event,context):
    client=boto3.client('bedrock-agentcore',config=Config(read_timeout=160,retries={'max_attempts':1}))
    session='acme-refund-email-poll-'+os.environ.get('REFUND_DEPLOYMENT_VERSION','unknown')+'-'+datetime.now(timezone.utc).strftime('%Y%m%d%H') if event.get('action')=='poll_email' else 'acme-refund-delivery-'+str(uuid.uuid4())
    r=client.invoke_agent_runtime(agentRuntimeArn=os.environ['REFUND_RUNTIME_ARN'],runtimeSessionId=session,qualifier='DEFAULT',contentType='application/json',payload=json.dumps(event).encode())
    data=json.loads(r['response'].read())
    if r.get('statusCode',200)>=400:raise RuntimeError('Refund runtime invocation failed')
    print(json.dumps({'event':'refund_delivery_completed','action':event.get('action'),'case_id':data.get('case_id'),'phase':data.get('phase'),'aws_request_id':r['ResponseMetadata']['RequestId']}))
    return {'ok':True,'case_id':data.get('case_id'),'phase':data.get('phase')}
