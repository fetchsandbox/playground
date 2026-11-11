/** Actual worker SIGKILL + sequential FileStore restart + independent HTTP
 * fixture. This is local qualification, not native n8n/live-provider proof. */
import {describe,it,expect,beforeAll,afterAll,beforeEach,afterEach} from 'vitest';
import {createServer,type Server} from 'node:http';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore} from '../src/kit/store';
describe('Friendly feedback process and HTTP qualification',()=>{
 let server:Server,origin:string,dir:string;
 type Kind='contact'|'deal'|'gmail'|'calendar'|'slack';
 let effects:Record<Kind,any[]>,reads:Record<Kind|'directDeal',number>,visible:Record<Kind,boolean>;
 const children=new Set<ChildProcess>(),policy={maxLookups:3,windowMs:4000,quietNotifications:true};
 const raw=Buffer.from('To: crash@example.com\r\nMessage-ID: <crash@example.com>\r\n\r\nUnsent follow-up').toString('base64url');
 const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 beforeAll(async()=>{
  server=createServer(async(req,res)=>{
   let text='';for await(const c of req)text+=c;
   const body=text?JSON.parse(text):{},path=req.url!;let out:any;
   const read=(kind:Kind)=>{reads[kind]++;return visible[kind]?effects[kind]:[];};
   if(path.endsWith('/contacts/search'))out={results:read('contact')};
   else if(path.endsWith('/deals/search'))out={results:read('deal')};
   else if(path.includes('/objects/deals/')&&req.method==='GET'){reads.directDeal++;out=path.includes('idProperty=fetchsandbox_pilot_lead_id')?effects.deal.find(x=>x.properties.fetchsandbox_pilot_lead_id===decodeURIComponent(path.split('?')[0]!.split('/').pop()!)):effects.deal.find(x=>path.includes('/'+x.id+'?'));}
   else if(path.includes('/messages?'))out={messages:read('gmail').map(x=>({id:x.id}))};
   else if(path.includes('/messages/')&&req.method==='GET')out=effects.gmail[0];
   else if(path.includes('/events/')&&req.method==='GET')out=effects.calendar[0];
   else if(path.includes('/conversations.history?'))out={ok:true,has_more:false,messages:read('slack')};
   else {
    const kind=path.includes('/contacts')?'contact':path.includes('/deals')?'deal':path.includes('/gmail/')?'gmail':path.includes('/events')?'calendar':'slack';
    const id=kind+'-'+(effects[kind].length+1);
    out=kind==='deal'?{id,properties:body.properties,associations:{contacts:{results:[{id:effects.contact[0].id}]}}}
     :kind==='gmail'?{id,labelIds:['SENT'],payload:{headers:[{name:'To',value:'crash@example.com'},{name:'Message-ID',value:'<crash@example.com>'}]}}
     :kind==='slack'?{ok:true,ts:id,...body}:kind==='calendar'?{status:'confirmed',...body,id:body.id}:{id,properties:body.properties};
    effects[kind].push(out);
   }
   res.writeHead(out?200:404,{'content-type':'application/json'});res.end(JSON.stringify(out??{}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+(server.address() as any).port;
 });
 beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'friendly-feedback-'));effects={contact:[],deal:[],gmail:[],calendar:[],slack:[]};reads={contact:0,deal:0,directDeal:0,gmail:0,calendar:0,slack:0};visible={contact:true,deal:true,gmail:true,calendar:true,slack:true};});
 afterEach(async()=>{for(const c of [...children]){const end=once(c,'exit');c.kill('SIGKILL');await end;}rmSync(dir,{recursive:true,force:true});});
 afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
 const row=()=>new FileStore(join(dir,'state.json')).get('lead-pilot#feedback#crash');
 const worker=(owner:string,killAfter?:(m:any)=>boolean,uniqueDealIdentity=false)=>new Promise<any>((resolve,reject)=>{
  const c=fork(new URL('./fixtures/n8n-c9-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,C9_FIXTURE:JSON.stringify({file:join(dir,'state.json'),scope:'feedback',owner,lead:'crash',provider:origin,raw,recoveryPolicy:{...policy,...(uniqueDealIdentity?{uniqueDealIdentity:true}:{})}})},stdio:['ignore','ignore','pipe','ipc']});
  children.add(c);let error='',result:any,killed=false;
  c.stderr?.on('data',x=>error+=x);c.on('error',reject);
  c.on('message',(m:any)=>{if(m.done)result=m.done;else if(killAfter?.(m)){killed=true;c.kill('SIGKILL');}else c.send('continue');});
  c.on('exit',code=>{children.delete(c);if(killed)resolve({killed:true});else if(result)resolve(result);else reject(Error('Worker exited '+code+': '+error));});
 });
 const accepted=(m:any,p:string,path:string)=>m.phase==='after'&&m.request?.kind==='provider'&&m.request.provider===p&&m.request.method==='POST'&&m.request.path===path;
 const nextDue=async()=>{const r=await row();await pause(Math.max(0,Number(r!.next_reconcile_at)-Date.now())+10);};
 it('lagged Deal search holds after accepted-write SIGKILL, then recovers original ID and association',async()=>{
  expect(await worker('original',m=>accepted(m,'hubspot','/crm/v3/objects/deals'))).toEqual({killed:true});
  visible.deal=false;await pause(1050);expect((await worker('recovery')).status).toBe('unknown');
  expect(effects.deal).toHaveLength(1);expect(effects.gmail).toHaveLength(0);expect(effects.slack).toHaveLength(1);
  const prior=JSON.stringify(reads);await worker('early');expect(JSON.stringify(reads)).toBe(prior);
  visible.deal=true;await nextDue();expect((await worker('visible')).status).toBe('confirmed');
  expect(effects.deal).toHaveLength(1);expect(reads.directDeal).toBe(1);
  expect((await row())!.operations).toMatchObject({deal:{id:effects.deal[0].id,status:'confirmed'}});
  expect(effects.gmail).toHaveLength(1);expect(effects.calendar).toHaveLength(1);
  expect(effects.slack.map(x=>JSON.parse(x.text).status)).toEqual(['unknown','confirmed']);
 },15000);
 it('Gmail unknown persists across workers and reaches needs_human with no resend, no Calendar, and two notices',async()=>{
  expect(await worker('original',m=>accepted(m,'gmail','/gmail/v1/users/me/messages/send'))).toEqual({killed:true});
  visible.gmail=false;await pause(1050);expect((await worker('first')).status).toBe('unknown');
  expect((await row())!.recovery_policy).toEqual(policy);
  await worker('duplicate');expect(reads.gmail).toBe(1);expect(effects.slack).toHaveLength(1);
  await nextDue();expect((await worker('second')).status).toBe('unknown');
  expect(reads.gmail).toBe(2);expect(effects.slack).toHaveLength(1);
  const deadline=((await row())!.operations as any).gmail.reconciliation.started_at+policy.windowMs;
  await pause(Math.max(0,deadline-Date.now())+20);expect((await worker('deadline')).status).toBe('needs_human');
  expect((await row())!.handoff).toMatchObject({lead_id:'crash',blocked_step:'gmail',lookup_attempts:2,email_draft:{raw_base64url:raw,send_outcome:'unknown'}});
  expect(effects.gmail).toHaveLength(1);expect(effects.calendar).toHaveLength(0);
  expect(effects.slack.map(x=>JSON.parse(x.text).status)).toEqual(['unknown','needs_human']);
  await worker('terminal');expect(effects.slack).toHaveLength(2);expect(reads.gmail).toBe(2);
 },15000);
 it('recovers a Slack notice accepted before SIGKILL without posting twice',async()=>{
  expect(await worker('original',m=>accepted(m,'slack','/chat.postMessage'))).toEqual({killed:true});
  expect(effects.slack).toHaveLength(1);expect((await row())!.notification).toMatchObject({status:'in_flight'});
  await pause(1050);expect((await worker('replacement')).status).toBe('confirmed');
  expect(reads.slack).toBe(1);expect(effects.slack).toHaveLength(1);
  expect((await row())!.notification).toMatchObject({status:'confirmed',ts:effects.slack[0].ts,confirmation:'positive_readback'});
  await worker('duplicate');expect(effects.slack).toHaveLength(1);
 },15000);
 it('recovers by unique Deal key after accepted-write crash even while search is invisible',async()=>{
  expect(await worker('original',m=>accepted(m,'hubspot','/crm/v3/objects/deals'),true)).toEqual({killed:true});
  visible.deal=false;await pause(1050);
  expect((await worker('replacement',undefined,true)).status).toBe('confirmed');
  expect(reads.deal).toBe(0);expect(reads.directDeal).toBe(1);expect(effects.deal).toHaveLength(1);
  expect(effects.deal[0].properties.fetchsandbox_pilot_lead_id).toBe('crash');
  expect((await row())!.operations).toMatchObject({deal:{id:effects.deal[0].id,status:'confirmed',confirmation:'positive_unique_key_readback'}});
  expect(effects.gmail).toHaveLength(1);expect(effects.calendar).toHaveLength(1);expect(effects.slack).toHaveLength(1);
 },15000);

});
