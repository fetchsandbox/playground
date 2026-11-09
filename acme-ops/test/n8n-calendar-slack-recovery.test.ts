import {describe,it,expect} from 'vitest';
// @ts-ignore Shared native n8n Code source.
import {advance} from '../n8n-lead-pilot/machine.mjs';
const calendar=()=>({lead_id:'example',attempt:'replacement',stage:'choose',index:3,state:{status:'in_progress',operations:{contact:{status:'confirmed'},deal:{status:'confirmed'},gmail:{status:'confirmed'},calendar:{status:'unknown',requested_id:'f12345'}}}});
const event={id:'f12345',status:'confirmed',summary:'Pilot example',start:{dateTime:'2026-12-01T16:00:00Z'},end:{dateTime:'2026-12-01T16:15:00Z'},attendees:[{email:'example@example.com'}]};
const notice=()=>({lead_id:'example',attempt:'replacement',stage:'notify',blocked:null,state:{status:'confirmed',operations:{},notification:{status:'unknown',outcome:'confirmed',blocked_step:null,accepted_ids:['previous']}}});
const text=JSON.stringify({lead_id:'example',status:'confirmed',blocked_step:null});
describe('Calendar and Slack uncertain-write readback',()=>{
 it('reads the saved Calendar intent and confirms exact event identity, fields and time',()=>{
  const q=advance(calendar());expect(q.request).toMatchObject({method:'GET',path:'/calendars/primary/events/f12345'});
  const out=advance({context:q.context,result:{status:200,body:event}});expect(out.request.state.operations.calendar).toMatchObject({id:'f12345',status:'confirmed',confirmation:'positive_readback'});
 });
 it.each([null,{...event,id:'foreign'},{...event,status:'cancelled'},{...event,attendees:[{email:'foreign@example.com'}]},{...event,start:{dateTime:'2026-12-02T16:00:00Z'}}])('does not confirm or re-create an absent/mismatched event',body=>{
  const q=advance(calendar());const out=advance({context:q.context,result:{status:body?200:404,body}});expect(out.request.kind).toBe('save');expect(out.request.state.status).toBe('unknown');expect(out.request.state.operations.calendar.id).toBeUndefined();
 });
 it('saves a deterministic valid Calendar ID before dispatch and refuses a different acknowledged ID',()=>{
  const c=calendar();c.state.operations.calendar={status:'pending'} as any;const out=advance(c);expect(out.request.kind).toBe('save');expect(out.request.state.operations.calendar.requested_id).toMatch(/^[0-9a-v]{5,1024}$/);
  const bad=advance({context:{...out.context,stage:'effect',step:'calendar'},result:{status:200,body:{id:'unexpected'}}});expect(bad.request.state.operations.calendar.status).toBe('unknown');
 });
 it('confirms a new exact Slack message while excluding already-confirmed prior sends',()=>{
  const c=notice(),q=advance({context:c,result:{saved:true,state:c.state}});expect(q.request).toMatchObject({method:'GET',path:'/conversations.history?channel=C_PILOT&limit=100'});
  const out=advance({context:q.context,result:{status:200,body:{ok:true,has_more:false,messages:[{ts:'previous',text},{ts:'new',text}]}}});expect(out.request.state.notification).toMatchObject({status:'confirmed',ts:'new',confirmation:'positive_readback',accepted_ids:['previous','new']});
 });
 it.each([
  {ok:true,has_more:false,messages:[]},
  {ok:true,has_more:false,messages:[{ts:'one',text},{ts:'two',text}]},
  {ok:true,has_more:true,messages:[{ts:'one',text}]},
  {ok:true,has_more:false,response_metadata:{next_cursor:'more'},messages:[{ts:'one',text}]},
  {ok:true,has_more:false,messages:[{ts:'one',text,channel:'FOREIGN'}]},
  {ok:true,has_more:false,messages:[{ts:'one',text:'wrong'}]},
  {ok:false,has_more:false,messages:[{ts:'one',text}]},
 ])('holds an empty, ambiguous, paginated or wrong Slack observation without sending',body=>{
  const c=notice(),q=advance({context:c,result:{saved:true,state:c.state}});const out=advance({context:q.context,result:{status:200,body}});expect(out.request.kind).toBe('save');expect(out.request.state.notification.status).toBe('unknown');expect(out.request.state.notification.ts).toBeUndefined();
 });
 it('does not call a Slack acknowledgment without a timestamp confirmed',()=>{
  const c=notice();const out=advance({context:{...c,stage:'notified'},result:{status:200,body:{ok:true}}});expect(out.request.state.notification.status).toBe('unknown');
 });
});
