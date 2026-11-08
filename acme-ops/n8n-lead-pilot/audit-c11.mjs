/** Inspect two real retained MCP runs plus separately recorded lifecycle probes.
 * Does not run a workflow or replace the FetchSandbox behavioral evaluator. */
import {isDeepStrictEqual} from 'node:util';
import {sessionScope} from './session-scope.mjs';
const lead='friendly-session-isolation';
export function auditC11(a,b,stateA,stateB,probe,cleanup){
 const scopeA=sessionScope(a.session.legs),scopeB=sessionScope(b.session.legs);
 if(!scopeA || !scopeB || scopeA===scopeB || a.session.session_id===b.session.session_id)throw Error('Distinct real session bindings required');
 const idsA=Object.values(a.session.legs).map(x=>x.sandbox_id),idsB=Object.values(b.session.legs).map(x=>x.sandbox_id);
 if(idsA.some(id=>idsB.includes(id)))throw Error('Provider sandbox identity reused');
 for(const run of [a,b]){
  const result=run.snapshot.workflow_result.receipt_verification;
  if(result.run_id!==run.summary.run_id || result.checks.find(x=>x.id==='C11')?.status!=='held')throw Error('C11 receipt result missing');
  const trace=result.evidence.trace.filter(x=>x.check_id==='C11');
  const first=trace.find(x=>x.kind==='app_request' && x.method==='GET' && x.path==='/proof/'+lead);
  if(first?.status!==200 || first.response?.records?.length!==0)throw Error('Fresh-session initial state not empty');
  const effects=trace.filter(x=>x.kind==='provider_state');
  if(effects.length!==5 || !effects.every(x=>x.assertion_held===true))throw Error('Independent C11 provider effects not qualified');
 }
 if(!isDeepStrictEqual(a.snapshot.workflow_result.receipt_verification.manifest.checks,b.snapshot.workflow_result.receipt_verification.manifest.checks))throw Error('Check definitions changed');
 const pkA=`lead-pilot#${scopeA}#${lead}`,pkB=`lead-pilot#${scopeB}#${lead}`;
 const first=stateA.find(x=>x.pk===pkA),retained=stateB.find(x=>x.pk===pkA),second=stateB.find(x=>x.pk===pkB);
 if(first?.status!=='confirmed' || second?.status!=='confirmed' || !isDeepStrictEqual(first,retained))throw Error('Reused physical store does not retain isolated state');
 if(!stateA.every(old=>stateB.some(current=>isDeepStrictEqual(old,current))))throw Error('Prior state was overwritten or reset');
 if(probe.session_scope!==scopeB || probe.current_verifier_status!==200 || probe.retired_verifier_statuses.length!==3 || !probe.retired_verifier_statuses.every(s=>s===401) || probe.state_sha_before!==probe.state_sha_after)throw Error('Verifier credential boundary not qualified');
 if(probe.provider_credentials.length!==4 || new Set(probe.provider_credentials.map(x=>x.provider)).size!==4 || !probe.provider_credentials.every(x=>x.current_authorized===true && x.retired_authorized===false && x.keys_differ===true))throw Error('Provider credential separation not qualified');
 if(cleanup.sessions.length!==2 || !cleanup.sessions.every(s=>Object.values(s.sandbox_delete_statuses).length===4 && Object.values(s.sandbox_delete_statuses).every(v=>v===200) && s.snapshot_after_cleanup_status===200 && s.temporary_bindings_absent===true))throw Error('Session cleanup/receipt retention not qualified');
 if(!cleanup.original_handoffs_absent || !cleanup.replay_handoffs_absent || !cleanup.shared_state_removed || !cleanup.app_port_closed || !cleanup.ngrok_port_closed)throw Error('Local temporary artifacts still active');
 return {sessions:2,same_business_lead:true,same_physical_store_reused:true,prior_scope_records_retained_unchanged:true,distinct_provider_sandboxes:8,retired_verifier_requests_denied:3,provider_credential_pairs_denied:4,retained_receipts:2,cleanup_passed:true,scope:'Single adapter/FileStore, independent sandbox sessions. Shared app credential revocation, per-requester identity, stale callback/owner fencing and multi-worker crash recovery are not established.'};
}
