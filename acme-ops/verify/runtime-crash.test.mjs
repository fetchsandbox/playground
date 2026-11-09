import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {watchAcceptedWriteCrash} from './runtime-crash.mjs';
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'crash-control-'));let accepted=0;
 const server=createServer((req,res)=>{if(req.method==='POST'){accepted++;res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:'effect-'+accepted}));}else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({accepted}));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const plan={url:'https://fetchsandbox.com/sandbox/test-fixture/crm/v3/objects/deals',method:'POST',body_path:['properties','dealname'],body_equals:'Pilot example',nonce:'fixture-only'};
 const origin='http://127.0.0.1:'+server.address().port,checkpoint=join(dir,'checkpoint.json');
 const child=fork(new URL('../test/fixtures/c9-preload-process.mjs',import.meta.url),[],{env:{...process.env,FS_PROOF_CRASH_TARGET:JSON.stringify(plan),FIXTURE_PLAN:JSON.stringify(plan),FIXTURE_ORIGIN:origin,FIXTURE_CHECKPOINT:checkpoint},stdio:['ignore','ignore','pipe','ipc']});
 const cleanup=async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});};
 return {child,plan,origin,checkpoint,cleanup};
}
test('real accepted HTTP effect is witnessed before SIGKILL and no checkpoint is saved',async()=>{
 const f=await fixture();let replacement,records=[];
 try{
  const watch=watchAcceptedWriteCrash({child:f.child,plan:f.plan,witness:async id=>{
   const state=await(await fetch(f.origin+'/state')).json();
   return {provider_accepted:state.accepted===1&&id==='effect-1',checkpoint_pending:!existsSync(f.checkpoint)};
  },record:async x=>records.push(x),restart:async()=>{replacement=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);return {pid:replacement.pid};}});
  const result=await watch.done;
  assert.equal(result.signal,'SIGKILL');assert.notEqual(result.pid_before,result.pid_after);assert.equal(existsSync(f.checkpoint),false);assert.equal(records.length,2);
 }finally{if(replacement){const exit=once(replacement,'exit');replacement.kill('SIGKILL');await exit;}await f.cleanup();}
});
test('missing independent witness releases the real response and never claims a crash',async()=>{
 const f=await fixture();const exited=once(f.child,'exit');
 try{
  const watch=watchAcceptedWriteCrash({child:f.child,plan:f.plan,witness:async()=>({provider_accepted:false,checkpoint_pending:true}),record:async()=>{throw Error('Must not record qualified crash');},restart:async()=>{throw Error('Must not restart');}});
  await assert.rejects(watch.done,/Independent provider/);await exited;assert.equal(f.child.signalCode,null);assert.equal(existsSync(f.checkpoint),true);
 }finally{await f.cleanup();}
});
test('wrong nonce cannot trigger the crash controller',async()=>{
 const child=spawn(process.execPath,['-e','process.send({type:"proof_provider_accepted",nonce:"other",effect_id:"x"});setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
 try{
  const observed=once(child,'message');const watch=watchAcceptedWriteCrash({child,plan:{nonce:'expected'},witness:async()=>{throw Error('Must not inspect unrelated message');},record:async()=>{},restart:async()=>{}});
  await observed;assert.equal(watch.triggered,false);assert.equal(child.signalCode,null);
 }finally{const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
});
