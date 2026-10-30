import {createHash} from "node:crypto";
import {z} from "zod";
import {FatalError} from "../kit/errors";
import type {ActionContext,ActionReceipt,AgentResults,RunContext,WorkflowDef} from "../kit/types";
import type {MetaAd,MetaCreative} from "../providers/meta";

const Policy=z.object({version:z.string().min(1),organization:z.string().min(1),account:z.string().regex(/^act_\d+$/),adsets:z.array(z.string().regex(/^\d+$/)).min(1),status:z.literal("PAUSED")}).strict();
export const DEFAULT_AD_POLICY={version:"acme-ads-2026-10-30",organization:"Acme",account:"act_1001",adsets:["2001"],status:"PAUSED"} as const;
export const adPolicy=()=>Policy.parse(JSON.parse(process.env.AD_PUBLISHING_POLICY_JSON??JSON.stringify(DEFAULT_AD_POLICY)));
function canonical(v:unknown):unknown {return Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;}
export const adHash=(v:unknown)=>createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const Input=z.object({organization:z.string(),customer:z.object({email:z.email()}),creativeId:z.string().regex(/^\d+$/),adsetId:z.string().regex(/^\d+$/),title:z.string().min(1).max(120)}).strict();
type Input=z.infer<typeof Input>;
type Evidence={creative:MetaCreative;policy:ReturnType<typeof adPolicy>;policyHash:string;creativeHash:string};
type Intent={name:string;account:string;adset_id:string;creative:{creative_id:string};status:"PAUSED";policyHash:string;creativeHash:string};
const evidence=(r:AgentResults)=>r.ok["creative-research"] as Evidence|undefined;
function exact(a:MetaAd,i:Intent){return a.name===i.name&&a.account_id===i.account.slice(4)&&a.adset_id===i.adset_id&&a.creative?.id===i.creative.creative_id&&a.status===i.status;}
function expected(ctx:RunContext<Input>,e:Evidence):Intent{return {name:ctx.input.title,account:e.policy.account,adset_id:ctx.input.adsetId,creative:{creative_id:ctx.input.creativeId},status:"PAUSED",policyHash:e.policyHash,creativeHash:e.creativeHash};}
async function verify(ctx:RunContext<Input>,i:Intent){
 if(adHash(adPolicy())!==i.policyHash)throw new FatalError("Policy changed since review; publication held");
 const c=await ctx.providers.meta!.creative(i.creative.creative_id);
 if(adHash(c)!==i.creativeHash)throw new FatalError("Creative changed since review; publication held");
}
async function recover(ctx:ActionContext<Input>,i:Intent):Promise<ActionReceipt>{
 const rows=(await ctx.providers.meta!.ads(i.account)).filter(a=>a.name===i.name);
 if(rows.length!==1||!exact(rows[0]!,i))throw new FatalError("Publication outcome is unknown or conflicting; no resend permitted");
 const read=await ctx.providers.meta!.ad(rows[0]!.id);
 if(!exact(read,i))throw new FatalError("Publication read-back conflicts with the approved request");
 return {ref:read.id,detail:{recovered:true,independentReadback:true,status:read.status}};
}
export const adCreativePublishing:WorkflowDef<Input>={
 id:"ad-creative-publishing",title:"Owner-reviewed pergola ad publication",org:"Marketing",team:"creative-operations",
 description:"Research a seeded pergola creative, freeze an exact paused Meta ad, wait for owner approval and reconcile uncertain creation without blind resending. Sandbox demonstration; no live delivery or spend.",input:Input,
 agents:[{name:"creative-research",needs:["meta"],async run(ctx){
  const policy=adPolicy();if(ctx.input.organization!==policy.organization||!policy.adsets.includes(ctx.input.adsetId))throw new FatalError("Business or ad set is outside the publishing policy");
  const creative=await ctx.providers.meta!.creative(ctx.input.creativeId);
  if(creative.id!==ctx.input.creativeId||creative.account_id!==policy.account.slice(4))throw new FatalError("Creative does not belong to the approved business account");
  return {summary:`Read creative ${creative.id}; owner approval required before paused ad creation`,data:{creative,policy,policyHash:adHash(policy),creativeHash:adHash(creative)} satisfies Evidence};
 }},{name:"campaign-lead",needs:[],async run(){return {summary:"One business, one exact creative and one owner-reviewed publication; no payment or model authority",data:{approvalRequired:true}};}}],
 output(ctx,results){const e=evidence(results);return {decision:e?"publish":"hold",policyVersion:e?.policy.version??"not_verified",policyHash:e?.policyHash,creativeHash:e?.creativeHash,publication:e?expected(ctx,e):null};},
 plan(ctx,results){const e=evidence(results);if(!e)return [];const i=expected(ctx,e);return [{id:"meta.create_paused_ad",kind:"meta.create_paused_ad",provider:"meta",agent:"campaign-lead",gate:"approval",summary:{...i,creativeSnapshot:e.creative},
  async execute(action){
   await verify(action,i);
   const prior=await action.checkpoint.load<Intent>("publication-intent");
   if(prior){if(adHash(prior)!==adHash(i))throw new FatalError("Saved publication intent conflicts");return recover(action,i);}
   // Durable intent is saved BEFORE the only provider write. Any uncertainty
   // after this point permits observation, never a second create request.
   await action.checkpoint.save("publication-intent",i);
   const id=await action.providers.meta!.create(i.account,i);
   const read=await action.providers.meta!.ad(id);
   if(!exact(read,i))throw new FatalError("Meta did not read back the exact approved paused ad");
   return {ref:id,detail:{status:read.status,independentReadback:true,recovered:false}};
  },
  async recover(action){return recover(action,i);},
  async reconcile(action,receipt){const read=await action.providers.meta!.ad(receipt.ref);return {status:exact(read,i)?"match":"drift",detail:"Compared account, exact tagged name, creative, ad set and PAUSED state"};}
 }];},
 catalog:[{kind:"meta.create_paused_ad",provider:"meta",gate:"approval",description:"Create one paused Meta ad only after review; uncertain outcomes are reconciled without resending"}]
};
export default adCreativePublishing;
