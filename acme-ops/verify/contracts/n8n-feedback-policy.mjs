/** Explicit app-owned policy revision. Historical contract JSON is immutable.
 * Cloud qualification uses an accelerated 30-second window, NOT proof that
 * the production 30-minute deployment/scheduler has run successfully. */
export const feedbackProofPolicy={maxLookups:3,windowMs:30000,quietNotifications:true};
export function applyFeedbackPolicy(config){
 const updated=structuredClone(config);
 // Provider scenarios are session-wide. The real background timer remains
 // enabled: let accepted-write recovery finish under ITS fault before the
 // harness arms the next case's fault. Delays consume no response aliases.
 for(const id of ['C2','C4']){
  const c=updated.checks.find(x=>x.id===id);
  c.actions.splice(1,0,...Array.from({length:3},()=>({delay_seconds:5})));
 }
 // Fewer notices is an intentional customer policy change, not a weakened
 // duplicate oracle. All provider effect/identity assertions remain intact.
 for(const id of ['C3','C3_recovery','C5']){
  const c=updated.checks.find(x=>x.id===id);
  for(const item of c.provider_assertions.filter(x=>x.provider==='slack'))for(const a of item.assertion.all_of){
   if(id==='C3')a.count=1;
   else if(id==='C5')a.count=1;
   else if(a.where.some(w=>typeof w.equals==='string'&&w.equals.includes('"status":"failed"')))a.count=1;
   else if(a.where.some(w=>w.contains))a.count=2;
  }
 }
 const source=updated.checks.find(x=>x.id==='C5');
 const deadline=JSON.parse(JSON.stringify(source).replaceAll('fs-c5-','fs-feedback-deadline-'));
 deadline.id='F_email_deadline';deadline.name='Unresolved email reaches human handoff within accelerated recovery window, without resend or Calendar';
 deadline.actions=[deadline.actions[0],...Array.from({length:8},()=>({delay_seconds:5})),{method:'POST',path:'/invoke',body:{lead_id:'fs-feedback-deadline-{{run_id}}'},expect_status:200}];
 deadline.assertion.where=deadline.assertion.where.filter(a=>!a.equals?.startsWith?.('{{step'));
 deadline.assertion.where.find(a=>a.select==='status').equals='needs_human';
 deadline.assertion.where.push(
  {select:'handoff.lead_id',equals:'fs-feedback-deadline-{{run_id}}',required:true},
  {select:'handoff.blocked_step',equals:'gmail',required:true},
  {select:'handoff.lookup_attempts',count:1,required:true},
  {select:'handoff.email_draft.raw_base64url',count:1,required:true},
  {select:'handoff.email_draft.send_outcome',equals:'unknown',required:true},
  {select:'recovery_policy.maxLookups',equals:3,required:true},
  {select:'recovery_policy.windowMs',equals:30000,required:true});
 // The new schedule has no step2 state response; retain positive independent
 // resource count/content/association observations without stale step links.
 const removeStepRefs=a=>{
  if(Array.isArray(a))return a.map(removeStepRefs).filter(x=>x!==null);
  if(a&&typeof a==='object'){
   if(typeof a.equals==='string'&&a.equals.includes('{{step'))return null;
   return Object.fromEntries(Object.entries(a).map(([k,v])=>[k,removeStepRefs(v)]));
  }return a;
 };
 deadline.provider_assertions=removeStepRefs(deadline.provider_assertions);
 const slack=deadline.provider_assertions.find(x=>x.provider==='slack');
 slack.assertion={all_of:[
  {select:'records[*]',count:1,required:true,where:[{select:'text',equals:JSON.stringify({lead_id:'fs-feedback-deadline-{{run_id}}',status:'unknown',blocked_step:'gmail'}),required:true}]},
  {select:'records[*]',count:1,required:true,where:[{select:'text',equals:JSON.stringify({lead_id:'fs-feedback-deadline-{{run_id}}',status:'needs_human',blocked_step:'gmail'}),required:true}]},
  {select:'records[*]',count:2,required:true,where:[{select:'text',contains:'fs-feedback-deadline-{{run_id}}',required:true}]}]};
 updated.checks.push(deadline,{id:'F_deal_unique',name:'Unique Deal key preserves one Deal across delayed search visibility',blocker:{category:'setup_missing',reason:'Native unique-property and direct idProperty behavior qualified separately; this sandbox path still needs explicit property-registry/unique-query qualification before enabling it in the workflow proof.',evidence:['n8n-lead-pilot/evidence/friendly-feedback/plan.json']}});
 // Unlike the historical indefinite-unknown contract, the timed policy must
 // settle this case before later provider faults are armed. Keep exactly one
 // unknown notice plus one handoff notice, not two repeated unknown notices.
 source.name='Unresolved Gmail stays unsent and Calendar waits, then bounded recovery requests human help';
 source.actions.push(...Array.from({length:8},()=>({delay_seconds:5})));
 source.assertion.where.find(a=>a.select==='status').equals='needs_human';
 source.assertion.where.push({select:'handoff.blocked_step',equals:'gmail',required:true});
 source.provider_assertions.find(x=>x.provider==='slack').assertion={all_of:[
  {select:'records[*]',count:1,required:true,where:[{select:'text',equals:JSON.stringify({lead_id:'fs-c5-{{run_id}}',status:'unknown',blocked_step:'gmail'}),required:true}]},
  {select:'records[*]',count:1,required:true,where:[{select:'text',equals:JSON.stringify({lead_id:'fs-c5-{{run_id}}',status:'needs_human',blocked_step:'gmail'}),required:true}]},
  {select:'records[*]',count:2,required:true,where:[{select:'text',contains:'fs-c5-{{run_id}}',required:true}]}]};
 for(const check_id of ['F_email_deadline','F_deal_unique'])updated.scope_review.push({check_id,classification:'in_scope',reason:'Friendly feedback, separate timed-policy revision; unresolved provider qualification remains visible.',evidence:['n8n-lead-pilot/evidence/friendly-feedback/plan.json']});
 return updated;
}
