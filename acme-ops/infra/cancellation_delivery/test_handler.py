import unittest,datetime,base64,hmac,hashlib,json
from unittest.mock import patch
import handler
from decimal import Decimal
NOW=1770000000
TS=datetime.datetime.fromtimestamp(NOW,datetime.timezone.utc).isoformat()
class TestDelivery(unittest.TestCase):
 def test_signature_valid_exact_raw_body(self):
  raw=b'{"ticket_id":11}'; sig=base64.b64encode(hmac.new(b'test',TS.encode()+raw,hashlib.sha256).digest()).decode(); h={'x-zendesk-webhook-signature-timestamp':TS,'x-zendesk-webhook-signature':sig}
  self.assertTrue(handler.signature_ok(h,raw,'test',NOW)); self.assertFalse(handler.signature_ok(h,raw+b' ','test',NOW))
 def test_signature_rejects_expired_missing_invalid(self):
  for h in [{},{'x-zendesk-webhook-signature-timestamp':'bad'},{'x-zendesk-webhook-signature-timestamp':TS}]:self.assertFalse(handler.signature_ok(h,b'{}','test',NOW+301))
 def test_closed_or_unoffered_not_delivered(self):
  for tags in [[],['cxl_refund_offer','cxl_refunded']]:self.assertIsNone(handler.select_reply({'tags':tags,'requester_id':7},[{'id':1,'public':True,'author_id':7}]))
 def test_latest_bot_comment_does_not_replay_old_requester(self):
  self.assertIsNone(handler.select_reply({'tags':['cxl_refund_offer'],'requester_id':7},[{'id':1,'public':True,'author_id':7},{'id':2,'public':True,'author_id':9}]))
 def test_internal_and_cc_not_requester(self):
  self.assertIsNone(handler.select_reply({'tags':['cxl_refund_offer'],'requester_id':7},[{'id':1,'public':False,'author_id':7},{'id':2,'public':True,'author_id':9}]))
 def fixture(self):
  class Zd:
   def get(self,path):
    if '/tickets/' in path:return {'ticket':{'requester_id':7,'tags':['cxl_refund_offer']}}
    return {'user':{'id':7,'email':'demo@example.test','name':'Demo'}}
   def comments(self,tid):return [{'id':123,'public':True,'author_id':7}]
  return Zd()
 def test_stable_run_and_canonical_identity(self):
  bodies=[]
  def invoke(x):bodies.append(x);return {'phase':'DONE','outcome':'ok','output':{'decision':'refund'}}
  cfg={'ops_channel':'D_DEMO','approvers':['U_DEMO']}
  for _ in range(2):handler.process({'ticket_id':11,'email':'attacker@example.test','choice':'gift_card'},cfg,self.fixture(),invoke)
  self.assertEqual(bodies[0]['runId'],bodies[1]['runId']);self.assertEqual(bodies[0]['runId'],'zd-11-reply-123');self.assertEqual(bodies[0]['input']['customer']['email'],'demo@example.test');self.assertNotIn('choice',bodies[0]['input'])
 def test_resume_failed_committed_run_before_requeue(self):
  calls=[]
  def invoke(x):
   calls.append(x)
   return {'phase':'DONE','outcome':'ok','actions':[]} if x['action']=='resume' else {'phase':'DONE','outcome':'partial','actions':[{'status':'failed'}]}
  handler.process({'ticket_id':11},{'ops_channel':'D','approvers':['U']},self.fixture(),invoke);self.assertEqual([x['action'] for x in calls],['start','resume'])
 def test_unknown_or_failed_state_raises_for_sqs_retry(self):
  for result in [{'phase':'FAILED'},{'phase':'DONE','outcome':'partial'},{'phase':'RUNNING'}]:
   with self.assertRaises(RuntimeError):handler.process({'ticket_id':11},{'ops_channel':'D','approvers':['U']},self.fixture(),lambda x:result)
 def test_approval_is_a_valid_parked_checkpoint(self):
  r=handler.process({'ticket_id':11},{'ops_channel':'D','approvers':['U']},self.fixture(),lambda x:{'phase':'AWAITING_APPROVAL'});self.assertEqual(r['phase'],'AWAITING_APPROVAL')
 def test_invalid_ingress_never_queues(self):
  with patch.object(handler,'config',return_value={'webhook_signing_secret':'test'}),patch.object(handler.boto3,'client') as client:
   self.assertEqual(handler.ingress({'body':'{}','headers':{}},None)['statusCode'],401);client.assert_not_called()
 def test_durable_event_replay_keeps_bound_reply_after_bot_comment(self):
  class Ledger:
   item=None
   def get_item(self,**kw):return {'Item':self.item} if self.item else {}
   def put_item(self,**kw):
    self.item=kw['Item'];self.item['command']['input']['ticketId']=Decimal(self.item['command']['input']['ticketId'])
  ledger=Ledger();cfg={'ops_channel':'D','approvers':['U']};msg={'ticket_id':11,'event_id':'evt-1'}
  def lost_response(body):raise RuntimeError('connection lost after commit')
  with self.assertRaises(RuntimeError):handler.process(msg,cfg,self.fixture(),lost_response,ledger)
  class ChangedTicket:
   def get(self,path):raise AssertionError('Must replay the saved command before rereading later bot comments')
  calls=[]
  def delivered(body):json.dumps(body);calls.append(body);return {'phase':'DONE','outcome':'ok'}
  handler.process(msg,cfg,ChangedTicket(),delivered,ledger)
  self.assertEqual(calls[0]['runId'],'zd-11-reply-123')
if __name__=='__main__':unittest.main()
