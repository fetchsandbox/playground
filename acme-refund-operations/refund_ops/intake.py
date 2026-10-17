"""Native Slack/Gmail intake. Invoked only by Acme's IAM-authenticated delivery worker."""
import base64,json,re,os
from email.utils import parseaddr,getaddresses

def slack_intake(engine, event):
    p=engine.p;ev=event.get('event',event)
    if ev.get('bot_id') or ev.get('subtype') or not ev.get('user'):return {'ignored':'not_customer_message'}
    channel=ev['channel'];thread=ev.get('thread_ts') or ev['ts'];text=ev.get('text','')
    case_id='SLACK-'+(event.get('event_id') or ev['ts'].replace('.','-'))
    if engine.store.get('CASE#'+case_id):return engine.status(case_id)
    who=p.request('slack','GET','/api/users.info',params={'user':ev['user']})
    email=who.get('user',{}).get('profile',{}).get('email')
    if not email:
        p.slack(channel,'Acme Refund Operations · I need a verified customer email associated with your Slack profile.',thread);return {'needs_info':'customer_email'}
    case_id='SLACK-'+(event.get('event_id') or ev['ts'].replace('.','-'))
    if engine.store.create('INTAKE#'+case_id,{'ttl':int(engine.now())+30*86400}):
        p.slack(channel,'Acme Refund Operations · Checking the purchase, product conditions and refund policy. No refund has been issued yet.',thread)
    try:return engine.start({'caseId':case_id,'customerEmail':email,'requestText':text,'slackChannel':channel,'slackThread':thread,'channel':'slack','requesterUserId':ev['user']})
    except ValueError:
        p.slack(channel,'Acme Refund Operations · Please include the original payment reference and percentage, for example: refund pi_… 20%. I will verify the purchase and product policy before any refund.',thread)
        return {'needs_info':'purchase_reference_and_percentage','case_id':case_id}

def email_intake(make_engine):
    p=make_engine().p
    listing=p.request('gmail','GET','/gmail/v1/users/me/messages',params={'q':'in:inbox to:operations@fetchsandbox.com subject:"Acme refund" newer_than:7d','maxResults':10})
    result=[]
    for message in listing.get('messages',[]):
        # Recipient boundary is checked before requesting message bodies.
        raw=p.request('gmail','GET','/gmail/v1/users/me/messages/'+message['id'],params={'format':'metadata','metadataHeaders':['To','Cc','From','Subject','Message-ID']})
        headers={h['name'].lower():h['value'] for h in raw.get('payload',{}).get('headers',[])}
        recipients={a.lower() for _,a in getaddresses([headers.get('to',''),headers.get('cc','')])}
        sender=parseaddr(headers.get('from',''))[1].lower()
        if 'operations@fetchsandbox.com' not in recipients or sender=='operations@fetchsandbox.com':continue
        case_id='GMAIL-'+message['id'];e=make_engine()
        if e.store.get('CASE#'+case_id):continue
        full=p.request('gmail','GET','/gmail/v1/users/me/messages/'+message['id'],params={'format':'full'})
        def plain(part):
            if part.get('mimeType')=='text/plain' and part.get('body',{}).get('data'):
                b=part['body']['data'];return base64.urlsafe_b64decode(b+'='*(-len(b)%4)).decode('utf-8',errors='replace')[:4000]
            return '\n'.join(plain(x) for x in part.get('parts',[]))[:4000]
        text=plain(full.get('payload',{}))
        try:
            r=e.start({'caseId':case_id,'customerEmail':sender,'requestText':text,'channel':'email','gmailThread':full['threadId'],'gmailMessageId':headers.get('message-id'),'slackChannel':os.getenv('REFUND_MANAGER_CHANNEL')})
            result.append({'case_id':case_id,'phase':r['phase']})
        except ValueError:
            # One clarification per Gmail delivery, recorded durably. No unrelated mailbox processing.
            marker='INTAKE#'+message['id']
            if e.store.create(marker,{'ttl':int(e.now())+30*86400}):
                p.mail(sender,'Re: '+headers.get('subject','Acme refund'),'Please include the original payment reference and refund percentage, for example refund pi_… 20%. No refund has been issued.',case_id,full['threadId'],headers.get('message-id'))
            result.append({'case_id':case_id,'phase':'NEEDS_INFORMATION'})
    return {'processed':result,'scope':'operations@fetchsandbox.com / Acme refund subject only'}
