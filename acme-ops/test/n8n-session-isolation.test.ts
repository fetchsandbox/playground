import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore} from '../src/kit/store';
import {LeadState} from '../n8n-lead-pilot/state';
describe('pilot state session boundaries on the same durable file',()=>{
 it('does not inherit the same business lead from another bound session',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pilot-scope-'));const file=join(dir,'shared.json');
  try{
   const a=new (LeadState as any)(new FileStore(file),'session-a');
   const first=await a.claim('same-business-lead','owner-a');expect(first.claimed).toBe(true);
   const b=new (LeadState as any)(new FileStore(file),'session-b');
   const fresh=await b.claim('same-business-lead','owner-b');expect(fresh.claimed).toBe(true);
   expect(fresh.state.pk).not.toBe(first.state.pk);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});

it('preserves same-session restart state but refuses a cross-session save',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pilot-scope-'));const file=join(dir,'shared.json');
 try{
  const a=new LeadState(new FileStore(file),'a');const first=await a.claim('lead','same-owner');
  await a.save('lead','same-owner',{...first.state!,status:'confirmed',operations:{deal:{status:'confirmed',id:'old-deal'}}});
  expect((await new LeadState(new FileStore(file),'a').claim('lead','next-owner')).claimed).toBe(false);
  const b=new LeadState(new FileStore(file),'b');await b.claim('lead','same-owner');
  const old=(await new LeadState(new FileStore(file),'a').records('lead'))[0]!;
  expect((await b.save('lead','same-owner',old)).saved).toBe(false);
  expect((await b.records('lead'))[0]?.operations).not.toMatchObject({deal:{id:'old-deal'}});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('returns only an exact lead rather than a matching prefix',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pilot-scope-'));const file=join(dir,'shared.json');
 try{const state=new LeadState(new FileStore(file),'a');await state.claim('lead-long','a');expect(await state.records('lead')).toEqual([]);}finally{rmSync(dir,{recursive:true,force:true});}
});
it('refuses a missing or malformed namespace',()=>{
 for(const scope of ['',undefined,'bad#scope','../other'])expect(()=>new LeadState({} as any,scope as any)).toThrow('scope');
});
// @ts-ignore Node-readable binding helper is shared with the runner.
import {sessionScope} from '../n8n-lead-pilot/session-scope.mjs';
it('derives a stable namespace only from complete issued session identities',()=>{
 const legs=Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-a',base_url:'https://fetchsandbox.com/sandbox/'+role+'-a'}]));
 expect(sessionScope(legs)).toBe(sessionScope(Object.fromEntries(Object.entries(legs).reverse())));
 const changed=structuredClone(legs);changed.gmail={sandbox_id:'gmail-b',base_url:'https://fetchsandbox.com/sandbox/gmail-b'};
 expect(sessionScope(changed)).not.toBe(sessionScope(legs));expect(sessionScope({})).toBeNull();
 expect(()=>sessionScope({hubspot:legs.hubspot})).toThrow('Incomplete');
 expect(()=>sessionScope({...legs,gmail:{sandbox_id:'gmail-a',base_url:'https://outside.example'}})).toThrow('identity');
});
