/** Test process: executes the production decision machine and conditional store.
 * IPC barriers belong to the test harness, never the application or provider.
 */
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoStore,FileStore} from '../../src/kit/store';
import {LeadState} from '../../n8n-lead-pilot/state';
// @ts-ignore Native shared decision machine.
import {advance} from '../../n8n-lead-pilot/machine.mjs';
// @ts-ignore Existing native negative-control source variant.
import {blindDealRetry,skipCalendarReadback,blindSlackResend} from '../../n8n-lead-pilot/build-workflow.mjs';
const cfg=JSON.parse(process.env.C9_FIXTURE!);
const store=cfg.file?new FileStore(cfg.file):new DynamoStore(cfg.table,new DynamoDBClient({endpoint:cfg.endpoint,region:'us-west-2',credentials:{accessKeyId:'local',secretAccessKey:'local'}}));
const state=new LeadState(store,cfg.scope,{leaseMs:1000,...(cfg.recoveryPolicy?{recoveryPolicy:cfg.recoveryPolicy}:{})});
async function barrier(phase:string,context:any,request:any,result?:any){
 process.send?.({phase,context,request,result});
 await new Promise<void>(resolve=>process.once('message',()=>resolve()));
}
let next:any={lead_id:cfg.lead,attempt:cfg.owner,...(cfg.raw?{raw:cfg.raw}:{})};
for(let i=0;i<120;i++){
 const raw=advance(next);
 const out=cfg.variant==='blind-deal-retry'?blindDealRetry(raw):cfg.variant==='skip-calendar-readback'?skipCalendarReadback(raw):cfg.variant==='blind-slack-resend'?blindSlackResend(raw):raw;
 if(out.done){process.send?.({done:out});process.disconnect?.();break;}
 const c=out.context,q=out.request;
 await barrier('before',c,q);
 let result;
 if(q.kind==='claim')result=await state.claim(c.lead_id,c.attempt);
 else if(q.kind==='save')result=await state.save(c.lead_id,c.attempt,q.state);
 else{
  const permit=await state.authorizeProvider(c.lead_id,c.attempt,c.state.version,'pilot-team:pilot-owner');
  if(!permit.allowed)result={denied:true};
  else{
   c.state={...c.state,version:permit.state!.version,epoch:permit.state!.epoch,lease_expires_at:permit.state!.lease_expires_at};
   const r=await fetch(cfg.provider+q.path,{method:q.method,headers:{'content-type':'application/json'},body:q.method==='POST'?JSON.stringify(q.body):undefined});
   result={status:r.status,body:await r.json()};
  }
 }
 await barrier('after',c,q,result);
 next={context:c,result};
}
