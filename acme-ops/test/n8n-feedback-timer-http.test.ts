import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InvocationAuthority} from '../n8n-lead-pilot/identity';
// @ts-ignore Existing session namespace implementation.
import {sessionScope} from '../n8n-lead-pilot/session-scope.mjs';

it('protects the real timer route and durably backs off an unavailable native trigger without claiming recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feedback-http-')),bundle=join(dir,'adapter.mjs');
 await build({entryPoints:[new URL('../n8n-lead-pilot/adapter.ts',import.meta.url).pathname],outfile:bundle,bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
 const legs=Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-fixture',base_url:'https://fetchsandbox.com/sandbox/'+role+'-fixture',api_key:'fixture-only'}]));
 // Deliberately UNBOUND native webhook. This exercises a real setup failure;
 // it cannot create an n8n execution or make a live provider request.
 const cfg={legs,session_scope:sessionScope(legs),token:'fixture-runtime',n8n_token:'fixture-runtime',invocation_secret:'test-only-signing-key-32-bytes-long',requesters:[{subject:'owner',tenant:'team',token:'fixture-owner'}]};
 const binding=join(dir,'binding.json');writeFileSync(binding,JSON.stringify(cfg),{mode:0o600});
 const child=spawn(process.execPath,[bundle],{env:{PATH:process.env.PATH,PILOT_BINDINGS:binding,STATE_FILE:join(dir,'state.json'),TRACE_FILE:join(dir,'trace.jsonl'),PORT:'0',FETCHSANDBOX_VERIFIER_TOKEN:'fixture-verifier',PILOT_RECOVERY_POLICY:JSON.stringify({maxLookups:3,windowMs:1800000,quietNotifications:true})}});
 try{
  const port=await new Promise<number>((resolve,reject)=>{let text='';child.once('error',reject);child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]!).port);});});
  const request=async(path:string,token:string,body?:unknown)=>{const r=await fetch('http://127.0.0.1:'+port+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
  expect((await request('/reconcile-due','fixture-owner',{})).status).toBe(403);
  expect((await request('/reconcile-due','wrong',{})).status).toBe(401);
  const context={lead_id:'timer',attempt:'native-one',retry_failed:false};
  const invocation=new InvocationAuthority(cfg.invocation_secret,cfg.session_scope).mint({subject:'owner',tenant:'team'},context);
  const claim=await request('/io','fixture-runtime',{context:{...context,invocation},request:{kind:'claim'}});
  const row={...claim.body.result.state,status:'unknown',next_reconcile_at:0,operations:{gmail:{status:'unknown',reconciliation:{started_at:Date.now(),attempts:1}}}};
  expect((await request('/io','fixture-runtime',{context:{...context,invocation},request:{kind:'save',state:row}})).body.result.saved).toBe(true);
  expect(await request('/reconcile-due','fixture-verifier',{})).toEqual({status:200,body:{invoked:1,unconfirmed:1}});
  const saved=(await request('/proof/timer','fixture-owner')).body.records[0];
  expect(saved).toMatchObject({status:'unknown',reconciliation_transport_error:{status:'unconfirmed'},operations:{gmail:{reconciliation:{attempts:1}}}});
  expect(saved.transport_retry_not_before).toBeGreaterThan(Date.now());
  expect((await request('/reconcile-due','fixture-verifier',{})).body).toEqual({invoked:0,unconfirmed:0});
 }finally{
  const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;rmSync(dir,{recursive:true,force:true});
 }
});
