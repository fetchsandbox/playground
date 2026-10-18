import copy,json,unittest
from decimal import Decimal
from unittest.mock import patch
import handler
CFG={'ops_channel':'D','approvers':['U'],'request_addresses':['support@example.zendesk.com']}
T={'id':31,'requester_id':7,'subject':'Cancel subscription sub_DEMO123','recipient':'support@example.zendesk.com','via':{'channel':'email'},'status':'new','tags':[]}
C=[{'id':123,'public':True,'author_id':7,'via':{'channel':'email','source':{'from':{'address':'demo@example.test'}}}}]
class Ledger:
 def __init__(self):self.item=None
 def get_item(self,**kw):return {'Item':copy.deepcopy(self.item)} if self.item else {}
 def put_item(self,**kw):self.item=copy.deepcopy(kw['Item']);self.item['command']['input']['ticketId']=Decimal(31)
class Zd:
 def get(self,path):
  return {'ticket':copy.deepcopy(T)} if '/tickets/' in path else {'user':{'id':7,'email':'demo@example.test','name':'Demo','role':'end-user'}}
 def comments(self,tid):return copy.deepcopy(C)
class TestEmailRequest(unittest.TestCase):
 def test_new_email_uses_original_ticket_and_stable_run(self):
  calls=[]
  for event in ['invocation1','invocation2']:
   handler.process_request({'ticket_id':31,'event_id':event,'email':'attacker@example.test'},CFG,Zd(),lambda b:calls.append(b) or {'phase':'DONE','outcome':'ok'},Ledger())
  self.assertEqual(calls[0]['runId'],calls[1]['runId']);self.assertEqual(calls[0]['runId'],'zd-31-request-123')
  self.assertEqual(calls[0]['input']['ticketId'],31);self.assertEqual(calls[0]['input']['channel'],'email');self.assertEqual(calls[0]['input']['subscriptionId'],'sub_DEMO123');self.assertEqual(calls[0]['input']['customer']['email'],'demo@example.test')
 def test_excludes_unrelated_replies_negation_ambiguous_and_wrong_mailbox(self):
  for subject in ['Hello','Re: Cancel subscription sub_DEMO123','Do not cancel subscription sub_DEMO123','Cancel subscription sub_ONE sub_TWO','Cancel subscription','Can I cancel subscription sub_DEMO123?']:
   t={**T,'subject':subject};self.assertIsNone(handler.select_request(t,C,CFG),subject)
  for change in [{'recipient':'personal@example.test'},{'via':{'channel':'api'}},{'status':'closed'},{'tags':['cxl_refund_offer']},{'tags':['cxl_acknowledged']}]:self.assertIsNone(handler.select_request({**T,**change},C,CFG))
  self.assertIsNone(handler.select_request(T,C,{**CFG,'request_addresses':[]}))
 def test_first_comment_must_be_public_email_from_requester(self):
  for change in [{'author_id':8},{'public':False},{'via':{'channel':'api'}}]:self.assertIsNone(handler.select_request(T,[{**C[0],**change}],CFG))
 def test_sender_mismatch_never_invokes(self):
  class Mismatch(Zd):
   def comments(self,tid):return [{**C[0],'via':{'channel':'email','source':{'from':{'address':'other@example.test'}}}}]
  calls=[];r=handler.process_request({'ticket_id':31,'event_id':'x'},CFG,Mismatch(),lambda b:calls.append(b),Ledger());self.assertFalse(calls);self.assertEqual(r['outcome'],'ignored_non_customer_requester')
 def test_persist_before_invoke_replay_after_bot_output_and_decimal(self):
  ledger=Ledger()
  def lost(b):raise RuntimeError('lost response')
  with self.assertRaises(RuntimeError):handler.process_request({'ticket_id':31,'event_id':'x'},CFG,Zd(),lost,ledger)
  class Changed:
   def get(self,path):raise AssertionError('replay must use saved command')
  calls=[]
  handler.process_request({'ticket_id':31,'event_id':'x'},CFG,Changed(),lambda b:calls.append(json.loads(json.dumps(b))) or {'phase':'DONE','outcome':'ok'},ledger)
  self.assertEqual(calls[0]['runId'],'zd-31-request-123')
 def test_attention_is_a_terminal_report_not_a_success_claim(self):
  r=handler.process_request({'ticket_id':31,'event_id':'x'},CFG,Zd(),lambda b:{'phase':'DONE','outcome':'partial','output':{'decision':'unverified'}},Ledger());self.assertEqual(r['decision'],'unverified');self.assertEqual(r['outcome'],'partial')
 def test_ingress_rejects_unknown_kind_and_retains_request_kind(self):
  class Sqs:
   def send_message(self,**kw):self.body=json.loads(kw['MessageBody'])
  sqs=Sqs()
  with patch.object(handler,'config',return_value={}),patch.object(handler,'signature_ok',return_value=True),patch.dict(handler.os.environ,{'QUEUE_URL':'q'}),patch.object(handler.boto3,'client',return_value=sqs):
   h={'x-zendesk-webhook-invocation-id':'evt'}
   self.assertEqual(handler.ingress({'body':json.dumps({'ticket_id':31,'kind':'bad'}),'headers':h},None)['statusCode'],400)
   self.assertEqual(handler.ingress({'body':json.dumps({'ticket_id':31,'kind':'email_cancellation_request'}),'headers':h},None)['statusCode'],202);self.assertEqual(sqs.body['kind'],'email_cancellation_request')
if __name__=='__main__':unittest.main()
