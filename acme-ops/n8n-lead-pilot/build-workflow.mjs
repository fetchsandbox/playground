import {readFileSync,writeFileSync} from 'node:fs';
import {advance} from './machine.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export function buildWorkflow(url,path,credential){
const origin=new URL(url);
if(origin.protocol!=='https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=='/')throw Error('HTTPS adapter origin required');
if(path!=='friendly-pilot-mcp-20261106')throw Error('Fixed qualified pilot route required');
if(!credential || typeof credential.id!=='string' || !credential.id || typeof credential.name!=='string' || !credential.name)throw Error('Saved native Header Auth credential reference required');
url=origin.origin;
const init=`const x=$json.body ?? $json;\nif(!/^[a-zA-Z0-9_-]{1,100}$/.test(x.lead_id??'')) throw Error('Invalid lead_id');\nconst raw=Buffer.from('From: FetchSandbox Pilot <pilot@example.com>\\r\\nTo: '+x.lead_id+'@example.com\\r\\nSubject: Pilot '+x.lead_id+'\\r\\nMessage-ID: <'+x.lead_id+'@example.com>\\r\\n\\r\\nDummy-data lead follow-up').toString('base64url');\nreturn [{json:{lead_id:x.lead_id,attempt:String($execution.id),retry_failed:x.retry_failed===true,raw}}];`;
const nodes=[
 {id:'trigger',name:'Lead webhook',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,0],parameters:{httpMethod:'POST',path,authentication:'headerAuth',responseMode:'responseNode',options:{}},credentials:{httpHeaderAuth:credential},webhookId:path},
 {id:'init',name:'Validate dummy lead',type:'n8n-nodes-base.code',typeVersion:2,position:[240,0],parameters:{jsCode:init}},
 {id:'plan',name:'Durable decision machine',type:'n8n-nodes-base.code',typeVersion:2,position:[480,0],parameters:{jsCode:advance.toString()+'\nreturn [{json:advance($json)}];'}},
 {id:'done',name:'Finished or held',type:'n8n-nodes-base.if',typeVersion:2.2,position:[720,0],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'is-done',leftValue:'={{ $json.done === true }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}},
 {id:'http',name:'State or isolated twin I/O',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[960,150],parameters:{method:'POST',url:url+'/io',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json) }}',options:{timeout:15000}},credentials:{httpHeaderAuth:credential}},
 {id:'reply',name:'Return observed workflow status',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[960,-100],parameters:{respondWith:'json',responseBody:'={{ JSON.stringify($json) }}',options:{}}}
];
const connections={'Lead webhook':{main:[[{node:'Validate dummy lead',type:'main',index:0}]]},'Validate dummy lead':{main:[[{node:'Durable decision machine',type:'main',index:0}]]},'Durable decision machine':{main:[[{node:'Finished or held',type:'main',index:0}]]},'Finished or held':{main:[[{node:'Return observed workflow status',type:'main',index:0}],[{node:'State or isolated twin I/O',type:'main',index:0}]]},'State or isolated twin I/O':{main:[[{node:'Durable decision machine',type:'main',index:0}]]}};
return {name:'Friendly lead recovery — MCP repeatable verification',nodes,connections,settings:{executionOrder:'v1'},active:false};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [url,path,output]=process.argv.slice(2);
 if(!url||!path||!output)throw Error('usage: build-workflow https-adapter-origin fixed-pilot-path private-output.json');
 const config=JSON.parse(readFileSync(process.env.PILOT_BINDINGS,'utf8'));
 writeFileSync(output,JSON.stringify(buildWorkflow(url,path,config.n8n_header_auth),null,2),{mode:0o600});
}
