import {describe,it,expect} from 'vitest';
// @ts-ignore Node-readable lifecycle evidence audit.
import {auditC11} from '../n8n-lead-pilot/audit-c11.mjs';
// @ts-ignore Shared session binding hash.
import {sessionScope} from '../n8n-lead-pilot/session-scope.mjs';
function fixture(){
 const roles=['hubspot','gmail','google-calendar','slack'];
 const run=(id:string)=>({session:{session_id:'vs-'+id,legs:Object.fromEntries(roles.map(role=>[role,{sandbox_id:role+'-'+id,base_url:'https://fetchsandbox.com/sandbox/'+role+'-'+id}]))},summary:{run_id:'vr-'+id},snapshot:{workflow_result:{receipt_verification:{run_id:'vr-'+id,checks:[{id:'C11',status:'held'}],manifest:{checks:[{id:'C11'}]},evidence:{trace:[{kind:'app_request',check_id:'C11',method:'GET',path:'/proof/friendly-session-isolation',status:200,response:{records:[]}},...Array.from({length:5},()=>({kind:'provider_state',check_id:'C11',assertion_held:true}))]}}}}});
 const a=run('a'),b=run('b');const scopeA=sessionScope(a.session.legs),scopeB=sessionScope(b.session.legs);
 const stateA=[{pk:`lead-pilot#${scopeA}#friendly-session-isolation`,status:'confirmed',version:2}];
 const stateB=[...structuredClone(stateA),{pk:`lead-pilot#${scopeB}#friendly-session-isolation`,status:'confirmed',version:2}];
 const probe={session_scope:scopeB,current_verifier_status:200,retired_verifier_statuses:[401,401,401],state_sha_before:'same',state_sha_after:'same',provider_credentials:roles.map(provider=>({provider,current_authorized:true,retired_authorized:false,keys_differ:true}))};
 const cleanup={sessions:Array.from({length:2},()=>({sandbox_delete_statuses:Object.fromEntries(roles.map(role=>[role,200])),snapshot_after_cleanup_status:200,temporary_bindings_absent:true})),original_handoffs_absent:true,replay_handoffs_absent:true,shared_state_removed:true,app_port_closed:true,ngrok_port_closed:true};
 return {a,b,stateA,stateB,probe,cleanup};
}
function audit(f:ReturnType<typeof fixture>){return auditC11(f.a,f.b,f.stateA,f.stateB,f.probe,f.cleanup);}
describe('C11 lifecycle artifact audit fail-closed controls (fixtures, not cloud proof)',()=>{
 it('accepts distinct sessions with retained old state, denied old keys and observed cleanup',()=>expect(audit(fixture())).toMatchObject({same_business_lead:true,same_physical_store_reused:true,cleanup_passed:true}));
 it.each(['erased-state','old-verifier-accepted','old-provider-accepted','missing-cleanup','same-twins','changed-contract'])('rejects %s',kind=>{
  const f=fixture();
  if(kind==='erased-state')f.stateB.shift();
  if(kind==='old-verifier-accepted')f.probe.retired_verifier_statuses[0]=200;
  if(kind==='old-provider-accepted')f.probe.provider_credentials[0]!.retired_authorized=true;
  if(kind==='missing-cleanup')f.cleanup.replay_handoffs_absent=false;
  if(kind==='same-twins')f.b.session.legs=f.a.session.legs;
  if(kind==='changed-contract')f.b.snapshot.workflow_result.receipt_verification.manifest.checks.push({id:'changed'});
  expect(()=>audit(f)).toThrow();
 });
});
