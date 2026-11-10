import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createStaleIoProxy,watchStaleIo} from './runtime-stale-io.mjs';
async function fixture(){
 let calls=0,replaced=false;
 const app=createServer(async(req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({result:{denied:replaced}}));});app.listen(0,'127.0.0.1');await once(app,'listening');
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const proxy=await createStaleIoProxy({listenPort:port,appPort:app.address().port});proxy.bind({lead:'fixture-stale'});
 const request=()=>fetch('http://127.0.0.1:'+port+'/io',{method:'POST',headers:{authorization:'Bearer fixture-only'},body:JSON.stringify({context:{lead_id:'fixture-stale',attempt:'old',invocation:'fixture-only'},request:{kind:'provider',provider:'hubspot',method:'POST',path:'/crm/v3/objects/contacts'}}),signal:AbortSignal.timeout(1000)});
 return {proxy,request,calls:()=>calls,replace(){replaced=true;},async close(){await proxy.close();await new Promise(r=>app.close(r));}};
}
test('real stale native HTTP intent is forwarded only after replacement and returns real adapter denial',async()=>{
 const f=await fixture();try{
  const watcher=watchStaleIo({proxy:f.proxy,witnessPending:async q=>({checkpoint_pending:true,provider_matching_records:0,owner_before:q.attempt,epoch_before:1}),awaitReplacement:async()=>{assert.equal(f.calls(),0);f.replace();return {replacement_held_unknown:true,owner_after:'new',epoch_after:2};},verifyInvocation:()=>true,witnessDenied:async()=>({replacement_preserved:true,provider_matching_records:0}),record:async()=>{}});
  const response=f.request();const result=await watcher.done;assert.equal(result.adapter_denied,true);assert.equal(result.native_worker_host_suspended,false);assert.equal((await(await response).json()).result.denied,true);assert.equal(f.calls(),1);
 }finally{await f.close();}
});
test('expired invocation cannot be counted as stale ownership-fence proof',async()=>{
 const f=await fixture();try{
  const watcher=watchStaleIo({proxy:f.proxy,witnessPending:async q=>({checkpoint_pending:true,provider_matching_records:0,owner_before:q.attempt,epoch_before:1}),awaitReplacement:async()=>({replacement_held_unknown:true,owner_after:'new',epoch_after:2}),verifyInvocation:()=>false,witnessDenied:async()=>{throw Error('Must not witness');},record:async()=>{}});
  const request=f.request();request.catch(()=>{});await assert.rejects(watcher.done,/expired or invalid/);assert.equal(f.calls(),0);
 }finally{await f.close();}
});
test('unexpected business route cannot turn the loopback proxy into general egress',async()=>{await assert.rejects(createStaleIoProxy({listenPort:80,appPort:8098}),/Distinct loopback/);});

test('non-target routes, hostile identity headers and exact body bytes reach the application unchanged',async()=>{
 const app=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);res.writeHead(418,{'content-type':'application/json'});res.end(JSON.stringify({url:req.url,spoof:req.headers['x-pilot-requester'],body:Buffer.concat(chunks).toString('hex')}));});app.listen(0,'127.0.0.1');await once(app,'listening');const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const proxy=await createStaleIoProxy({listenPort:port,appPort:app.address().port});
 try{
  for(const path of ['/unknown-proof-route','/invoke']){const body=JSON.stringify({lead:'ordinary',note:'日本語'});const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'x-pilot-requester':'spoofed-owner','content-type':'application/json'},body});assert.equal(response.status,418);assert.deepEqual(await response.json(),{url:path,spoof:'spoofed-owner',body:Buffer.from(body).toString('hex')});}
 }finally{await proxy.close();await new Promise(r=>app.close(r));}
});
