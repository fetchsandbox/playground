import {describe,it,expect} from 'vitest';
import {MemoryStore} from '../src/kit/store';
import {LeadState} from '../n8n-lead-pilot/state';
// @ts-ignore Native n8n embeds this same decision machine.
import {advance} from '../n8n-lead-pilot/machine.mjs';

describe('C9 lease and unknown-outcome recovery',()=>{
 it('reclaims an expired abandoned claim, preserving effects and fencing the old worker',async()=>{
  let time=1000;const store=new MemoryStore();const state=new LeadState(store,'crash',{now:()=>time,leaseMs:100});
  const first=await state.claim('lead','worker-a');
  const checkpoint=await state.save('lead','worker-a',{...first.state!,operations:{contact:{status:'confirmed',id:'contact-1'},deal:{status:'in_flight'},gmail:{status:'pending'},calendar:{status:'pending'}}});
  expect((await state.claim('lead','worker-b')).claimed).toBe(false);
  time=1101;
  const recovered=await state.claim('lead','worker-b');
  expect(recovered.claimed).toBe(true);
  expect(recovered.state?.operations).toMatchObject({contact:{status:'confirmed',id:'contact-1'},deal:{status:'unknown'}});
  expect((await state.save('lead','worker-a',checkpoint.state!)).saved).toBe(false);
  expect((await state.authorizeProvider('lead','worker-a',checkpoint.state!.version!,'pilot-team:pilot-owner')).allowed).toBe(false);
  const next=advance({context:{lead_id:'lead',attempt:'worker-b',stage:'claimed'},result:recovered});
  const search=advance({context:next.context,result:{saved:true,state:next.request.state}});
  expect(search.request.method).toBe('POST');expect(search.request.path).toContain('/deals/search');
 });
 it('allows only one contender to reclaim an expired owner and refuses a foreign requester',async()=>{
  let time=0;const state=new LeadState(new MemoryStore(),'race',{now:()=>time,leaseMs:100});
  await state.claim('lead','a');time=101;
  expect(await state.claim('lead','foreign',false,'another:person')).toMatchObject({claimed:false,denied:true});
  const claims=await Promise.all(Array.from({length:10},(_,i)=>state.claim('lead','b'+i)));
  expect(claims.filter(x=>x.claimed)).toHaveLength(1);
 });
 it('refuses expired-owner writes even before someone takes over; ignores client lease extensions',async()=>{
  let time=0;const state=new LeadState(new MemoryStore(),'expiry',{now:()=>time,leaseMs:100});
  const first=await state.claim('lead','a');time=101;
  expect((await state.save('lead','a',{...first.state!,lease_expires_at:999999})).saved).toBe(false);
  expect((await state.authorizeProvider('lead','a',first.state!.version!,'pilot-team:pilot-owner')).allowed).toBe(false);
 });
 it('does not repeat an uncertain notification after a crash',()=>{
  const c={lead_id:'mail',attempt:'new',stage:'notify',blocked:null,state:{status:'confirmed',notification:{status:'unknown',outcome:'confirmed',blocked_step:null},operations:{}}};
  const out=advance({context:c,result:{saved:true,state:c.state}});
  expect(out.request).toMatchObject({kind:'provider',provider:'slack',method:'GET'});
  const missing=advance({context:out.context,result:{status:200,body:{ok:true,has_more:false,messages:[]}}});
  expect(missing.request.kind).toBe('save');expect(missing.request.state.notification.status).toBe('unknown');
 });
 it('a new held attempt reports again after a confirmed notification, while checkpointing before dispatch',()=>{
  const c={lead_id:'mail',attempt:'new',stage:'notify',blocked:'gmail',state:{status:'failed',notification:{status:'confirmed',outcome:'failed',blocked_step:'gmail'},operations:{}}};
  const out=advance({context:c,result:{saved:true,state:c.state}});
  expect(out.request.kind).toBe('save');expect(out.context.stage).toBe('dispatch_notification');
  expect(out.request.state.notification).toMatchObject({status:'in_flight',outcome:'failed',blocked_step:'gmail'});
 });
 it('positive contact readback can recover a committed contact, but an empty result cannot authorize resend',()=>{
  const c={lead_id:'contact',attempt:'new',stage:'choose',index:0,state:{status:'in_progress',operations:{contact:{status:'unknown'},deal:{status:'pending'},gmail:{status:'pending'},calendar:{status:'pending'}}}};
  const lookup=advance(c);expect(lookup.request.path).toBe('/crm/v3/objects/contacts/search');
  const missing=advance({context:lookup.context,result:{status:200,body:{results:[]}}});
  expect(missing.request.kind).toBe('save');expect(missing.request.state.status).toBe('unknown');
  const found=advance({context:lookup.context,result:{status:200,body:{results:[{id:'c1',properties:{email:'contact@example.com'}}]}}});
  expect(found.request.state.operations.contact).toMatchObject({status:'confirmed',id:'c1'});
 });
});
