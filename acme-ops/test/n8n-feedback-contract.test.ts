import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
// @ts-ignore Plain Node contract owner.
import {applyFeedbackPolicy,feedbackProofPolicy,applyUniqueFeedbackPolicy,uniqueFeedbackProofPolicy} from '../verify/contracts/n8n-feedback-policy.mjs';
it('keeps the historical contract untouched and changes only declared Slack policy plus separate feedback scenarios',()=>{
 const original=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const bytes=JSON.stringify(original),revised=applyFeedbackPolicy(original);
 expect(JSON.stringify(original)).toBe(bytes);expect(revised.checks.length).toBe(original.checks.length+2);
 expect(feedbackProofPolicy).toEqual({maxLookups:3,windowMs:30000,quietNotifications:true});
 for(const check of original.checks){
  const after=revised.checks.find((x:any)=>x.id===check.id);
  if(['C2','C4'].includes(check.id))expect({...after,actions:after.actions.filter((a:any)=>!a.delay_seconds)}).toEqual(check);
  else if(check.id==='C5'){
   expect(after.assertion.where).toContainEqual({select:'status',equals:'needs_human',required:true});
   expect(after.actions.filter((a:any)=>!a.delay_seconds)).toEqual(check.actions);
   expect(after.provider_assertions.filter((p:any)=>p.provider!=='slack')).toEqual(check.provider_assertions.filter((p:any)=>p.provider!=='slack'));
  }
  else if(!['C3','C3_recovery'].includes(check.id))expect(after).toEqual(check);
  else{
   const withoutSlack=(x:any)=>({...x,provider_assertions:x.provider_assertions.filter((p:any)=>p.provider!=='slack')});
   expect(withoutSlack(after)).toEqual(withoutSlack(check));
  }
 }
 const deadline=revised.checks.find((x:any)=>x.id==='F_email_deadline');
 expect(deadline.actions.filter((a:any)=>a.delay_seconds).reduce((sum:number,a:any)=>sum+a.delay_seconds,0)).toBe(40);
 expect(deadline.assertion.where).toContainEqual({select:'status',equals:'needs_human',required:true});
 expect(deadline.provider_assertions.find((x:any)=>x.provider==='google-calendar').assertion.count).toBe(0);
 expect(JSON.stringify(deadline)).not.toContain('{{step');
 expect(revised.checks.find((x:any)=>x.id==='F_deal_unique').blocker.category).toBe('setup_missing');
});
it('qualifies unique-key recovery separately without relabelling the old timed receipt',()=>{
 const original=JSON.parse(readFileSync(new URL('../n8n-lead-pilot/contract.json',import.meta.url),'utf8'));
 const before=JSON.stringify(original), timed=applyFeedbackPolicy(original), revised=applyUniqueFeedbackPolicy(original);
 expect(JSON.stringify(original)).toBe(before);
 expect(timed.checks.find((x:any)=>x.id==='F_deal_unique').blocker).toBeDefined();
 const unique=revised.checks.find((x:any)=>x.id==='F_deal_unique');
 expect(unique.blocker).toBeUndefined();
 expect(unique.fault).toEqual({provider:'hubspot',scenario:'deal_accepted_response_loss',evidence:'accepted_response_readback'});
 expect(unique.assertion.where).toContainEqual({select:'operations.deal.confirmation',equals:'positive_unique_key_readback',required:true});
 expect(revised.checks.find((x:any)=>x.id==='C3_recovery').before.assertion.where).toContainEqual({select:'operations.deal.confirmation',equals:'positive_unique_key_readback',required:true});
 expect(JSON.stringify(unique)).not.toContain('fs-c2-');
 expect(unique.provider_assertions.find((x:any)=>x.provider==='hubspot'&&x.collection==='deals').assertion.all_of).toContainEqual({select:'records[*]',count:1,required:true,where:[{select:'properties.fetchsandbox_pilot_lead_id',equals:'fs-feedback-unique-{{run_id}}',required:true}]});
 expect(uniqueFeedbackProofPolicy).toEqual({...feedbackProofPolicy,uniqueDealIdentity:true});
});
