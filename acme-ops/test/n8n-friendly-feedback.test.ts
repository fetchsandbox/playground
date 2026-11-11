import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore,FileStore,type KvStore} from '../src/kit/store';
import {LeadState} from '../n8n-lead-pilot/state';
// @ts-ignore Same source embedded in the native Code node.
import {advance as currentAdvance} from '../n8n-lead-pilot/machine.mjs';
// Optional baseline source supports the SAME component oracle before/after.
// It is a local test instrument, never a runtime source selector.
const advance=process.env.FEEDBACK_MACHINE_SOURCE
 ? new Function(readFileSync(process.env.FEEDBACK_MACHINE_SOURCE,'utf8').replace('export function advance','function advance')+';return advance;')()
 : currentAdvance;
const policy={maxLookups:3,windowMs:30*60*1000,quietNotifications:true};
const raw=Buffer.from('To: feedback@example.com\r\nMessage-ID: <feedback@example.com>\r\n\r\nUnsent follow-up').toString('base64url');
afterEach(()=>vi.useRealTimers());

// Component execution uses the real state machine and conditional store.
// Provider replies below are controlled local fixtures, not provider parity.
async function fixture(store:KvStore){
 const effects={lookups:0,emails:0,calendar:0,slack:[] as string[]};
 let visible=false;
 const createState=()=>new LeadState(store,'feedback',{recoveryPolicy:policy});
 const seed=await createState().claim('feedback','seed');
 await createState().save('feedback','seed',{...seed.state!,status:'unknown',next_reconcile_at:Date.now(),operations:{contact:{status:'confirmed',id:'contact-original'},deal:{status:'confirmed',id:'deal-original'},gmail:{status:'unknown'},calendar:{status:'pending'}}});
 const run=async(attempt:string)=>{
  // Reconstruct the application store owner on each invocation, as a timer or
  // redelivery does. The machine, not the test, chooses reads and writes.
  const state=createState();let next:any={lead_id:'feedback',attempt,raw};
  for(let i=0;i<100;i++){
   const out=advance(next);if(out.done)return out;
   const c=out.context,q=out.request;let result:any;
   if(q.kind==='claim')result=await state.claim(c.lead_id,c.attempt);
   else if(q.kind==='save')result=await state.save(c.lead_id,c.attempt,q.state);
   else {
    const permit=await state.authorizeProvider(c.lead_id,c.attempt,c.state.version,'pilot-team:pilot-owner');
    if(!permit.allowed)result={denied:true};
    else{
     c.state={...c.state,version:permit.state!.version,epoch:permit.state!.epoch};
     if(q.provider==='gmail'&&q.method==='GET'&&q.path.includes('?')){effects.lookups++;result={status:200,body:{messages:visible?[{id:'message-original'}]:[]}};}
     else if(q.provider==='gmail'&&q.method==='GET')result={status:200,body:{id:'message-original',labelIds:['SENT'],payload:{headers:[{name:'To',value:'feedback@example.com'},{name:'Message-ID',value:'<feedback@example.com>'}]}}};
     else if(q.provider==='gmail'){effects.emails++;throw Error('Unknown email was sent again');}
     else if(q.provider==='google-calendar'){effects.calendar++;result={status:200,body:{id:q.body.id}};}
     else if(q.provider==='slack'){effects.slack.push(q.body.text);result={status:200,body:{ok:true,ts:'notice-'+effects.slack.length}};}
     else throw Error('Confirmed CRM was touched again');
    }
   }
   next={context:c,result};
  }
  throw Error('Machine did not terminate');
 };
 return {run,effects,state:createState,show:()=>{visible=true;}};
}

describe('Friendly feedback policy, isolated component scope',()=>{
 it('prefers direct Deal identity over eventually consistent search when the ID is known',()=>{
  const q=advance({lead_id:'saved',attempt:'a',stage:'choose',index:1,state:{operations:{contact:{status:'confirmed',id:'c'},deal:{status:'unknown',id:'d'},gmail:{status:'pending'},calendar:{status:'pending'}}}});
  expect(q.request).toMatchObject({method:'GET',path:'/crm/v3/objects/deals/d?associations=contacts'});
 });
 it.each([{results:[]},{results:[{id:'one'},{id:'two'}]}])('a missing or ambiguous Deal search never becomes a second create',({results})=>{
  const out=advance({context:{lead_id:'saved',attempt:'a',stage:'reconciled',step:'deal',index:1,state:{operations:{contact:{status:'confirmed',id:'c'},deal:{status:'unknown'}}}},result:{status:200,body:{results}}});
  expect(out.request.kind).toBe('save');expect(out.request.state.status).toBe('unknown');
 });
 it('looks up at 0,15,30 minutes then hands off; repeated deliveries neither resend nor spam',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const f=await fixture(new MemoryStore());
  expect((await f.run('first')).status).toBe('unknown');
  expect(f.effects.lookups).toBe(1);expect(f.effects.slack).toHaveLength(1);
  expect((await f.state().records('feedback'))[0]).toMatchObject({next_reconcile_at:900000});
  for(let i=0;i<5;i++)await f.run('duplicate-'+i);
  expect(f.effects.lookups).toBe(1);expect(f.effects.slack).toHaveLength(1);
  vi.setSystemTime(900000);await f.run('second');expect(f.effects.lookups).toBe(2);expect(f.effects.slack).toHaveLength(1);
  vi.setSystemTime(1800000);expect((await f.run('third')).status).toBe('needs_human');
  const record=(await f.state().records('feedback'))[0]!;
  expect(record.handoff).toMatchObject({lead_id:'feedback',blocked_step:'gmail',lookup_attempts:3,email_draft:{raw_base64url:raw,send_outcome:'unknown'}});
  expect(record).not.toHaveProperty('next_reconcile_at');
  expect(f.effects).toMatchObject({lookups:3,emails:0,calendar:0});expect(f.effects.slack).toHaveLength(2);
  expect(f.effects.slack.map(x=>JSON.parse(x).status)).toEqual(['unknown','needs_human']);
  await f.run('after-handoff');expect(f.effects.slack).toHaveLength(2);
 });
 it('retains the original email and CRM IDs when the second lookup resolves uncertainty',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const f=await fixture(new MemoryStore());await f.run('first');
  vi.setSystemTime(900000);f.show();expect((await f.run('second')).status).toBe('confirmed');
  const record=(await f.state().records('feedback'))[0]!;
  expect(record.operations).toMatchObject({contact:{id:'contact-original'},deal:{id:'deal-original'},gmail:{id:'message-original',status:'confirmed'}});
  expect(f.effects).toMatchObject({lookups:2,emails:0,calendar:1});
  expect(f.effects.slack.map(x=>JSON.parse(x).status)).toEqual(['unknown','confirmed']);
  await f.run('completed-replay');expect(f.effects.slack).toHaveLength(2);
 });
 it('retains the deadline and attempt budget across a new file-store consumer',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const dir=mkdtempSync(join(tmpdir(),'feedback-durable-'));
  try{
   const path=join(dir,'state.json');const f=await fixture(new FileStore(path));await f.run('first');
   vi.setSystemTime(899999);const reader=new LeadState(new FileStore(path),'feedback',{recoveryPolicy:policy});
   expect(await reader.due()).toEqual([]);expect((await reader.claim('feedback','early')).claimed).toBe(false);
   vi.setSystemTime(900000);expect(await reader.due()).toEqual([{lead_id:'feedback',requester:'pilot-team:pilot-owner'}]);
   const row=(await reader.claim('feedback','replacement')).state!;
   expect(row.operations).toMatchObject({gmail:{reconciliation:{started_at:0,attempts:1}}});
   expect(row.recovery_policy).toEqual(policy);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('overdue unknown transitions to a human without another provider lookup',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const f=await fixture(new MemoryStore());await f.run('first');
  vi.setSystemTime(1800001);expect((await f.run('late')).status).toBe('needs_human');expect(f.effects.lookups).toBe(1);expect(f.effects.emails).toBe(0);
 });
 it('retains a checkpointed read budget if a worker dies before issuing its lookup',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const state=new LeadState(new MemoryStore(),'abandoned',{leaseMs:100,recoveryPolicy:policy});
  const first=await state.claim('ordinary','old');await state.save('ordinary','old',{...first.state!,operations:{gmail:{status:'unknown',reconciliation:{started_at:0,attempts:1}}}});
  vi.setSystemTime(101);expect(await state.due()).toEqual([{lead_id:'ordinary',requester:'pilot-team:pilot-owner'}]);
  const newOwner=await state.claim('ordinary','new');expect(newOwner.claimed).toBe(true);expect(newOwner.state?.operations).toMatchObject({gmail:{reconciliation:{attempts:1}}});
  expect((await state.authorizeProvider('ordinary','old',first.state!.version!,'pilot-team:pilot-owner')).allowed).toBe(false);
 });
 it('rejects invalid policy settings rather than silently disabling the budget',()=>{
  for(const p of [null,0,{...policy,maxLookups:0},{...policy,windowMs:0},{...policy,quietNotifications:'yes'}])expect(()=>new LeadState(new MemoryStore(),'policy',{recoveryPolicy:p as any})).toThrow();
 });
});

describe('qualified unique Deal identity opt-in',()=>{
 const context=()=>({lead_id:'saved',attempt:'owner',stage:'choose',index:1,state:{recovery_policy:{...policy,uniqueDealIdentity:true},operations:{contact:{status:'confirmed',id:'contact-original'},deal:{status:'unknown'},gmail:{status:'pending'},calendar:{status:'pending'}}}});
 const lookup=(c:any)=>{const checkpoint=advance(c);expect(checkpoint.request.kind).toBe('save');return advance({context:checkpoint.context,result:{saved:true,state:checkpoint.request.state}});};
 const original={id:'deal-original',properties:{dealname:'Pilot saved',fetchsandbox_pilot_lead_id:'saved'},associations:{contacts:{results:[{id:'contact-original'}]}}};
 it('looks up the stable unique property even when the lost response left no Deal ID',()=>{
  const q=lookup(context());expect(q.request).toMatchObject({method:'GET',path:'/crm/v3/objects/deals/saved?idProperty=fetchsandbox_pilot_lead_id&properties=dealname%2Cfetchsandbox_pilot_lead_id&associations=contacts'});
  const out=advance({context:q.context,result:{status:200,body:original}});
  expect(out.request.state.operations.deal).toMatchObject({id:'deal-original',status:'confirmed',confirmation:'positive_unique_key_readback'});
 });
 it.each([
  null,{...original,properties:{...original.properties,fetchsandbox_pilot_lead_id:'foreign'}},
  {...original,associations:{contacts:{results:[{id:'foreign'}]}}},
  {...original,properties:{...original.properties,dealname:'foreign'}}
 ])('missing or foreign unique-key evidence never authorizes create or downstream effects',body=>{
  const q=lookup(context());const out=advance({context:q.context,result:{status:body?200:404,body}});
  expect(out.request.kind).toBe('save');expect(out.request.state.status).toBe('unknown');expect(out.request.state.operations.deal.status).toBe('unknown');
 });
 it('rejects a different returned Deal ID if an earlier acknowledgement supplied one',()=>{
  const c=context();(c.state.operations.deal as any).id='acknowledged';const q=lookup(c);
  const out=advance({context:q.context,result:{status:200,body:original}});expect(out.request.state.status).toBe('unknown');
 });
});
