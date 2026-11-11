import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const builderUrl=new URL('../n8n-lead-pilot/build-workflow.mjs',import.meta.url).href;
const moduleUrl=new URL('../verify/contracts/n8n-lead-recovery.mjs',import.meta.url).href;
function fixture(change:(w:any)=>void=()=>{},variant='normal'){
 const dir=mkdtempSync(join(tmpdir(),'n8n-contract-'));
 const workflow=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`const {buildWorkflow}=await import(${JSON.stringify(builderUrl)});console.log(JSON.stringify(buildWorkflow('https://adapter.example','friendly-pilot-mcp-20261106',{id:'fixture',name:'Fixture credential reference'},${JSON.stringify(variant)})));`],{encoding:'utf8'}));
 workflow.active=true;change(workflow);
 const path=join(dir,'workflow.json');writeFileSync(path,JSON.stringify(workflow));
 const source=join(dir,'bindings.json');writeFileSync(source,JSON.stringify({token:'fixture-only',n8n_token:'fixture-only',n8n_webhook:'https://fetchsandbox.app.n8n.cloud/webhook/friendly-pilot-mcp-20261106'}),{mode:0o600});
 return {dir,path,source};
}
function load(f:ReturnType<typeof fixture>,code='console.log(JSON.stringify({checks:c.checks.map(x=>({id:x.id,executable:!!x.actions})),dimensions:c.applicationConfig.coverage_review.length,version:c.appVersion}));',variant='normal',extraEnv:Record<string,string>={}){
 return spawnSync(process.execPath,['--input-type=module','-e',`const c=(await import(${JSON.stringify(moduleUrl)})).default;${code}`],{env:{PATH:process.env.PATH,N8N_WORKFLOW_EXPORT:f.path,PILOT_BINDINGS_SOURCE:f.source,PILOT_VARIANT:variant,...extraEnv},encoding:'utf8'});
}
describe('existing MCP runner n8n contract boundary (fixture exports only)',()=>{
 it('refuses to present the new feedback business policy as legacy pilot proof',()=>{
  const f=fixture();try{
   const result=load(f,undefined,'normal',{PILOT_RECOVERY_POLICY:JSON.stringify({maxLookups:3,windowMs:1800000,quietNotifications:true})});
   expect(result.status).not.toBe(0);expect(result.stderr).toContain('requires its own reviewed native contract');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
 });
 it('retains original requirements, C3 recovery subcheck and reviewed default dimensions',()=>{
  const f=fixture();try{const result=load(f);expect(result.status).toBe(0);const out=JSON.parse(result.stdout);expect(out.dimensions).toBe(17);expect(out.checks).toHaveLength(16);expect(out.checks.filter((x:any)=>x.executable).map((x:any)=>x.id)).toEqual(['baseline','C1','C2','C3','C3_recovery','C4','C5','C7','C8','C10','C11','C12','C12_hold','C12_recover']);expect(out.version).toMatch(/^n8n-export-[0-9a-f]{64}$/);}finally{rmSync(f.dir,{recursive:true,force:true});}
 });
 it.each(['unpublished','pinned','inline-header','no-native-auth','changed-decision'])('refuses %s before starting the runtime',kind=>{
  const f=fixture(w=>{
   if(kind==='unpublished')w.active=false;
   if(kind==='changed-decision')w.nodes.find((n:any)=>n.name==='Durable decision machine').parameters.jsCode='return [{json:{status:"confirmed"}}];';
   if(kind==='pinned')w.pinData={'Lead webhook':[{}]};
   if(kind==='inline-header')w.nodes.find((n:any)=>n.name==='State or isolated twin I/O').parameters.headerParameters={parameters:[{name:'Authorization',value:'fixture-only'}]};
   if(kind==='no-native-auth')w.nodes[0].parameters.authentication='none';
  });try{expect(load(f).status).not.toBe(0);}finally{rmSync(f.dir,{recursive:true,force:true});}
 });
 it('writes attempt bindings privately for the existing runtime lifecycle',()=>{
  const f=fixture();try{
   const result=load(f,`const env=await c.runtimeEnv({outDir:${JSON.stringify(f.dir)},legs:Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-fixture',base_url:'https://fetchsandbox.com/sandbox/'+role+'-fixture',api_key:'fixture-key-only'}]))});console.log(JSON.stringify({file:env.PILOT_BINDINGS,scope:JSON.parse((await import('node:fs')).readFileSync(env.PILOT_BINDINGS,'utf8')).session_scope}));`);
   expect(result.status).toBe(0);const output=JSON.parse(result.stdout);expect(output.scope).toMatch(/^[a-f0-9]{64}$/);const file=output.file;expect(statSync(file).mode&0o777).toBe(0o600);expect(JSON.parse(readFileSync(file,'utf8')).legs.hubspot.api_key).toBe('fixture-key-only');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
 });
});

it.each(['blind-deal-retry','blind-gmail-resend','skip-calendar-readback','blind-slack-resend'])('requires explicit matching source attestation for %s',variant=>{
 const f=fixture(()=>{},variant);try{
  expect(load(f).status).not.toBe(0);
  const accepted=load(f,'console.log(c.sourceVariant);',variant);
  expect(accepted.status).toBe(0);expect(accepted.stdout.trim()).toBe(variant);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('C7 reaches both public entry points with identical invalid payloads and zero-effect checks',()=>{
 const contract=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const c=contract.checks.find((x:any)=>x.id==='C7');
 expect(c.actions).toHaveLength(10);
 expect(c.actions.slice(0,5).map((x:any)=>x.body)).toEqual(c.actions.slice(5).map((x:any)=>x.body));
 expect(c.actions.every((x:any)=>x.expect_status===400)).toBe(true);
 expect(c.actions.slice(0,5).every((x:any)=>x.path==='/invoke')).toBe(true);
 expect(c.actions.slice(5).every((x:any)=>x.path==='/native-invoke')).toBe(true);
 expect(c.provider_assertions).toHaveLength(5);
 expect(c.provider_assertions.every((x:any)=>x.assertion.count===0 && x.assertion.required)).toBe(true);
});

it('C10 exercises the real denied routes and records harmless canaries without introducing a verifier bypass',()=>{
 const contract=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const c=contract.checks.find((x:any)=>x.id==='C10');
 expect(c.blocker).toBeUndefined();expect(c.actions).toHaveLength(8);
 expect(c.actions.slice(0,7).every((x:any)=>x.path==='/io' && x.expect_status===400)).toBe(true);
 expect(c.actions[7]).toMatchObject({path:'/not-an-allowed-route',expect_status:404});
 expect(c.actions[0].body).toMatchObject({authorization:'c10-dummy-auth-{{run_id}}',c10_marker:'c10-public-marker-{{run_id}}'});
 expect(c.before.assertion.count).toBe(0);expect(c.assertion.count).toBe(0);
 expect(c.provider_assertions).toHaveLength(5);expect(c.provider_assertions.every((x:any)=>x.assertion.count===0)).toBe(true);
});

it('C11 reuses the same business identity across independent sessions and independently checks all five effects',()=>{
 const contract=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const c=contract.checks.find((x:any)=>x.id==='C11');
 expect(c.blocker).toBeUndefined();expect(c.before).toMatchObject({path:'/proof/friendly-session-isolation',assertion:{count:0,required:true}});
 expect(c.actions).toEqual([{method:'POST',path:'/invoke',body:{lead_id:'friendly-session-isolation'},expect_status:200}]);
 expect(c.provider_assertions).toHaveLength(5);expect(c.assertion.count).toBe(1);
});

it('keeps an explicitly requested replay handoff private and refuses to overwrite it',()=>{
 const f=fixture();try{
  const original=join(f.dir,'original.env'),replay=join(f.dir,'replay.env'),state=join(f.dir,'retained-state.json');
  writeFileSync(original,'FETCHSANDBOX_VERIFIER_TOKEN=disposable-fixture-only\n',{mode:0o600});
  const legs="Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-fixture',base_url:'https://fetchsandbox.com/sandbox/'+role+'-fixture',api_key:'fixture-key-only'}]))";
  const code=`const env=await c.runtimeEnv({outDir:${JSON.stringify(f.dir)},legs:${legs},credentialFile:${JSON.stringify(original)}});console.log(JSON.stringify({state:env.STATE_FILE}));`;
  const env={PILOT_REPLAY_HANDOFF:replay,PILOT_STATE_FILE:state};const first=load(f,code,'normal',env);
  expect(first.status).toBe(0);expect(JSON.parse(first.stdout).state).toBe(state);expect(statSync(replay).mode&0o777).toBe(0o600);expect(readFileSync(replay,'utf8')).toBe(readFileSync(original,'utf8'));
  expect(load(f,code,'normal',env).status).not.toBe(0);expect(readFileSync(replay,'utf8')).toBe(readFileSync(original,'utf8'));
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});


it('freezes all 13 earlier check oracles and stays inside the engine configuration byte cap',()=>{
 const c=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const earlier=c.checks.filter((x:any)=>!['C12','C12_hold','C12_recover'].includes(x.id));
 expect(earlier).toHaveLength(13);
 expect(createHash('sha256').update(JSON.stringify(earlier)).digest('hex')).toBe('12b75e6ce89bc6ffab265c306c8127d4b2498155fc6416b514ec706e4a10299c');
 const config={app_version:'n8n-export-'+ 'a'.repeat(64)+'-bridge-'+ 'b'.repeat(12),disposable_test_app:true,require_verifier_token:true,coverage_review:c.coverage_review,scope_review:c.scope_review,checks:c.checks};
 const bytes=spawnSync('python3',['-c','import json,sys;print(len(json.dumps(json.load(sys.stdin)).encode()))'],{input:JSON.stringify(config),encoding:'utf8'});
 expect(bytes.status).toBe(0);expect(Number(bytes.stdout)).toBeLessThanOrEqual(65536);
 expect(c.checks.find((x:any)=>x.id==='C12_recover').actions.filter((x:any)=>x.delay_seconds).reduce((sum:number,x:any)=>sum+x.delay_seconds,0)).toBe(35);
});


it('C6 candidate preserves every other check and requires the new protected requester profiles',()=>{
 const original=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const overlay=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.identity.json',import.meta.url),'utf8'));
 expect(overlay.checks).toHaveLength(1);expect(overlay.checks[0].id).toBe('C6');
 const f=fixture();try{
  const result=load(f,'console.log(JSON.stringify({checks:c.checks,...c.applicationConfig}));','normal',{PILOT_CONTRACT:'identity'});expect(result.status).toBe(0);const identity=JSON.parse(result.stdout);
  expect(identity.checks.filter((x:any)=>x.id!=='C6')).toEqual(original.checks.filter((x:any)=>x.id!=='C6'));
  expect(identity.requester_profiles).toEqual(['requester_a','requester_b']);
  const c=identity.checks.find((x:any)=>x.id==='C6');expect(c.provider_assertions).toHaveLength(5);expect(JSON.stringify(c.provider_assertions)).not.toContain('step1.state.');expect(JSON.stringify(c.provider_assertions)).toContain('step1.records.0.operations.contact.id');expect(c.actions.map((a:any)=>a.expect_status)).toEqual([200,200,401,401,401,401,403,403,200]);
  const bytes=spawnSync('python3',['-c','import json,sys;print(len(json.dumps(json.load(sys.stdin)).encode()))'],{input:JSON.stringify({app_version:'n8n-export-'+'a'.repeat(64)+'-bridge-'+'b'.repeat(12),disposable_test_app:true,require_verifier_token:true,...identity}),encoding:'utf8'});expect(bytes.status).toBe(0);expect(Number(bytes.stdout)).toBe(71268);expect(Number(bytes.stdout)).toBeLessThanOrEqual(131072);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('adds only three bounded accepted-write crash checks while retaining the original C9 blocker and every prior oracle',()=>{
 const f=fixture();try{
  const result=load(f,'console.log(JSON.stringify({checks:c.checks,config:c.applicationConfig,crash:typeof c.crashSimulation,crashCount:c.crashSimulationCount,plans:[0,1,2,3].map(faultIndex=>c.crashSimulation({faultIndex,flowRunId:"test-run",legs:Object.fromEntries(["hubspot","google-calendar","slack"].map(p=>[p,{base_url:"https://fetchsandbox.com/sandbox/"+p}]))}))}));','normal',{PILOT_CONTRACT:'crash'});
  expect(result.status).toBe(0);const out=JSON.parse(result.stdout);
  const original=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
  const identity=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.identity.json',import.meta.url),'utf8'));
  expect(out.checks).toHaveLength(original.checks.length+3);
  for(const c of original.checks)expect(out.checks.find((x:any)=>x.id===c.id)).toEqual(c.id==='C6'?identity.checks[0]:c);
  expect(out.checks.find((x:any)=>x.id==='C9').blocker).toBeDefined();
  expect(out.checks.find((x:any)=>x.id==='C9_deal_crash').assertion.where).toContainEqual({select:'epoch',equals:2,required:true});
  const crash=out.checks.find((x:any)=>x.id==='C9_deal_crash');
  expect(crash.actions[1]).toMatchObject({method:'GET',path:'/proof/fs-c9-{{run_id}}'});
  const delays=crash.actions.filter((x:any)=>x.delay_seconds).map((x:any)=>x.delay_seconds);
  expect(delays.every((x:number)=>x>0&&x<=5)).toBe(true);expect(delays.reduce((a:number,b:number)=>a+b,0)).toBe(35);
  expect(JSON.stringify(crash.provider_assertions)).not.toContain('step1.state.');
  expect(JSON.stringify(crash.provider_assertions)).toContain('step2.records.0.operations.contact.id');
  expect(JSON.stringify(crash.provider_assertions)).toContain('step3.state.operations.deal.id');
  const bytes=spawnSync('python3',['-c','import json,sys;print(len(json.dumps(json.load(sys.stdin)).encode()))'],{input:JSON.stringify({app_version:'n8n-export-'+'a'.repeat(64)+'-bridge-'+'b'.repeat(12),disposable_test_app:true,require_verifier_token:true,...out.config,checks:out.checks}),encoding:'utf8'});
  expect(bytes.status).toBe(0);expect(Number(bytes.stdout)).toBeLessThanOrEqual(131072);
  expect(out.crash).toBe('function');expect(out.crashCount).toBe(3);
  expect(out.plans.map((p:any)=>p?.id??null)).toEqual(['deal','calendar','slack',null]);
  expect(out.plans.slice(0,3).map((p:any)=>p.response_identity)).toEqual(['id','id','ts']);
  for(const id of ['C9_deal_crash','C9_calendar_crash','C9_slack_crash']){
   const check=out.checks.find((c:any)=>c.id===id);expect(check.provider_assertions).toHaveLength(5);expect(check.actions[0].expect_status).toBe(502);expect(check.assertion.where).toContainEqual({select:'epoch',equals:2,required:true});
  }
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('late-dispatch overlay preserves prior oracles and reconciles the one late Contact',()=>{
 const f=fixture();try{
  const out=load(f,'console.log(JSON.stringify({checks:c.checks,count:c.scheduleSimulationCount,none:c.scheduleSimulation({crashCount:3}),plan:c.scheduleSimulation({crashCount:4,flowRunId:"fixture",legs:{hubspot:{base_url:"https://fetchsandbox.com/sandbox/h"}}})}));','normal',{PILOT_CONTRACT:'late-dispatch'});
  expect(out.status).toBe(0);const x=JSON.parse(out.stdout);const previous=JSON.parse(load(f,'console.log(JSON.stringify(c.checks));','normal',{PILOT_CONTRACT:'takeover'}).stdout);
  for(const c of previous)expect(x.checks.find((p:any)=>p.id===c.id)).toEqual(c);
  expect(x.checks).toHaveLength(previous.length+1);expect(x.count).toBe(1);expect(x.none).toBeNull();expect(x.plan.body_equals).toBe('fs-c9-late-fixture@example.com');
  const c=x.checks.find((c:any)=>c.id==='C9_late_dispatch');expect(c.assertion.where).toContainEqual({select:'epoch',equals:3,required:true});expect(c.assertion.where).toContainEqual({select:'operations.contact.confirmation',equals:'positive_readback',required:true});expect(c.provider_assertions).toHaveLength(5);
  expect(JSON.stringify(c.provider_assertions)).not.toContain('step2.records.0.operations.contact.id');expect(JSON.stringify(c.provider_assertions)).toContain('step6.state.operations.contact.id');
  const bytes=spawnSync('python3',['-c','import json,sys;print(len(json.dumps(json.load(sys.stdin)).encode()))'],{input:JSON.stringify({checks:x.checks}),encoding:'utf8'});expect(bytes.status).toBe(0);expect(Number(bytes.stdout)).toBeLessThan(120000);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

 it('takeover overlay preserves all previous checks and requires concurrent recovery plus exact independent effect identities',()=>{
 const f=fixture();try{
 const out=load(f,'console.log(JSON.stringify({checks:c.checks,count:c.crashSimulationCount,plan:c.crashSimulation({faultIndex:3,flowRunId:"test",legs:{hubspot:{base_url:"https://fetchsandbox.com/sandbox/h"}}})}));','normal',{PILOT_CONTRACT:'takeover'});
 expect(out.status).toBe(0);const x=JSON.parse(out.stdout);const prior=JSON.parse(load(f,'console.log(JSON.stringify(c.checks));','normal',{PILOT_CONTRACT:'crash'}).stdout);
 for(const c of prior)expect(x.checks.find((p:any)=>p.id===c.id)).toEqual(c);
 expect(x.checks).toHaveLength(prior.length+1);expect(x.count).toBe(4);expect(x.plan.id).toBe('takeover');expect(x.plan.body_equals).toBe('Pilot fs-c9-takeover-test');
 const check=x.checks.find((c:any)=>c.id==='C9_competing_takeover');expect(check.actions.filter((a:any)=>a.concurrency===2)).toHaveLength(1);expect(check.provider_assertions).toHaveLength(5);expect(JSON.stringify(check)).not.toContain('step3.state.');expect(JSON.stringify(check)).toContain('step4.state.operations.deal.id');
 expect(check.assertion.where).toContainEqual({select:'epoch',equals:2,required:true});
 }finally{rmSync(f.dir,{recursive:true,force:true});}
 });

it('late acceptance requires one held/unknown Slack report and one later confirmed report, not two confirmations',()=>{
 const overlay=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.late-dispatch.json',import.meta.url),'utf8'));
 const assertions=overlay.checks[0].provider_assertions.find((p:any)=>p.provider==='slack').assertion.all_of;
 expect(assertions.some((a:any)=>a.count===1&&a.where?.some((w:any)=>w.select==='text'&&w.equals===JSON.stringify({lead_id:'fs-c9-late-{{run_id}}',status:'unknown',blocked_step:'contact'})))).toBe(true);
 expect(assertions.find((a:any)=>a.where?.some((w:any)=>w.select==='text'&&w.contains)).count).toBe(2);
});

it('stale native I/O overlay retains every prior check and requires withheld effects plus an unknown Contact',()=>{
 const f=fixture();try{
  const out=load(f,'console.log(JSON.stringify({checks:c.checks,stale:c.staleIo}));','normal',{PILOT_CONTRACT:'stale-io'});expect(out.status).toBe(0);const x=JSON.parse(out.stdout);const prior=JSON.parse(load(f,'console.log(JSON.stringify(c.checks));','normal',{PILOT_CONTRACT:'late-dispatch'}).stdout);
  for(const c of prior)expect(x.checks.find((p:any)=>p.id===c.id)).toEqual(c);expect(x.checks).toHaveLength(prior.length+1);expect(x.stale).toBe(true);
  const c=x.checks.find((c:any)=>c.id==='C9_stale_native_io');expect(c.assertion.where).toContainEqual({select:'epoch',equals:2,required:true});expect(c.assertion.where).toContainEqual({select:'status',equals:'unknown',required:true});expect(c.assertion.where).toContainEqual({select:'notification.blocked_step',equals:'contact',required:true});expect(c.provider_assertions).toHaveLength(5);expect(c.provider_assertions.slice(0,4).every((p:any)=>p.assertion.count===0)).toBe(true);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('stale I/O qualification checks the actual signing authority rather than treating an expired or altered ticket as ownership proof',()=>{
 const f=fixture();try{
  const code=`const legs=Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-fixture',base_url:'https://fetchsandbox.com/sandbox/'+role+'-fixture',api_key:'fixture-only'}]));const env=await c.runtimeEnv({legs,outDir:${JSON.stringify(f.dir)}});const w=await c.staleIoWitnesses({legs,flowRunId:'fixture',port:8098,env});const b=JSON.parse((await import('node:fs')).readFileSync(env.PILOT_BINDINGS));const {tsImport}=await import('tsx/esm/api');const {InvocationAuthority}=await tsImport('../../n8n-lead-pilot/identity.ts',${JSON.stringify(moduleUrl)});const a=new InvocationAuthority(b.invocation_secret,b.session_scope),input={lead_id:'fs-c9-stale-fixture',retry_failed:false},p={subject:'pilot-owner',tenant:'pilot-team'},ticket=a.mint(p,input);console.log(JSON.stringify({valid:w.verifyInvocation(ticket),expired:w.verifyInvocation(a.mint(p,input,Date.now()-100000)),altered:w.verifyInvocation(ticket.slice(0,-3)+'xxx'),foreign:w.verifyInvocation(a.mint({subject:'pilot-other',tenant:'pilot-team'},input))}));`;
  const out=load(f,code,'normal',{PILOT_CONTRACT:'stale-io'});expect(out.status,out.stderr).toBe(0);expect(JSON.parse(out.stdout)).toEqual({valid:true,expired:false,altered:false,foreign:false});
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('the executable C9 candidate keeps prior checks and covers actual Contact and Gmail crashes with shared conditional storage',()=>{
 const f=fixture();try{
  expect(load(f,'','normal',{PILOT_CONTRACT:'c9-candidate'}).status).not.toBe(0);
  const code='console.log(JSON.stringify({checks:c.checks,count:c.crashSimulationCount,plans:[0,1,2,3,4,5,6].map(faultIndex=>c.crashSimulation({faultIndex,flowRunId:"fixture",legs:Object.fromEntries(["hubspot","gmail","google-calendar","slack"].map(p=>[p,{base_url:"https://fetchsandbox.com/sandbox/"+p}]))}))}));';
  const out=load(f,code,'normal',{PILOT_CONTRACT:'c9-candidate',PILOT_STATE_TABLE:'fixture-conditional-table'});expect(out.status,out.stderr).toBe(0);const x=JSON.parse(out.stdout);const prior=JSON.parse(load(f,'console.log(JSON.stringify(c.checks));','normal',{PILOT_CONTRACT:'stale-io'}).stdout);
  for(const c of prior.filter((c:any)=>c.id!=='C9'))expect(x.checks.find((p:any)=>p.id===c.id)).toEqual(c);
  expect(x.checks).toHaveLength(prior.length+1);expect(x.count).toBe(6);expect(x.plans.map((p:any)=>p?.id??null)).toEqual(['deal','calendar','slack','takeover','contact','gmail',null]);
  const c=x.checks.find((c:any)=>c.id==='C9');expect(c.blocker).toBeUndefined();expect(c.actions.some((a:any)=>a.concurrency===2)).toBe(true);expect(c.assertion.where).toContainEqual({select:'operations.gmail.confirmation',equals:'positive_readback',required:true});expect(JSON.stringify(c)).toContain('step2.records.0.operations.deal.id');expect(JSON.stringify(c)).toContain('step4.state.operations.gmail.id');
  expect(Buffer.from(x.plans[5].body_equals,'base64url').toString()).toContain('Message-ID: <fs-c9-gmail-fixture@example.com>');
  const contact=x.checks.find((c:any)=>c.id==='C9_contact_crash');expect(contact.assertion.where).toContainEqual({select:'operations.contact.confirmation',equals:'positive_readback',required:true});expect(JSON.stringify(contact)).not.toContain('step2.records.0.operations.contact.id');
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('qualifies the two-minute feedback policy with every existing crash control, without reusing historical policy receipts',()=>{
 const f=fixture();try{
  const policy={maxLookups:3,windowMs:120000,quietNotifications:true,uniqueDealIdentity:true};
  const code=`console.log(JSON.stringify({checks:c.checks,crashes:c.crashSimulationCount,schedule:c.scheduleSimulationCount,stale:c.staleIo,env:c.appEnv}));`;
  const result=load(f,code,'normal',{PILOT_CONTRACT:'feedback-crash',PILOT_STATE_TABLE:'fixture',PILOT_RECOVERY_POLICY:JSON.stringify(policy)});
  expect(result.status,result.stderr).toBe(0);const out=JSON.parse(result.stdout);
  expect(out.crashes).toBe(6);expect(out.schedule).toBe(1);expect(out.stale).toBe(true);
  expect(JSON.parse(out.env.PILOT_RECOVERY_POLICY)).toEqual(policy);
  expect(out.checks).toHaveLength(25);expect(out.checks.some((c:any)=>c.blocker)).toBe(false);
  expect(out.checks.find((c:any)=>c.id==='F_email_deadline').observation_deadline_seconds).toBe(150);
  expect(out.checks.find((c:any)=>c.id==='F_email_deadline').assertion.where).toContainEqual({select:'recovery_policy.windowMs',equals:120000,required:true});
  expect(out.checks.find((c:any)=>c.id==='C9').actions.some((a:any)=>a.concurrency===2)).toBe(true);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('retains unmeasured scenarios in the separate real30-minute focused receipt and requests an explicit bounded tunnel',()=>{
 const f=fixture();try{
  const policy={maxLookups:3,windowMs:1800000,quietNotifications:true,uniqueDealIdentity:true};
  const result=load(f,`console.log(JSON.stringify({checks:c.checks,config:c.applicationConfig,lease:c.tunnelTtlSeconds,env:c.appEnv}));`,'normal',{PILOT_CONTRACT:'feedback-wallclock',PILOT_RECOVERY_POLICY:JSON.stringify(policy)});
  expect(result.status,result.stderr).toBe(0);const out=JSON.parse(result.stdout);
  expect(out.checks.filter((c:any)=>c.actions).map((c:any)=>c.id)).toEqual(['baseline','F_email_deadline']);
  expect(out.checks.filter((c:any)=>c.blocker)).toHaveLength(16);
  expect(out.config.execution_budget_seconds).toBe(2400);expect(out.lease).toBe(3600);
  expect(out.checks.find((c:any)=>c.id==='F_email_deadline').observation_deadline_seconds).toBe(1830);
  expect(JSON.parse(out.env.PILOT_RECOVERY_POLICY)).toEqual(policy);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
