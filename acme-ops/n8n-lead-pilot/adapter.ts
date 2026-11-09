import {createServer} from 'node:http';
import {readFileSync, appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
// @ts-ignore Shared Node-readable session binding function.
import {sessionScope} from './session-scope.mjs';
import {FileStore,DynamoStore} from '../src/kit/store';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {LeadState} from './state';
import {InvocationAuthority,equalSecret,requesterFor,requesterKey} from './identity';
// @ts-ignore Shared native input parser.
import {parseLeadInput} from './input.mjs';
import {invokeN8n,invokeNativeN8n} from './trigger';
import {allowedProviderOperation,callTwin} from './provider-transport';

// Private test adapter only: conditional state writes and bounded twin transport.
// n8n owns the transition/recovery logic. This server does not choose next steps.
const cfg = JSON.parse(readFileSync(process.env.PILOT_BINDINGS!, 'utf8'));
const endpoint=process.env.DYNAMODB_ENDPOINT;
if(endpoint && !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint))throw Error('Local DynamoDB endpoint must be loopback');
if(process.env.STATE_TABLE && !/^[a-zA-Z0-9_.-]{3,255}$/.test(process.env.STATE_TABLE))throw Error('Invalid state table');
const store=process.env.STATE_TABLE
 ? new DynamoStore(process.env.STATE_TABLE,new DynamoDBClient(endpoint?{endpoint,region:'us-west-2',credentials:{accessKeyId:'local',secretAccessKey:'local'}}:{}))
 : new FileStore(process.env.STATE_FILE!);
const scope=sessionScope(cfg.legs);
if(cfg.session_scope!==scope)throw Error('Session binding scope mismatch');
const state=scope?new LeadState(store,scope):null;
const runtimeId=randomUUID();
const authority=scope?new InvocationAuthority(cfg.invocation_secret,scope):null;
const verifierPrincipal={subject:'pilot-owner',tenant:'pilot-team'};
const configuredCallers=[...(cfg.requesters??[]),...[['A','pilot-owner'],['B','pilot-other']].flatMap(([role,subject])=>{const token=process.env['FETCHSANDBOX_REQUESTER_'+role+'_TOKEN'];return token?[{token,subject,tenant:'pilot-team'}]:[];})];
const server=createServer(async(req,res)=>{
 const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 const authorization=req.headers.authorization??'';
 const token=/^Bearer [^\s,]+$/i.test(authorization)?authorization.slice(7):'';
 const verifier=equalSecret(token,process.env.FETCHSANDBOX_VERIFIER_TOKEN);
 const requester=verifier?verifierPrincipal:requesterFor(token,configuredCallers);
 const native=equalSecret(token,cfg.n8n_token);
 const health=equalSecret(token,cfg.token);
 if(req.url==='/io'?!(native||requester):!(requester || (health && ['/ping','/session'].includes(req.url??''))))return send(401,{error:'unauthorized'});
 try {
  if(req.method==='GET' && req.url==='/ping') return send(200,{ok:true,scope:'disposable-n8n-pilot'});
  if(!state)return send(503,{error:'session_not_bound'});
  if(req.method==='GET' && req.url==='/session')return send(200,{session_scope:scope,runtime_id:runtimeId});
  if(req.method==='GET' && (req.url?.startsWith('/state/') || req.url?.startsWith('/proof/'))){
   const lead=decodeURIComponent(req.url.slice(7));const found=verifier?{records:await state.records(lead)}:await state.recordsFor(lead,requesterKey(requester!));
   return 'denied' in found?send(403,{error:'forbidden'}):send(200,found);
  }
  if(req.method!=='POST'||!['/io','/invoke','/native-invoke'].includes(req.url??'')) return send(404,{error:'not_found'});
  let raw='';for await(const b of req){raw+=b;if(raw.length>65536)throw new Error('oversize');}
  if(req.url==='/invoke' || req.url==='/native-invoke'){
   let input=null;try{input=parseLeadInput(JSON.parse(raw));}catch{}
   if(input){const found=await state.recordsFor(input.lead_id,requesterKey(requester!));if('denied' in found)return send(403,{error:'forbidden'});}
   const ticket=input?authority!.mint(requester!,input):undefined;
   const out=await (req.url==='/native-invoke'?invokeNativeN8n:invokeN8n)(cfg,raw,fetch,ticket);
   return send(out.status,out.body);
  }
  const {context:c,request:q}=JSON.parse(raw);
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(c?.lead_id??'')||typeof c.attempt!=='string')return send(400,{error:'invalid_identity'});
  if(q?.kind==='provider' && !allowedProviderOperation(q))return send(400,{error:'operation_not_allowed'});
  if(!['claim','save','provider'].includes(q?.kind))return send(400,{error:'unknown_command'});
  if(!native)return send(401,{error:'runtime_credential_required'});
  const principal=authority!.verify(c.invocation,c);
  if(!principal)return send(200,{context:c,result:{denied:true}});
  const actor=requesterKey(principal);
  const owned=await state.recordsFor(c.lead_id,actor);
  if('denied' in owned)return send(200,{context:c,result:{denied:true}});
  if(q.kind==='provider'){
   const permit=await state.authorizeProvider(c.lead_id,c.attempt,c.state?.version,actor);
   if(!permit.allowed)return send(200,{context:c,result:{denied:true}});
   c.state={...c.state,version:permit.state!.version,epoch:permit.state!.epoch,lease_expires_at:permit.state!.lease_expires_at};
  }
  let result;
  if(q.kind==='claim')result=await state.claim(c.lead_id,c.attempt,c.retry_failed===true,actor);
  else if(q.kind==='save')result=await state.save(c.lead_id,c.attempt,q.state,actor);
  else if(q.kind==='provider'){
   if(!allowedProviderOperation(q))return send(400,{error:'operation_not_allowed'});
   const started=new Date().toISOString();
   result=await callTwin(cfg.legs[q.provider],q,process.env.X_FLOW_RUN_ID);
   appendFileSync(process.env.TRACE_FILE!,JSON.stringify({at:started,lead_id:c.lead_id,attempt:c.attempt,provider:q.provider,method:q.method,path:q.path,status:result.status,body:result.body,...('retry_not_before' in result?{retry_after_seconds:result.retry_after_seconds,retry_not_before:result.retry_not_before}:{})})+'\n',{mode:0o600});
  }else return send(400,{error:'unknown_command'});
  return send(200,{context:c,result});
 }catch{return send(500,{error:'adapter_failure'});}
});
server.listen(Number(process.env.PORT??8097),'127.0.0.1',()=>{const address=server.address();console.log(JSON.stringify({msg:'listening',port:typeof address==='object' && address?address.port:0,workflow:process.env.WORKFLOW??'n8n-lead-recovery'}));});
