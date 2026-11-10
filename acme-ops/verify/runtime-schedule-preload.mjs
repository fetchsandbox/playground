/** Redirect only the exact isolated fault target to an owned loopback queue.
 * The original fetch and its abort signal remain in force. The separate queue
 * has already read the HTTP request when the adapter dies, and can finish later.
 */
const raw=process.env.FS_PROOF_SCHEDULE_TARGET;
if(raw){
 const plan=JSON.parse(raw),target=new URL(plan.url),proxy=new URL(plan.proxy_url);
 if(target.origin!=='https://fetchsandbox.com'||!/^\/sandbox\/[a-zA-Z0-9_-]+\//.test(target.pathname)||proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||proxy.pathname!=='/'+plan.nonce||!Array.isArray(plan.body_path)||plan.body_path.some(k=>typeof k!=='string'||['__proto__','constructor','prototype'].includes(k)))throw Error('Invalid isolated queue plan');
 const original=globalThis.fetch;let used=false;
 globalThis.fetch=(input,init)=>{
  if(used||String(input)!==plan.url||init?.method!=='POST'||typeof init.body!=='string')return original(input,init);
  let body;try{body=JSON.parse(init.body);}catch{return original(input,init);}
  if(plan.body_path.reduce((v,k)=>v?.[k],body)!==plan.body_equals)return original(input,init);
  used=true;return original(plan.proxy_url,init);
 };
}
