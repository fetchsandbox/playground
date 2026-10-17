"""Separate refund delivery worker; no LoopLabs dependency or shared quote state."""
import boto3,json,os,uuid
from botocore.config import Config

def handler(event,context):
    client=boto3.client('bedrock-agentcore',config=Config(read_timeout=160,retries={'max_attempts':1}))
    r=client.invoke_agent_runtime(agentRuntimeArn=os.environ['REFUND_RUNTIME_ARN'],runtimeSessionId='acme-refund-delivery-'+str(uuid.uuid4()),qualifier='DEFAULT',contentType='application/json',payload=json.dumps(event).encode())
    data=json.loads(r['response'].read())
    print(json.dumps({'event':'refund_delivery_completed','action':event.get('action'),'case_id':data.get('case_id'),'phase':data.get('phase'),'aws_request_id':r['ResponseMetadata']['RequestId']}))
    return {'ok':True,'case_id':data.get('case_id'),'phase':data.get('phase')}
