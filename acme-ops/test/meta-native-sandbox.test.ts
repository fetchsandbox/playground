import {describe,it,expect,vi} from "vitest";
import {ProviderHttp} from "../src/kit/http";
import {MetaClient} from "../src/providers/meta";
import {nativeMetaSandbox,assertNativeMetaWrite,NATIVE_META_SANDBOX as pin} from "../src/providers/meta-native-sandbox";
const env={WORKFLOW:"ad-campaign-preparation",META_EXECUTION_MODE:"native-sandbox",META_BASE_URL:"https://graph.facebook.com",META_API_KEY:"account-secret",META_PAGE_API_KEY:"page-secret",AD_PREPARATION_POLICY_JSON:JSON.stringify({...pin,maxDailyBudgetMinor:1000,destinationHosts:["fetchsandbox.com"]})};
describe("native Meta sandbox containment",()=>{
 it("requires explicit opt-in and both credentials on the exact qualified binding",()=>{
  expect(nativeMetaSandbox({})).toBe(false);expect(nativeMetaSandbox(env)).toBe(true);
  for(const change of [{META_EXECUTION_MODE:"live"},{WORKFLOW:"ad-creative-publishing"},{META_BASE_URL:"https://graph.facebook.com.evil.test"},{META_BASE_URL:"https://graph.facebook.com/"},{META_PAGE_API_KEY:""},{AD_PREPARATION_POLICY_JSON:JSON.stringify({...pin,account:"act_999",maxDailyBudgetMinor:1000,destinationHosts:["fetchsandbox.com"]})}])expect(()=>nativeMetaSandbox({...env,...change})).toThrow();
 });
 it.each(["campaigns","adsets","ads"])("rejects activation and foreign accounts before %s requests",edge=>{
  expect(()=>assertNativeMetaWrite("act_999",edge,{status:"PAUSED"})).toThrow();expect(()=>assertNativeMetaWrite(pin.account,edge,{status:"ACTIVE"})).toThrow();
 });
 it("refuses different creative identity, destination and excessive budget",()=>{
  for(const story of [{page_id:"other"},{page_id:pin.pageId,instagram_user_id:"other"},{page_id:pin.pageId,link_data:{link:"https://evil.test/"}}])expect(()=>assertNativeMetaWrite(pin.account,"adcreatives",{object_story_spec:story})).toThrow();
  expect(()=>assertNativeMetaWrite(pin.account,"adsets",{status:"PAUSED",daily_budget:1001})).toThrow();
 });
 it("routes by operation without falling back or retrying a refused Page write",async()=>{
  const account=new ProviderHttp({provider:"meta",baseUrl:"https://graph.facebook.com",token:"account-secret"});const page=new ProviderHttp({provider:"meta",baseUrl:"https://graph.facebook.com",token:"page-secret"});
  const ar=vi.spyOn(account,"request").mockResolvedValue({body:{id:"1",account_id:pin.account.slice(4)},status:200,headers:{}});const pr=vi.spyOn(page,"request").mockResolvedValue({body:{id:"2",account_id:pin.account.slice(4)},status:200,headers:{}});const m=new MetaClient(account,page);
  await m.prepare(pin.account,"campaigns",{status:"PAUSED"});expect(ar).toHaveBeenCalledTimes(1);expect(pr).not.toHaveBeenCalled();
  await m.prepare(pin.account,"adcreatives",{object_story_spec:{page_id:pin.pageId,instagram_user_id:pin.instagramUserId,link_data:{link:"https://fetchsandbox.com/mcp"}}});expect(pr).toHaveBeenCalledTimes(1);
  await m.node("2","id,account_id,object_story_spec");expect(pr).toHaveBeenCalledTimes(2);await m.node("1","id,account_id,status");expect(ar).toHaveBeenCalledTimes(2);
  pr.mockRejectedValue(new Error("permission refused"));await expect(m.prepare(pin.account,"ads",{status:"PAUSED"})).rejects.toThrow("permission refused");expect(pr).toHaveBeenCalledTimes(3);expect(pr.mock.calls[2]![2]).toMatchObject({retry:false});expect(ar).toHaveBeenCalledTimes(2);
  await expect(m.prepare(pin.account,"ads",{status:"ACTIVE"})).rejects.toThrow();expect(pr).toHaveBeenCalledTimes(3);
  ar.mockResolvedValue({body:{id:"1",account_id:"foreign"},status:200,headers:{}});await expect(m.node("1","id,account_id,status")).rejects.toThrow("different or unverified account");
 });
});
