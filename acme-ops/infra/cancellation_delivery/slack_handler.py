"""Authenticated workspace identities → canonical cancellation command → thread outcome."""
import json,re,time,uuid,urllib.request,urllib.parse
from handler import deliver

class Slack:
 def __init__(self,token):self.token=token
 def api(self,method,body):
  if method in ['users.info','conversations.replies']:
   req=urllib.request.Request('https://slack.com/api/'+method+'?'+urllib.parse.urlencode(body),headers={'Authorization':'Bearer '+self.token})
  else:req=urllib.request.Request('https://slack.com/api/'+method,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+self.token,'content-type':'application/json'})
  with urllib.request.urlopen(req,timeout=25) as r:result=json.load(r)
  if not result.get('ok'):raise RuntimeError('Slack '+method+' '+str(result.get('error','failed')))
  return result

def outcome_text(result):
 ref=result.get('case_ref') or 'Cancellation request';ticket=result.get('ticket_id');suffix=f'\nCase: {ref}'+(f' · Support ticket #{ticket}' if ticket else '')
 if result.get('phase')=='AWAITING_APPROVAL':return '*Cancellation awaiting approval*\nThe policy requires a manager review before it can continue.'+suffix
 if result.get('decision')=='cancel' and result.get('phase')=='DONE' and result.get('outcome')=='ok':return '*Subscription cancelled*\nPlease check your email for the policy outcome and any refund choices. Reply to that email to choose.'+suffix
 return '*Cancellation needs attention*\nI could not confirm a completed cancellation. Please review the case before trying again.'+suffix

def send_thread(slack,message,text,rid,existing=None):
 # Recover an already-posted result after losing the Slack response. Do not
 # blindly post another reply on a delivery retry.
 cursor=None
 for _ in range(20):
  page=slack.api('conversations.replies',{'channel':message['channel_id'],'ts':message['thread_ts'],'limit':100,'include_all_metadata':'true',**({'cursor':cursor} if cursor else {})})
  found=[m for m in page.get('messages',[]) if m.get('metadata',{}).get('event_payload',{}).get('cancellation_run_id')==rid]
  if found:
   if found[0].get('text')!=text:slack.api('chat.update',{'channel':message['channel_id'],'ts':found[0]['ts'],'text':text})
   return found[0]['ts']
  cursor=page.get('response_metadata',{}).get('next_cursor')
  if not cursor:break
 else:raise RuntimeError('Slack thread pagination limit')
 return slack.api('chat.postMessage',{'channel':message['channel_id'],'thread_ts':message['thread_ts'],'text':text,'unfurl_links':False,'unfurl_media':False,'client_msg_id':str(uuid.uuid5(uuid.NAMESPACE_URL,rid)),'metadata':{'event_type':'acme_cancellation_result','event_payload':{'cancellation_run_id':rid}}})['ts']

def process_slack(message,cfg,slack_cfg,invoke,ledger,slack):
 if message.get('team_id')!=slack_cfg['expected_team_id']:raise ValueError('Slack workspace mismatch')
 key=message['event_id'];previous=ledger.get_item(Key={'event_id':key},ConsistentRead=True).get('Item')
 if previous:
  command=previous['command'];message=previous['slack_message']
 else:
  user=slack.api('users.info',{'user':message['user_id']})['user'];email=user.get('profile',{}).get('email','')
  if user.get('id')!=message['user_id'] or user.get('deleted') or user.get('is_bot') or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):raise ValueError('Slack requester identity unavailable')
  ids=list(dict.fromkeys(re.findall(r'\bsub_\w+\b',message.get('text',''))));rid='slack-cxl-'+message['event_id'].rsplit(':',1)[-1]
  if len(ids)!=1:
   ts=send_thread(slack,message,'Please include one subscription reference, for example: `cancel subscription sub_…`. I have not cancelled anything.',rid)
   return {'event_id':key,'outcome':'clarification_sent','slack_thread_message_ts':ts}
  command={'action':'start','runId':rid,'wait':True,'requestedBy':{'userId':'slack:'+message['user_id']},'labels':{'trigger':'slack','slack_event_id':message['event_id'],'delivery_version':__import__('os').environ.get('DELIVERY_VERSION','unknown')},'input':{'stage':'request','channel':'slack','subscriptionId':ids[0],'customer':{'email':email,'name':user.get('real_name') or user.get('name') or 'Customer'},'message':message['text'][:4000],'opsChannel':message['channel_id'],'opsThreadTs':message['thread_ts'],'approvers':cfg['approvers'],**({'giftCardLocationId':cfg['gift_card_location_id']} if cfg.get('gift_card_location_id') else {})}}
  ledger.put_item(Item={'event_id':key,'command':command,'slack_message':message,'expires_at':int(time.time())+7*86400},ConditionExpression='attribute_not_exists(event_id)')
 if not previous:send_thread(slack,message,'Checking your subscription, purchase and cancellation policy…',command['runId'])
 result=deliver(command,invoke,allow_attention=True);rid=command['runId'];ts=send_thread(slack,message,outcome_text(result),rid)
 return {**result,'event_id':key,'slack_thread_message_ts':ts}
