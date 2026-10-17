import copy,json,importlib.util,sys
from pathlib import Path
import httpx,pytest
from refund_ops.providers import Providers,ProviderFailure
from refund_ops.intake import email_intake

spec=importlib.util.spec_from_file_location('refund_router',Path(__file__).parents[1]/'verify/ingress_router.py');router=importlib.util.module_from_spec(spec);spec.loader.exec_module(router)
@pytest.mark.parametrize('text,expected',[('refund pi_demo 20%',True),('Please refund my purchase',True),('Please quote 2 seats',False)])
def test_narrow_slack_routing(text,expected):
    payload={'path':'/webhooks/slack/events','raw_body':json.dumps({'event_id':'evt1','event':{'text':text,'user':'U1','channel':'D1','ts':'1.1'}})}
    r=router.refund_route(payload);assert bool(r)==expected

def test_bot_messages_do_not_loop():
    assert router.refund_route({'path':'/webhooks/slack/events','raw_body':json.dumps({'event':{'text':'refund pending','bot_id':'B1'}})}) is None

def test_approval_mapping_does_not_capture_quote_buttons():
    from urllib.parse import urlencode
    payload=lambda action:{'path':'/webhooks/slack/interactions','raw_body':urlencode({'payload':json.dumps({'user':{'id':'RAJ'},'actions':[{'action_id':action,'value':'CASE1'}]})})}
    assert router.refund_route(payload('discount_approve')) is None
    assert router.refund_route(payload('acme_refund_approve'))=={'action':'decide','caseId':'CASE1','decision':'approve','userId':'RAJ'}

def test_provider_purchase_checks_owner_and_test_mode():
    def run(live,email):
        def response(req):
            if '/payment_intents/' in req.url.path:return httpx.Response(200,json={'id':'pi_x','livemode':live,'customer':'cus_x'})
            return httpx.Response(200,json={'id':'cus_x','email':'owner@example.test'})
        p=Providers({'STRIPE_API_KEY':'unit-key'},httpx.Client(transport=httpx.MockTransport(response)))
        return p.purchase('pi_x',email)
    with pytest.raises(ValueError,match='test-mode'):run(True,'owner@example.test')
    with pytest.raises(ValueError,match='does not belong'):run(False,'other@example.test')

def test_provider_trace_logs_no_credentials_or_body():
    captured=[]
    def response(req):return httpx.Response(200,json={'id':'cus_test'})
    p=Providers({'STRIPE_API_KEY':'sk_test_secret'},httpx.Client(transport=httpx.MockTransport(response)));p.event=lambda kind,**fields:captured.append({'event':kind,**fields})
    p.request('stripe','POST','/v1/customers',data={'email':'private@example.test','name':'Private Customer'})
    log=json.dumps(captured);assert 'sk_test_secret' not in log and 'private@example.test' not in log and 'Private Customer' not in log
    assert len({x['action_id'] for x in captured})==1

def test_email_recipient_boundary_before_body():
    calls=[]
    class P:
        def request(self,provider,method,path,**kw):
            calls.append((path,kw))
            if path.endswith('/messages'):return {'messages':[{'id':'unrelated'}]}
            assert kw['params']['format']=='metadata'
            return {'payload':{'headers':[{'name':'To','value':'personal@example.test'},{'name':'From','value':'sender@example.test'}]}}
    class E:
        p=P()
    assert email_intake(E)['processed']==[]
    assert len(calls)==2
