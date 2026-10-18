"""Real mail adapter with HTTP doubles; native delivery is measured separately."""
import json
import httpx
import pytest
from refund_ops.providers import Providers, ProviderFailure


def test_direct_sendgrid_acceptance_and_reply_headers_without_gmail():
    requests=[];events=[]
    def reply(req):
        requests.append(req)
        return httpx.Response(202,headers={'X-Message-Id':'provider-accepted-1'})
    p=Providers({'SENDGRID_API_KEY':'unit-only-key'},httpx.Client(transport=httpx.MockTransport(reply)))
    p.event=lambda kind,**fields:events.append({'event':kind,**fields})
    out=p.mail('private@example.test','Refund completed','Private outcome','case:COMPLETED:email','gmail-internal-thread','<original@example.test>')
    assert len(requests)==1 and str(requests[0].url)=='https://api.sendgrid.com/v3/mail/send'
    payload=json.loads(requests[0].content)
    assert payload['from']['email']==payload['reply_to']['email']=='operations@fetchsandbox.com'
    assert payload['personalizations']==[{'to':[{'email':'private@example.test'}]}]
    assert payload['headers']['In-Reply-To']==payload['headers']['References']=='<original@example.test>'
    assert 'threadId' not in payload and 'raw' not in payload
    assert out=={'id':'provider-accepted-1','transport':'sendgrid','delivery_status':'accepted'}
    log=json.dumps(events)
    assert all(x not in log for x in ['private@example.test','Private outcome','unit-only-key'])
    assert events[-1]['provider_reference']=='provider-accepted-1'


@pytest.mark.parametrize('status,uncertain',[(400,False),(401,False),(429,False),(500,True)])
def test_send_failure_is_classified_without_gmail_fallback(status,uncertain):
    calls=[]
    def reply(req):calls.append(req);return httpx.Response(status,json={'errors':[{'message':'not accepted'}]})
    p=Providers({'SENDGRID_API_KEY':'unit-only-key'},httpx.Client(transport=httpx.MockTransport(reply)))
    with pytest.raises(ProviderFailure) as error:p.mail('recipient@example.test','Outcome','Body','case')
    assert error.value.provider=='sendgrid' and error.value.uncertain is uncertain
    assert len(calls)==1 and calls[0].url.host=='api.sendgrid.com'


@pytest.mark.parametrize('fault',['timeout','missing-reference','unexpected-success'])
def test_ambiguous_submission_is_uncertain_and_never_falls_back(fault):
    calls=[]
    def reply(req):
        calls.append(req)
        if fault=='timeout':raise httpx.ReadTimeout('unit response lost',request=req)
        return httpx.Response(202 if fault=='missing-reference' else 200)
    p=Providers({'SENDGRID_API_KEY':'unit-only-key'},httpx.Client(transport=httpx.MockTransport(reply)))
    with pytest.raises(ProviderFailure) as error:p.mail('recipient@example.test','Outcome','Body','case')
    assert error.value.uncertain and len(calls)==1


def test_missing_sendgrid_key_does_not_use_existing_gmail_credentials():
    def forbidden(req):pytest.fail('no request is permitted without SendGrid credentials')
    p=Providers({'GMAIL_API_KEY':'unit-gmail'},httpx.Client(transport=httpx.MockTransport(forbidden)))
    with pytest.raises(ProviderFailure,match='sendgrid'):p.mail('recipient@example.test','Outcome','Body','case')


def test_explicit_legacy_gmail_binding_remains_separate():
    calls=[]
    def reply(req):calls.append(req);return httpx.Response(200,json={'id':'legacy-gmail'})
    p=Providers({'REFUND_EMAIL_TRANSPORT':'gmail','GMAIL_API_KEY':'unit-gmail'},httpx.Client(transport=httpx.MockTransport(reply)))
    assert p.mail('recipient@example.test','Outcome','Body','case')['id']=='legacy-gmail'
    assert calls[0].url.host=='gmail.googleapis.com'
