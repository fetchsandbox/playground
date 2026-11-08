/** Bounded transport to the persistent, native-authenticated pilot webhook.
 * No retry: a transport error may follow an accepted application execution.
 */
// @ts-ignore Plain JS is also embedded verbatim in the native Code node.
import {parseLeadInput} from './input.mjs';
export const N8N_PILOT_WEBHOOK='https://fetchsandbox.app.n8n.cloud/webhook/friendly-pilot-mcp-20261106';
export type TriggerBinding={n8n_webhook?:string;n8n_token?:string};
export async function invokeN8n(cfg:TriggerBinding,raw:string,transport:typeof fetch=fetch,invocation?:string){
 if(cfg.n8n_webhook!==N8N_PILOT_WEBHOOK || !cfg.n8n_token || /[\r\n]/.test(cfg.n8n_token))return {status:503,body:{error:'authenticated_webhook_not_bound'}};
 let parsed:unknown;
 try{parsed=JSON.parse(raw);}catch{return {status:400,body:{error:'invalid_input'}};}
 const input=parseLeadInput(parsed);
 if(!input)return {status:400,body:{error:'invalid_input'}};
 return invokeNativeN8n(cfg,JSON.stringify(input),transport,invocation);
}

/** Authenticated fixed-destination transport. Raw business input is validated by
 * the native webhook; this path must not mask a native schema defect. */
export async function invokeNativeN8n(cfg:TriggerBinding,raw:string,transport:typeof fetch=fetch,invocation?:string){
 if(cfg.n8n_webhook!==N8N_PILOT_WEBHOOK || !cfg.n8n_token || /[\r\n]/.test(cfg.n8n_token))return {status:503,body:{error:'authenticated_webhook_not_bound'}};
 try{
  if(invocation){try{const body=JSON.parse(raw);if(parseLeadInput(body))raw=JSON.stringify({...body,_invocation:invocation});}catch{}}
  const out=await transport(N8N_PILOT_WEBHOOK,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+cfg.n8n_token},body:raw,redirect:'error',signal:AbortSignal.timeout(24000)});
  const text=await out.text();
  try{return {status:out.status,body:JSON.parse(text)};}
  catch{return {status:out.ok?502:out.status,body:{error:'n8n_non_json_response',upstream_status:out.status,automatic_retry:false}};}
 }catch{return {status:504,body:{error:'n8n_outcome_unknown',automatic_retry:false}};}
}
