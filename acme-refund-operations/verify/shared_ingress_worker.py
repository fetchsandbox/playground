"""Invoke the unmodified app's native endpoint; never rewrite Slack payloads."""
import json,os
import boto3
from botocore.config import Config
from ingress_router import refund_route

def handler(event,context):
 client=boto3.client('bedrock-agentcore',config=Config(read_timeout=150,retries={'max_attempts':1}))
 failed=[]
 for record in event.get('Records',[]):
  try:
   body=record['body'];payload=json.loads(body)
   route=refund_route(payload) if os.getenv('REFUND_DELIVERY_FUNCTION') else None
   if route:
    queued=boto3.client('lambda').invoke(FunctionName=os.environ['REFUND_DELIVERY_FUNCTION'],InvocationType='Event',Payload=json.dumps(route).encode())
    if queued.get('StatusCode')!=202:raise RuntimeError('Refund delivery was not accepted')
    print(json.dumps({'kind':'acme_refund_delivery_queued','queue_message_id':record['messageId'],'action':route['action']}))
    if route['action']!='poll_email':continue

   r=client.invoke_agent_runtime(agentRuntimeArn=os.environ['RUNTIME_ARN'],runtimeSessionId=os.environ['RUNTIME_SESSION_ID'],qualifier='DEFAULT',contentType='application/json',accept='application/json',payload=body.encode())
   data=r['response'].read()
   if r.get('statusCode',200)>=400:raise RuntimeError('Application HTTP failure')
   print(json.dumps({'kind':'agentcore_webhook_forwarded','queue_message_id':record['messageId'],'aws_request_id':r['ResponseMetadata']['RequestId'],'application_path':payload['path'].split('?',1)[0],'status_code':r.get('statusCode',200),'response_bytes':len(data)}))
  except Exception as exc:
   print(json.dumps({'kind':'agentcore_webhook_forward_failed','queue_message_id':record.get('messageId'),'error_type':type(exc).__name__}))
   failed.append({'itemIdentifier':record['messageId']})
 return {'batchItemFailures':failed}
