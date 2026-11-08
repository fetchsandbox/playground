#!/usr/bin/env python3
"""Use two protected native handoffs for C11 credential controls, never read them.
Usage: python3 n8n-lead-pilot/probe-session-lifecycle.py /private/proof-directory
Does not execute or judge a workflow. Removes its own temporary child on exit.
"""
from pathlib import Path
import json,os,subprocess,hashlib,socket,sys,re
root=Path(sys.argv[1]).resolve()
assert root.is_dir() and root.stat().st_mode&0o077==0,'Private proof directory required'
a=Path(json.loads((root/'session-a-out.json').read_text())['path']);b=Path(json.loads((root/'session-b-out.json').read_text())['path'])
shared=root/'shared-state-private.json';repo=Path(__file__).resolve().parents[1]
for directory in [a,b]:assert (directory/'replay-handoff-private.env').stat().st_mode&0o077==0,'Private handoff permissions required'
with socket.socket() as sock:assert sock.connect_ex(('127.0.0.1',8097))!=0,'Owned proof port is occupied'
inherited={k:v for k,v in os.environ.items() if not re.match(r'^(META|STRIPE|HUBSPOT|GMAIL|GCAL|GOOGLE_CALENDAR|SLACK|ZENDESK|ASANA|WORKOS|GH|GITHUB|TWILIO|PAGERDUTY|NOTION|BOX|TRADE_GOV|SCREENING|SQUARE|OPENAI|SHOPIFY|NETSUITE|EASYPOST|PLAID|TWILIO_VERIFY|FETCHSANDBOX|ANTHROPIC|X_FLOW)_',k)}
env=dict(inherited,PILOT_BINDINGS=str(b/'n8n-bindings-private.json'),STATE_FILE=str(shared),TRACE_FILE=str(b/'lifecycle-trace-private.jsonl'),PORT='8097',WORKFLOW='n8n-lead-recovery')
log=(b/'lifecycle-adapter-private.log').open('w');(b/'lifecycle-adapter-private.log').chmod(0o600)
child=subprocess.Popen(['node','--env-file='+str(b/'replay-handoff-private.env'),str(repo/'dist/lead-pilot-c11.mjs')],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT)
try:
 before=hashlib.sha256(shared.read_bytes()).hexdigest();observations={}
 for mode,directory in [('current',b),('retired',a)]:
  command=['node','--env-file='+str(directory/'replay-handoff-private.env'),str(repo/'n8n-lead-pilot/probe-session-credential.mjs'),str(b/'session.json'),str(a/'session.json'),mode]
  with (b/('credential-worker-'+mode+'-private.log')).open('w') as errors:
   output=subprocess.check_output(command,env=inherited,cwd=repo,text=True,stderr=errors)
  observations[mode]=json.loads(output)
 current,retired=observations['current'],observations['retired']
 assert current['verifier_fingerprint']!=retired['verifier_fingerprint'],'Verifier credential was reused'
 pairs=[]
 for new in current['provider_credentials']:
  old=next(x for x in retired['provider_credentials'] if x['provider']==new['provider'])
  pairs.append({'provider':new['provider'],'keys_differ':new['fingerprint']!=old['fingerprint'],'current_status':new['status'],'retired_status':old['status'],'current_authorized':new['authorized'],'retired_authorized':old['authorized']})
 result={'session_scope':current['session_scope'],'runtime_identity_source':'application_reported','observed_os_child_pid':child.pid,'current_verifier_status':current['current_verifier_status'],'retired_verifier_statuses':retired['retired_verifier_statuses'],'provider_credentials':pairs,'retired_sandbox_url_statuses':[x['prior_url_status'] for x in retired['provider_credentials']],'state_sha_before':before,'state_sha_after':hashlib.sha256(shared.read_bytes()).hexdigest()}
 (root/'lifecycle-probe-observation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
 assert result['current_verifier_status']==200 and result['retired_verifier_statuses']==[401]*3 and result['state_sha_before']==result['state_sha_after']
 assert all(x['keys_differ'] and x['current_authorized'] and not x['retired_authorized'] for x in pairs)
 assert result['retired_sandbox_url_statuses']==[404]*4
finally:
 child.terminate()
 try:child.wait(timeout=10)
 except subprocess.TimeoutExpired:child.kill();child.wait()
 log.close()
