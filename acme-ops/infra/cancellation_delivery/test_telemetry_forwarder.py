import base64,gzip,json,unittest
from telemetry_forwarder import forward
SOURCE='/aws/bedrock-agentcore/runtimes/acme_product_cancellation-OXtwF22hKd-DEFAULT';DEST=SOURCE.removesuffix('-DEFAULT')+'-business-v4'
class Logs:
 class exceptions:
  class ResourceAlreadyExistsException(Exception):pass
 def __init__(self):self.rows=[]
 def create_log_stream(self,**kw):self.stream=kw
 def put_log_events(self,**kw):self.rows.extend(kw['logEvents'])
def event(v=None,**over):
 value={'schema_version':'1.0','event_name':'workflow.started','event_id':'evt_1','run_id':'slack-cxl-test','action_id':None,'timestamp':'2026-10-19T20:00:00.000Z','attempt':1,'trace_id':'a'*32,'span_id':'b'*16,'trigger_channel':'slack','agent_deployment_version':'4'};value.update(v or {})
 b={'owner':'342206308838','logGroup':SOURCE,'messageType':'DATA_MESSAGE','logEvents':[{'timestamp':1792440000000,'message':json.dumps(value)}],**over};return {'awslogs':{'data':base64.b64encode(gzip.compress(json.dumps(b).encode())).decode()}}
def call(e,c):return forward(e,c,source=SOURCE,destination=DEST,owner='342206308838',version='4')
class Tests(unittest.TestCase):
 def test_keeps_typed_event_identity_and_scope(self):
  c=Logs();self.assertEqual(call(event(),c),{'forwarded':1,'coverageGaps':0});v=json.loads(c.rows[0]['message']);self.assertEqual(v['event_id'],'evt_1');self.assertEqual(v['agent_deployment_version'],'4');self.assertEqual(c.stream['logGroupName'],DEST)
 def test_invalid_business_data_remains_a_redacted_coverage_gap(self):
  for patch in [{'private_customer_message':'secret-content'},{'schema_version':'2.0'},{'agent_deployment_version':'3'},{'event_name':'unknown'},{'provider':'private@example.test'},{'attempt':True}]:
   c=Logs();self.assertEqual(call(event(patch),c)['coverageGaps'],1);self.assertNotIn('secret-content',c.rows[0]['message']);self.assertEqual(json.loads(c.rows[0]['message'])['schema_version'],'unsupported')
 def test_refuses_a_different_account_or_source_before_writes(self):
  for over in [{'owner':'123456789012'},{'logGroup':'/other'}]:
   c=Logs()
   with self.assertRaises(AssertionError):call(event(**over),c)
   self.assertEqual(c.rows,[])
 def test_refuses_invalid_or_oversized_compressed_payloads(self):
  for data in ['not-base64',base64.b64encode(gzip.compress(b'x'*2097153)).decode()]:
   c=Logs()
   with self.assertRaises(Exception):call({'awslogs':{'data':data}},c)
   self.assertEqual(c.rows,[])
 def test_redelivery_keeps_original_ids_for_observer_deduplication(self):
  c=Logs();call(event(),c);call(event(),c);self.assertEqual(c.rows[0],c.rows[1])
