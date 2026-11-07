import {createServer} from 'node:http';
import {readFileSync, appendFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {FileStore} from '../src/kit/store';
import {LeadState} from './state';

// Private test adapter only: conditional state writes and bounded twin transport.
// n8n owns the transition/recovery logic. This server does not choose next steps.
const cfg = JSON.parse(readFileSync(process.env.PILOT_BINDINGS!, 'utf8'));
const store = new FileStore(process.env.STATE_FILE!);
const state = new LeadState(store);
const allow:Record<string,RegExp> = {
 hubspot:/^\/crm\/v3\/objects\/(contacts|deals)(\/search|\/[a-zA-Z0-9_-]+)?(\?associations=contacts)?$/,
 gmail:/^\/gmail\/v1\/users\/me\/messages(\/[a-zA-Z0-9_-]+)?(\?q=[^\s]*)?$/,
 'google-calendar':/^\/calendars\/primary\/events$/,
 slack:/^\/chat.postMessage$/,
};
createServer(async(req,res)=>{
 const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 const token=Buffer.from((req.headers.authorization??'').replace(/^Bearer /,''));
 const keys=[cfg.token,process.env.FETCHSANDBOX_VERIFIER_TOKEN].filter(Boolean);
 if(!keys.some(k=>{const expected=Buffer.from(k);return token.length===expected.length && timingSafeEqual(token,expected);})) return send(401,{error:'unauthorized'});
 try {
  if(req.method==='GET' && req.url==='/ping') return send(200,{ok:true,scope:'disposable-n8n-pilot'});
  if(req.method==='GET' && req.url?.startsWith('/state/')) return send(200,{records:await store.list('lead-pilot#'+decodeURIComponent(req.url.slice(7)))});
  if(req.method==='GET' && req.url?.startsWith('/proof/')) return send(200,{records:await store.list('lead-pilot#'+decodeURIComponent(req.url.slice(7)))});
  if(req.method!=='POST'||!['/io','/invoke'].includes(req.url??'')) return send(404,{error:'not_found'});
  let raw='';for await(const b of req){raw+=b;if(raw.length>65536)throw new Error('oversize');}
  if(req.url==='/invoke'){
   if(cfg.n8n_webhook!=='https://fetchsandbox.app.n8n.cloud/webhook-test/friendly-pilot-20261106')return send(503,{error:'test_webhook_not_bound'});
   const out=await fetch(cfg.n8n_webhook,{method:'POST',headers:{'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(90000)});
   return send(out.status,await out.json());
  }
  const {context:c,request:q}=JSON.parse(raw);
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(c?.lead_id??'')||typeof c.attempt!=='string')return send(400,{error:'invalid_identity'});
  let result;
  if(q.kind==='claim')result=await state.claim(c.lead_id,c.attempt);
  else if(q.kind==='save')result=await state.save(c.lead_id,c.attempt,q.state);
  else if(q.kind==='provider'){
   if(!allow[q.provider]?.test(q.path)||!['POST','GET'].includes(q.method))return send(400,{error:'operation_not_allowed'});
   const leg=cfg.legs[q.provider];
   if(!leg || !leg.base_url.startsWith('https://fetchsandbox.com/'))throw new Error('non-twin binding refused');
   const started=new Date().toISOString();
   try{
    const out=await fetch(leg.base_url.replace(/\/$/,'')+q.path,{method:q.method,headers:{authorization:`Bearer ${leg.api_key}`,'content-type':'application/json','user-agent':'fetchsandbox-n8n-pilot/1.0','x-sandbox-strict-validation':'1',...(process.env.X_FLOW_RUN_ID?{'x-flow-run-id':process.env.X_FLOW_RUN_ID}:{})},body:q.method==='POST'?JSON.stringify(q.body):undefined,signal:AbortSignal.timeout(6000)});
    result={status:out.status,body:await out.json()};
   }catch{result={status:0,body:null,transport:'unknown'};}
   appendFileSync(process.env.TRACE_FILE!,JSON.stringify({at:started,lead_id:c.lead_id,attempt:c.attempt,provider:q.provider,method:q.method,path:q.path,status:result.status,body:result.body})+'\n',{mode:0o600});
  }else return send(400,{error:'unknown_command'});
  return send(200,{context:c,result});
 }catch{return send(500,{error:'adapter_failure'});}
}).listen(Number(process.env.PORT??8097),'127.0.0.1',()=>console.log('pilot adapter listening'));
