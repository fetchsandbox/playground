"""Copy bounded native business events to an exact read-only observation source.

This does not interpret general logs, approve requests, or verify provider effects.
Malformed version-scoped business events become redacted coverage-gap records.
"""
import base64
import json
import re
import zlib

REQUIRED = {'schema_version','event_name','event_id','run_id','action_id','timestamp','attempt','trace_id','span_id','trigger_channel','agent_deployment_version'}
OPTIONAL = {'action_name','provider','decision','reason_code','outcome','rule_id','rule_version','requested_pct','approval_threshold_pct','decline_above_pct','quote_id','approval_id'}
EVENTS = {'workflow.started','workflow.resumed','workflow.paused','workflow.finished','action.proposed','action.started','action.completed','action.failed','action.uncertain','action.withheld','policy.evaluated','approval.requested','approval.approved','approval.rejected','approval.expired','customer_output.prepared','customer_output.withheld','customer_output.sent','customer_output.failed'}
def symbol(v):
    return isinstance(v,str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,160}',v) and not re.search(r'xox[abp]-|sk-|fsk_|bearer|AIza|GOCSPX',v,re.I)
def projection(raw,version):
    try:
        assert isinstance(raw,str) and len(raw.encode()) <= 65536
        v=json.loads(raw)
        assert isinstance(v,dict) and REQUIRED <= set(v) <= REQUIRED|OPTIONAL
        assert v['schema_version']=='1.0' and v['agent_deployment_version']==version and v['event_name'] in EVENTS
        assert all(symbol(v[k]) for k in ['event_id','run_id','agent_deployment_version']) and (v['action_id'] is None or symbol(v['action_id']))
        assert type(v['attempt']) is int and 1 <= v['attempt'] <= 10000
        assert isinstance(v['timestamp'],str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)',v['timestamp'])
        assert isinstance(v['trace_id'],str) and re.fullmatch(r'[a-f0-9]{32}',v['trace_id']) and set(v['trace_id']) != {'0'}
        assert isinstance(v['span_id'],str) and re.fullmatch(r'[a-f0-9]{16}',v['span_id']) and set(v['span_id']) != {'0'}
        assert v['trigger_channel'] in ['slack','email','internal']
        for k in OPTIONAL & set(v):
            if k in ['requested_pct','approval_threshold_pct','decline_above_pct']:
                assert v[k] is None or type(v[k]) in [int,float] and 0 <= v[k] <= 100
            elif k in ['quote_id','approval_id']:
                assert v[k] is None or symbol(v[k])
            else: assert symbol(v[k])
        return json.dumps(v,separators=(',',':'),ensure_ascii=False),False
    except (AssertionError,ValueError,TypeError,KeyError):
        return '{"schema_version":"unsupported","coverage_reason":"malformed-business-event"}',True

def forward(event,client,*,source,destination,owner,version):
    assert re.fullmatch(r'\d{12}',owner) and re.fullmatch(r'[1-9][0-9]*',version)
    suffix=next((x for x in ['-DEFAULT','-looplabs_cancel_v'+version] if source.endswith(x)),None)
    assert suffix and source.startswith('/aws/bedrock-agentcore/runtimes/') and source != destination
    assert destination==source.removesuffix(suffix)+'-business-v'+version
    encoded=event['awslogs']['data'];assert isinstance(encoded,str) and len(encoded)<=8388608
    zipped=base64.b64decode(encoded,validate=True);decoder=zlib.decompressobj(16+zlib.MAX_WBITS);raw=decoder.decompress(zipped,2097153)
    assert len(raw)<=2097152 and decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data
    body=json.loads(raw);assert body.get('owner')==owner and body.get('logGroup')==source
    if body.get('messageType')=='CONTROL_MESSAGE':return {'forwarded':0,'coverageGaps':0}
    assert body.get('messageType')=='DATA_MESSAGE' and isinstance(body.get('logEvents'),list) and len(body['logEvents'])<=10000
    rows=[];gaps=0
    for e in body['logEvents']:
        assert isinstance(e,dict) and type(e.get('timestamp')) is int and e['timestamp']>0
        value,gap=projection(e.get('message'),version);gaps+=int(gap);rows.append({'timestamp':e['timestamp'],'message':value})
    stream='business-v'+version
    try:client.create_log_stream(logGroupName=destination,logStreamName=stream)
    except client.exceptions.ResourceAlreadyExistsException:pass
    batch=[];size=0
    for e in sorted(rows,key=lambda e:e['timestamp']):
        n=len(e['message'].encode())+26
        if size+n>1000000:
            client.put_log_events(logGroupName=destination,logStreamName=stream,logEvents=batch);batch=[];size=0
        batch.append(e);size+=n
    if batch:client.put_log_events(logGroupName=destination,logStreamName=stream,logEvents=batch)
    return {'forwarded':len(rows),'coverageGaps':gaps}

def lambda_handler(event,context):
    import os
    import boto3
    from botocore.config import Config
    return forward(event,boto3.client('logs',config=Config(retries={'total_max_attempts':1})),source=os.environ['SOURCE_LOG_GROUP'],destination=os.environ['DESTINATION_LOG_GROUP'],owner=os.environ['SOURCE_ACCOUNT'],version=os.environ['DEPLOYMENT_VERSION'])
