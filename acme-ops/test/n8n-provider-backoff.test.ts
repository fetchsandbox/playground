import {describe,it,expect,vi,afterEach} from 'vitest';
import {callTwin} from '../n8n-lead-pilot/provider-transport';
import {LeadState} from '../n8n-lead-pilot/state';
import {MemoryStore} from '../src/kit/store';
// @ts-ignore Shared native Code source.
import {advance} from '../n8n-lead-pilot/machine.mjs';
const now=Date.parse('2026-11-08T16:00:00Z');
afterEach(()=>vi.useRealTimers());
describe('C12 persisted Retry-After and notification-only retry',()=>{
 it('retains only normalized retry timing from a provider 429',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const result=await callTwin({base_url:'https://fetchsandbox.com/sandbox/fixture',api_key:'fixture-only'},{method:'POST',path:'/chat.postMessage',body:{}},undefined,vi.fn(async()=>new Response('{"ok":false,"error":"ratelimited"}',{status:429,headers:{'Retry-After':'30','Set-Cookie':'never-expose'}})));
  expect(result).toMatchObject({retry_after_seconds:30,retry_not_before:'2026-11-08T16:00:30.000Z'});expect(result).not.toHaveProperty('headers');
 });
 it.each(['', '-1', '1.5', 'tomorrow', '99999999999999999999'])('withholds timing for invalid Retry-After %s',async(header)=>{
  const result=await callTwin({base_url:'https://fetchsandbox.com/sandbox/fixture',api_key:'fixture-only'},{method:'POST',path:'/chat.postMessage'},undefined,vi.fn(async()=>new Response('{}',{status:429,headers:{'Retry-After':header}})));
  expect(result).not.toHaveProperty('retry_not_before');
 });
 it('normalizes an HTTP-date and ignores timing on non-429 responses',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const invoke=(status:number)=>callTwin({base_url:'https://fetchsandbox.com/sandbox/fixture',api_key:'fixture-only'},{method:'POST',path:'/chat.postMessage'},undefined,vi.fn(async()=>new Response('{}',{status,headers:{'Retry-After':'Sun, 08 Nov 2026 16:00:30 GMT'}})));
  expect(await invoke(429)).toMatchObject({retry_after_seconds:30});expect(await invoke(500)).not.toHaveProperty('retry_not_before');
 });
 it.each(['unknown','confirmed'])('never reclaims completed business state with a %s notification',async(status)=>{
  const state=new LeadState(new MemoryStore(),'session');const first=await state.claim('ordinary','one');await state.save('ordinary','one',{...first.state!,status:'confirmed',notification:{status,retry_not_before:'2020-01-01T00:00:00Z'}});
  expect((await state.claim('ordinary','retry',true)).claimed).toBe(false);
 });
 it('persists a rate-limited notification separately from confirmed business effects',()=>{
  const next=advance({context:{lead_id:'ordinary',attempt:'one',stage:'notified',state:{status:'confirmed',operations:{calendar:{id:'existing',status:'confirmed'}}}},result:{status:429,body:{ok:false,error:'ratelimited'},retry_after_seconds:30,retry_not_before:'2026-11-08T16:00:30.000Z'}});
  expect(next.request.state.notification).toMatchObject({status:'rate_limited',retry_after_seconds:30,retry_not_before:'2026-11-08T16:00:30.000Z'});expect(next.request.state.operations.calendar.id).toBe('existing');
 });
 it('withholds early retries and grants only one explicit retry after the saved deadline',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);const state=new LeadState(new MemoryStore(),'session');const first=await state.claim('ordinary','one');await state.save('ordinary','one',{...first.state!,status:'confirmed',operations:Object.fromEntries(['contact','deal','gmail','calendar'].map(s=>[s,{status:'confirmed',id:s+'-existing'}])),notification:{status:'rate_limited',retry_not_before:'2026-11-08T16:00:30.000Z',retry_after_seconds:30}});
  expect((await state.claim('ordinary','early',true)).claimed).toBe(false);vi.setSystemTime(now+30000);expect((await state.claim('ordinary','not-explicit')).claimed).toBe(false);
  const retries=await Promise.all([state.claim('ordinary','two',true),state.claim('ordinary','three',true)]);expect(retries.filter(x=>x.claimed)).toHaveLength(1);
  const accepted=retries.find(x=>x.claimed)!;const next=advance({context:{lead_id:'ordinary',attempt:accepted.state!.owner,stage:'claimed',retry_failed:true},result:accepted});const choose=advance({context:next.context,result:{saved:true,state:next.request.state}});expect(choose.request.kind).toBe('save');expect(choose.context.stage).toBe('notify');
 });
});
