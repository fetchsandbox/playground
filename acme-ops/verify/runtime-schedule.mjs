import {createServer} from 'node:http';
import {once} from 'node:events';
/** A proof-only provider queue. Reads a real request before the adapter dies and
 * deliberately continues it after the disconnected client. No success is invented.
 * It models deferred provider processing, not the real vendor's infrastructure.
 */
export async function createDeferredQueue(plan,transport=fetch){
 const target=new URL(plan.url);
 if(target.origin!=='https://fetchsandbox.com'||!/^\/sandbox\/[a-zA-Z0-9_-]+\//.test(target.pathname)||plan.method!=='POST'||!plan.nonce||!Array.isArray(plan.body_path))throw Error('Isolated queue target required');
 let resolveQueued,used=false,forwarded=false;
 const queued=new Promise(resolve=>resolveQueued=resolve);
 const server=createServer(async(req,res)=>{
  const send=(code,body)=>{if(!res.destroyed){res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));}};
  if(req.method!=='POST'||req.url!=='/'+plan.nonce)return send(404,{error:'not_found'});
  let raw='';for await(const b of req){raw+=b;if(raw.length>65536)return send(413,{error:'too_large'});}
  let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'invalid_body'});}
  if(plan.body_path.reduce((v,k)=>v?.[k],body)!==plan.body_equals||!/^Bearer \S+$/.test(req.headers.authorization??''))return send(400,{error:'wrong_operation'});
  if(used)return send(409,{error:'already_queued'});used=true;
  const headers=Object.fromEntries(['authorization','content-type','user-agent','x-sandbox-strict-validation','x-flow-run-id'].flatMap(k=>typeof req.headers[k]==='string'?[[k,req.headers[k]]]:[]));
  resolveQueued({received_at:new Date().toISOString(),async forward(){
   if(forwarded)throw Error('Queued request already forwarded');forwarded=true;
   const response=await transport(plan.url,{method:'POST',redirect:'error',headers,body:raw,signal:AbortSignal.timeout(10000)});
   const result=await response.json();send(response.status,result);
   if(!response.ok||typeof result.id!=='string'||!result.id)throw Error('Deferred real provider write not accepted');
   return {effect_id:result.id,accepted_at:new Date().toISOString()};
  }});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {queued,proxy_url:'http://127.0.0.1:'+server.address().port+'/'+plan.nonce,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
export function watchDelayedDispatch({child,queue,witnessPending,awaitReplacement,witnessAccepted,record,restart}){
 let triggered=false;
 const done=(async()=>{
  const request=await queue.queued;triggered=true;
  const pending=await witnessPending();
  if(pending?.checkpoint_pending!==true||pending?.provider_matching_records!==0||!pending.owner_before)throw Error('Independent queued/no-effect witness missing');
  await record({...pending,phase:'request_queued',pid:child.pid,at:request.received_at});
  const pid=child.pid;
  if(!pid||child.exitCode!==null||child.signalCode!==null)throw Error('Owned adapter already exited');
  const exited=once(child,'exit');if(!child.kill('SIGKILL'))throw Error('Owned adapter kill refused');const [,signal]=await exited;
  if(signal!=='SIGKILL')throw Error('Adapter did not exit by SIGKILL');
  const replacementProcess=await restart();if(!replacementProcess?.pid||replacementProcess.pid===pid)throw Error('Replacement PID unchanged');
  await record({phase:'adapter_restarted',pid_before:pid,pid_after:replacementProcess.pid,signal,at:new Date().toISOString()});
  const replacement=await awaitReplacement(pending);
  if(replacement?.replacement_held_unknown!==true||!replacement.owner_after||replacement.owner_after===pending.owner_before||replacement.epoch_after!==pending.epoch_before+1)throw Error('Independent replacement/unknown witness missing');
  await record({...replacement,phase:'replacement_held_unknown',at:new Date().toISOString()});
  const accepted=await request.forward();
  const observed=await witnessAccepted(accepted.effect_id,replacement);
  if(observed?.provider_accepted!==true||observed?.replacement_preserved!==true)throw Error('Independent late acceptance/state witness missing');
  const result={...pending,...replacement,...observed,...accepted,phase:'late_acceptance_observed',pid_before:pid,pid_after:replacementProcess.pid,signal,worker_killed:true,fault:'proof_provider_queue'};
  await record(result);return result;
 })();
 return {done,get triggered(){return triggered;}};
}
