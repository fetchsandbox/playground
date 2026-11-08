import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const builderUrl=new URL('../n8n-lead-pilot/build-workflow.mjs',import.meta.url).href;
const moduleUrl=new URL('../verify/contracts/n8n-lead-recovery.mjs',import.meta.url).href;
function fixture(change:(w:any)=>void=()=>{},variant='normal'){
 const dir=mkdtempSync(join(tmpdir(),'n8n-contract-'));
 const workflow=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`const {buildWorkflow}=await import(${JSON.stringify(builderUrl)});console.log(JSON.stringify(buildWorkflow('https://adapter.example','friendly-pilot-mcp-20261106',{id:'fixture',name:'Fixture credential reference'},${JSON.stringify(variant)})));`],{encoding:'utf8'}));
 workflow.active=true;change(workflow);
 const path=join(dir,'workflow.json');writeFileSync(path,JSON.stringify(workflow));
 const source=join(dir,'bindings.json');writeFileSync(source,JSON.stringify({token:'fixture-only',n8n_token:'fixture-only',n8n_webhook:'https://fetchsandbox.app.n8n.cloud/webhook/friendly-pilot-mcp-20261106'}),{mode:0o600});
 return {dir,path,source};
}
function load(f:ReturnType<typeof fixture>,code='console.log(JSON.stringify({checks:c.checks.map(x=>({id:x.id,executable:!!x.actions})),dimensions:c.applicationConfig.coverage_review.length,version:c.appVersion}));',variant='normal'){
 return spawnSync(process.execPath,['--input-type=module','-e',`const c=(await import(${JSON.stringify(moduleUrl)})).default;${code}`],{env:{PATH:process.env.PATH,N8N_WORKFLOW_EXPORT:f.path,PILOT_BINDINGS_SOURCE:f.source,PILOT_VARIANT:variant},encoding:'utf8'});
}
describe('existing MCP runner n8n contract boundary (fixture exports only)',()=>{
 it('retains original requirements, C3 recovery subcheck and reviewed default dimensions',()=>{
  const f=fixture();try{const result=load(f);expect(result.status).toBe(0);const out=JSON.parse(result.stdout);expect(out.dimensions).toBe(17);expect(out.checks).toHaveLength(14);expect(out.checks.filter((x:any)=>x.executable).map((x:any)=>x.id)).toEqual(['baseline','C1','C2','C3','C3_recovery','C4','C5','C7','C8','C10']);expect(out.version).toMatch(/^n8n-export-[0-9a-f]{64}$/);}finally{rmSync(f.dir,{recursive:true,force:true});}
 });
 it.each(['unpublished','pinned','inline-header','no-native-auth','changed-decision'])('refuses %s before starting the runtime',kind=>{
  const f=fixture(w=>{
   if(kind==='unpublished')w.active=false;
   if(kind==='changed-decision')w.nodes.find((n:any)=>n.name==='Durable decision machine').parameters.jsCode='return [{json:{status:"confirmed"}}];';
   if(kind==='pinned')w.pinData={'Lead webhook':[{}]};
   if(kind==='inline-header')w.nodes.find((n:any)=>n.name==='State or isolated twin I/O').parameters.headerParameters={parameters:[{name:'Authorization',value:'fixture-only'}]};
   if(kind==='no-native-auth')w.nodes[0].parameters.authentication='none';
  });try{expect(load(f).status).not.toBe(0);}finally{rmSync(f.dir,{recursive:true,force:true});}
 });
 it('writes attempt bindings privately for the existing runtime lifecycle',()=>{
  const f=fixture();try{
   const result=load(f,`const env=await c.runtimeEnv({outDir:${JSON.stringify(f.dir)},legs:{hubspot:{base_url:'https://fetchsandbox.com/sandbox/fixture',api_key:'fixture-key-only'}}});console.log(JSON.stringify({file:env.PILOT_BINDINGS}));`);
   expect(result.status).toBe(0);const file=JSON.parse(result.stdout).file;expect(statSync(file).mode&0o777).toBe(0o600);expect(JSON.parse(readFileSync(file,'utf8')).legs.hubspot.api_key).toBe('fixture-key-only');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
 });
});

it.each(['blind-deal-retry','blind-gmail-resend'])('requires explicit matching source attestation for %s',variant=>{
 const f=fixture(()=>{},variant);try{
  expect(load(f).status).not.toBe(0);
  const accepted=load(f,'console.log(c.sourceVariant);',variant);
  expect(accepted.status).toBe(0);expect(accepted.stdout.trim()).toBe(variant);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

it('C7 reaches both public entry points with identical invalid payloads and zero-effect checks',()=>{
 const contract=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const c=contract.checks.find((x:any)=>x.id==='C7');
 expect(c.actions).toHaveLength(10);
 expect(c.actions.slice(0,5).map((x:any)=>x.body)).toEqual(c.actions.slice(5).map((x:any)=>x.body));
 expect(c.actions.every((x:any)=>x.expect_status===400)).toBe(true);
 expect(c.actions.slice(0,5).every((x:any)=>x.path==='/invoke')).toBe(true);
 expect(c.actions.slice(5).every((x:any)=>x.path==='/native-invoke')).toBe(true);
 expect(c.provider_assertions).toHaveLength(5);
 expect(c.provider_assertions.every((x:any)=>x.assertion.count===0 && x.assertion.required)).toBe(true);
});

it('C10 exercises the real denied routes and records harmless canaries without introducing a verifier bypass',()=>{
 const contract=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const c=contract.checks.find((x:any)=>x.id==='C10');
 expect(c.blocker).toBeUndefined();expect(c.actions).toHaveLength(8);
 expect(c.actions.slice(0,7).every((x:any)=>x.path==='/io' && x.expect_status===400)).toBe(true);
 expect(c.actions[7]).toMatchObject({path:'/not-an-allowed-route',expect_status:404});
 expect(c.actions[0].body).toMatchObject({authorization:'c10-dummy-auth-{{run_id}}',c10_marker:'c10-public-marker-{{run_id}}'});
 expect(c.before.assertion.count).toBe(0);expect(c.assertion.count).toBe(0);
 expect(c.provider_assertions).toHaveLength(5);expect(c.provider_assertions.every((x:any)=>x.assertion.count===0)).toBe(true);
});
