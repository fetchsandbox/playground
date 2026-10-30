import {afterEach, describe, expect, it} from "vitest";
import {createHash, createHmac, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FileStore} from "../src/kit/store";
import {approvalView, controlEnvelope, type ControlConfig} from "../src/kit/looplabs-control";
import type {Engine} from "../src/kit/engine";
import {productCancellation} from "../src/workflows/product-cancellation";
import {NOW, startWorld, type World} from "./fake-world";

// Same application/provider contract in both modes. Native approval remains on.
// This is local application evidence, not a deployed or LangGraph acceptance test.
const control: ControlConfig = {scope:{tenantId:"acme",connectionId:"comparison",resourceArn:"arn:aws:bedrock-agentcore:us-west-2:342206308838:runtime/acme_product_cancellation-demo",version:"1",epoch:"comparison-1"},secret:"a".repeat(64),reviewerMap:{"reviewer@example.test":"U_MANAGER"},allowSelfReview:false};
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const resources: {world:World;dir:string}[]=[];
afterEach(async()=>{for(const {world,dir} of resources.splice(0)){await world.close();rmSync(dir,{recursive:true,force:true});}});
async function fixture(withControl:boolean){
 const w=await startWorld(),dir=mkdtempSync(join(tmpdir(),"acme-control-comparison-"));resources.push({world:w,dir});
 const file=join(dir,"state.json");
 w.state.zendesk.tickets.push({id:4242,subject:"Cancellation",status:"new",requester_id:777,tags:[],updated_at:"2026-10-14T00:00:00Z"});
 const product={id:"prod_contract",name:"Monitor Pro contract",active:true,metadata:{acme_cancellation:"contract",acme_min_term_months:"12"}};
 const price={id:"price_contract",active:true,currency:"usd",unit_amount:2500,product:product.id,recurring:{interval:"month"}};
 w.state.stripe.products.push(product);w.state.stripe.prices.push(price);
 const sub={id:"sub_contract",customer:"cus_alice",status:"active",start_date:Math.floor((NOW-86400000)/1000),items:{data:[{price,quantity:1}]},metadata:{}};
 w.state.stripe.subscriptions.push(sub);
 const events:Record<string,unknown>[]=[];
 const make=()=>{const store=new FileStore(file);return {store,engine:w.engine(productCancellation,{store,now:()=>NOW,approvers:["U_MANAGER"],...(withControl?{control,controlSink:e=>events.push(e)}:{})})};};
 const start=async()=>{const f=make();await f.engine.handle({action:"start",runId:"comparison",requestedBy:{userId:"U_REQUESTER"},input:{stage:"request",channel:"slack",ticketId:4242,subscriptionId:sub.id,customer:{email:"alice@acmecorp.com"},message:"Please cancel my subscription",opsChannel:"C0SUPPORT1",approvers:["U_MANAGER"]}});return f;};
 return {w,sub,events,make,start};
}
async function signed(f:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>,over:Record<string,unknown>={}){
 const r=(await f.engine.load("comparison"))!,a=approvalView(r,control)!;
 const c={operation:"decide",id:a.id,revision:a.revision,policyVersion:a.policyVersion,reviewer:"reviewer@example.test",decision:"approved",...over};
 const raw=JSON.stringify({contract:"looplabs-shared-approval-1",scope:control.scope,nonce:randomUUID(),timestamp:String(NOW/1000),...c,decisionId:hash([control.scope.tenantId,control.scope.resourceArn,c.id,c.revision,c.reviewer,c.decision])});
 return controlEnvelope(f.engine as Engine<unknown>,f.store,control,{method:"POST",path:"/looplabs/approval-bridge",raw_body:raw,headers:{"x-looplabs-signature":createHmac("sha256",control.secret).update("request\n"+raw).digest("hex")}},()=>NOW);
}
describe.each([false,true])("same cancellation application: LoopLabs=%s",withControl=>{
 it("holds the 12-month contract before the Stripe cancellation",async()=>{const x=await fixture(withControl),f=await x.start();expect((await f.engine.load("comparison"))?.phase).toBe("AWAITING_APPROVAL");expect(x.sub.status).toBe("active");expect(x.w.requests.filter(r=>r.method==="DELETE"&&r.path.includes("/subscriptions/"))).toHaveLength(0);expect(x.events.some(e=>e.event_name==="approval.requested")).toBe(withControl);});
 it("refuses an unconfigured native reviewer",async()=>{const x=await fixture(withControl),f=await x.start();expect((await f.engine.handle({action:"decide",runId:"comparison",userId:"U_STRANGER",decision:"approve"})).status).toBe(403);expect(x.sub.status).toBe("active");});
 it("recovers the held checkpoint in a new engine/store and executes once across decision replay",async()=>{const x=await fixture(withControl);await x.start();const f=x.make();expect((await f.engine.load("comparison"))?.phase).toBe("AWAITING_APPROVAL");if(withControl)expect((await signed(f)).status).toBe(200);else expect((await f.engine.handle({action:"decide",runId:"comparison",userId:"U_MANAGER",decision:"approve"})).status).toBe(200);await f.engine.idle();expect(x.sub.status).toBe("canceled");const before=x.w.requests.filter(r=>r.method==="DELETE"&&r.path.includes("/subscriptions/")).length;expect(before).toBe(1);if(withControl)expect((await signed(f)).status).toBe(200);else await f.engine.handle({action:"decide",runId:"comparison",userId:"U_MANAGER",decision:"approve"});await f.engine.idle();expect(x.w.requests.filter(r=>r.method==="DELETE"&&r.path.includes("/subscriptions/"))).toHaveLength(before);expect((await f.engine.load("comparison"))?.phase).toBe("DONE");});
 it("honors rejection without canceling the subscription",async()=>{const x=await fixture(withControl),f=await x.start();if(withControl)expect((await signed(f,{decision:"rejected"})).status).toBe(200);else await f.engine.handle({action:"decide",runId:"comparison",userId:"U_MANAGER",decision:"reject"});await f.engine.idle();expect((await f.engine.load("comparison"))?.phase).toBe("REJECTED");expect(x.sub.status).toBe("active");});
});
describe("external review additions",()=>{
 it.each([{reviewer:"stranger@example.test"},{revision:"f".repeat(64)},{policyVersion:"old-policy"}])("refuses mismatched external authority or reviewed request %#",async over=>{const x=await fixture(true),f=await x.start();expect((await signed(f,over)).status).toBe(409);expect(x.sub.status).toBe("active");});
});
