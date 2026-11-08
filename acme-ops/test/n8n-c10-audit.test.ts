import {describe,it,expect} from 'vitest';
// @ts-ignore Plain JS audit is invoked directly on saved JSON artifacts.
import {auditC10} from '../n8n-lead-pilot/audit-c10.mjs';
function fixture(){
 const run_id='vr_fixture';
 const trace=Array.from({length:7},()=>({kind:'app_request',check_id:'C10',path:'/io',status:400,request:{c10_marker:'c10-public-marker-'+run_id,authorization:'[redacted]',api_key:'[redacted]',nested:{password:'[redacted]',cookie:'[redacted]',note:'[redacted: FetchSandbox API key]'}}}));
 trace.push({kind:'app_request',check_id:'C10',path:'/not-an-allowed-route',status:404,request:{} as any});
 const owner={workflow_result:{receipt_verification:{run_id,evidence:{trace}}}};
 const summary={...structuredClone(owner),flow_run_id:run_id,summary_only:true};
 return {owner,summary};
}
describe('C10 retained artifact audit fail-closed controls',()=>{
 it('requires both actual body capture and explicit masks, not simply absent secret strings',()=>{
  const {owner,summary}=fixture();expect(auditC10(owner,summary)).toMatchObject({denied_io_requests:7,positive_body_witnesses:7,retained_owner_canary_redaction:true,anonymous_summary_canary_redaction:true});
  delete (owner.workflow_result.receipt_verification.evidence.trace[0]!.request as any).c10_marker;
  expect(()=>auditC10(owner,summary)).toThrow('Positive canary missing');
 });
 it.each(['owner','summary'])('rejects a leaked canary in the %s artifact',target=>{
  const f=fixture();(f[target as 'owner'|'summary'] as any).extra='c10-dummy-auth-vr_fixture';expect(()=>auditC10(f.owner,f.summary)).toThrow('Sensitive canary');
 });
 it('rejects an actual supplied credential even outside the expected sensitive fields',()=>{
  const {owner,summary}=fixture();(summary as any).extra='opaque-fixture-credential';expect(()=>auditC10(owner,summary,['opaque-fixture-credential'])).toThrow('credential');
 });
 it('rejects mixed-run evidence and an omitted/unsuccessful denied request',()=>{
  const {owner,summary}=fixture();summary.flow_run_id='another';expect(()=>auditC10(owner,summary)).toThrow('identity');
  summary.flow_run_id='vr_fixture';owner.workflow_result.receipt_verification.evidence.trace[0]!.status=200;expect(()=>auditC10(owner,summary)).toThrow('Denied requests');
 });
});
