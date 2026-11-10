import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const helper=new URL('../n8n-lead-pilot/build-adapter.mjs',import.meta.url);
test('registered negative adapter has a distinct bundle and truthful provenance; source stays unchanged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adapter-control-')),source=new URL('../n8n-lead-pilot/adapter.ts',import.meta.url),before=readFileSync(source);
 try{
  const normal=join(dir,'normal.mjs'),negative=join(dir,'negative.mjs');
  for(const [variant,path]of [['normal',normal],['allow-stale-dispatch',negative]]){const built=spawnSync(process.execPath,[helper.pathname,path],{env:{...process.env,PILOT_ADAPTER_VARIANT:variant},encoding:'utf8'});assert.equal(built.status,0,built.stderr);const manifest=JSON.parse(readFileSync(path+'.build.json'));assert.equal(manifest.adapter_variant,variant);assert.equal(manifest.bundle_sha256,createHash('sha256').update(readFileSync(path)).digest('hex'));}
  assert.notDeepEqual(readFileSync(normal),readFileSync(negative));assert.deepEqual(readFileSync(source),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unregistered source control cannot create a bundle',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adapter-control-'));try{const path=join(dir,'refused.mjs');const out=spawnSync(process.execPath,[helper.pathname,path],{env:{...process.env,PILOT_ADAPTER_VARIANT:'unknown'},encoding:'utf8'});assert.notEqual(out.status,0);assert.equal(existsSync(path),false);}finally{rmSync(dir,{recursive:true,force:true});}
});
