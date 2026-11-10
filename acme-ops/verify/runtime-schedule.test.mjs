import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createDeferredQueue,watchDelayedDispatch} from './runtime-schedule.mjs';
async function fixture(){
 let count=0;const server=createServer((req,res)=>{count++;res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:'late-'+count}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const plan={url:'https://fetchsandbox.com/sandbox/schedule-fixture/crm/v3/objects/contacts',method:'POST',body_path:['email'],body_equals:'fixture@example.com',nonce:'fixture-nonce'};
 const queue=await createDeferredQueue(plan,(_url,init)=>fetch('http://127.0.0.1:'+server.address().port+'/effect',init));
 const children=[];const launch=()=>{const c=fork(new URL('../test/fixtures/c9-schedule-process.mjs',import.meta.url),[],{env:{...process.env,FS_PROOF_SCHEDULE_TARGET:JSON.stringify({...plan,proxy_url:queue.proxy_url})},stdio:['ignore','ignore','ignore','ipc']});children.push(c);return c;};
 const replacement=()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);children.push(c);return {pid:c.pid};};
 return {queue,plan,launch,replacement,count:()=>count,async cleanup(){for(const c of children)if(c.exitCode===null&&c.signalCode===null){const exited=once(c,'exit');c.kill('SIGKILL');await exited;}await queue.close();await new Promise(r=>server.close(r));}};
}
test('HTTP request is queued before actual SIGKILL; only forwarded after independent replacement witness',async()=>{
 const f=await fixture();const records=[];
 try{
  const c=watchDelayedDispatch({child:f.launch(),queue:f.queue,witnessPending:async()=>({checkpoint_pending:true,provider_matching_records:f.count(),owner_before:'old',epoch_before:1}),restart:async()=>f.replacement(),awaitReplacement:async()=>{assert.equal(f.count(),0);return {replacement_held_unknown:true,owner_after:'new',epoch_after:2};},witnessAccepted:async id=>({provider_accepted:f.count()===1&&id==='late-1',replacement_preserved:true}),record:async r=>records.push(r)});
  const out=await c.done;assert.equal(out.signal,'SIGKILL');assert.notEqual(out.pid_before,out.pid_after);assert.equal(f.count(),1);assert.equal(records.length,4);assert.equal(out.worker_killed,true);
 }finally{await f.cleanup();}
});
for(const missing of ['pending','replacement'])test('refuses provider write without '+missing+' witness',async()=>{
 const f=await fixture();try{
  const c=watchDelayedDispatch({child:f.launch(),queue:f.queue,witnessPending:async()=>({checkpoint_pending:missing!=='pending',provider_matching_records:0,owner_before:'old',epoch_before:1}),restart:async()=>f.replacement(),awaitReplacement:async()=>({replacement_held_unknown:false,owner_after:'new',epoch_after:2}),witnessAccepted:async()=>{throw Error('Must not accept');},record:async()=>{}});
  await assert.rejects(c.done,/Independent/);assert.equal(f.count(),0);
 }finally{await f.cleanup();}
});
test('queued HTTP request can finish after caller AbortSignal fires; no signal is disabled',async()=>{
 const f=await fixture();try{
  const call=fetch(f.queue.proxy_url,{method:'POST',headers:{authorization:'Bearer fixture-only'},body:JSON.stringify({email:f.plan.body_equals}),signal:AbortSignal.timeout(50)});const stopped=assert.rejects(call);
  const queued=await f.queue.queued;await stopped;assert.equal(f.count(),0);const accepted=await queued.forward();assert.equal(accepted.effect_id,'late-1');assert.equal(f.count(),1);await assert.rejects(queued.forward(),/already forwarded/);
 }finally{await f.cleanup();}
});
test('wrong request is rejected without forwarding',async()=>{
 const f=await fixture();try{const out=await fetch(f.queue.proxy_url,{method:'POST',headers:{authorization:'Bearer fixture-only'},body:JSON.stringify({email:'different@example.com'})});assert.equal(out.status,400);assert.equal(f.count(),0);}finally{await f.cleanup();}
});
test('non-twin target is refused',async()=>{await assert.rejects(createDeferredQueue({url:'https://example.com/write',method:'POST',body_path:['email'],nonce:'x'}),/Isolated/);});
