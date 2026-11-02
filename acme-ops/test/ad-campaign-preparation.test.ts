import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {createHmac,randomUUID} from "node:crypto";
import {approvalView,controlEnvelope,type ControlConfig} from "../src/kit/looplabs-control";
import type {Engine} from "../src/kit/engine";
import {adHash} from "../src/workflows/ad-creative-publishing";
import {MemoryStore} from "../src/kit/store";
import {providerFactory} from "../src/providers";
import {adCampaignPreparation,preparationPolicy} from "../src/workflows/ad-campaign-preparation";
import {startWorld,type World,NOW} from "./fake-world";
const input={organization:"Acme",customer:{email:"builder@example.test"},platform:"instagram" as const,title:"Pergola campaign",message:"Plan a pergola",link:"https://example.test/pergolas",dailyBudgetMinor:1000};
describe("campaign preparation review boundary",()=>{
 let w:World;beforeEach(async()=>{w=await startWorld();});afterEach(async()=>{delete process.env.AD_PREPARATION_POLICY_JSON;await w.close();});
 function setup(){return w.engine(adCampaignPreparation,{now:()=>NOW,approvers:["U_OWNER"]});}
 it("freezes four ordered pending effects, platform and budget before any write",async()=>{const e=setup();const r=await e.handle({action:"start",runId:"prepare",requestedBy:{userId:"U_BUILDER"},input});expect(r.body.phase).toBe("AWAITING_APPROVAL");expect(r.body.actions).toHaveLength(4);expect(r.body.output.reviewedInput.platform).toBe("instagram");expect(r.body.output.reviewedInput.dailyBudgetMinor).toBe(1000);expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(0);});
 it.each([{dailyBudgetMinor:1001},{organization:"Other business"},{link:"https://unapproved.test/"},{link:"https://user:password@example.test/"}])("refuses an out-of-policy request without writes: %j",async over=>{const e=setup();const r=await e.handle({action:"start",runId:"prepare",requestedBy:{userId:"U_BUILDER"},input:{...input,...over}});expect(r.body.outcome).not.toBe("ok");expect(r.body.actions).toHaveLength(0);expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(0);});
 it("refuses the wrong reviewer and a policy change at execution",async()=>{const e=setup();await e.handle({action:"start",runId:"prepare",requestedBy:{userId:"U_BUILDER"},input});expect((await e.handle({action:"decide",runId:"prepare",userId:"U_STRANGER",decision:"approve"})).status).toBe(403);process.env.AD_PREPARATION_POLICY_JSON=JSON.stringify({...preparationPolicy(),version:"changed"});await e.handle({action:"decide",runId:"prepare",userId:"U_OWNER",decision:"approve"});expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(0);});
 it.each([false,true])("checks audience values and stops dependent writes on expansion drift: %s",async drift=>{
  const factory=providerFactory(w.endpoints(["meta"]));const clients=factory({runId:"audience"} as any);const rows=new Map<string,Record<string,unknown>>();const writes:string[]=[];
  clients.meta!.prepare=async(_account,edge,payload)=>{const id=String(rows.size+1);writes.push(edge);const row=structuredClone(payload);if(edge==="ads")row.creative={id:(row.creative as any).creative_id};rows.set(id,{...row,id,account_id:"1001"});return id;};
  clients.meta!.node=async id=>{const row=structuredClone(rows.get(id)!);if(drift&&row.targeting)(row.targeting as any).targeting_automation.advantage_audience=1;return row;};
  const e=w.engine(adCampaignPreparation,{now:()=>NOW,approvers:["U_OWNER"],providers:()=>clients});const pending=await e.handle({action:"start",runId:"audience",requestedBy:{userId:"U_BUILDER"},input});
  expect((pending.body.actions[1] as any).summary.audience.advantageAudience).toBe(false);
  const result=await e.handle({action:"decide",runId:"audience",userId:"U_OWNER",decision:"approve"});
  expect(result.body.outcome).toBe(drift?"partial":"ok");expect(writes).toEqual(drift?["campaigns","adsets"]:["campaigns","adsets","adcreatives","ads"]);
  if(!drift){const check=await e.handle({action:"reconcile",runId:"audience"});expect(check.body.actions.every((a:any)=>a.reconcile.status==="match")).toBe(true);}
 });
 it.each(["normal","lost","known_ref","duplicate","story_conflict","bad_name","later_rename"])("handles native creative naming and recovery: %s",async mode=>{
  const clients=providerFactory(w.endpoints(["meta"]))({} as any);const rows=new Map<string,Record<string,any>>();const writes:string[]=[];let creativeId="";let readFailed=false;let rename=false;
  clients.meta!.prepare=async(_account,edge,payload)=>{writes.push(edge);const id=String(rows.size+1);const row=structuredClone(payload) as any;row.id=id;row.account_id="1001";if(edge==="ads")row.creative={id:row.creative.creative_id};if(edge==="adcreatives"){creativeId=id;row.name+=mode==="bad_name"?" arbitrary edit":" 2026-11-01-"+"a".repeat(32);if(mode==="story_conflict")row.object_story_spec.link_data.image_hash="different-image";}rows.set(id,row);
   if(edge==="adcreatives"&&mode==="duplicate")rows.set("duplicate",{...structuredClone(row),id:"duplicate",name:payload.name+" 2026-11-01-"+"b".repeat(32)});
   if(edge==="adcreatives"&&["lost","duplicate","story_conflict"].includes(mode))throw new Error("accepted response lost");return id;};
  clients.meta!.node=async id=>{if(mode==="known_ref"&&id===creativeId&&!readFailed){readFailed=true;throw new Error("temporary GET failure");}const row=structuredClone(rows.get(id)!);if(rename&&id===creativeId)row.name=String(row.name).replace("a".repeat(32),"b".repeat(32));return row;};
  clients.meta!.nodes=async(_account,edge)=>{if(mode==="known_ref")throw new Error("list unavailable; saved ID must suffice");return [...rows.values()].filter(r=>edge==="adcreatives"?r.object_story_spec:edge==="ads"?r.creative:edge==="adsets"?r.targeting:!!r.objective);};
  const store=new MemoryStore();const engine=()=>w.engine(adCampaignPreparation,{now:()=>NOW,approvers:["U_OWNER"],providers:()=>clients,store});let e=engine();await e.handle({action:"start",runId:"native-name-"+mode,requestedBy:{userId:"U_BUILDER"},input});let result=await e.handle({action:"decide",runId:"native-name-"+mode,userId:"U_OWNER",decision:"approve"});
  if(mode!=="normal"&&mode!=="later_rename"){e=engine();result=await e.handle({action:"resume",runId:"native-name-"+mode});}
  const success=["normal","lost","known_ref","later_rename"].includes(mode);expect(result.body.outcome).toBe(success?"ok":"partial");expect(writes.filter(x=>x==="adcreatives")).toHaveLength(1);expect(writes.includes("ads")).toBe(success);
  if(success){expect((result.body.actions[2] as any).detail.observedName).toBe(rows.get(creativeId)!.name);rename=mode==="later_rename";const reconciled=await e.handle({action:"reconcile",runId:"native-name-"+mode});expect((reconciled.body.actions[2] as any).reconcile.status).toBe(rename?"drift":"match");}
 });
 it("binds creative requests to the run even when business content is identical",async()=>{
  const clients=providerFactory(w.endpoints(["meta"]))({} as any);const requested:string[]=[];const rows=new Map<string,Record<string,unknown>>();
  clients.meta!.prepare=async(_account,edge,payload)=>{const id=String(rows.size+1);if(edge==="adcreatives")requested.push(String(payload.name));const row=structuredClone(payload);if(edge==="ads")row.creative={id:(row.creative as any).creative_id};rows.set(id,{...row,id,account_id:"1001"});return id;};clients.meta!.node=async id=>rows.get(id)!;
  const e=w.engine(adCampaignPreparation,{now:()=>NOW,approvers:["U_OWNER"],providers:()=>clients});for(const runId of ["first-identical","second-identical"]){await e.handle({action:"start",runId,requestedBy:{userId:"U_BUILDER"},input});expect((await e.handle({action:"decide",runId,userId:"U_OWNER",decision:"approve"})).body.outcome).toBe("ok");}
  expect(requested).toHaveLength(2);expect(requested[0]).not.toBe(requested[1]);expect(requested.every(n=>/ \[FS:[a-f0-9]{24}\]$/.test(n))).toBe(true);
 });

 it.each(["bridge","native"])("refuses requester self-review despite a different customer email through %s",async route=>{
  const control:ControlConfig={scope:{tenantId:"acme",connectionId:"preparation-test",resourceArn:"arn:aws:bedrock-agentcore:us-west-2:342206308838:runtime/acme_ad_campaign_preparation-demo",version:"4",epoch:"identity-test"},secret:"a".repeat(64),reviewerMap:{"owner@example.test":"U_OWNER"},allowSelfReview:false};
  const store=new MemoryStore();const makeEngine=()=>w.engine(adCampaignPreparation,{store,now:()=>NOW,approvers:["U_OWNER"],control,requireReviewedDecisions:true});
  let e=makeEngine();await e.handle({action:"start",runId:"self-review",requestedBy:{userId:"U_OWNER"},input});
  e=makeEngine();const a=approvalView((await e.load("self-review"))!,control)!;
  expect(a.requestedBy).toBe("owner@example.test");
  if(route==="native")expect((await e.decideReviewed(a.runId,"owner@example.test","U_OWNER","approved",a.revision,a.policyVersion)).status).toBe(403);
  else {
   const reviewer="owner@example.test",decision="approved";const raw=JSON.stringify({contract:"looplabs-shared-approval-1",scope:control.scope,nonce:randomUUID(),timestamp:String(NOW/1000),operation:"decide",id:a.id,revision:a.revision,policyVersion:a.policyVersion,decision,reviewer,decisionId:adHash([control.scope.tenantId,control.scope.resourceArn,a.id,a.revision,reviewer,decision])});
   expect((await controlEnvelope(e as Engine<unknown>,store,control,{method:"POST",path:"/looplabs/approval-bridge",raw_body:raw,headers:{"x-looplabs-signature":createHmac("sha256",control.secret).update("request\n"+raw).digest("hex")}},()=>NOW)).status).toBe(409);
  }
  await e.idle();expect((await e.load("self-review"))!.phase).toBe("AWAITING_APPROVAL");expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(0);
 });

 it.each(["approve","reject","stale","wrong_reviewer","changed_input","changed_policy"])("binds LoopLabs preparation review and refuses changed authority: %s",async mode=>{
  const control:ControlConfig={scope:{tenantId:"acme",connectionId:"preparation-test",resourceArn:"arn:aws:bedrock-agentcore:us-west-2:342206308838:runtime/acme_ad_campaign_preparation-demo",version:"3",epoch:"test"},secret:"a".repeat(64),reviewerMap:{"owner@example.test":"U_OWNER"},allowSelfReview:false};
  const store=new MemoryStore(),events:Record<string,unknown>[]=[];const e=w.engine(adCampaignPreparation,{store,now:()=>NOW,approvers:["U_OWNER"],control,controlSink:event=>events.push(event),requireReviewedDecisions:true});
  await e.handle({action:"start",runId:"controlled",requestedBy:{userId:"U_BUILDER"},input});
  const run=(await e.load("controlled"))!,a=approvalView(run,control);
  expect(a).not.toBeNull();expect(a!.title).toBe("Review Instagram campaign preparation");
  expect(JSON.parse(a!.after)).toMatchObject({deliveryEnabled:false,reviewedInput:input});expect(JSON.parse(a!.after).actions).toHaveLength(4);
  expect(events.find(x=>x.event_name==="policy.evaluated")?.rule_id).toBe("ad-preparation-policy");for(const privateValue of [input.customer.email,input.link,input.message])expect(JSON.stringify(events)).not.toContain(privateValue);expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(0);
  expect((await e.handle({action:"decide",runId:run.runId,userId:"U_OWNER",decision:"approve"})).status).toBe(403);
  if(mode==="changed_input"){const saved=(await store.get("run#"+run.runId))!;(saved.input as any).dailyBudgetMinor=999;await store.replace(saved);}
  if(mode==="changed_policy")process.env.AD_PREPARATION_POLICY_JSON=JSON.stringify({...preparationPolicy(),version:"changed-after-review"});
  const decision=mode==="reject"?"rejected":"approved",reviewer=mode==="wrong_reviewer"?"stranger@example.test":"owner@example.test",revision=mode==="stale"?"f".repeat(64):a!.revision;
  async function send(){const raw=JSON.stringify({contract:"looplabs-shared-approval-1",scope:control.scope,nonce:randomUUID(),timestamp:String(NOW/1000),operation:"decide",id:a!.id,revision,policyVersion:a!.policyVersion,decision,reviewer,decisionId:adHash([control.scope.tenantId,control.scope.resourceArn,a!.id,revision,reviewer,decision])});return controlEnvelope(e as Engine<unknown>,store,control,{method:"POST",path:"/looplabs/approval-bridge",raw_body:raw,headers:{"x-looplabs-signature":createHmac("sha256",control.secret).update("request\n"+raw).digest("hex")}},()=>NOW);}
  const reply=await send();expect(reply.status).toBe(["stale","wrong_reviewer","changed_input"].includes(mode)?409:200);await e.idle();
  if(mode==="approve"){expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(4);await send();await e.idle();expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(4);expect((await e.handle({action:"reconcile",runId:run.runId})).body.actions.every((x:any)=>x.reconcile.status==="match")).toBe(true);}else {expect(w.requests.filter(x=>x.method==="POST")).toHaveLength(0);if(mode==="changed_policy")expect((await e.handle({action:"status",runId:run.runId})).body.outcome).toBe("partial");}
 });

});
