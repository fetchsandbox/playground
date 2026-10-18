"""Zendesk-only continuation bridge. Never trust ticket/customer text in a webhook."""
import base64,datetime,hashlib,hmac,json,os,re,time,urllib.request,uuid
import boto3
from botocore.config import Config

def config():
    return json.loads(boto3.client('secretsmanager').get_secret_value(SecretId=os.environ['CONFIG_SECRET_ARN'])['SecretString'])

def signature_ok(headers,raw,secret,now=None):
    timestamp=headers.get('x-zendesk-webhook-signature-timestamp','')
    try:
        at=datetime.datetime.fromisoformat(timestamp.replace('Z','+00:00')).timestamp()
        if abs((time.time() if now is None else now)-at)>300:return False
        expected=base64.b64encode(hmac.new(secret.encode(),timestamp.encode()+raw,hashlib.sha256).digest()).decode()
        return bool(secret) and hmac.compare_digest(expected,headers.get('x-zendesk-webhook-signature',''))
    except (ValueError,TypeError):return False

def ingress(event,context):
    raw=base64.b64decode(event['body']) if event.get('isBase64Encoded') else event.get('body','').encode()
    if len(raw)>8192:return {'statusCode':413,'body':'payload too large'}
    cfg=config();headers={k.lower():v for k,v in event.get('headers',{}).items()}
    if not signature_ok(headers,raw,cfg.get('webhook_signing_secret','')):return {'statusCode':401,'body':'invalid signature'}
    try:
        payload=json.loads(raw);ticket_id=int(payload['ticket_id'])
        kind=payload.get('kind','zendesk_reply')
        if kind not in ['zendesk_reply','email_cancellation_request']:raise ValueError()
        if ticket_id<1:raise ValueError()
    except (ValueError,KeyError,TypeError,json.JSONDecodeError):return {'statusCode':400,'body':'invalid ticket id'}
    event_id=headers.get('x-zendesk-webhook-invocation-id') or hashlib.sha256(raw+headers['x-zendesk-webhook-signature-timestamp'].encode()).hexdigest()
    boto3.client('sqs').send_message(QueueUrl=os.environ['QUEUE_URL'],MessageBody=json.dumps({'ticket_id':ticket_id,'event_id':event_id,'kind':kind}),MessageGroupId=str(ticket_id),MessageDeduplicationId=hashlib.sha256(event_id.encode()).hexdigest())
    print(json.dumps({'event':'cancellation_reply_queued','ticket_id':ticket_id,'event_id':event_id}))
    return {'statusCode':202,'body':'queued'}

class Zendesk:
    def __init__(self,cfg):
        self.base='https://'+cfg['ZENDESK_SUBDOMAIN']+'.zendesk.com'
        req=urllib.request.Request(self.base+'/oauth/tokens',data=json.dumps({'grant_type':'client_credentials','client_id':cfg['ZENDESK_CLIENT_ID'],'client_secret':cfg['ZENDESK_CLIENT_SECRET'],'scope':cfg['ZENDESK_SCOPES'],'expires_in':3600}).encode(),headers={'content-type':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as r:self.token=json.load(r)['access_token']
    def get(self,path):
        req=urllib.request.Request(self.base+path,headers={'Authorization':'Bearer '+self.token})
        with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
    def comments(self,ticket_id):
        result=[];path=f'/api/v2/tickets/{ticket_id}/comments.json?sort_order=asc'
        for _ in range(100):
            page=self.get(path);result.extend(page['comments']);n=page.get('next_page')
            if not n:return result
            if not n.startswith(self.base+'/api/v2/'):raise ValueError('untrusted pagination host')
            path=n[len(self.base):]
        raise ValueError('comment pagination limit')

def select_reply(ticket,comments):
    tags=set(ticket.get('tags',[]))
    if 'cxl_refund_offer' not in tags or 'cxl_refunded' in tags:return None
    # Only the latest public comment can advance a conversation. Bot output,
    # CCs and old requester comments cannot be mistaken for a fresh reply.
    public=[c for c in comments if c.get('public')]
    if not public:return None
    latest=max(public,key=lambda c:int(c['id']))
    if latest.get('author_id')!=ticket['requester_id']:return None
    return latest

def process(message,cfg,zd,invoke,ledger=None):
    key=str(message.get("event_id", ""))
    previous=ledger.get_item(Key={"event_id":key},ConsistentRead=True).get("Item") if ledger is not None else None
    if previous:
        command=previous["command"]
        # DynamoDB deserializes JSON numbers as Decimal; restore the API integer.
        command["input"]["ticketId"]=int(command["input"]["ticketId"])
        return deliver(command,invoke)
    tid=int(message['ticket_id']);ticket=zd.get(f'/api/v2/tickets/{tid}.json')['ticket'];reply=select_reply(ticket,zd.comments(tid))
    if reply is None:return {'ticket_id':tid,'outcome':'ignored_non_requester_or_closed_offer'}
    user=zd.get(f"/api/v2/users/{ticket['requester_id']}.json")['user']
    if not user.get('email'):raise ValueError('requester has no email')
    rid=f"zd-{tid}-reply-{reply['id']}"
    body={'action':'start','runId':rid,'wait':True,'requestedBy':{'userId':f"zendesk:{user['id']}"},'labels':{'trigger':'zendesk_email_reply','zendesk_ticket_id':str(tid),'zendesk_comment_id':str(reply['id']),'delivery_version':os.environ.get('DELIVERY_VERSION','unknown')},'input':{'stage':'refund_choice','ticketId':tid,'customer':{'email':user['email'],'name':user.get('name','Customer')},'opsChannel':cfg['ops_channel'],'approvers':cfg['approvers'],**({'giftCardLocationId':cfg['gift_card_location_id']} if cfg.get('gift_card_location_id') else {})}}
    if ledger is not None:
        ledger.put_item(Item={"event_id":key,"command":body,"expires_at":int(time.time())+7*86400},ConditionExpression="attribute_not_exists(event_id)")
    return deliver(body,invoke)

def select_request(ticket,comments,cfg):
    """A dedicated command on a new email ticket, never a reply or arbitrary Inbox mail."""
    if ticket.get('via',{}).get('channel')!='email' or ticket.get('status') in ['solved','closed']:return None
    if set(ticket.get('tags',[])) & {'cxl_acknowledged','cxl_refund_offer','cxl_cancelled','cxl_refunded'}:return None
    recipient=(ticket.get('recipient') or '').lower()
    if recipient not in [x.lower() for x in cfg.get('request_addresses',[])]:return None
    match=re.fullmatch(r'\s*(?:please\s+)?cancel\s+(?:my\s+)?subscription\s+(sub_[A-Za-z0-9]+)\s*[.!]?\s*',ticket.get('subject',''),re.I)
    if not match:return None
    public=[c for c in comments if c.get('public')]
    if not public:return None
    first=min(public,key=lambda c:int(c['id']))
    if first.get('author_id')!=ticket.get('requester_id') or first.get('via',{}).get('channel')!='email':return None
    return first,match.group(1)

def process_request(message,cfg,zd,invoke,ledger):
    key=str(message['event_id'])
    previous=ledger.get_item(Key={'event_id':key},ConsistentRead=True).get('Item')
    if previous:
        command=previous['command'];command['input']['ticketId']=int(command['input']['ticketId'])
        return deliver(command,invoke,allow_attention=True)
    tid=int(message['ticket_id']);ticket=zd.get(f'/api/v2/tickets/{tid}.json')['ticket']
    selected=select_request(ticket,zd.comments(tid),cfg)
    if not selected:return {'ticket_id':tid,'outcome':'ignored_non_cancellation_request'}
    first,sub=selected
    user=zd.get(f"/api/v2/users/{ticket['requester_id']}.json")['user']
    sender=first.get('via',{}).get('source',{}).get('from',{}).get('address','')
    if not user.get('email') or sender.lower()!=user['email'].lower():return {'ticket_id':tid,'outcome':'ignored_non_customer_requester'}
    body={'action':'start','runId':f"zd-{tid}-request-{first['id']}",'wait':True,
      'requestedBy':{'userId':f"zendesk:{user['id']}"},
      'labels':{'trigger':'zendesk_new_cancellation_email','zendesk_ticket_id':str(tid),'zendesk_comment_id':str(first['id']),'delivery_version':os.environ.get('DELIVERY_VERSION','unknown')},
      'input':{'stage':'request','channel':'email','ticketId':tid,'subscriptionId':sub,
        'message':ticket['subject'],'customer':{'email':user['email'],'name':user.get('name','Customer')},
        'opsChannel':cfg['ops_channel'],'approvers':cfg['approvers'],
        **({'giftCardLocationId':cfg['gift_card_location_id']} if cfg.get('gift_card_location_id') else {})}}
    ledger.put_item(Item={'event_id':key,'command':body,'expires_at':int(time.time())+7*86400},ConditionExpression='attribute_not_exists(event_id)')
    return deliver(body,invoke,allow_attention=True)

def deliver(body,invoke,allow_attention=False):
    rid=body["runId"];tid=body["input"].get("ticketId");comment_id=body["labels"].get("zendesk_comment_id")
    result=invoke(body)
    # A request lost after commit is delivered with the same run id. Resume a
    # parked recoverable run; never mint a new id to disguise an earlier failure.
    if result.get('phase') in ['RUNNING','APPROVED'] or (result.get('phase') in ['DONE','AWAITING_APPROVAL'] and any(a.get('status')=='failed' for a in result.get('actions',[]))):
        result=invoke({'action':'resume','runId':rid,'wait':True})
    attention=allow_attention and result.get('phase')=='DONE' and result.get('output',{}).get('decision') in ['unverified','clarify','blocked']
    if not attention and (result.get('phase') not in ['DONE','AWAITING_APPROVAL','REJECTED','EXPIRED','CANCELLED'] or (result.get('outcome') not in [None,'ok'] and result.get('phase')=='DONE')):
        raise RuntimeError('runtime did not reach an acceptable checkpoint')
    return {'ticket_id':tid or next((a.get('ref') for a in result.get('actions',[]) if a['id']=='zendesk.create_ticket'),None),'comment_id':int(comment_id) if comment_id else None,'run_id':rid,'phase':result['phase'],'outcome':result.get('outcome'),'decision':result.get('output',{}).get('decision'),'case_ref':result.get('output',{}).get('caseRef')}

def worker(event,context):
    cfg=config();client=boto3.client('bedrock-agentcore',config=Config(read_timeout=180,retries={'max_attempts':1}))
    def invoke(body):
        r=client.invoke_agent_runtime(agentRuntimeArn=os.environ['RUNTIME_ARN'],qualifier='DEFAULT',runtimeSessionId='cancellation-zendesk-'+str(uuid.uuid4()),contentType='application/json',payload=json.dumps(body).encode())
        return json.loads(r['response'].read())
    for record in event['Records']:
        message=json.loads(record['body']);ledger=boto3.resource('dynamodb').Table(os.environ['LEDGER_TABLE'])
        if message.get('kind')=='slack_cancellation':
            from slack_handler import process_slack,Slack
            slack_cfg=json.loads(boto3.client('secretsmanager').get_secret_value(SecretId=os.environ['SLACK_CONFIG_SECRET_ARN'])['SecretString'])
            result=process_slack(message,cfg,slack_cfg,invoke,ledger,Slack(slack_cfg['SLACK_API_KEY']))
        elif message.get('kind')=='email_cancellation_request':result=process_request(message,cfg,Zendesk(cfg),invoke,ledger)
        else:result=process(message,cfg,Zendesk(cfg),invoke,ledger)
        print(json.dumps({'event':'cancellation_reply_delivered','delivery_version':os.environ['DELIVERY_VERSION'],**result}))
