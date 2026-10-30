#!/usr/bin/env python3
"""External maintainer observer. Application booleans/stdout never grade outcomes."""
import argparse
import concurrent.futures
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT/'verify/contract.json').read_text())
DOCKER_HOST = 'unix:///Users/raj/.colima/xenon-verification/docker.sock'
PG = 'postgres:16.15-bookworm@sha256:e8a07d2c7579b038938cdba6c539e580e5001caf9ea203d397b5cc83e76bd938'

def digest(b): return hashlib.sha256(b).hexdigest()
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def cmd(args, *, data=None, check=True, timeout=60):
    r=subprocess.run(args,input=data,text=True,capture_output=True,timeout=timeout)
    if check and r.returncode:
        # Retain failure category, not SQL, credentials or arbitrary stderr.
        category=next((s for s in ['Connection refused','server closed the connection','database system is starting up',
          'database system is shutting down','password authentication failed','permission denied'] if s in r.stderr),'unclassified')
        raise RuntimeError(f'operation failed: {args[:3]} ({r.returncode}, {category})')
    return r
def docker(*args, **kw): return cmd(['docker',*args],**kw)
def save(path,value):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n')
    with tmp.open('rb') as f: os.fsync(f.fileno())
    tmp.replace(path)
def until(f,timeout=12):
    end=time.monotonic()+timeout;last=None
    while time.monotonic()<end:
        last=f()
        if last:return last
        time.sleep(.12)
    return last

class Run:
    def __init__(self,label,image,out):
        self.label,self.image,self.out=label,image,out
        self.prefix=f'fsoc-{label}-{secrets.token_hex(4)}'
        self.net=self.prefix+'-net';self.pg=self.prefix+'-db';self.sink=self.prefix+'-sink';self.observer=self.prefix+'-observer'
        self.names=[];self.apps=[]
        self.app_pw=secrets.token_hex(18);self.sink_pw=secrets.token_hex(18)
        self.webhook=secrets.token_hex(24);self.sink_token=secrets.token_hex(24)
        self.receipt={'schema_version':1,'workflow':CONTRACT['workflow'],'leg':label,
          'contract_sha256':digest(canonical(CONTRACT)),'assertion_implementation_sha256':digest(Path(__file__).read_bytes()),
          'available':False,'exit_code':2,'cases':[],'scope':CONTRACT['scope'],'sdk':CONTRACT['sdk'],
          'started_at':datetime.now(timezone.utc).isoformat(),'owner_release_approval':False,
          'source_revision':cmd(['git','rev-parse','HEAD'],check=False).stdout.strip()}
    def sql(self,db,sql):
        r=docker('exec','-i',self.pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db,'-At',data=sql,timeout=15)
        return r.stdout.strip()
    def number(self,db,sql):return int(self.sql(db,sql))
    def container(self,name,env,command):
        self.names.append(name)
        argv=['run','-d','--name',name,'--network',self.net,'--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
          '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--memory-swap','256m','--cpus','1','--pids-limit','80']
        for k,v in env.items():argv.extend(['-e',f'{k}={v}'])
        docker(*argv,self.image,*command)
    def request(self,name,path='/health',event=None,*,invalid=False,stale=False):
        data={'url':f'http://{name}:8080{path}'}
        if event is not None:
            body=json.dumps(event,separators=(',',':'));stamp=str(int(time.time())-(600 if stale else 0))
            sig=hmac.new(self.webhook.encode(),f'{stamp}.{body}'.encode(),hashlib.sha256).hexdigest()
            data.update(method='POST',body=body,headers={'content-type':'application/json',
              'agentcard-signature':f't={stamp},v1={"0"*64 if invalid else sig}'})
        return json.loads(docker('exec','-i',self.observer,'node','verify/request.mjs',data=json.dumps(data),timeout=8).stdout)
    def start(self):
        docker('network','create','--internal',self.net)
        self.names.append(self.pg)
        docker('run','-d','--name',self.pg,'--network',self.net,'--memory','384m','--cpus','1','--pids-limit','120',
          '--tmpfs','/var/lib/postgresql/data:rw,size=192m','-e','POSTGRES_HOST_AUTH_METHOD=trust',PG)
        # The image's temporary initialization server accepts Unix sockets before
        # shutting down. Only the final server listens on TCP. Do not race it.
        if not until(lambda:docker('exec',self.pg,'pg_isready','-h','127.0.0.1','-U','postgres',check=False).returncode==0):raise RuntimeError('postgres_not_ready')
        self.receipt['setup_stage']='schema_initialization'
        schema=(ROOT/'verify/schema.sql').read_text().replace(":'app_password'",f"'{self.app_pw}'").replace(":'sink_password'",f"'{self.sink_pw}'")
        self.sql('postgres',schema)
        # Enforce password auth after first setup; only disposable private database.
        docker('exec',self.pg,'sh','-c',"printf 'local all all trust\nhost all all all scram-sha-256\n' > /var/lib/postgresql/data/pg_hba.conf")
        self.sql('postgres','SELECT pg_reload_conf();')
        self.receipt['setup_stage']='sink_and_observer'
        self.container(self.observer,{},['sleep','infinity'])
        self.container(self.sink,{'DATABASE_URL':f'postgres://sink:{self.sink_pw}@{self.pg}:5432/sink','SINK_TOKEN':self.sink_token},['node','src/sink.mjs'])
        if not until(lambda:self.request(self.sink)['status']==200):raise RuntimeError('sink_not_ready')
        self.receipt['available']=True
    def stop_apps(self):
        for a in self.apps:docker('rm','-f',a,check=False)
        self.apps=[]
    def apps_up(self,phase=None,event_id=None):
        for i in range(2):
            name=f'{self.prefix}-app-{secrets.token_hex(3)}';self.apps.append(name)
            env={'DATABASE_URL':f'postgres://app:{self.app_pw}@{self.pg}:5432/app','SINK_URL':f'http://{self.sink}:8080',
              'SINK_TOKEN':self.sink_token,'AGENTCARD_WEBHOOK_SECRET':self.webhook}
            if i==0 and phase:env.update(DEMO_FAULT_PHASE=phase,DEMO_FAULT_EVENT=event_id)
            self.container(name,env,[])
            if not until(lambda:self.request(name)['status']==200):raise RuntimeError('app_not_ready')
        if not self.receipt.get('runtime'):
            x=json.loads(docker('inspect',self.apps[0]).stdout)[0];h=x['HostConfig']
            self.receipt['runtime']={'internal_network':json.loads(docker('network','inspect',self.net).stdout)[0]['Internal'],
              'host_mounts':x['Mounts'],'published_ports':h['PortBindings'] or {},'app_image_id':x['Image'],
              'cap_drop':h['CapDrop'],'security_opt':h['SecurityOpt'],'readonly_root':h['ReadonlyRootfs'],
              'memory':h['Memory'],'pids_limit':h['PidsLimit'],'nanocpus':h['NanoCpus'],
              'no_provider_credentials':True,'mode':'sandbox-fixture-only'}
            self.receipt['runtime']['postgres_image_id']=json.loads(docker('inspect',self.pg).stdout)[0]['Image']
            self.receipt['runtime']['postgres_version']=docker('exec',self.pg,'postgres','--version').stdout.strip()
            # Assert transport isolation; these are controls, not business outcomes.
            if self.receipt['runtime']['host_mounts'] or self.receipt['runtime']['published_ports']:raise RuntimeError('isolation_contract_failed')
    def reset(self):
        self.stop_apps()
        self.sql('app','TRUNCATE inbox,outbox,rejections;')
        self.sql('sink','TRUNCATE messages,attempts,controls;')
    def message(self,eid,shopper='a',thread=None,text='Your test order was confirmed.'):
        return {'id':eid,'type':'purchase.message','created':int(time.time()),'livemode':False,
          'data':{'kind':'order_placed','user_id':f'provider-{shopper}','external_user_id':f'shopper-{shopper}',
            'thread_id':thread or f'thread-{shopper}','text':text,'connection':{'client_id':'demo-client'},
            'facts':{'order_id':f'order-{eid}','merchant_name':'Demo Store','currency':'usd','total_cents':2500}}}
    def state(self):
        return {'inbox':self.number('app','SELECT count(*) FROM inbox;'),
          'outbox_pending':self.number('app','SELECT count(*) FROM outbox WHERE delivered_at IS NULL;'),
          'messages':self.number('sink','SELECT count(*) FROM messages;'),
          'attempts':self.number('sink','SELECT count(*) FROM attempts;'),
          'routes':json.loads(self.sql('sink',"SELECT coalesce(json_agg(x ORDER BY event_id),'[]') FROM (SELECT event_id,shopper_id,thread_id,text FROM messages) x;"))}
    def settled(self,count,timeout=3):
        until(lambda:self.number('sink','SELECT count(*) FROM messages;')>=count,timeout)
        time.sleep(.35)
        return self.state()
    def paused(self,app,phase):
        if not until(lambda:f'"checkpoint":"{phase}"' in docker('logs',app).stdout.replace(' ',''),4):raise RuntimeError('fault_checkpoint_not_reached')
    def case(self,name):
        self.reset();eid='evt_'+name;event=self.message(eid);details={};expected={}
        if name in ('crash_after_inbox','crash_after_sink'):
            phase='after-inbox' if name=='crash_after_inbox' else 'after-sink'
            # Only one worker may claim this event until the observed crash.
            self.apps_up(phase,eid);docker('rm','-f',self.apps.pop())
            ack=self.request(self.apps[0],'/webhooks/agentcard',event);self.paused(self.apps[0],phase)
            before=self.state();victim=self.apps[0];docker('kill','--signal','KILL',victim)
            killed=json.loads(docker('inspect',victim).stdout)[0]['State']['ExitCode']
            self.stop_apps();self.apps_up();after=self.settled(1)
            expected={'ack':200,'crash_exit':137,'messages_before':0 if phase=='after-inbox' else 1,'messages_after':1}
            details={'ack':ack['status'],'crash_exit':killed,'messages_before':before['messages'],'messages_after':after['messages'],
              'inbox_before':before['inbox'],'after':after,'redeliveries_after_restart':0}
            held=all(details[k]==v for k,v in expected.items()) and before['inbox']==1 and after['outbox_pending']==0
        else:
            self.apps_up();a,b=self.apps
            if name=='same_worker_replay':
                replies=[self.request(a,'/webhooks/agentcard',event) for _ in range(2)];s=self.settled(1)
                held=all(r['status']==200 for r in replies) and s['messages']==1
            elif name=='concurrent_workers':
                with concurrent.futures.ThreadPoolExecutor(2) as pool:replies=list(pool.map(lambda n:self.request(n,'/webhooks/agentcard',event),[a,b]))
                s=self.settled(1);held=all(r['status']==200 for r in replies) and s['messages']==1
            elif name=='restart_replay':
                first=self.request(a,'/webhooks/agentcard',event);self.settled(1)
                self.stop_apps();self.apps_up();second=self.request(self.apps[0],'/webhooks/agentcard',event);s=self.settled(1)
                held=first['status']==second['status']==200 and s['messages']==1
            elif name in ('sink_failure','lost_sink_response'):
                action='fail-once' if name=='sink_failure' else 'lose-response'
                self.sql('sink',f"INSERT INTO controls VALUES('{eid}','{action}');")
                reply=self.request(a,'/webhooks/agentcard',event);s=self.settled(1)
                held=reply['status']==200 and s['messages']==1 and s['attempts']>=2
            elif name in ('invalid_signature','stale_signature','expired_message'):
                if name=='expired_message':event['data']['facts']['valid_until']='2000-01-01T00:00:00Z'
                reply=self.request(a,'/webhooks/agentcard',event,invalid=name=='invalid_signature',stale=name=='stale_signature')
                s=self.settled(0);held=reply['status']==(200 if name=='expired_message' else 400) and s['messages']==s['inbox']==0
            elif name=='shopper_thread_isolation':
                events=[event,self.message(eid+'_b','b'),self.message(eid+'_a2','a','thread-a2'),self.message(eid+'_mismatch','a','thread-b')]
                replies=[self.request(a,'/webhooks/agentcard',e) for e in events];s=self.settled(3)
                routes={(x['shopper_id'],x['thread_id']) for x in s['routes']}
                held=all(r['status']==200 for r in replies) and s['messages']==3 and routes=={('shopper-a','thread-a'),('shopper-b','thread-b'),('shopper-a','thread-a2')}
            elif name=='conflicting_event':
                self.request(a,'/webhooks/agentcard',event);self.settled(1)
                changed=self.message(eid,text='Different order outcome.');reply=self.request(b,'/webhooks/agentcard',changed);s=self.settled(1)
                held=reply['status']==500 and s['messages']==1 and s['routes'][0]['text']==event['data']['text']
            elif name=='database_failure_retry':
                self.sql('postgres',"ALTER ROLE app NOLOGIN;SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='app';")
                failed=self.request(a,'/webhooks/agentcard',event)
                self.sql('postgres','ALTER ROLE app LOGIN;')
                recovered=self.request(a,'/webhooks/agentcard',event);s=self.settled(1)
                held=failed['status']==500 and recovered['status']==200 and s['messages']==1
                details['unavailable_status']=failed['status'];details['recovered_status']=recovered['status']
            else:raise RuntimeError('unknown_case')
            details.update(state=s)
            if 'reply' in locals():details['http_status']=reply['status']
        return {'name':name,'held':bool(held),'expected':expected or next(c['expected'] for c in CONTRACT['cases'] if c['id']==name),'observed':details}
    def cleanup(self):
        for n in reversed(self.names):docker('rm','-f',n,check=False,timeout=15)
        docker('network','rm',self.net,check=False)
        containers=docker('ps','-a','--filter',f'name={self.prefix}','--format','{{.Names}}').stdout.strip()
        networks=docker('network','ls','--filter',f'name={self.net}','--format','{{.Name}}').stdout.strip()
        self.receipt['cleanup']={'containers_remaining':bool(containers),'networks_remaining':bool(networks)}
    def execute(self):
        self.out.mkdir(parents=True,exist_ok=False)
        try:
            self.start()
            for case in CONTRACT['cases']:
                result=self.case(case['id']);self.receipt['cases'].append(result)
                save(self.out/'receipt.json',self.receipt)
                print(self.label,case['id'],'PASS' if result['held'] else 'FAIL',flush=True)
            self.receipt['exit_code']=0 if all(c['held'] for c in self.receipt['cases']) else 1
        except Exception as e:
            self.receipt['error_class']=type(e).__name__;self.receipt['error_stage']='setup_or_controller';self.receipt['exit_code']=2
            print(self.label,'SETUP/CONTROLLER ERROR',str(e),flush=True)
        finally:
            self.cleanup();self.receipt['finished_at']=datetime.now(timezone.utc).isoformat();save(self.out/'receipt.json',self.receipt)
        return self.receipt

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--fixed-image',required=True);p.add_argument('--broken-image',required=True)
    p.add_argument('--engine-root',help='Optional maintained private FetchSandbox engine checkout; no replacement gate is included')
    p.add_argument('--allow-local-demo-host',action='store_true',help='Explicitly use your own disposable local Docker daemon; never a production daemon')
    a=p.parse_args()
    selected_host=os.environ.get('DOCKER_HOST','')
    if selected_host!=DOCKER_HOST and not (a.allow_local_demo_host and selected_host.startswith('unix://')):
        raise SystemExit('dedicated pilot Docker host required; for your own local disposable daemon set DOCKER_HOST and explicitly pass --allow-local-demo-host')
    out=Path(a.out).resolve();out.mkdir(parents=True,exist_ok=False)
    receipts={}
    for label,image in [('healthy',a.fixed_image),('broken',a.broken_image),('repaired',a.fixed_image)]:
        receipts[label]=Run(label,image,out/label).execute()
    if a.engine_root:
        sys.path[:0]=[a.engine_root,str(Path(a.engine_root)/'backend')]
        from verification_factory.comparison import compare_control_receipts
        comparison=compare_control_receipts(receipts['healthy'],receipts['broken'],receipts['repaired'],
          expected_cases=frozenset(c['id'] for c in CONTRACT['cases']),scope=CONTRACT['scope']+'; controlled integration defect, not an Agentcard defect')
    else:
        comparison={'scope':CONTRACT['scope'],'state':'not_executed',
          'reason':'Public scenario execution only. The maintained FetchSandbox comparison engine is not distributed in this example.',
          'gate':None,'owner_release_approval':False}
    save(out/'comparison.json',comparison);save(out/'contract.json',CONTRACT)
    # Reopen every persisted receipt; command success is not a readback substitute.
    readback={k:json.loads((out/k/'receipt.json').read_text())==v for k,v in receipts.items()}
    save(out/'readback.json',readback)
    print(json.dumps(comparison),flush=True)
    if not all(readback.values()) or any(len(r['cases'])!=len(CONTRACT['cases']) or r['exit_code']==2 for r in receipts.values()):
        sys.exit(2)
    if a.engine_root:
        sys.exit(0 if comparison['gate']['green_allowed'] else 2)
    # Ordinary application test exit status, not a substitute proof verdict.
    sys.exit(0 if receipts['healthy']['exit_code']==receipts['repaired']['exit_code']==0 and receipts['broken']['exit_code']==1 else 1)
