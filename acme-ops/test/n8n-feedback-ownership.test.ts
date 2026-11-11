import {it,expect} from 'vitest';
import {MemoryStore} from '../src/kit/store';
import {LeadState} from '../n8n-lead-pilot/state';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoStore} from '../src/kit/store';
import {randomUUID} from 'node:crypto';

const policy={maxLookups:3,windowMs:30000,quietNotifications:true};
const original='a'.repeat(64),replacement='b'.repeat(64);
it('a due timer cannot steal an unknown lead while its original native invocation is still notifying',async()=>{
 let now=0;const state=new LeadState(new MemoryStore(),'race',{now:()=>now,recoveryPolicy:policy});
 const claimed=await state.claim('lead','original',false,'team:owner',original);
 const saved=await state.save('lead','original',{...claimed.state!,invocation_fingerprint:replacement,status:'unknown',next_reconcile_at:0,notification:{status:'in_flight'}},'team:owner');
 expect(saved.state!.invocation_fingerprint).toBe(original);
 // Pause immediately before the original's Slack request. The real timer
 // sees persisted unknown here; the lease must still fence the invocation.
 expect(await state.due()).toEqual([]);
 expect((await state.claim('lead','timer',false,'team:owner',replacement)).claimed).toBe(false);
 const before=(await state.records('lead'))[0];
 expect(await state.deferDue('lead','team:owner')).toBe(false);
 expect((await state.records('lead'))[0]).toEqual(before);
 expect((await state.authorizeProvider('lead','original',saved.state!.version!,'team:owner')).allowed).toBe(true);
 expect(await state.finishInvocation('lead','team:other',original)).toBe(false);
 expect(await state.finishInvocation('lead','team:owner',replacement)).toBe(false);
 expect(await state.finishInvocation('lead','team:owner',original)).toBe(true);
 expect(await state.due()).toEqual([{lead_id:'lead',requester:'team:owner'}]);
 const next=await state.claim('lead','timer',false,'team:owner',replacement);expect(next.claimed).toBe(true);
 expect(await state.finishInvocation('lead','team:owner',original)).toBe(false);
 expect((await state.authorizeProvider('lead','original',saved.state!.version!,'team:owner')).allowed).toBe(false);
 expect((await state.authorizeProvider('lead','timer',next.state!.version!,'team:owner')).allowed).toBe(true);
});

it('an unreturned or crashed native invocation becomes recoverable only after its real lease expires',async()=>{
 let now=0;const state=new LeadState(new MemoryStore(),'crashed',{now:()=>now,leaseMs:1000,recoveryPolicy:policy});
 const claimed=await state.claim('lead','original',false,'team:owner',original);
 await state.save('lead','original',{...claimed.state!,status:'unknown',next_reconcile_at:0},'team:owner');
 now=999;expect(await state.due()).toEqual([]);
 now=1000;expect(await state.due()).toEqual([{lead_id:'lead',requester:'team:owner'}]);
 expect((await state.claim('lead','timer',false,'team:owner',replacement)).claimed).toBe(true);
 expect(await state.finishInvocation('lead','team:owner',original)).toBe(false);
});

it.skipIf(!process.env.C9_DYNAMODB_ENDPOINT)('persists the invocation fence across fresh DynamoDB consumers and rejects an old completion after concurrent takeover',async()=>{
 const opts={endpoint:process.env.C9_DYNAMODB_ENDPOINT,region:'us-west-2',credentials:{accessKeyId:'local',secretAccessKey:'local'}};
 const a=new DynamoDBClient(opts),b=new DynamoDBClient(opts),table='friendly-finish-'+randomUUID();
 await a.send(new CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));
 try{
  const first=new LeadState(new DynamoStore(table,a),'native',{recoveryPolicy:policy});
  const next=new LeadState(new DynamoStore(table,b),'native',{recoveryPolicy:policy});
  const row=await first.claim('lead','original',false,'team:owner',original);
  await first.save('lead','original',{...row.state!,status:'unknown',next_reconcile_at:0},'team:owner');
  expect(await next.due()).toEqual([]);expect((await next.claim('lead','early',false,'team:owner',replacement)).claimed).toBe(false);
  expect(await first.finishInvocation('lead','team:owner',original)).toBe(true);
  const claims=await Promise.all([next.claim('lead','replacement',false,'team:owner',replacement),first.claim('lead','competitor',false,'team:owner','c'.repeat(64))]);
  expect(claims.filter(x=>x.claimed)).toHaveLength(1);
  expect(await first.finishInvocation('lead','team:owner',original)).toBe(false);
  const stored=(await next.records('lead'))[0]!;
  expect(stored.lease_expires_at).toBeGreaterThan(Date.now());expect(stored.owner).not.toBe('original');
 }finally{await a.send(new DeleteTableCommand({TableName:table}));a.destroy();b.destroy();}
},20000);
