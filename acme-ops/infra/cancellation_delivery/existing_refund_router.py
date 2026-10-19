"""Narrow routing extension for the existing signature-verified Acme Slack queue.

The existing worker remains responsible for every non-refund delivery. The
refund worker receives Slack events/buttons or a scoped Gmail polling nudge.
"""
import json,re
from urllib.parse import parse_qs

def refund_route(payload):
    path=payload.get('path','').split('?')[0]
    if path=='/webhooks/slack/events':
        body=json.loads(payload.get('raw_body','{}'));ev=body.get('event',{})
        if ev.get('bot_id') or ev.get('subtype'):return None
        if re.search(r'\brefund\b',ev.get('text',''),re.I):return {'action':'slack_intake','event':body}
    if path=='/webhooks/slack/interactions':
        form=parse_qs(payload.get('raw_body',''));body=json.loads(form.get('payload',['{}'])[0]);action=(body.get('actions') or [{}])[0]
        if action.get('action_id') in ['acme_refund_approve','acme_refund_reject']:
            return {'action':'decide','caseId':action['value'],'decision':'approve' if action['action_id']=='acme_refund_approve' else 'reject','userId':body['user']['id']}
    if path=='/webhooks/gmail':return {'action':'poll_email'}
    return None
