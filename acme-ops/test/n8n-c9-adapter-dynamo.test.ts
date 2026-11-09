import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient,CreateTableCommand,DeleteTableCommand} from '@aws-sdk/client-dynamodb';
import {DynamoStore} from '../src/kit/store';
import {InvocationAuthority} from '../n8n-lead-pilot/identity';
// @ts-ignore Maintained session namespace function.
import {sessionScope} from '../n8n-lead-pilot/session-scope.mjs';
const endpoint=process.env.C9_DYNAMODB_ENDPOINT;
it.skipIf(!endpoint)('real adapter stores authenticated claims in DynamoDB and preserves them after SIGKILL',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'friendly-c9-adapter-')),file=join(dir,'adapter.mjs'),binding=join(dir,'binding.json'),trace=join(dir,'trace.jsonl');
 const table='friendly-c9-http-'+randomUUID();
 const client=new DynamoDBClient({endpoint,region:'us-west-2',credentials:{accessKeyId:'local',secretAccessKey:'local'}});
 let child:ChildProcessWithoutNullStreams|undefined;
 const kill=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const old=child;await new Promise<void>(resolve=>{old.once('exit',()=>resolve());old.kill('SIGKILL');});}child=undefined;};
 try{
  await client.send(new CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));
  await build({entryPoints:[new URL('../n8n-lead-pilot/adapter.ts',import.meta.url).pathname],outfile:file,bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
  const legs=Object.fromEntries(['hubspot','gmail','google-calendar','slack'].map(role=>[role,{sandbox_id:role+'-fixture',base_url:'https://fetchsandbox.com/sandbox/'+role+'-fixture',api_key:'fixture-only'}]));
  const cfg={legs,session_scope:sessionScope(legs),token:'fixture-runtime',n8n_token:'fixture-runtime',invocation_secret:'test-only-signing-key-32-bytes-long',requesters:[{subject:'owner',tenant:'team',token:'fixture-owner'},{subject:'other',tenant:'team',token:'fixture-other'}]};
  writeFileSync(binding,JSON.stringify(cfg),{mode:0o600});
  const start=async()=>{
   child=spawn(process.execPath,[file],{env:{PATH:process.env.PATH,PILOT_BINDINGS:binding,STATE_TABLE:table,DYNAMODB_ENDPOINT:endpoint,TRACE_FILE:trace,PORT:'0'}});
   const current=child;
   return await new Promise<number>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Adapter startup timeout')),10000);current.once('error',reject);current.once('exit',()=>{clearTimeout(timer);reject(Error('Adapter exited before readiness'));});current.stdout.on('data',data=>{output+=data;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]!).port);}});});
  };
  let port=await start();
  const request=async(path:string,token:string,body?:unknown)=>{const r=await fetch('http://127.0.0.1:'+port+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
  const context={lead_id:'durable',attempt:'old',retry_failed:false};const invocation=new InvocationAuthority(cfg.invocation_secret,cfg.session_scope).mint({subject:'owner',tenant:'team'},context);
  const accepted=await request('/io','fixture-runtime',{context:{...context,invocation},request:{kind:'claim'}});expect(accepted.body.result.claimed).toBe(true);
  const before=(await request('/proof/durable','fixture-owner')).body;
  expect((await new DynamoStore(table,client).get(before.records[0].pk))?.owner).toBe('old');
  await kill();port=await start();
  expect((await request('/proof/durable','fixture-owner')).body).toEqual(before);
  expect((await request('/proof/durable','fixture-other')).status).toBe(403);
  expect(existsSync(trace)).toBe(false);
 }finally{await kill();await client.send(new DeleteTableCommand({TableName:table}));client.destroy();rmSync(dir,{recursive:true,force:true});}
},20000);
