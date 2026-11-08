/** App-owned contract for the existing proof runner, not a second verifier. */
import {readFileSync,writeFileSync,copyFileSync,chmodSync,constants} from 'node:fs';
import {sessionScope} from '../../n8n-lead-pilot/session-scope.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {buildWorkflow} from '../../n8n-lead-pilot/build-workflow.mjs';
const contractName=process.env.PILOT_CONTRACT??'default';
if(!['default','identity'].includes(contractName))throw Error('Unreviewed pilot contract refused');
const config=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
if(contractName==='identity'){
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.identity.json',import.meta.url),'utf8'));
 if(Object.keys(overlay).some(key=>!['requester_profiles','checks'].includes(key)) || overlay.checks?.length!==1 || overlay.checks[0].id!=='C6')throw Error('Identity overlay may replace only C6');
 config.requester_profiles=overlay.requester_profiles;
 config.checks=config.checks.map(check=>check.id==='C6'?overlay.checks[0]:check);
}
const exportPath=process.env.N8N_WORKFLOW_EXPORT;
const sourcePath=process.env.PILOT_BINDINGS_SOURCE;
if(!exportPath || !sourcePath)throw Error('N8N_WORKFLOW_EXPORT and PILOT_BINDINGS_SOURCE must name private files');
const bytes=readFileSync(exportPath);
const workflow=JSON.parse(bytes);
if(workflow.name!=='Friendly lead recovery — MCP repeatable verification')throw Error('Unexpected native workflow export');
const trigger=workflow.nodes?.find(n=>n.type==='n8n-nodes-base.webhook');
if(trigger?.parameters.authentication!=='headerAuth' || trigger?.parameters.path!=='friendly-pilot-mcp-20261106' || !trigger.credentials?.httpHeaderAuth)throw Error('Native webhook Header Auth credential and fixed persistent route required');
const io=workflow.nodes?.find(n=>n.name==='State or isolated twin I/O');
if(io?.parameters.authentication!=='genericCredentialType' || io?.parameters.genericAuthType!=='httpHeaderAuth' || io?.credentials?.httpHeaderAuth?.id!==trigger.credentials.httpHeaderAuth.id || io?.parameters.headerParameters)throw Error('Native credential references required on both pilot boundaries; inline bearer headers refused');
if(workflow.active!==true)throw Error('Persistent workflow must be published before the end-to-end proof');
if(Object.keys(workflow.pinData??{}).length || workflow.nodes.some(n=>n.disabled))throw Error('Pinned/disabled nodes cannot establish this workflow contract');
const variant=process.env.PILOT_VARIANT??'normal';
const expected=buildWorkflow(new URL(io.parameters.url).origin,'friendly-pilot-mcp-20261106',trigger.credentials.httpHeaderAuth,variant);
const normalize=params=>{
 const result={...params};
 if(typeof result.jsCode==='string')result.jsCode=result.jsCode.replace(/\s*return \[\{json:advance\(\$json\)\}\];\s*$/, '\nreturn [{json:advance($json)}];');
 return result;
};
for(const expectedNode of expected.nodes){
 const nodes=workflow.nodes.filter(n=>n.name===expectedNode.name);
 if(nodes.length!==1 || nodes[0].type!==expectedNode.type || nodes[0].typeVersion!==expectedNode.typeVersion || !isDeepStrictEqual(normalize(nodes[0].parameters),normalize(expectedNode.parameters)))throw Error('Saved workflow differs from the app-owned contract source: '+expectedNode.name);
}
if(workflow.nodes.length!==expected.nodes.length || !isDeepStrictEqual(workflow.connections,expected.connections))throw Error('Saved workflow wiring differs from the app-owned contract source');
const sha=createHash('sha256').update(bytes).digest('hex');
const identity={invocation_secret:randomBytes(32).toString('hex'),requesters:['pilot-owner','pilot-other'].map(subject=>({subject,tenant:'pilot-team',token:randomBytes(32).toString('hex')}))};
export default {
 workflow:'n8n-lead-recovery', providers:['hubspot','gmail','google-calendar','slack'],
 appVersion:'n8n-export-'+sha,
 sourceVariant:variant,
 context:{goal:'Verify the actual n8n lead workflow: exact Contact and associated Deal, confirmed email before Calendar, accurate Slack outcome, no duplicate effects on replay; review applicable default production risks and keep unqualified risks visible.',workflow:'Persistent native Header Auth webhook; Code decision machine and HTTP Request I/O; versioned source '+variant+'; exported workflow SHA256 '+sha,entry_points:['POST /invoke','POST /native-invoke (fixed protected transport to the same native webhook; no local business validation)'],state_store:'Single-process FileStore conditional claims/CAS, read through GET /proof/{lead}; abandoned claims and multi-worker crash recovery remain unqualified.'},
 checks:config.checks,
 applicationConfig:{coverage_review:config.coverage_review,scope_review:config.scope_review,...(config.requester_profiles?{requester_profiles:config.requester_profiles}:{})},
 startupPingHeaders(){const source=JSON.parse(readFileSync(sourcePath,'utf8'));return {authorization:'Bearer '+source.token};},
 async runtimeEnv({legs,outDir,credentialFile}){
  const source=JSON.parse(readFileSync(sourcePath,'utf8'));
  if(source.n8n_webhook!=='https://fetchsandbox.app.n8n.cloud/webhook/friendly-pilot-mcp-20261106' || !source.n8n_token || !source.token)throw Error('Private native trigger and adapter bindings required');
  const file=join(outDir,'n8n-bindings-private.json');
  const scope=sessionScope(legs);
  if(credentialFile && process.env.PILOT_REPLAY_HANDOFF){copyFileSync(credentialFile,process.env.PILOT_REPLAY_HANDOFF,constants.COPYFILE_EXCL);chmodSync(process.env.PILOT_REPLAY_HANDOFF,0o600);}
  writeFileSync(file,JSON.stringify({...identity,session_scope:scope,token:source.token,n8n_token:source.n8n_token,n8n_webhook:source.n8n_webhook,legs:legs??{}}),{mode:0o600});
  return {PILOT_BINDINGS:file,TRACE_FILE:join(outDir,'n8n-twin-trace-private.jsonl'),...(process.env.PILOT_STATE_FILE?{STATE_FILE:process.env.PILOT_STATE_FILE}:{})};
 },
};
