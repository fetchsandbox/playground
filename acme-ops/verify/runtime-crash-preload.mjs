/** Explicit test-process preload. Never imported by application source.
 * Calls the real fetch unchanged, then pauses a matching successful response
 * before the application can consume it or checkpoint. No effects are invented.
 */
const raw=process.env.FS_PROOF_CRASH_TARGET;
if(raw){
 if(typeof process.send!=='function')throw Error('Crash simulation requires a parent IPC channel');
 const plan=JSON.parse(raw),url=new URL(plan.url);
 if(url.origin!=='https://fetchsandbox.com'||!/^\/sandbox\/[a-zA-Z0-9_-]+\//.test(url.pathname)||plan.method!=='POST'||!['id','ts'].includes(plan.response_identity??'id')||!Array.isArray(plan.body_path)||plan.body_path.some(x=>typeof x!=='string'||['__proto__','constructor','prototype'].includes(x)))throw Error('Invalid isolated crash target');
 const original=globalThis.fetch;let fired=false;
 globalThis.fetch=async(input,init)=>{
  const response=await original(input,init);
  if(fired||String(input)!==plan.url||init?.method!==plan.method||typeof init.body!=='string'||!response.ok)return response;
  let body;try{body=JSON.parse(init.body);}catch{return response;}
  const value=plan.body_path.reduce((v,k)=>v?.[k],body);
  if(value!==plan.body_equals)return response;
  const accepted=await response.clone().json();
  const identity=accepted?.[plan.response_identity??'id'];
  if(plan.response_identity==='ts' && accepted?.ok!==true)return response;
  if(typeof identity!=='string'||!identity)throw Error('Accepted effect has no identity; cannot simulate qualified crash');
  fired=true;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{process.off('message',message);reject(Error('Crash witness timed out; no simulated success'));},10000);
   const message=m=>{if(m?.type==='proof_crash_release'&&m.nonce===plan.nonce){clearTimeout(timer);process.off('message',message);resolve();}};
   process.on('message',message);
   process.send({type:'proof_provider_accepted',nonce:plan.nonce,effect_id:identity,observed_at:new Date().toISOString()});
  });
  return response;
 };
}
