/** Offline inspection of actual retained owner proof and anonymous summary.
 * This is a separate artifact audit, not another workflow execution engine. */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function auditC10(owner,summary,secrets=[]){
 const result=owner?.workflow_result?.receipt_verification;
 if(!result?.run_id || result.run_id!==summary?.flow_run_id || summary?.summary_only!==true)throw Error('Receipt identity mismatch');
 const rid=result.run_id;
 const privateTrace=result.evidence?.trace??[];
 const rows=privateTrace.filter(r=>r.kind==='app_request' && r.check_id==='C10');
 const requests=rows.filter(r=>r.path==='/io');
 if(requests.length!==7 || !requests.every(r=>r.status===400) || !rows.some(r=>r.path==='/not-an-allowed-route' && r.status===404))throw Error('Denied requests were not all independently recorded');
 const marker='c10-public-marker-'+rid;
 if(!requests.every(r=>r.request?.c10_marker===marker))throw Error('Positive canary missing: cannot establish body capture');
 const forbidden=['c10-dummy-auth-','c10-dummy-api-key-','c10-dummy-password-','c10-dummy-cookie-','c10-dummy-route-token-'].map(p=>p+rid).concat('fsk_C10DUMMYSECRETNOTVALID1234567890',secrets.filter(x=>typeof x==='string' && x.length>8));
 for(const document of [owner,summary]){
  const serialized=JSON.stringify(document);
  if(forbidden.some(value=>serialized.includes(value)))throw Error('Sensitive canary or credential found in retained evidence');
 }
 for(const r of requests){
  if(r.request.authorization!=='[redacted]' || r.request.api_key!=='[redacted]' || r.request.nested?.password!=='[redacted]' || r.request.nested?.cookie!=='[redacted]' || !r.request.nested?.note?.includes('[redacted'))throw Error('Expected explicit redaction evidence missing');
 }
 const publicResult=summary.workflow_result.receipt_verification;
 const publicC10=JSON.stringify(publicResult);
 if(!publicC10.includes(marker))throw Error('Anonymous summary lacks positive request-body witness');
 return {run_id:rid,denied_io_requests:7,denied_unknown_routes:1,positive_body_witnesses:7,retained_owner_canary_redaction:true,anonymous_summary_canary_redaction:true,credential_values_scanned:secrets.filter(x=>typeof x==='string' && x.length>8).length,scope:'Sensitive field names and one key-shaped dummy value, plus supplied actual credentials. Not arbitrary PII or all secret formats.'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const [ownerFile,summaryFile,bindingsFile]=process.argv.slice(2);
 if(!ownerFile || !summaryFile || !bindingsFile)throw Error('usage: audit-c10.mjs owner-private.json anonymous-summary.json bindings-private.json');
 const bindings=JSON.parse(readFileSync(bindingsFile));
 const secrets=[bindings.token,bindings.n8n_token,process.env.FETCHSANDBOX_API_KEY,...Object.values(bindings.legs??{}).map(x=>x.api_key)];
 console.log(JSON.stringify(auditC10(JSON.parse(readFileSync(ownerFile)),JSON.parse(readFileSync(summaryFile)),secrets),null,2));
}
