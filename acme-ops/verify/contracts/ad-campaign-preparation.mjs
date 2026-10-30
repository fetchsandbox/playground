import {check,start,command,restart,runs,eq,action,agent} from "./lib.mjs";
const OWNER="U_AD_OWNER";
const input=(id,over={})=>({organization:"Acme",customer:{email:"builder@example.test"},platform:"instagram",title:`Pergola ${id} {{run_id}}`,message:"Plan your pergola consultation",link:"https://example.test/pergolas",dailyBudgetMinor:1000,...over});
const begin=(id,over)=>start(id,input(id,over));const approve=()=>command("decide",1,{userId:OWNER,decision:"approve"});
const writes=[['campaigns',' campaign'],['adsets',' ad set'],['adcreatives',' creative'],['ads',' ad']];
const effects=(id,n)=>writes.map(([collection,suffix],index)=>{
 const where=[eq("name",`Pergola ${id} {{run_id}}${suffix}`),eq("account_id","1001")];
 if(n){
  if(!(id==='unknown'&&collection==='ads'))where.push(eq('id',`{{prev.actions.${index}.ref}}`));
  if(collection!=='adcreatives')where.push(eq('status','PAUSED'));
  if(collection==='adsets')where.push(eq('campaign_id','{{prev.actions.0.ref}}'),eq('daily_budget','1000'),{select:'targeting.publisher_platforms',set_equals:[id==='facebook'?'facebook':'instagram'],count:1,required:false});
  if(collection==='adcreatives'){where.push(eq('object_story_spec.page_id','4001'));if(id!=='facebook')where.push(eq('object_story_spec.instagram_user_id','5001'));}
  if(collection==='ads')where.push(eq('adset_id','{{prev.actions.1.ref}}'),eq('creative.id','{{prev.actions.2.ref}}'));
 }
 return {provider:"meta-marketing",collection,assertion:{select:"records[*]",count:n,required:true,where:where.map(predicate=>({...predicate,required:false}))}};
});
const applied=()=>writes.map(([edge])=>action('meta.prepare_'+edge,'applied'));
const rule=(id,name,actions,assertions,count,extra={})=>check(id,name,actions,runs(assertions),{...extra,provider_assertions:effects(id,count)});
export const checks=[
 rule('baseline','Instagram preparation creates one linked paused hierarchy after approval',[begin('baseline'),approve(),command('reconcile',1)],[eq('outcome','ok'),...writes.map(([edge])=>action('meta.prepare_'+edge,'applied',1,[eq('reconcile.status','match')]))],1),
 rule('held','No preparation writes before owner approval',[begin('held')],[eq('phase','AWAITING_APPROVAL')],0),
 rule('facebook','Facebook feed uses the same approval and preparation boundaries',[begin('facebook',{platform:'facebook'}),approve()],[eq('outcome','ok'),...applied()],1),
 rule('rejected','Rejected preparation creates no objects',[begin('rejected'),command('decide',1,{userId:OWNER,decision:'reject'})],[eq('phase','REJECTED')],0),
 rule('wrong_reviewer','An unconfigured reviewer cannot release preparation',[begin('wrong_reviewer'),command('decide',1,{userId:'U_STRANGER',decision:'approve'},403)],[eq('phase','AWAITING_APPROVAL')],0),
 rule('replay','Approval replay does not repeat any of the four writes',[begin('replay'),approve(),approve()],[eq('outcome','ok'),...applied()],1),
 rule('budget','Above-policy daily budget creates nothing',[begin('budget',{dailyBudgetMinor:1001})],[agent('policy-review','failed')],0),
 rule('business','Wrong organization creates nothing',[begin('business',{organization:'Other business'})],[agent('policy-review','failed')],0),
 rule('destination','Unapproved destination creates nothing',[begin('destination',{link:'https://unapproved.test/'})],[agent('policy-review','failed')],0),
 rule('provider_auth','Provider authentication refusal cannot create objects',[begin('provider_auth'),approve()],[eq('outcome','partial'),action('meta.prepare_campaigns','failed')],0,{fault:{provider:'meta-marketing',scenario:'auth_failure',evidence:'refusal'}}),
 rule('unknown','Unavailable read-back leaves the accepted ad unresolved and never resends',[begin('unknown'),approve(),command('resume',1),command('resume',1)],[eq('outcome','partial'),action('meta.prepare_ads','failed')],1,{fault:{provider:'meta-marketing',scenario:'ad_loss_readback_unavailable',evidence:'refusal'}}),
 rule('restart','A real worker restart preserves the review and subsequent effects',[begin('restart'),restart,approve()],[eq('outcome','ok'),...applied()],1),
 ...[['campaign_loss','campaign_response_loss','campaigns'],['adset_loss','adset_response_loss','adsets'],['creative_loss','creative_response_loss','adcreatives'],['ad_loss','ad_response_loss','ads']].map(([id,scenario,edge])=>rule(id,'Accepted '+edge+' response loss recovers without resending',[begin(id),approve(),command('resume',1),command('reconcile',1),{delay_seconds:5.1}],[eq('outcome','ok'),...applied(),action('meta.prepare_'+edge,'applied',1,[eq('detail.recovered',true),eq('reconcile.status','match')])],1,{fault:{provider:'meta-marketing',scenario,evidence:'accepted_response_readback'}})),
];
export default {workflow:'ad-campaign-preparation',providers:['meta-marketing'],checks,appEnv:{APPROVER_USER_IDS:OWNER,META_WRITE_TIMEOUT_MS:'2000',LOOPLABS_CONTROL_CONFIG:'',LOOPLABS_APPROVAL_SIGNING_SECRET:''},context:{goal:'Owner-reviewed Facebook/Instagram feed preparation with paused campaign, ad set, link creative and ad. Existing image fixture only; no activation, media upload, live Meta review/delivery or spend.',workflow:'Start through POST /invocations, inspect saved review, approve as configured owner, read back all four provider effects. Resume uncertain effects using saved per-effect intent and provider observations only.',entry_points:['POST /invocations'],state_store:'Saved application runs and independent provider collection assertions.'},coverage:{baseline:['baseline','facebook','held'],identity_and_access:['wrong_reviewer','business'],schema_and_value_boundaries:['budget','destination'],amount_currency_quantity:['budget'],duplicate_replay:['replay'],concurrency:'Multi-worker contention not measured.',ordering_and_stale_events:'Policy-change refusal is locally regression tested; no inbound provider events.',delayed_or_missing_events:'No inbound webhook delivery in this subset.',provider_auth_and_scopes:['provider_auth'],rate_limit_server_error_timeout:['campaign_loss','adset_loss','creative_loss','ad_loss'],accepted_effect_response_loss:['campaign_loss','adset_loss','creative_loss','ad_loss'],partial_effects_and_recovery:['campaign_loss','adset_loss','creative_loss','ad_loss','unknown'],restart_and_durability:['restart'],reconciliation:['baseline','campaign_loss','adset_loss','creative_loss','ad_loss'],cancellation_refund_entitlements:'No payments, refunds or entitlements.',data_and_privacy_boundaries:['business','destination'],cleanup_and_isolation:'Fresh owned validation session and maintained disposable credential lifecycle.'},evidence:['acme-ops/src/workflows/ad-campaign-preparation.ts','acme-ops/src/providers/meta.ts','acme-ops/src/kit/engine.ts']};
