import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore,MemoryStore} from '../src/kit/store';
import {LeadState} from '../n8n-lead-pilot/state';
// @ts-ignore Pure logic is also embedded verbatim in the n8n Code node.
import {advance} from '../n8n-lead-pilot/machine.mjs';

describe('pilot operation state boundary',()=>{
 it('withholds Gmail unless the Deal read-back names the same saved contact',()=>{
  const c={lead_id:'bound',attempt:'a',stage:'reconciled_deal',step:'deal',index:1,state:{status:'in_progress',operations:{contact:{status:'confirmed',id:'contact-a'},deal:{status:'unknown',id:'deal-a'},gmail:{status:'pending'}}}};
  const wrong=advance({context:c,result:{status:200,body:{id:'deal-a',properties:{dealname:'Pilot bound'},associations:{contacts:{results:[{id:'contact-b'}]}}}}});
  expect(wrong.request.kind).toBe('save');expect(wrong.request.state.status).toBe('unknown');expect(wrong.context.blocked).toBe('deal');
  expect(wrong.request.state.operations.gmail.status).toBe('pending');
  const right=advance({context:c,result:{status:200,body:{id:'deal-a',properties:{dealname:'Pilot bound'},associations:{contacts:{results:[{id:'contact-a'}]}}}}});
  expect(right.request.state.operations.deal).toMatchObject({status:'confirmed',id:'deal-a'});
 });
 it('only one simultaneous first delivery claims a lead',async()=>{
  const state=new LeadState(new MemoryStore());
  const out=await Promise.all(Array.from({length:8},(_,i)=>state.claim('same-lead','a'+i)));
  expect(out.filter(x=>x.claimed)).toHaveLength(1);
 });
 it('retains confirmed resource IDs after recreating the store; refuses stale saves',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lead-state-'));const path=join(dir,'state.json');
  try{
   const state=new LeadState(new FileStore(path));const first=await state.claim('restart','a');
   const saved=await state.save('restart','a',{...first.state!,status:'unknown',operations:{gmail:{status:'unknown'},deal:{status:'confirmed',id:'42'}}});
   expect(saved.saved).toBe(true);
   expect((await state.save('restart','a',first.state!)).saved).toBe(false);
   const resumed=await new LeadState(new FileStore(path)).claim('restart','b');
   expect(resumed.claimed).toBe(true);
   expect(resumed.state?.operations).toMatchObject({deal:{status:'confirmed',id:'42'},gmail:{status:'unknown'}});
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('holds Calendar and does not resend Gmail when positive readback is unavailable',()=>{
  const c={lead_id:'unknown',attempt:'a',stage:'choose',index:2,state:{status:'unknown',operations:{contact:{status:'confirmed'},deal:{status:'confirmed'},gmail:{status:'unknown'},calendar:{status:'pending'}}}};
  const lookup=advance(c);
  expect(lookup.request.method).toBe('GET');expect(lookup.request.provider).toBe('gmail');
  const hold=advance({context:lookup.context,result:{status:503,body:{}}});
  expect(hold.request.kind).toBe('save');expect(hold.request.state.status).toBe('unknown');expect(hold.context.blocked).toBe('gmail');
  expect(hold.request.state.operations.calendar.status).toBe('pending');
 });
 it('keeps explicit rejection separate from lost response and stops downstream writes',()=>{
  const c={lead_id:'rejection',attempt:'a',stage:'effect',index:2,step:'gmail',state:{operations:{gmail:{status:'in_flight'},calendar:{status:'pending'}}}};
  expect(advance({context:c,result:{status:401,body:{}}}).request.state.status).toBe('failed');
  expect(advance({context:c,result:{status:0,body:null}}).request.state.status).toBe('unknown');
  expect(advance({context:c,result:{status:503,body:{}}}).request.state.status).toBe('unknown');
 });
 it('stops on a rejected checkpoint rather than calling a provider',()=>{
  const c={lead_id:'cas',attempt:'a',stage:'dispatch',step:'gmail',state:{status:'in_progress'}};
  expect(advance({context:c,result:{saved:false}}).done).toBe(true);
 });
 it('returns the original resource IDs on completed replay',()=>{
  const saved={status:'confirmed',operations:{deal:{id:'existing-deal',status:'confirmed'}}};
  const replay=advance({context:{lead_id:'replay',attempt:'b',stage:'claimed'},result:{claimed:false,state:saved}});
  expect(replay.done).toBe(true);expect(replay.status).toBe('confirmed');expect(replay.state.operations.deal.id).toBe('existing-deal');
 });
 it('does not trust an arbitrary Gmail list hit as send confirmation',()=>{
  const c={lead_id:'mail',attempt:'a',stage:'reconciled',step:'gmail',index:2,state:{operations:{gmail:{status:'unknown'}}}};
  const lookup=advance({context:c,result:{status:200,body:{messages:[{id:'msg'}]}}});
  expect(lookup.request.path).toBe('/gmail/v1/users/me/messages/msg');
  const wrong=advance({context:lookup.context,result:{status:200,body:{id:'msg',labelIds:['SENT'],payload:{headers:[{name:'To',value:'other@example.com'}]}}}});
  expect(wrong.request.state.status).toBe('unknown');
  const right=advance({context:lookup.context,result:{status:200,body:{id:'msg',labelIds:['SENT'],payload:{headers:[{name:'To',value:'mail@example.com'},{name:'Message-ID',value:'<mail@example.com>'}]}}}});
  expect(right.request.state.operations.gmail).toMatchObject({status:'confirmed',id:'msg'});
 });
});
