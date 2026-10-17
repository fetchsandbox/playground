"""Transport routing tests; provider calls are doubles, not native acceptance."""
import importlib.util,sys,json,io
from pathlib import Path
import pytest
root=Path(__file__).parents[1]/'verify';sys.path.insert(0,str(root))
spec=importlib.util.spec_from_file_location('shared_delivery',root/'shared_ingress_worker.py');worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

@pytest.mark.parametrize('path,body,refund_calls,quote_calls',[
 ('/webhooks/slack/events',{'event':{'user':'U1','text':'refund pi_test 20%'}},1,0),
 ('/webhooks/slack/events',{'event':{'user':'U1','text':'quote 5 seats'}},0,1),
 ('/webhooks/gmail?token=redacted',{'message':{}},1,1),
])
def test_existing_quote_transport_preserved(monkeypatch,path,body,refund_calls,quote_calls):
    calls=[]
    class Client:
        def __init__(self,name):self.name=name
        def invoke(self,**kw):calls.append((self.name,kw));return {'StatusCode':202}
        def invoke_agent_runtime(self,**kw):calls.append((self.name,kw));return {'response':io.BytesIO(b'{}'),'ResponseMetadata':{'RequestId':'unit'}}
    monkeypatch.setattr(worker.boto3,'client',lambda name,**kw:Client(name))
    monkeypatch.setenv('REFUND_DELIVERY_FUNCTION','refund-only');monkeypatch.setenv('RUNTIME_ARN','unchanged-quote');monkeypatch.setenv('RUNTIME_SESSION_ID','unchanged-session')
    payload=json.dumps({'path':path,'raw_body':json.dumps(body)})
    assert worker.handler({'Records':[{'messageId':'msg1','body':payload}]},None)=={'batchItemFailures':[]}
    assert sum(x[0]=='lambda' for x in calls)==refund_calls
    assert sum(x[0]=='bedrock-agentcore' for x in calls)==quote_calls
    for name,kw in calls:
        if name=='bedrock-agentcore':assert kw['payload']==payload.encode() and kw['agentRuntimeArn']=='unchanged-quote'

def test_refund_enqueue_failure_does_not_fall_back_to_quote(monkeypatch):
    class Client:
        def invoke(self,**kw):raise RuntimeError('unit enqueue failure')
        def invoke_agent_runtime(self,**kw):pytest.fail('Refund must not be sent to quote app')
    monkeypatch.setattr(worker.boto3,'client',lambda *a,**kw:Client());monkeypatch.setenv('REFUND_DELIVERY_FUNCTION','refund-only')
    payload=json.dumps({'path':'/webhooks/slack/events','raw_body':json.dumps({'event':{'user':'U1','text':'refund pi_test 20%'}})})
    assert worker.handler({'Records':[{'messageId':'msg1','body':payload}]},None)=={'batchItemFailures':[{'itemIdentifier':'msg1'}]}
