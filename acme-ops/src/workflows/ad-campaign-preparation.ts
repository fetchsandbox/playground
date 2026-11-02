import {z} from "zod";
import {FatalError} from "../kit/errors";
import type {ActionContext,ActionReceipt,WorkflowDef} from "../kit/types";
import {adHash} from "./ad-creative-publishing";
const Policy=z.object({version:z.string().min(1),organization:z.string(),account:z.string().regex(/^act_\d+$/),pageId:z.string(),instagramUserId:z.string(),imageHash:z.string(),maxDailyBudgetMinor:z.number().int().positive(),destinationHosts:z.array(z.string()).min(1)}).strict();
export const preparationPolicy=()=>Policy.parse(JSON.parse(process.env.AD_PREPARATION_POLICY_JSON??JSON.stringify({version:"acme-feed-2026-10-30",organization:"Acme",account:"act_1001",pageId:"4001",instagramUserId:"5001",imageHash:"demo-image-1001",maxDailyBudgetMinor:1000,destinationHosts:["example.test"]})));
const Input=z.object({organization:z.string(),customer:z.object({email:z.email()}),platform:z.enum(["facebook","instagram"]),title:z.string().min(1).max(90),message:z.string().min(1).max(1000),link:z.url(),dailyBudgetMinor:z.number().int().positive()}).strict();type Input=z.infer<typeof Input>;
type Edge="campaigns"|"adsets"|"adcreatives"|"ads";
type Plan={policy:ReturnType<typeof preparationPolicy>;policyHash:string};
function validate(input:Input,p:Plan["policy"]){const u=new URL(input.link);if(input.organization!==p.organization||input.dailyBudgetMinor>p.maxDailyBudgetMinor||u.protocol!=="https:"||u.username||u.password||!p.destinationHosts.includes(u.hostname))throw new FatalError("Business, budget or destination is outside the owner publishing policy");}
// A provider-assigned suffix is allowed only on the initial creative observation.
// Once observed, the exact returned name is durable and later changes are drift.
function sameName(edge:Edge,actual:unknown,intended:unknown){
 if(typeof actual!=="string"||typeof intended!=="string")return false;
 return actual===intended||(edge==="adcreatives"&&actual.startsWith(intended+" ")&&/^\d{4}-\d{2}-\d{2}-[a-f0-9]{32}$/.test(actual.slice(intended.length+1)));
}
function exact(row:Record<string,unknown>,payload:Record<string,unknown>,account:string,edge:Edge,observedName?:string){
 return row.account_id===account.slice(4)&&Object.entries(payload).every(([k,v])=>k==="name"?(observedName===undefined?sameName(edge,row[k],v):row[k]===observedName):adHash(row[k])===adHash(k==="creative"&&v&&typeof v==="object"&&"creative_id" in v?{id:(v as {creative_id:string}).creative_id}:v));
}
function step(edge:Edge,payload:(c:ActionContext<Input>)=>Record<string,unknown>,plan:Plan){
 const id="meta.prepare_"+edge,intentKey="preparation-intent:"+edge,refKey="preparation-ref:"+edge,observationKey="preparation-observation:"+edge;
 const fields=(p:Record<string,unknown>)=>["id","account_id",...Object.keys(p)].join(",");
 type Observation={ref:string;name:string};
 async function confirm(c:ActionContext<Input>,ref:string,saved:Record<string,unknown>,recovered:boolean,listedName?:string):Promise<ActionReceipt>{
  const observed=await c.checkpoint.load<Observation>(observationKey),read=await c.providers.meta!.node(ref,fields(saved));
  if(read.id!==ref||!exact(read,saved,plan.policy.account,edge,observed?.name)||observed&&observed.ref!==ref||listedName!==undefined&&read.name!==listedName)throw new FatalError("Preparation read-back conflicts");
  await c.checkpoint.save(refKey,ref);await c.checkpoint.save(observationKey,{ref,name:read.name});
  return {ref,detail:{recovered,requestedName:saved.name,observedName:read.name}};
 }
 async function recover(c:ActionContext<Input>):Promise<ActionReceipt>{
  const saved=await c.checkpoint.load<Record<string,unknown>>(intentKey);if(!saved)throw new FatalError("No persisted intent; recovery cannot invent a write");
  const ref=await c.checkpoint.load<string>(refKey);if(ref)return confirm(c,ref,saved,true);
  const rows=(await c.providers.meta!.nodes(plan.policy.account,edge,fields(saved))).filter(r=>sameName(edge,r.name,saved.name));
  if(rows.length!==1||!exact(rows[0]!,saved,plan.policy.account,edge))throw new FatalError("Preparation outcome unknown or conflicting; no resend permitted");
  return confirm(c,String(rows[0]!.id),saved,true,String(rows[0]!.name));
 }
 return {id,kind:id,provider:"meta" as const,agent:"campaign-planner",gate:"approval" as const,summary:{edge,...(edge==="campaigns"?{is_adset_budget_sharing_enabled:false}:{}),...(edge==="adsets"?{bid_strategy:"LOWEST_COST_WITHOUT_CAP",audience:{country:"US",ageMin:18,ageMax:65,advantageAudience:false,locationTypes:["frequently_in","home","recent"]}}:{}),...(edge==="adcreatives"?{namePolicy:"Run-bound creative name; retain provider-assigned date/hash suffix and detect subsequent changes"}:{}),platform:"resolved from reviewed input",policyVersion:plan.policy.version,policyHash:plan.policyHash,policy:plan.policy,account:plan.policy.account,status:"PAUSED",scope:"Prepare linked objects using pre-existing image; no activation"},
 async execute(c:ActionContext<Input>):Promise<ActionReceipt>{
  validate(c.input,plan.policy);const order:Edge[]=["campaigns","adsets","adcreatives","ads"],previous=order[order.indexOf(edge)-1];if(previous)parent(c,previous);
  if(adHash(preparationPolicy())!==plan.policyHash)throw new FatalError("Policy changed since review");
  const intended=payload(c),saved=await c.checkpoint.load<Record<string,unknown>>(intentKey);
  if(saved){if(adHash(saved)!==adHash(intended))throw new FatalError("Saved preparation intent conflicts");return recover(c);}
  await c.checkpoint.save(intentKey,intended);const ref=await c.providers.meta!.prepare(plan.policy.account,edge,intended);
  await c.checkpoint.save(refKey,ref);return confirm(c,ref,intended,false);
 },recover,
 async reconcile(c:ActionContext<Input>,receipt:ActionReceipt){
  const saved=await c.checkpoint.load<Record<string,unknown>>(intentKey),observed=await c.checkpoint.load<Observation>(observationKey);
  if(!saved||!observed)return {status:"unverifiable" as const,detail:"Missing saved intent or provider observation"};
  const read=await c.providers.meta!.node(receipt.ref,fields(saved));return {status:read.id===receipt.ref&&observed.ref===receipt.ref&&exact(read,saved,plan.policy.account,edge,observed.name)?"match" as const:"drift" as const,detail:"Compared every prepared field and account; provider name compared with frozen observation"};}};
}
function parent(c:ActionContext<Input>,edge:Edge){const r=c.applied["meta.prepare_"+edge];if(!r)throw new FatalError("Earlier preparation is unresolved; dependent write refused");return r.ref;}
export const adCampaignPreparation:WorkflowDef<Input>={id:"ad-campaign-preparation",title:"Owner-reviewed Facebook and Instagram feed campaign preparation",org:"Marketing",team:"creative-operations",description:"Review business, budget, destination and creative before preparing linked paused campaign/adset/creative/ad objects. Existing image fixture only; no live delivery.",input:Input,
 agents:[{name:"policy-review",needs:[],async run(c){const policy=preparationPolicy();validate(c.input,policy);return {summary:"Business, daily budget and destination checked; owner approval required",data:{policy,policyHash:adHash(policy)}};}},{name:"campaign-planner",needs:["meta"],async run(){return {summary:"Four ordered provider effects, each with durable intent and observation-only recovery",data:{deliveryEnabled:false}};}}],
 output(c,r){const p=r.ok["policy-review"] as Plan|undefined;return {decision:p?"prepare":"hold",reviewedInput:c.input,policyVersion:p?.policy.version,policyHash:p?.policyHash,deliveryEnabled:false};},
 plan(c,r){const plan=r.ok["policy-review"] as Plan|undefined;if(!plan||!r.ok["campaign-planner"])return [];const p=plan.policy;return [
 step("campaigns",()=>({name:c.input.title+" campaign",objective:"OUTCOME_TRAFFIC",special_ad_categories:[],is_adset_budget_sharing_enabled:false,status:"PAUSED"}),plan),
 step("adsets",a=>({name:c.input.title+" ad set",campaign_id:parent(a,"campaigns"),daily_budget:String(c.input.dailyBudgetMinor),billing_event:"IMPRESSIONS",optimization_goal:"LINK_CLICKS",bid_strategy:"LOWEST_COST_WITHOUT_CAP",targeting:{age_min:18,age_max:65,targeting_automation:{advantage_audience:0},geo_locations:{countries:["US"],location_types:["frequently_in","home","recent"]},publisher_platforms:[c.input.platform],...(c.input.platform==="instagram"?{instagram_positions:["stream"]}:{facebook_positions:["feed"]})},status:"PAUSED"}),plan),
 step("adcreatives",()=>({name:c.input.title+" creative [FS:"+adHash({runId:c.runId,account:p.account,policy:plan.policyHash}).slice(0,24)+"]",object_story_spec:{page_id:p.pageId,...(c.input.platform==="instagram"?{instagram_user_id:p.instagramUserId}:{}),link_data:{message:c.input.message,link:c.input.link,name:c.input.title,image_hash:p.imageHash}}}),plan),
 step("ads",a=>({name:c.input.title+" ad",adset_id:parent(a,"adsets"),creative:{creative_id:parent(a,"adcreatives")},status:"PAUSED"}),plan)].map(a=>({...a,summary:{...a.summary,...(a.kind==="meta.prepare_adcreatives"?{creativeReference:"FS:"+adHash({runId:c.runId,account:p.account,policy:plan.policyHash}).slice(0,24)}:{}),reviewedInput:c.input}}));},
 catalog:["campaigns","adsets","adcreatives","ads"].map(edge=>({kind:"meta.prepare_"+edge,provider:"meta" as const,gate:"approval" as const,description:"Owner-reviewed paused preparation; uncertain writes require read-back, never blind resend"}))};
export default adCampaignPreparation;
