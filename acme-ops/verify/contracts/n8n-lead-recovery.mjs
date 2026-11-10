/** App-owned contract for the existing proof runner, not a second verifier. */
import {readFileSync,writeFileSync,copyFileSync,chmodSync,constants} from 'node:fs';
import {sessionScope} from '../../n8n-lead-pilot/session-scope.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {buildWorkflow} from '../../n8n-lead-pilot/build-workflow.mjs';
const contractName=process.env.PILOT_CONTRACT??'default';
const adapterVariant=process.env.PILOT_ADAPTER_VARIANT??'normal';
if(!['normal','allow-stale-dispatch'].includes(adapterVariant))throw Error('Unregistered adapter source control');
if(!['default','identity','crash','takeover','late-dispatch','stale-io','c9-candidate'].includes(contractName))throw Error('Unreviewed pilot contract refused');
const config=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
if(['identity','crash','takeover','late-dispatch','stale-io','c9-candidate'].includes(contractName)){
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.identity.json',import.meta.url),'utf8'));
 if(Object.keys(overlay).some(key=>!['requester_profiles','checks'].includes(key)) || overlay.checks?.length!==1 || overlay.checks[0].id!=='C6')throw Error('Identity overlay may replace only C6');
 config.requester_profiles=overlay.requester_profiles;
 config.checks=config.checks.map(check=>check.id==='C6'?overlay.checks[0]:check);
}
if(['crash','takeover','late-dispatch','stale-io','c9-candidate'].includes(contractName)){
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.crash.json',import.meta.url),'utf8'));
 if(overlay.checks?.length!==3 || overlay.checks.map(c=>c.id).join(',')!=='C9_deal_crash,C9_calendar_crash,C9_slack_crash')throw Error('Crash overlay must add only the three bounded accepted-write crashes');
 config.checks.splice(config.checks.findIndex(c=>c.id==='C9'),0,...overlay.checks);
 config.scope_review.push(...overlay.checks.map(c=>({check_id:c.id,classification:'in_scope',reason:'Bounded accepted-write adapter process crash; original C9 matrix stays blocked.',evidence:['n8n-lead-pilot/C9-CRASH-RECOVERY.md']})));
 const restart=config.coverage_review.find(x=>x.dimension==='restart_and_durability');
 restart.rule_ids.push(...overlay.checks.map(c=>c.id));
}
if(['takeover','late-dispatch','stale-io','c9-candidate'].includes(contractName)){
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.takeover.json',import.meta.url),'utf8'));
 if(overlay.checks?.length!==1 || overlay.checks[0].id!=='C9_competing_takeover')throw Error('Takeover overlay must add only its bounded native concurrency check');
 config.checks.splice(config.checks.findIndex(c=>c.id==='C9'),0,...overlay.checks);
 config.scope_review.push({check_id:'C9_competing_takeover',classification:'in_scope',reason:'Two concurrent native recovery executions following witnessed accepted Deal and adapter SIGKILL; does not establish stale-owner or late-request schedules.',evidence:['n8n-lead-pilot/C9-CRASH-RECOVERY.md']});
 config.coverage_review.find(x=>x.dimension==='restart_and_durability').rule_ids.push('C9_competing_takeover');
}
if(['late-dispatch','stale-io','c9-candidate'].includes(contractName)){
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.late-dispatch.json',import.meta.url),'utf8'));
 if(overlay.checks?.length!==1 || overlay.checks[0].id!=='C9_late_dispatch')throw Error('Late-dispatch overlay may add only its bounded schedule');
 config.checks.splice(config.checks.findIndex(c=>c.id==='C9'),0,...overlay.checks);
 config.scope_review.push({check_id:'C9_late_dispatch',classification:'in_scope',reason:'A real HTTP request enters a separate proof provider queue before adapter SIGKILL; queue forwards to the real twin only after replacement holds unknown. Does not prove vendor queue implementation or native-worker-host suspension.',evidence:['n8n-lead-pilot/C9-CRASH-RECOVERY.md']});
 config.coverage_review.find(x=>x.dimension==='restart_and_durability').rule_ids.push('C9_late_dispatch');
}
if(['stale-io','c9-candidate'].includes(contractName)){
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.stale-io.json',import.meta.url),'utf8'));
 if(overlay.checks?.length!==1||overlay.checks[0].id!=='C9_stale_native_io')throw Error('Stale I/O overlay may add only its native command schedule');
 config.checks.splice(config.checks.findIndex(c=>c.id==='C9'),0,...overlay.checks);
 config.scope_review.push({check_id:'C9_stale_native_io',classification:'in_scope',reason:'A real native provider I/O command is delayed before the ownership fence; after takeover, the unchanged adapter must deny it despite an unexpired valid invocation. Not native SaaS host suspension.',evidence:['n8n-lead-pilot/C9-CRASH-RECOVERY.md']});
 config.coverage_review.find(x=>x.dimension==='restart_and_durability').rule_ids.push('C9_stale_native_io');
}
if(contractName==='c9-candidate'){
 if(!process.env.PILOT_STATE_TABLE)throw Error('C9 candidate requires shared conditional DynamoDB storage');
 const overlay=JSON.parse(readFileSync(new URL('../../n8n-lead-pilot/contract.c9-candidate.json',import.meta.url),'utf8'));
 if(overlay.checks?.length!==2||overlay.checks.map(c=>c.id).join(',')!=='C9_contact_crash,C9')throw Error('C9 candidate must add Contact and replace only the original C9 blocker with its executable Gmail/concurrent-recovery contract');
 const index=config.checks.findIndex(c=>c.id==='C9');config.checks.splice(index,1,...overlay.checks);
 config.scope_review.push({check_id:'C9_contact_crash',classification:'in_scope',reason:'Actual Contact acceptance then owned-adapter SIGKILL before checkpoint; positive exact read-back. Separate from provider-timeout proof.',evidence:['n8n-lead-pilot/C9-CRASH-RECOVERY.md']});
 config.coverage_review.find(x=>x.dimension==='restart_and_durability').rule_ids.push('C9_contact_crash');
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
 sourceVariant:variant,adapterVariant,
 context:{goal:'Verify the actual n8n lead workflow: exact Contact and associated Deal, confirmed email before Calendar, accurate Slack outcome, no duplicate effects on replay; review applicable default production risks and keep unqualified risks visible.',workflow:(adapterVariant==='normal'?'':'Ephemeral negative adapter source control '+adapterVariant+'. ')+'Persistent native Header Auth webhook; Code decision machine and HTTP Request I/O; versioned source '+variant+'; exported workflow SHA256 '+sha,entry_points:['POST /invoke','POST /native-invoke (fixed protected transport to the same native webhook; no local business validation)'],state_store:process.env.PILOT_STATE_TABLE?'Shared DynamoDB conditional claims/CAS and leases; native crash recovery remains unqualified.':'Single-process FileStore conditional claims/CAS; not independent-worker storage. Native crash recovery remains unqualified.'},
 checks:config.checks,
 applicationConfig:{coverage_review:config.coverage_review,scope_review:config.scope_review,...(config.requester_profiles?{requester_profiles:config.requester_profiles}:{})},
 crashSimulationCount:contractName==='c9-candidate'?6:['takeover','late-dispatch','stale-io'].includes(contractName)?4:contractName==='crash'?3:0,
 crashSimulation:['crash','takeover','late-dispatch','stale-io','c9-candidate'].includes(contractName)?({legs,flowRunId,faultIndex=0})=>{
   const targets=[{id:'deal',provider:'hubspot',path:'/crm/v3/objects/deals',body_path:['properties','dealname'],body_equals:'Pilot fs-c9-'+flowRunId,response_identity:'id'},
    {id:'calendar',provider:'google-calendar',path:'/calendars/primary/events',body_path:['summary'],body_equals:'Pilot fs-c9-calendar-'+flowRunId,response_identity:'id'},
    {id:'slack',provider:'slack',path:'/chat.postMessage',body_path:['text'],body_equals:JSON.stringify({lead_id:'fs-c9-slack-'+flowRunId,status:'confirmed',blocked_step:null}),response_identity:'ts'}];
   if(['takeover','late-dispatch','stale-io','c9-candidate'].includes(contractName))targets.push({id:'takeover',provider:'hubspot',path:'/crm/v3/objects/deals',body_path:['properties','dealname'],body_equals:'Pilot fs-c9-takeover-'+flowRunId,response_identity:'id'});
   if(contractName==='c9-candidate'){const lead='fs-c9-gmail-'+flowRunId;targets.push({id:'contact',provider:'hubspot',path:'/crm/v3/objects/contacts',body_path:['properties','email'],body_equals:'fs-c9-contact-'+flowRunId+'@example.com',response_identity:'id'},{id:'gmail',provider:'gmail',path:'/gmail/v1/users/me/messages/send',body_path:['raw'],body_equals:Buffer.from('From: FetchSandbox Pilot <pilot@example.com>\r\nTo: '+lead+'@example.com\r\nSubject: Pilot '+lead+'\r\nMessage-ID: <'+lead+'@example.com>\r\n\r\nDummy-data lead follow-up').toString('base64url'),response_identity:'id'});}
   const t=targets[faultIndex];return t?{...t,nonce:randomBytes(24).toString('hex'),url:legs[t.provider].base_url.replace(/\/$/,'')+t.path,method:'POST'}:null;
 }:undefined,
 async witnessCrash({legs,flowRunId,effectId,port,env,plan}){
   const kind=plan.id,lead='fs-c9-'+(kind==='deal'?'':kind+'-')+flowRunId;
   const response=await fetch('https://fetchsandbox.com/api/sandboxes/'+encodeURIComponent(legs[plan.provider].sandbox_id)+'/state',{headers:{authorization:'Bearer '+process.env.FETCHSANDBOX_API_KEY}});
   if(!response.ok)throw Error('Independent provider state read failed');
   const data=await response.json();
   const matches=['deal','takeover'].includes(kind)?(data.deals??[]).filter(x=>x.id===effectId&&x.properties?.dealname==='Pilot '+lead)
    :kind==='contact'?(data.contacts??[]).filter(x=>x.id===effectId&&x.properties?.email===lead+'@example.com')
    :kind==='gmail'?(data.messages??[]).filter(x=>x.id===effectId&&x.labelIds?.includes('SENT')&&x.payload?.headers?.some(h=>h.name==='To'&&h.value===lead+'@example.com')&&x.payload?.headers?.some(h=>h.name==='Message-ID'&&h.value==='<'+lead+'@example.com>'))
    :kind==='calendar'?(data.events??[]).filter(x=>x.id===effectId&&x.summary==='Pilot '+lead)
    :(data.messages??[]).filter(x=>x.ts===effectId&&x.channel==='C_PILOT'&&x.text===plan.body_equals);
   const binding=JSON.parse(readFileSync(env.PILOT_BINDINGS,'utf8'));
   const saved=await fetch('http://127.0.0.1:'+port+'/proof/'+lead,{headers:{authorization:'Bearer '+binding.requesters[0].token}});
   if(!saved.ok)throw Error('Saved checkpoint read failed');
   const rows=(await saved.json()).records;const state=rows?.length===1?rows[0]:null;
   const op=kind==='slack'?state?.notification:state?.operations?.[kind==='takeover'?'deal':kind];
   const pending=op?.status==='in_flight' && !(kind==='slack'?op.ts:op.id) && (kind!=='calendar'||op.requested_id===effectId);
   return {provider_accepted:matches.length===1,checkpoint_pending:!!pending,step:kind,lead_id:lead,owner_before:state?.owner,version_before:state?.version,epoch_before:state?.epoch,provider_matching_records:matches.length};
 },
 staleIo:['stale-io','c9-candidate'].includes(contractName),
 async staleIoWitnesses({legs,flowRunId,port,env}){
  const lead='fs-c9-stale-'+flowRunId,binding=JSON.parse(readFileSync(env.PILOT_BINDINGS,'utf8'));
  const {tsImport}=await import('tsx/esm/api');
  const {InvocationAuthority}=await tsImport('../../n8n-lead-pilot/identity.ts',import.meta.url);
  const authority=new InvocationAuthority(binding.invocation_secret,sessionScope(binding.legs));
  const inspect=async()=>{
   const [saved,twin]=await Promise.all([fetch('http://127.0.0.1:'+port+'/proof/'+lead,{headers:{authorization:'Bearer '+binding.requesters[0].token},signal:AbortSignal.timeout(5000)}),fetch('https://fetchsandbox.com/api/sandboxes/'+encodeURIComponent(legs.hubspot.sandbox_id)+'/state',{headers:{authorization:'Bearer '+process.env.FETCHSANDBOX_API_KEY},signal:AbortSignal.timeout(5000)})]);
   if(!saved.ok||!twin.ok)throw Error('Stale I/O witness read failed');
   const rows=(await saved.json()).records;return {state:rows?.length===1?rows[0]:null,contacts:((await twin.json()).contacts??[]).filter(x=>x.properties?.email===lead+'@example.com')};
  };
  return {
   witnessPending:async()=>{const {state,contacts}=await inspect();return {checkpoint_pending:state?.status==='in_progress'&&state?.operations?.contact?.status==='in_flight',provider_matching_records:contacts.length,owner_before:state?.owner,epoch_before:state?.epoch};},
   awaitReplacement:async before=>{const end=Date.now()+70000;while(Date.now()<end){const {state,contacts}=await inspect();if(state?.owner!==before.owner_before&&state?.epoch===2&&state?.status==='unknown'&&state?.operations?.contact?.status==='unknown'&&contacts.length===0)return {replacement_held_unknown:true,owner_after:state.owner,epoch_after:state.epoch};await new Promise(r=>setTimeout(r,1000));}throw Error('No independent replacement before stale dispatch');},
   verifyInvocation:ticket=>{const principal=authority.verify(ticket,{lead_id:lead,retry_failed:false});return principal?.subject==='pilot-owner'&&principal?.tenant==='pilot-team';},
   witnessDenied:async after=>{const {state,contacts}=await inspect();return {replacement_preserved:state?.owner===after.owner_after&&state?.epoch===after.epoch_after&&state?.status==='unknown'&&state?.operations?.contact?.status==='unknown',provider_matching_records:contacts.length};},
  };
 },
 scheduleSimulationCount:['late-dispatch','stale-io','c9-candidate'].includes(contractName)?1:0,
 scheduleSimulation:['late-dispatch','stale-io','c9-candidate'].includes(contractName)?({legs,flowRunId,crashCount})=>crashCount===4?{id:'late-contact',url:legs.hubspot.base_url.replace(/\/$/,'')+'/crm/v3/objects/contacts',method:'POST',body_path:['properties','email'],body_equals:'fs-c9-late-'+flowRunId+'@example.com',nonce:randomBytes(24).toString('hex')}:null:undefined,
 scheduleWitnesses({legs,flowRunId,port,env}){
  const lead='fs-c9-late-'+flowRunId;
  const binding=JSON.parse(readFileSync(env.PILOT_BINDINGS,'utf8'));
  const inspect=async()=>{
   const [saved,twin]=await Promise.all([
    fetch('http://127.0.0.1:'+port+'/proof/'+lead,{headers:{authorization:'Bearer '+binding.requesters[0].token},signal:AbortSignal.timeout(5000)}),
    fetch('https://fetchsandbox.com/api/sandboxes/'+encodeURIComponent(legs.hubspot.sandbox_id)+'/state',{headers:{authorization:'Bearer '+process.env.FETCHSANDBOX_API_KEY},signal:AbortSignal.timeout(5000)})]);
   if(!saved.ok||!twin.ok)throw Error('Independent late-dispatch read failed');
   const rows=(await saved.json()).records,state=rows?.length===1?rows[0]:null;
   const contacts=((await twin.json()).contacts??[]).filter(x=>x.properties?.email===lead+'@example.com');
   return {state,contacts};
  };
  return {
   witnessPending:async()=>{const {state,contacts}=await inspect();return {checkpoint_pending:state?.status==='in_progress'&&state?.operations?.contact?.status==='in_flight'&&!state.operations.contact.id,provider_matching_records:contacts.length,owner_before:state?.owner,epoch_before:state?.epoch};},
   awaitReplacement:async before=>{
    const deadline=Date.now()+70000;
    while(Date.now()<deadline){const {state,contacts}=await inspect();if(state?.owner!==before.owner_before&&state?.epoch===2&&state?.status==='unknown'&&state?.operations?.contact?.status==='unknown'&&contacts.length===0)return {replacement_held_unknown:true,owner_after:state.owner,epoch_after:state.epoch,provider_matching_records_before_release:contacts.length};await new Promise(r=>setTimeout(r,1000));}
    throw Error('Replacement did not independently hold unknown before dispatch');
   },
   witnessAccepted:async(effectId,replacement)=>{const {state,contacts}=await inspect();return {provider_accepted:contacts.length===1&&contacts[0].id===effectId,replacement_preserved:state?.owner===replacement.owner_after&&state?.epoch===replacement.epoch_after&&state?.status==='unknown'&&state?.operations?.contact?.status==='unknown',late_contact_count:contacts.length};},
  };
 },
 startupPingHeaders(){const source=JSON.parse(readFileSync(sourcePath,'utf8'));return {authorization:'Bearer '+source.token};},
 async runtimeEnv({legs,outDir,credentialFile}){
  const source=JSON.parse(readFileSync(sourcePath,'utf8'));
  if(source.n8n_webhook!=='https://fetchsandbox.app.n8n.cloud/webhook/friendly-pilot-mcp-20261106' || !source.n8n_token || !source.token)throw Error('Private native trigger and adapter bindings required');
  const file=join(outDir,'n8n-bindings-private.json');
  const scope=sessionScope(legs);
  if(credentialFile && process.env.PILOT_REPLAY_HANDOFF){copyFileSync(credentialFile,process.env.PILOT_REPLAY_HANDOFF,constants.COPYFILE_EXCL);chmodSync(process.env.PILOT_REPLAY_HANDOFF,0o600);}
  writeFileSync(file,JSON.stringify({...identity,session_scope:scope,token:source.token,n8n_token:source.n8n_token,n8n_webhook:source.n8n_webhook,legs:legs??{}}),{mode:0o600});
  return {PILOT_BINDINGS:file,TRACE_FILE:join(outDir,'n8n-twin-trace-private.jsonl'),...(process.env.PILOT_STATE_FILE?{STATE_FILE:process.env.PILOT_STATE_FILE}:{}),...(process.env.PILOT_STATE_TABLE?{STATE_TABLE:process.env.PILOT_STATE_TABLE}:{}),...(process.env.PILOT_DYNAMODB_ENDPOINT?{DYNAMODB_ENDPOINT:process.env.PILOT_DYNAMODB_ENDPOINT}:{})};
 },
};
