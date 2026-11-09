import {readFileSync,writeFileSync} from 'node:fs';
import {advance} from './machine.mjs';
import {parseLeadInput} from './input.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
// Explicit negative-control source variant, never selected from lead/check IDs.
// Its runtime behavior is intentionally wrong: retry an unknown Deal write.
export function blindDealRetry(next){
 if(next.request?.kind==='provider' && next.request.provider==='hubspot' && next.request.path==='/crm/v3/objects/deals/search'){
  const c=next.context;
  c.stage='effect';
  next.request={kind:'provider',provider:'hubspot',method:'POST',path:'/crm/v3/objects/deals',body:{properties:{dealname:'Pilot '+c.lead_id,pipeline:'default',dealstage:'appointmentscheduled'},associations:[{to:{id:c.state.operations.contact.id},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:3}]}]}};
 }
 return next;
}
// Explicit negative control: resend an uncertain Gmail message instead of reading it.
export function blindGmailResend(next){
 if(next.request?.kind==='provider' && next.request.provider==='gmail' && next.request.method==='GET' && next.request.path.startsWith('/gmail/v1/users/me/messages?q=')){
  next.context.stage='effect';
  next.request={kind:'provider',provider:'gmail',method:'POST',path:'/gmail/v1/users/me/messages/send',body:{raw:next.context.raw}};
 }
 return next;
}
// Explicit negative control: hold the uncertain Calendar action without its ID read-back.
// Selected by source variant only, never by a lead, check ID or verifier response.
export function skipCalendarReadback(next){
 if(next.request?.kind==='provider' && next.request.provider==='google-calendar' && next.request.method==='GET' && next.request.path.startsWith('/calendars/primary/events/')){
  const c=next.context;
  c.state.status='unknown';c.blocked='calendar';c.stage='notify';
  next.request={kind:'save',state:c.state};
 }
 return next;
}
// Explicit negative control: resend an uncertain Slack notification instead of reading history.
// Selected only as a versioned source variant, never from the incoming business input.
export function blindSlackResend(next){
 if(next.request?.kind==='provider' && next.request.provider==='slack' && next.request.method==='GET' && next.request.path==='/conversations.history?channel=C_PILOT&limit=100'){
  const c=next.context,notice=c.state.notification;
  c.stage='notified';
  next.request={kind:'provider',provider:'slack',method:'POST',path:'/chat.postMessage',body:{channel:'C_PILOT',text:JSON.stringify({lead_id:c.lead_id,status:notice.outcome,blocked_step:notice.blocked_step})}};
 }
 return next;
}
export function decisionSource(variant='normal'){
 const source=advance.toString();
 if(variant==='normal')return source;
 const mutation=variant==='blind-deal-retry'?blindDealRetry:variant==='blind-gmail-resend'?blindGmailResend:variant==='skip-calendar-readback'?skipCalendarReadback:variant==='blind-slack-resend'?blindSlackResend:null;
 if(!mutation)throw Error('Unknown versioned decision variant');
 return source+'\nconst normalAdvance=advance;\n'+mutation.toString()+'\nadvance = input => '+mutation.name+'(normalAdvance(input));';
}
export function buildWorkflow(url,path,credential,variant='normal'){
const origin=new URL(url);
if(origin.protocol!=='https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=='/')throw Error('HTTPS adapter origin required');
if(path!=='friendly-pilot-mcp-20261106')throw Error('Fixed qualified pilot route required');
if(!credential || typeof credential.id!=='string' || !credential.id || typeof credential.name!=='string' || !credential.name)throw Error('Saved native Header Auth credential reference required');
url=origin.origin;
const init=`${parseLeadInput.toString()}\nconst body=$json.body ?? $json;\nconst {_invocation,...business}=body && typeof body==='object' && !Array.isArray(body)?body:{};\nconst x=parseLeadInput(business);\nif(!x) return [{json:{input_rejected:true}}];\nif(typeof _invocation!=='string')return [{json:{input_denied:true}}];\nconst raw=Buffer.from('From: FetchSandbox Pilot <pilot@example.com>\\r\\nTo: '+x.lead_id+'@example.com\\r\\nSubject: Pilot '+x.lead_id+'\\r\\nMessage-ID: <'+x.lead_id+'@example.com>\\r\\n\\r\\nDummy-data lead follow-up').toString('base64url');\nreturn [{json:{lead_id:x.lead_id,invocation:_invocation,attempt:String($execution.id),retry_failed:x.retry_failed===true,raw}}];`;
const nodes=[
 {id:'trigger',name:'Lead webhook',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,0],parameters:{httpMethod:'POST',path,authentication:'headerAuth',responseMode:'responseNode',options:{}},credentials:{httpHeaderAuth:credential},webhookId:path},
 {id:'init',name:'Validate dummy lead',type:'n8n-nodes-base.code',typeVersion:2,position:[240,0],parameters:{jsCode:init}},
 {id:'plan',name:'Durable decision machine',type:'n8n-nodes-base.code',typeVersion:2,position:[480,0],parameters:{jsCode:decisionSource(variant)+'\nreturn [{json:advance($json)}];'}},
 {id:'done',name:'Finished or held',type:'n8n-nodes-base.if',typeVersion:2.2,position:[720,0],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'is-done',leftValue:'={{ $json.done === true }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}},
 {id:'http',name:'State or isolated twin I/O',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[960,150],parameters:{method:'POST',url:url+'/io',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json) }}',options:{timeout:15000}},credentials:{httpHeaderAuth:credential}},
 {id:'reply',name:'Return observed workflow status',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[960,-100],parameters:{respondWith:'json',responseBody:'={{ JSON.stringify($json) }}',options:{responseCode:'={{ $json.status === "rejected" ? 400 : $json.status === "forbidden" ? 403 : 200 }}'}}}
];
const connections={'Lead webhook':{main:[[{node:'Validate dummy lead',type:'main',index:0}]]},'Validate dummy lead':{main:[[{node:'Durable decision machine',type:'main',index:0}]]},'Durable decision machine':{main:[[{node:'Finished or held',type:'main',index:0}]]},'Finished or held':{main:[[{node:'Return observed workflow status',type:'main',index:0}],[{node:'State or isolated twin I/O',type:'main',index:0}]]},'State or isolated twin I/O':{main:[[{node:'Durable decision machine',type:'main',index:0}]]}};
return {name:'Friendly lead recovery — MCP repeatable verification',nodes,connections,settings:{executionOrder:'v1'},active:false};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [url,path,output]=process.argv.slice(2);
 if(!url||!path||!output)throw Error('usage: build-workflow https-adapter-origin fixed-pilot-path private-output.json');
 const config=JSON.parse(readFileSync(process.env.PILOT_BINDINGS,'utf8'));
 writeFileSync(output,JSON.stringify(buildWorkflow(url,path,config.n8n_header_auth,process.env.PILOT_VARIANT??'normal'),null,2),{mode:0o600});
}
