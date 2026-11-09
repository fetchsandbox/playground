import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {createServer,type Server} from 'node:http';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoStore} from '../src/kit/store';
const endpoint=process.env.C9_DYNAMODB_ENDPOINT;
// Explicit integration invocation; absent service is a skip, never a pass.
describe.skipIf(!endpoint)('C9 actual SIGKILL / independent workers / DynamoDB Local',()=>{
 const table='friendly-c9-'+randomUUID();
 const client=new DynamoDBClient({endpoint,region:'us-west-2',credentials:{accessKeyId:'local',secretAccessKey:'local'}});
 let server:Server,origin:string;
 let effects:Record<string,any[]>;
 let blockWrite:((kind:string)=>Promise<void>)|undefined;
 const children=new Set<ChildProcess>();
 beforeAll(async()=>{
  await client.send(new CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));
  server=createServer(async(req,res)=>{
   let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};const path=req.url!;let out:any={};
   const send=()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));};
   if(path.endsWith('/contacts/search'))out={results:effects.contact};
   else if(path.endsWith('/deals/search'))out={results:effects.deal};
   else if(path.includes('/objects/deals/')&&req.method==='GET')out=effects.deal![0];
   else if(path.includes('/messages?'))out={messages:effects.gmail!.map(x=>({id:x.id}))};
   else if(path.includes('/messages/')&&req.method==='GET')out=effects.gmail![0];
   else if(path.includes('/events?')&&req.method==='GET')out={items:effects.calendar};
   else if(path.includes('/events/')&&req.method==='GET')out=effects.calendar![0];
   else if(path.includes('/conversations.history?')&&req.method==='GET')out={ok:true,has_more:false,messages:effects.slack};
   else{
    const kind=path.includes('/contacts')?'contact':path.includes('/deals')?'deal':path.includes('/gmail/')?'gmail':path.includes('/events')?'calendar':'slack';
    if(blockWrite)await blockWrite(kind);
    const id=kind+'-'+(effects[kind]!.length+1);
    out=kind==='contact'?{id,properties:body.properties}:kind==='deal'?{id,properties:body.properties,associations:{contacts:{results:[{id:effects.contact![0].id}]}}}:kind==='gmail'?{id,labelIds:['SENT'],payload:{headers:[{name:'To',value:'crash@example.com'},{name:'Message-ID',value:'<crash@example.com>'}]}}:kind==='slack'?{ok:true,ts:id,...body}:{status:'confirmed',...body,id:body.id??id};
    effects[kind]!.push(out);
   }
   send();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+ (server.address() as any).port;
 });
 afterAll(async()=>{for(const child of children)child.kill('SIGKILL');await new Promise<void>(resolve=>server.close(()=>resolve()));await client.send(new DeleteTableCommand({TableName:table}));client.destroy();});
 const worker=(scope:string,owner:string,crash?:(m:any,child:ChildProcess)=>boolean|'hold',variant='normal')=>new Promise<any>((resolve,reject)=>{
  const child=fork(new URL('./fixtures/n8n-c9-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,C9_FIXTURE:JSON.stringify({table,endpoint,scope,owner,lead:'crash',provider:origin,variant})},stdio:['ignore','ignore','pipe','ipc']});children.add(child);
  let stderr='';child.stderr?.on('data',x=>stderr+=x);
  child.on('error',reject);let killed=false,finished=false;
  child.on('exit',code=>{children.delete(child);if(killed)resolve({killed:true});else if(!finished)reject(Error('Worker exited '+code+' '+stderr));});
  child.on('message',(m:any)=>{
   if(m.done){finished=true;resolve(m.done);}
   else {const action=crash?.(m,child);if(action==='hold')return;if(action){killed=true;child.kill('SIGKILL');}else child.send('continue');}
  });
 });
 const counts=()=>Object.fromEntries(Object.entries(effects).map(([k,v])=>[k,v.length]));
 const write=(m:any,kind:string)=>m.phase==='after'&&m.request?.kind==='provider'&&m.request.method==='POST'&&!m.request.path.endsWith('/search')&&m.request.provider===kind;
 it('the same one-Deal oracle rejects the registered blind-retry variant after a crash',async()=>{
  effects={contact:[],deal:[],gmail:[],calendar:[],slack:[]};const scope='s'+randomUUID();
  await worker(scope,'old',m=>write(m,'hubspot')&&m.request.path.endsWith('/deals'));
  await new Promise(resolve=>setTimeout(resolve,1100));
  await worker(scope,'broken',undefined,'blind-deal-retry');
  expect(effects.deal).toHaveLength(2);
  expect(effects.deal![0].id).not.toBe(effects.deal![1].id);
  const oneDealOracle=()=>effects.deal!.length===1;
  expect(oneDealOracle()).toBe(false);
 },20000);
 it('two independent replacement processes cannot both acquire the abandoned lead',async()=>{
  effects={contact:[],deal:[],gmail:[],calendar:[],slack:[]};const scope='s'+randomUUID();
  await worker(scope,'old',m=>write(m,'gmail'));
  await new Promise(resolve=>setTimeout(resolve,1100));
  const result=await Promise.all([worker(scope,'new-a'),worker(scope,'new-b')]);
  expect(result.filter(x=>x.reason==='Existing execution owns this lead, or lead is already complete')).toHaveLength(1);
  expect(counts()).toEqual({contact:1,deal:1,gmail:1,calendar:1,slack:1});
 },20000);
 it('a paused stale process cannot dispatch after a replacement took ownership',async()=>{
  effects={contact:[],deal:[],gmail:[],calendar:[],slack:[]};const scope='s'+randomUUID();
  let release!:()=>void,ready!:()=>void;const paused=new Promise<void>(resolve=>ready=resolve);
  const old=worker(scope,'old',(m,child)=>{
   if(m.phase==='before'&&m.request?.kind==='provider'&&m.request.path.endsWith('/contacts')){release=()=>child.send('continue');ready();return 'hold';}
   return false;
  });
  await paused;await new Promise(resolve=>setTimeout(resolve,1100));
  const replacement=await worker(scope,'new');expect(replacement.status).toBe('unknown');
  release();expect((await old).status).toBe('forbidden');
  expect(effects.contact).toHaveLength(0);expect(effects.deal).toHaveLength(0);
 },20000);
 it('a late already-issued request cannot cause a replacement to resend on empty readback',async()=>{
  effects={contact:[],deal:[],gmail:[],calendar:[],slack:[]};const scope='s'+randomUUID();
  let release!:()=>void,ready!:()=>void;const entered=new Promise<void>(resolve=>ready=resolve);
  blockWrite=async kind=>{if(kind==='contact'){ready();await new Promise<void>(resolve=>release=resolve);}};
  try{
   const old=worker(scope,'old');await entered;await new Promise(resolve=>setTimeout(resolve,1100));
   const replacement=await worker(scope,'new');expect(replacement.status).toBe('unknown');expect(effects.contact).toHaveLength(0);
   release();const oldResult=await old;expect(oldResult.reason).toContain('conflict');
   expect(effects.contact).toHaveLength(1);expect(effects.deal).toHaveLength(0);
   const row=await new DynamoStore(table,client).get('lead-pilot#'+scope+'#crash');expect(row?.owner).toBe('new');expect(row?.status).toBe('unknown');
  }finally{blockWrite=undefined;release?.();}
 },20000);
 for(const step of ['contact','deal','gmail','calendar','slack'])it('kills after committed '+step+' HTTP write, then restarts without a duplicate',async()=>{
  effects={contact:[],deal:[],gmail:[],calendar:[],slack:[]};const scope='s'+randomUUID();
  const killed=await worker(scope,'old',m=>write(m,step==='contact'||step==='deal'?'hubspot':step==='calendar'?'google-calendar':step) && (step!=='deal'||m.request.path.endsWith('/deals')) && (step!=='contact'||m.request.path.endsWith('/contacts')));
  expect(killed.killed).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,1100));
  const result=await worker(scope,'replacement');
  const store=new DynamoStore(table,client),row=await store.get('lead-pilot#'+scope+'#crash');
  expect(row?.owner).toBe('replacement');
  expect(Object.values(counts()).every(n=>n<=1)).toBe(true);
  expect(effects[step]).toHaveLength(1);
  if(['contact','deal','gmail','calendar','slack'].includes(step)){expect(result.status).toBe('confirmed');expect(counts()).toEqual({contact:1,deal:1,gmail:1,calendar:1,slack:1});}
  if(step==='calendar')expect((row?.operations as any).calendar).toMatchObject({status:'confirmed',id:effects.calendar![0].id,confirmation:'positive_readback'});
  if(step==='slack')expect(row?.notification).toMatchObject({status:'confirmed',ts:'slack-1',confirmation:'positive_readback'});
 },20000);
});
