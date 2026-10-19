import json,unittest,os,io
from unittest.mock import patch,MagicMock
import shared_worker
from slack_route import cancellation_route
from slack_handler import process_slack,outcome_text
class Ledger:
 def __init__(self):self.items={}
 def get_item(self,**kw):return {'Item':self.items[kw['Key']['event_id']]} if kw['Key']['event_id'] in self.items else {}
 def put_item(self,**kw):self.items[kw['Item']['event_id']]=kw['Item']
class Slack:
 def __init__(self):self.messages=[];self.calls=[]
 def api(self,method,body):
  self.calls.append(method)
  if method=='users.info':return {'user':{'id':'U1','profile':{'email':'owner@example.test'},'real_name':'Demo'}}
  if method=='conversations.replies':return {'messages':self.messages}
  if method=='chat.postMessage':self.messages.append({**body,'ts':'1.2'});return {'ts':'1.2'}
  if method=='chat.update':self.messages[0].update(body);return {'ts':'1.2'}
class TestSlack(unittest.TestCase):
 def payload(self,text,**extra):return {'path':'/webhooks/slack/events','raw_body':json.dumps({'type':'event_callback','event_id':'EV1','team_id':'T1','event':{'type':'message','user':'U1','channel':'D1','ts':'1.1','text':text,**extra}})}
 def test_explicit_subscription_intent_only(self):
  self.assertIsNotNone(cancellation_route(self.payload('cancel subscription sub_123 and refund if eligible')))
  for text in ['quote 10 seats','refund pi_123','cancel my quote','please help',"do not cancel subscription sub_123","is my subscription cancelled?","don't cancel subscription sub_123"]:self.assertIsNone(cancellation_route(self.payload(text)))
 def test_bots_edits_and_invalid_events_not_routed(self):
  for extra in [{'bot_id':'B1'},{'subtype':'message_changed'}]:self.assertIsNone(cancellation_route(self.payload('cancel subscription sub_1',**extra)))
  self.assertIsNone(cancellation_route({'path':'/webhooks/gmail','raw_body':'{}'}))
 def test_canonical_identity_thread_and_duplicate_recovery(self):
  m=cancellation_route(self.payload('cancel subscription sub_123 for attacker@example.test'));slack=Slack();ledger=Ledger();commands=[]
  def invoke(b):commands.append(b);return {'phase':'DONE','outcome':'ok','output':{'decision':'cancel','caseRef':'CXL-TEST'},'actions':[{'id':'zendesk.create_ticket','ref':'1'}]}
  for _ in range(2):process_slack(m,{'approvers':['U_APPROVER']},{'expected_team_id':'T1'},invoke,ledger,slack)
  self.assertEqual(commands[0]['input']['customer']['email'],'owner@example.test');self.assertEqual(commands[0]['input']['channel'],'slack');self.assertEqual(commands[0]['runId'],commands[1]['runId']);self.assertEqual(len(slack.messages),1);self.assertEqual(slack.messages[0]['thread_ts'],'1.1')
 def test_other_workspace_rejected_before_api_or_execution(self):
  slack=Slack()
  with self.assertRaises(ValueError):process_slack(cancellation_route(self.payload('cancel subscription sub_1')),{}, {'expected_team_id':'OTHER'},lambda _:self.fail(),Ledger(),slack)
  self.assertEqual(slack.calls,[])
 def test_missing_or_multiple_ids_clarify_without_execution(self):
  for text in ['cancel my subscription','cancel sub_a and sub_b']:
   slack=Slack();r=process_slack(cancellation_route(self.payload(text)),{}, {'expected_team_id':'T1'},lambda _:self.fail(),Ledger(),slack);self.assertEqual(r['outcome'],'clarification_sent');self.assertNotIn('Subscription cancelled',slack.messages[0]['text'])
 def test_partial_result_does_not_claim_success(self):self.assertIn('needs attention',outcome_text({'phase':'DONE','outcome':'partial','decision':'unverified'}))
class TestSharedRouting(unittest.TestCase):
 def test_quote_and_refund_keep_their_existing_targets(self):
  for text,target in [('quote 1 Pro seat','agent'),('refund pi_demo','refund'),('cancel subscription sub_demo','cancel')]:
   aws=MagicMock();client=aws.return_value;client.invoke.return_value={'StatusCode':202};client.invoke_agent_runtime.return_value={'response':io.BytesIO(b'{}'),'ResponseMetadata':{'RequestId':'test'}}
   payload=TestSlack().payload(text);event={'Records':[{'messageId':'test','body':json.dumps(payload)}]}
   with patch.object(shared_worker.boto3,'client',aws),patch.dict(os.environ,{'CANCELLATION_QUEUE_URL':'queue','REFUND_DELIVERY_FUNCTION':'refund_fn','RUNTIME_ARN':'quote_runtime','RUNTIME_SESSION_ID':'session'}):
    self.assertEqual(shared_worker.handler(event,None),{'batchItemFailures':[]})
   if target=='agent':client.invoke_agent_runtime.assert_called_once();self.assertEqual(client.invoke_agent_runtime.call_args.kwargs['payload'],json.dumps(payload).encode());client.send_message.assert_not_called();client.invoke.assert_not_called()
   elif target=='refund':client.invoke.assert_called_once();client.invoke_agent_runtime.assert_not_called();client.send_message.assert_not_called()
   else:client.send_message.assert_called_once();client.invoke_agent_runtime.assert_not_called();client.invoke.assert_not_called()
if __name__=='__main__':unittest.main()
