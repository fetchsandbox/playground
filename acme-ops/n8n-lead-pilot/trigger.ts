/** Bounded transport to the persistent, native-authenticated pilot webhook.
 * No retry: a transport error may follow an accepted application execution.
 */
export const N8N_PILOT_WEBHOOK='https://fetchsandbox.app.n8n.cloud/webhook/friendly-pilot-mcp-20261106';
export type TriggerBinding={n8n_webhook?:string;n8n_token?:string};
export async function invokeN8n(cfg:TriggerBinding,raw:string,transport:typeof fetch=fetch){
 if(cfg.n8n_webhook!==N8N_PILOT_WEBHOOK || !cfg.n8n_token || /[\r\n]/.test(cfg.n8n_token))return {status:503,body:{error:'authenticated_webhook_not_bound'}};
 let input:Record<string,unknown>;
 try{input=JSON.parse(raw);}catch{return {status:400,body:{error:'invalid_input'}};}
 if(!input || typeof input!=='object' || Array.isArray(input) || typeof input.lead_id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.lead_id) || Object.keys(input).some(k=>!['lead_id','retry_failed'].includes(k)) || ('retry_failed' in input && typeof input.retry_failed!=='boolean'))return {status:400,body:{error:'invalid_input'}};
 try{
  const out=await transport(N8N_PILOT_WEBHOOK,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+cfg.n8n_token},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(24000)});
  const text=await out.text();
  try{return {status:out.status,body:JSON.parse(text)};}
  catch{return {status:out.ok?502:out.status,body:{error:'n8n_non_json_response',upstream_status:out.status,automatic_retry:false}};}
 }catch{return {status:504,body:{error:'n8n_outcome_unknown',automatic_retry:false}};}
}
