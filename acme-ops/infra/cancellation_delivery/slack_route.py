"""Explicit subscription-cancellation intent, before the existing refund router."""
import json,re

def cancellation_route(payload):
    if payload.get('path','').split('?')[0]!='/webhooks/slack/events':return None
    body=json.loads(payload.get('raw_body','{}'));ev=body.get('event',{})
    if body.get('type')!='event_callback' or ev.get('type') not in ['message','app_mention']:return None
    if ev.get('bot_id') or ev.get('subtype') or not all(ev.get(k) for k in ['user','channel','ts']):return None
    text=ev.get('text','')
    if not re.match(r'^\s*(?:<@[A-Z0-9]+>\s*)?(?:please\s+)?cancel\s+(?:(?:my|this|the)\s+)?(?:subscription\b|sub_\w+\b)',text,re.I):return None
    if not (re.search(r'\bsubscription\b',text,re.I) or re.search(r'\bsub_\w+\b',text)):return None
    if not body.get('event_id') or not body.get('team_id'):return None
    return {'kind':'slack_cancellation','event_id':'slack:'+body['team_id']+':'+body['event_id'],'team_id':body['team_id'],'user_id':ev['user'],'channel_id':ev['channel'],'message_ts':ev['ts'],'thread_ts':ev.get('thread_ts') or ev['ts'],'text':text}
