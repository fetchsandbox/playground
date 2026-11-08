import {describe,it,expect} from 'vitest';
import {InvocationAuthority,requesterFor,requesterKey} from '../n8n-lead-pilot/identity';
import {LeadState} from '../n8n-lead-pilot/state';
import {MemoryStore} from '../src/kit/store';
const owner={subject:'owner',tenant:'pilot'},other={subject:'other',tenant:'pilot'};
const key='test-only-signing-key-32-bytes-long';
describe('C6 requester and native invocation authorization',()=>{
 it('derives identity only from configured credentials',()=>{
  expect(requesterFor('unknown',[{...owner,token:'owner-fixture'}])).toBeNull();expect(requesterFor('owner-fixture',[{...owner,token:'owner-fixture'}])).toEqual(owner);
 });
 it('binds native tickets to session, caller, input and expiry',()=>{
  const authority=new InvocationAuthority(key,'session-a'),ticket=authority.mint(owner,{lead_id:'ordinary'},100000);
  expect(authority.verify(ticket,{lead_id:'ordinary'},100001)).toEqual(owner);
  for(const input of [{lead_id:'other'},{lead_id:'ordinary',retry_failed:true}])expect(authority.verify(ticket,input,100001)).toBeNull();
  expect(authority.verify(ticket,{lead_id:'ordinary'},190000)).toBeNull();expect(new InvocationAuthority(key,'session-b').verify(ticket,{lead_id:'ordinary'},100001)).toBeNull();expect(authority.verify(ticket+'x',{lead_id:'ordinary'},100001)).toBeNull();
 });
 it('denies a second authenticated requester without disclosing or changing the owner state',async()=>{
  const state=new LeadState(new MemoryStore(),'session-a');const first=await state.claim('ordinary','exec-1',false,requesterKey(owner));expect(first.claimed).toBe(true);
  const before=await state.records('ordinary');expect((await state.claim('ordinary','exec-2',false,requesterKey(other))).denied).toBe(true);expect(await state.records('ordinary')).toEqual(before);
  expect(await state.recordsFor('ordinary',requesterKey(other))).toEqual({denied:true});
 });
 it('refuses owner substitution in a conditional save',async()=>{
  const state=new LeadState(new MemoryStore(),'session-a');const first=await state.claim('ordinary','exec-1',false,requesterKey(owner));expect((await state.save('ordinary','exec-1',{...first.state!,requester:requesterKey(other)},requesterKey(owner))).saved).toBe(false);
 });
});

it('rejects signed tickets with malformed principal types',()=>{const authority=new InvocationAuthority(key,'session-a');const ticket=authority.mint({subject:123,tenant:'team'} as any,{lead_id:'ordinary'},100000);expect(authority.verify(ticket,{lead_id:'ordinary'},100001)).toBeNull();});
