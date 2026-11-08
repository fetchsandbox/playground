/** Native credential consumer: run through node --env-file=<protected handoff>.
 * Prints only statuses and one-way fingerprints for the local parent audit.
 * Does not open, parse or log the handoff file or expose secret values. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {sessionScope} from './session-scope.mjs';
const [currentFile,priorFile,mode]=process.argv.slice(2);
if(!['current','retired'].includes(mode))throw Error('current or retired mode required');
const current=JSON.parse(readFileSync(currentFile)).legs,prior=JSON.parse(readFileSync(priorFile)).legs;
const paths={hubspot:'/crm/v3/objects/contacts',gmail:'/gmail/v1/users/me/messages','google-calendar':'/calendars/primary/events',slack:'/conversations.history?channel=C_PILOT'};
const stored=JSON.parse(readFileSync(join(dirname(currentFile),'state-after-b-private.json')));
const record=stored.find(r=>r.pk===`lead-pilot#${sessionScope(current)}#friendly-session-isolation`);
const eventId=record?.operations?.calendar?.id;
if(typeof eventId!=='string' || !/^[a-zA-Z0-9_-]+$/.test(eventId))throw Error('Observed completed Calendar identity required');
paths['google-calendar']='/calendars/primary/events/'+encodeURIComponent(eventId);
const names={hubspot:'HUBSPOT_API_KEY',gmail:'GMAIL_API_KEY','google-calendar':'GOOGLE_CALENDAR_API_KEY',slack:'SLACK_API_KEY'};
for(const provider of Object.keys(paths))for(const legs of [current,prior]){
 const leg=legs[provider];if(!leg || !/^[a-zA-Z0-9_-]+$/.test(leg.sandbox_id) || leg.base_url!=='https://fetchsandbox.com/sandbox/'+leg.sandbox_id)throw Error('Non-twin destination refused');
}
const fingerprint=value=>{if(!value)throw Error('Protected credential missing');return createHash('sha256').update(value).digest('hex');};
async function request(url,token,method='GET',body){
 if(!token)throw Error('Protected credential missing');
 const r=await fetch(url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','user-agent':'FetchSandbox-C11-lifecycle-audit'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
 let data={};try{data=await r.json();}catch{}
 return {status:r.status,authorized:r.ok&&!data.error&&data.ok!==false,data};
}
const verifier=process.env.FETCHSANDBOX_VERIFIER_TOKEN;
const result={mode,verifier_fingerprint:fingerprint(verifier),provider_credentials:[]};
if(mode==='current'){
 let observation;
 for(let i=0;i<100;i++){
  try{observation=await request('http://127.0.0.1:8097/session',verifier);if(observation.status===200)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(observation?.status!==200)throw Error('Current authenticated adapter not observed');
 result.session_scope=observation.data.session_scope;
 result.current_verifier_status=(await request('http://127.0.0.1:8097/proof/friendly-session-isolation',verifier)).status;
}else{
 result.retired_verifier_statuses=[];
 for(const [path,method,body] of [['/proof/friendly-session-isolation','GET',undefined],['/invoke','POST',{lead_id:'friendly-session-isolation'}],['/io','POST',{context:{lead_id:'friendly-session-isolation',attempt:'retired-credential'},request:{kind:'claim'}}]]){
  const status=(await request('http://127.0.0.1:8097'+path,verifier,method,body)).status;result.retired_verifier_statuses.push(status);if(status!==401)break;
 }
}
for(const provider of Object.keys(paths)){
 const token=process.env[names[provider]],r=await request(current[provider].base_url+paths[provider],token);
 const identityMatches=provider!=='google-calendar' || r.data.id===eventId;
 const row={provider,fingerprint:fingerprint(token),status:r.status,authorized:r.authorized&&identityMatches};
 if(mode==='retired')row.prior_url_status=(await request(prior[provider].base_url+paths[provider],token)).status;
 result.provider_credentials.push(row);
}
console.log(JSON.stringify(result));
