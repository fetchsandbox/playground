import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Engine } from "./engine";
import type { KvStore } from "./store";
import type { RunRecord } from "./types";

export interface ControlScope { tenantId:string; connectionId:string; resourceArn:string; version:string; epoch:string }
export interface ControlConfig { scope:ControlScope; secret:string; reviewerMap:Record<string,string>; allowSelfReview:boolean }
export interface ControlState { scope:ControlScope; events:Record<string,unknown>[]; frozen?: Approval; stateHash?:string }
export interface Approval { id:string;runId:string;policyVersion:string;title:string;reason:string;action:string;system:string;before:string;after:string;requestedBy:string;allowedReviewers:string[];expiresAt:string;channel:"slack"|"email"|"internal";revision:string }
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const email=(v:unknown):v is string=>typeof v==="string"&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)&&v.length<=254;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
export function readControlConfig(env:NodeJS.ProcessEnv):ControlConfig|undefined {
 if(!env.LOOPLABS_CONTROL_CONFIG&&!env.LOOPLABS_APPROVAL_SIGNING_SECRET)return undefined;
 const c=JSON.parse(env.LOOPLABS_CONTROL_CONFIG??"null");const secret=env.LOOPLABS_APPROVAL_SIGNING_SECRET??"";
 if(!object(c)||Object.keys(c).sort().join()!=="allowSelfReview,reviewerMap,scope"||!object(c.scope)||Object.keys(c.scope).sort().join()!=="connectionId,epoch,resourceArn,tenantId,version"||!Object.values(c.scope).every(x=>typeof x==="string"&&x.length>0&&x.length<=256)||!/^\d+$/.test(String(c.scope.version))||!/^arn:aws:bedrock-agentcore:[\w-]+:\d{12}:runtime\/[\w-]+$/.test(String(c.scope.resourceArn))||!object(c.reviewerMap)||!Object.keys(c.reviewerMap).length||Object.keys(c.reviewerMap).length>20||!Object.entries(c.reviewerMap).every(([e,id])=>email(e)&&typeof id==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(id))||new Set(Object.values(c.reviewerMap)).size!==Object.keys(c.reviewerMap).length||typeof c.allowSelfReview!=="boolean"||! /^[a-f0-9]{64,128}$/.test(secret))throw Error("Invalid reviewed LoopLabs control configuration");
 return {...c,secret} as unknown as ControlConfig;
}
export const sameScope=(a:ControlScope,b:ControlScope)=>Object.entries(a).every(([k,v])=>b[k as keyof ControlScope]===v)&&Object.keys(a).length===5&&Object.keys(b).length===5;
function customer(r:RunRecord){const i=r.input as {customer?:{email?:unknown}};return email(i.customer?.email)?i.customer!.email as string:null;}
function channel(r:RunRecord):"slack"|"email"|"internal"{const c=(r.input as {channel?:string}).channel??r.labels.trigger;return c==="slack"?"slack":c?.includes("email")?"email":"internal";}
function protectedState(r:RunRecord){return hash([r.workflow,r.input,r.requestedBy,r.agents,r.output,r.actions.map(a=>[a.id,a.kind,a.provider,a.agent,a.gate,a.summary]),r.approval?.approvers,r.approval?.expiresAt]);}
export function approvalRevision(a:Omit<Approval,"revision">){return hash([a.id,a.runId,a.policyVersion,a.title,a.reason,a.action,a.system,a.before,a.after,a.requestedBy,a.allowedReviewers,a.expiresAt,a.channel]);}
function freeze(r:RunRecord,c:ControlConfig):Approval|undefined {
 const requestedBy=customer(r);const allowedReviewers=Object.entries(c.reviewerMap).filter(([,id])=>r.approval?.approvers.includes(id)).map(([e])=>e).sort();
 if(!requestedBy||!allowedReviewers.length||!r.approval||!r.output)return undefined;
 const request=(r.input as {stage?:string}).stage==="request";const offer=r.output.refundOffer as {amountMinor?:number;currency?:string}|undefined;
 const refundMinor=request?offer?.amountMinor:r.output.refundMinor;const currency=request?offer?.currency:r.output.currency;const method=request?null:({original_payment:"the original payment method",store_credit:"store credit",gift_card:"a gift card"} as Record<string,string>)[String(r.output.refundMethod)];
 if(!request&&(!Number.isSafeInteger(refundMinor)||Number(refundMinor)<=0||typeof currency!=="string"||! /^[a-z]{3}$/.test(currency)||!method))return undefined;
 const amount=Number.isSafeInteger(refundMinor)&&Number(refundMinor)>=0?`${String(currency??"usd").toUpperCase()} ${(Number(refundMinor)/100).toFixed(2)}`:"not reported";
 const a={id:"APR-"+hash(r.runId).slice(0,16),runId:r.runId,policyVersion:"cxl-"+hash([r.output.policyVersion,c.scope.version,r.actions.map(a=>[a.kind,a.gate,a.summary])]).slice(0,24),title:request?"Review cancellation exception":"Review cancellation refund",reason:request?"The cancellation policy requires an authorized exception decision.":"The refund policy requires an authorized decision for this amount.",action:request?"Cancel the subscription and publish the reviewed refund offer":"Issue the reviewed refund and publish confirmation",system:request?"Stripe, Zendesk and Slack":"Stripe or Square, Zendesk and Slack",before:request?"Subscription not yet canceled by this request":"Refund not yet issued by this request",after:request?`Cancel subscription; refund offer ${amount}`:`Refund ${amount} to ${method}; publish confirmation`,requestedBy,allowedReviewers,expiresAt:r.approval.expiresAt,channel:channel(r)};
 return {...a,revision:approvalRevision(a)};
}
/** Events are saved with native state before emission; re-emission keeps IDs/content stable. */
export function checkpoint(previous:RunRecord|undefined,r:RunRecord,c:ControlConfig,at:string){
 if(!r.control||!sameScope(r.control.scope,c.scope))return;
 const add=(name:string,key:string,extra:Record<string,unknown>={})=>r.control!.events.push({schema_version:"1.0",event_name:name,event_id:"evt_"+String(r.control!.events.length).padStart(4,"0")+"_"+hash([r.runId,key]).slice(0,32),run_id:r.runId,action_id:null,timestamp:at,attempt:1,trace_id:hash(r.runId).slice(0,32),span_id:hash([r.runId,key]).slice(0,16),trigger_channel:channel(r),agent_deployment_version:c.scope.version,...extra});
 if(!previous)add("workflow.started","start");
 for(const a of r.agents)if(!previous?.agents.some(p=>p.name===a.name&&p.status===a.status))add(a.status==="ok"?"action.completed":"action.failed",`role:${a.name}:${a.status}`,{action_id:"role_"+hash(a.name).slice(0,16),action_name:a.name,provider:"internal"});
 if(r.output&&!previous?.output)add("policy.evaluated","policy",{rule_id:"cancellation-policy",rule_version:String(r.output.policyVersion??"not_reported"),decision:r.actions.some(a=>a.gate==="approval")?"needs_approval":["cancel","refund"].includes(String(r.output.decision))?"allow":"review_required"});
 for(const a of r.actions){const prior=previous?.actions.find(p=>p.id===a.id);if(prior?.status===a.status)continue;const event=a.status==="applied"?"action.completed":a.status==="failed"?"action.failed":a.status==="pending_approval"?"action.withheld":"action.proposed";add(event,`action:${a.id}:${a.status}:${a.attempts}`,{action_id:"action_"+hash(a.id).slice(0,16),action_name:a.kind,provider:a.provider,attempt:Math.max(1,a.attempts),...(r.control.frozen?{approval_id:r.control.frozen.id}:{})});}
 if(r.phase==="AWAITING_APPROVAL"&&previous?.phase!==r.phase){r.control.frozen=freeze(r,c);r.control.stateHash=protectedState(r);add("approval.requested","approval-requested",r.control.frozen?{approval_id:r.control.frozen.id}:{});add("workflow.paused","paused",{outcome:"awaiting_approval"});}
 if(r.approval?.decision&&!previous?.approval?.decision){add(r.approval.decision==="approve"?"approval.approved":"approval.rejected","decision",r.control.frozen?{approval_id:r.control.frozen.id}:{});if(r.approval.decision==="approve")add("workflow.resumed","resumed");}
 if(r.phase==="EXPIRED"&&previous?.phase!==r.phase)add("approval.expired","expired");
 if(["DONE","REJECTED","EXPIRED","CANCELLED","FAILED"].includes(r.phase)&&previous?.phase!==r.phase)add("workflow.finished","finished:"+r.phase,{outcome:r.phase==="DONE"?(r.actions.some(a=>a.status==="failed")?"partial":"completed"):r.phase.toLowerCase()});
 if(r.control.events.length>500)throw Error("Control event limit exceeded");
}
export function validateReviewed(r:RunRecord,c:ControlConfig,expected?:{revision:string;policyVersion:string}) {
 if(!r.control||!sameScope(r.control.scope,c.scope)||!r.control.frozen||r.control.stateHash!==protectedState(r))return false;
 return !expected||(r.control.frozen.revision===expected.revision&&r.control.frozen.policyVersion===expected.policyVersion);
}
export function approvalView(r:RunRecord,c:ControlConfig){
 const a=r.control?.frozen;if(!a||!r.control||!sameScope(r.control.scope,c.scope))return null;
 const decidedBy=Object.entries(c.reviewerMap).find(([,id])=>id===r.approval?.decidedBy)?.[0]??null;
 const status=r.approval?.decision==="approve"?"approved":r.approval?.decision==="reject"?"rejected":r.phase==="EXPIRED"?"expired":r.phase==="CANCELLED"?"cancelled":"pending";
 if((status==="approved"||status==="rejected")&&!decidedBy)return null;
 return {...a,status,decidedBy,decidedAt:r.approval?.decidedAt??null,executionStatus:r.phase==="AWAITING_APPROVAL"?"held":r.phase==="DONE"?r.actions.some(a=>a.status==="failed")?"failed":"completed":r.phase==="APPROVED"?"running":"uncertain"};
}
export async function controlEnvelope(engine:Engine<unknown>,store:KvStore,c:ControlConfig,payload:unknown,now=Date.now){
 const fail=(status:number)=>({status,body:Buffer.from('{"error":"Approval request refused"}').toString("base64"),headers:{"content-type":"application/json"}});
 try{
  if(!object(payload)||Object.keys(payload).sort().join()!=="headers,method,path,raw_body"||payload.method!=="POST"||payload.path!=="/looplabs/approval-bridge"||!object(payload.headers)||typeof payload.raw_body!=="string"||Buffer.byteLength(payload.raw_body)>16384)return fail(400);
  const raw=payload.raw_body;const signature=payload.headers["x-looplabs-signature"];const expected=createHmac("sha256",c.secret).update("request\n"+raw).digest();
  if(typeof signature!=="string"||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(expected,Buffer.from(signature,"hex")))return fail(401);
  const v:unknown=JSON.parse(raw);if(!object(v)||v.contract!=="looplabs-shared-approval-1"||!object(v.scope)||!sameScope(v.scope as unknown as ControlScope,c.scope)||typeof v.nonce!=="string"||! /^[a-f0-9-]{36}$/.test(v.nonce)||typeof v.timestamp!=="string"||!/^\d{10}$/.test(v.timestamp)||Math.abs(now()/1000-Number(v.timestamp))>60)return fail(409);
  const keys=v.operation==="list"?"contract,nonce,operation,scope,timestamp":"contract,decision,decisionId,id,nonce,operation,policyVersion,reviewer,revision,scope,timestamp";
  if(Object.keys(v).sort().join()!==keys||!["list","decide"].includes(String(v.operation)))return fail(400);
  if(!await store.create({pk:"control-nonce#"+hash(v.nonce),ttl:Math.floor(now()/1000)+120}))return fail(409);
  if(v.operation==="decide"){
   if(!email(v.reviewer)||!c.reviewerMap[v.reviewer]||! /^[a-f0-9]{64}$/.test(String(v.revision))||! /^[a-f0-9]{64}$/.test(String(v.decisionId))||!["approved","rejected"].includes(String(v.decision)))return fail(409);
   const rows=await engine.controlRuns();const run=rows.find(r=>r.control?.frozen?.id===v.id);const a=run&&approvalView(run,c);
   if(!run||!a||!a.allowedReviewers.includes(v.reviewer)||(a.requestedBy===v.reviewer&&!c.allowSelfReview)||v.decisionId!==hash([c.scope.tenantId,c.scope.resourceArn,a.id,v.revision,v.reviewer,v.decision]))return fail(409);
   const reply=await engine.decideReviewed(run.runId,v.reviewer,c.reviewerMap[v.reviewer]!,String(v.decision),String(v.revision),String(v.policyVersion));if(reply.status!==200)return fail(reply.status);
  }
  const requests=(await engine.controlRuns()).map(r=>approvalView(r,c)).filter(x=>x!==null);if(requests.length>100)return fail(503);
  const response=JSON.stringify({nonce:v.nonce,requests});if(Buffer.byteLength(response)>131072)return fail(503);
  const signed=createHmac("sha256",c.secret).update("response\n"+createHash("sha256").update(raw).digest("hex")+"\n"+response).digest("hex");return {status:200,body:Buffer.from(response).toString("base64"),headers:{"content-type":"application/json","x-looplabs-response-signature":signed}};
 }catch{return fail(503);}
}
