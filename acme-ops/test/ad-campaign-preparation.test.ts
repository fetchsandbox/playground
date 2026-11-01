import {afterEach,beforeEach,describe,expect,it} from "vitest";
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
});
