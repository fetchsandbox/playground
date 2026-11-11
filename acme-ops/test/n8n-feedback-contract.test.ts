import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
// @ts-ignore Plain Node contract owner.
import {applyFeedbackPolicy,feedbackProofPolicy} from '../verify/contracts/n8n-feedback-policy.mjs';
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
