import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
// @ts-ignore Shared session binding.
import {sessionScope} from '../n8n-lead-pilot/session-scope.mjs';
import {InvocationAuthority} from '../n8n-lead-pilot/identity';
it('enforces actual HTTP caller/runtime separation, tickets and immutable requester ownership before effects',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'c6-http-'));const file=join(dir,'adapter.mjs');
 await build({entryPoints:[new URL('../n8n-lead-pilot/adapter.ts',import.meta.url).pathname],outfile:file,bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
 const legs=Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-fixture',base_url:'https://fetchsandbox.com/sandbox/'+role+'-fixture',api_key:'fixture-only'}]));
 const cfg={legs,session_scope:sessionScope(legs),token:'fixture-runtime',n8n_token:'fixture-runtime',invocation_secret:'test-only-signing-key-32-bytes-long',requesters:[{subject:'owner',tenant:'team',token:'fixture-owner'},{subject:'other',tenant:'team',token:'fixture-other'}]};const binding=join(dir,'bindings.json'),state=join(dir,'state.json'),trace=join(dir,'trace.jsonl');writeFileSync(binding,JSON.stringify(cfg),{mode:0o600});
 const child=spawn(process.execPath,[file],{env:{PATH:process.env.PATH,PILOT_BINDINGS:binding,STATE_FILE:state,TRACE_FILE:trace,PORT:'0'}});
 try{
  const port=await new Promise<number>((resolve,reject)=>{let text='';child.once('error',reject);child.stdout.on('data',chunk=>{text+=chunk.toString();if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]!).port);});});
  const request=async(path:string,token?:string,body?:unknown)=>{const r=await fetch('http://127.0.0.1:'+port+path,{method:body?'POST':'GET',headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
  for(const token of [undefined,'wrong','fixture-runtime'])expect((await request('/invoke',token,{lead_id:'ordinary'})).status).toBe(401);
  expect((await fetch('http://127.0.0.1:'+port+'/proof/ordinary',{headers:{authorization:'fixture-owner'}})).status).toBe(401);
  const context={lead_id:'ordinary',attempt:'native-one',retry_failed:false};const command={context,request:{kind:'claim'}};
  expect((await request('/io','fixture-owner',command)).status).toBe(401);
  expect((await request('/io','fixture-runtime',command)).body.result.denied).toBe(true);
  expect((await request('/io','fixture-runtime',{...command,context:{...context,invocation:'forged'}})).body.result.denied).toBe(true);
  expect(existsSync(state)).toBe(false);
  const authority=new InvocationAuthority(cfg.invocation_secret,cfg.session_scope);const invocation=authority.mint({subject:'owner',tenant:'team'},context);
  expect((await request('/io','fixture-runtime',{context:{...context,invocation},request:{kind:'provider',provider:'slack',method:'POST',path:'/chat.postMessage',body:{}}})).body.result.denied).toBe(true);
  const accepted=await request('/io','fixture-runtime',{...command,context:{...context,invocation}});expect(accepted.body.result.claimed).toBe(true);
  const before=readFileSync(state,'utf8');
  expect((await request('/io','fixture-runtime',{context:{...context,invocation,state:{...accepted.body.result.state,version:-1}},request:{kind:'provider',provider:'slack',method:'POST',path:'/chat.postMessage',body:{}}})).body.result.denied).toBe(true);
  expect((await request('/proof/ordinary','fixture-owner')).body.records).toHaveLength(1);
  const denied=await request('/proof/ordinary','fixture-other');expect(denied).toEqual({status:403,body:{error:'forbidden'}});
  expect((await request('/invoke','fixture-other',{lead_id:'ordinary'})).status).toBe(403);
  const substitution=await request('/io','fixture-runtime',{context:{...context,invocation},request:{kind:'save',state:{...accepted.body.result.state,requester:'team:other'}}});expect(substitution.body.result.saved).toBe(false);
  expect(readFileSync(state,'utf8')).toBe(before);expect(existsSync(trace)).toBe(false);
 }finally{const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;rmSync(dir,{recursive:true,force:true});}
});
