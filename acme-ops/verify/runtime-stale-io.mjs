import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
/** Private loopback scheduling proxy. Holds one real native I/O request before
 * the adapter's ownership fence. Forwards every response from the real adapter.
 * It does not suspend an n8n SaaS host or invent a business result.
 */
export async function createStaleIoProxy({listenPort,appPort}){
 if(!Number.isSafeInteger(appPort)||!Number.isSafeInteger(listenPort)||appPort===listenPort||appPort<1024||listenPort<1024||appPort>65535||listenPort>65535)throw Error('Distinct loopback proof ports required');
 let plan,used=false,resolveQueued;
 const queued=new Promise(resolve=>resolveQueued=resolve);
 const server=createServer(async(req,res)=>{
  const send=(status,text,headers={})=>{if(!res.destroyed){res.writeHead(status,headers);res.end(text);}};
  try{
   const chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks);
   // Preserve end-to-end headers, including untrusted identity headers. The real
   // adapter, not this fault transport, must decide authentication and routing.
   const hop=new Set(['connection','keep-alive','proxy-connection','transfer-encoding','te','trailer','upgrade','content-length']);
   const headers=Object.fromEntries(Object.entries(req.headers).filter(([key])=>!hop.has(key)));
   const forward=()=>new Promise((resolve,reject)=>{
    // A fixed socket destination prevents egress even for an unusual request
    // target. Literal path, method and body bytes remain the app's inputs.
    const upstream=httpRequest({hostname:'127.0.0.1',port:appPort,path:req.url,method:req.method,headers},response=>{
     const parts=[];response.on('data',part=>parts.push(part));response.on('error',reject);response.on('end',()=>{
      const bytes=Buffer.concat(parts);send(response.statusCode,bytes,response.headers);let body;try{body=JSON.parse(bytes.toString('utf8'));}catch{body=null;}resolve({status:response.statusCode,body});
     });
    });
    upstream.setTimeout(30000,()=>upstream.destroy(Error('Owned adapter transport timeout')));upstream.on('error',reject);upstream.end(raw);
   });
   let body;try{body=JSON.parse(raw.toString('utf8'));}catch{}
   const q=body?.request,c=body?.context;
   if(!used&&plan&&req.method==='POST'&&req.url==='/io'&&c?.lead_id===plan.lead&&q?.kind==='provider'&&q.provider==='hubspot'&&q.method==='POST'&&q.path==='/crm/v3/objects/contacts'){
    used=true;resolveQueued({attempt:c.attempt,invocation:c.invocation,received_at:new Date().toISOString(),forward});
   }else await forward();
  }catch{send(502,JSON.stringify({error:'proof_transport_unavailable'}),{'content-type':'application/json'});}
 });
 server.listen(listenPort,'127.0.0.1');await once(server,'listening');
 return {queued,bind(next){if(plan&&plan.lead!==next.lead)throw Error('Proxy cannot switch active proof target');plan=next;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
export function watchStaleIo({proxy,witnessPending,awaitReplacement,verifyInvocation,witnessDenied,record}){
 let triggered=false;
 const done=(async()=>{
  const request=await proxy.queued;triggered=true;
  const before=await witnessPending(request);
  if(before?.checkpoint_pending!==true||before?.provider_matching_records!==0||before.owner_before!==request.attempt)throw Error('Independent stale native intent witness missing');
  await record({...before,phase:'native_io_queued',at:request.received_at});
  const after=await awaitReplacement(before);
  if(after?.replacement_held_unknown!==true||after.owner_after===before.owner_before||after.epoch_after!==before.epoch_before+1)throw Error('Independent replacement before stale dispatch missing');
  if(!verifyInvocation(request.invocation))throw Error('Original native invocation expired or invalid; ownership fence remains unmeasured');
  const response=await request.forward();
  if(response.status!==200||response.body?.result?.denied!==true)throw Error('Real adapter did not deny stale native command');
  const observed=await witnessDenied(after);
  if(observed?.replacement_preserved!==true||observed?.provider_matching_records!==0)throw Error('Independent no-effect/ownership witness missing');
  const result={...before,...after,...observed,phase:'stale_io_denied',at:new Date().toISOString(),invocation_valid_at_release:true,adapter_denied:true,native_worker_host_suspended:false};
  await record(result);return result;
 })();
 return {done,get triggered(){return triggered;}};
}
