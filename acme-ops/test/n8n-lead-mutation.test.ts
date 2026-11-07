import {it,expect} from 'vitest';
import {MemoryStore} from '../src/kit/store';
import {LeadState} from '../n8n-lead-pilot/state';
// @ts-ignore Pure n8n Code-node source.
import {advance} from '../n8n-lead-pilot/machine.mjs';

// Unit-level fault experiment only. Provider replies here are stubs, NOT twins
// or a FetchSandbox receipt. The same oracle checks both state implementations.
async function exercise(disableDedupe:boolean){
 const store=new MemoryStore();const state=new LeadState(store);
 const effects={contact:0,deal:0,gmail:0,calendar:0};
 const deals:Record<string,any>={};
 async function run(attempt:string){
  let next:any={lead_id:'repeat',attempt,raw:'dummy'};
  for(let i=0;i<80;i++){
   next=advance(next);if(next.done)return next;
   const {context:c,request:q}=next;let result:any;
   if(q.kind==='claim'){
    result=await state.claim(c.lead_id,c.attempt);
    // Deliberate defect: overwrite a completed claim and forget saved effects.
    if(disableDedupe && !result.claimed && result.state?.status==='confirmed'){
     const broken={...result.state,owner:c.attempt,status:'in_progress',operations:Object.fromEntries(Object.keys(effects).map(k=>[k,{status:'pending'}]))};
     await store.replace(broken);result={claimed:true,state:await store.get(broken.pk)};
    }
   }else if(q.kind==='save')result=await state.save(c.lead_id,c.attempt,q.state);
   else if(q.path.endsWith('/search'))result={status:200,body:{results:[]}};
   else if(q.provider==='slack')result={status:200,body:{ok:true}};
   else if(q.provider==='hubspot' && q.method==='GET')result={status:200,body:deals[c.state.operations.deal.id]};
   else {const step=c.step as keyof typeof effects;effects[step]++;const id=step+'-'+effects[step];result={status:200,body:{id}};
    if(step==='deal')deals[id]={id,properties:q.body.properties,associations:{contacts:{results:[{id:q.body.associations[0].to.id,type:'deal_to_contact'}]}}};
   }
   next={context:c,result};
  }
  throw Error('state machine failed to terminate');
 }
 await run('first');await run('redelivery');return effects;
}
const oneEffectEach=(effects:unknown)=>expect(effects).toEqual({contact:1,deal:1,gmail:1,calendar:1});
it('the frozen one-effect oracle rejects disabled dedupe and accepts the corrected state policy',async()=>{
 const broken=await exercise(true);
 expect(broken).toEqual({contact:2,deal:2,gmail:2,calendar:2});
 expect(()=>oneEffectEach(broken)).toThrow();
 const corrected=await exercise(false);oneEffectEach(corrected);
});
