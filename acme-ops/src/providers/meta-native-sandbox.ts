import {FatalError} from "../kit/errors";

// Qualified, cost-free developer account only. This is not a live-ad adapter.
export const NATIVE_META_SANDBOX = {
 account:"act_1280345154250951",pageId:"1055358164317651",instagramUserId:"17841412121833156",
} as const;
export function nativeMetaSandbox(env:NodeJS.ProcessEnv):boolean {
 const mode=env.META_EXECUTION_MODE;
 if(mode&&mode!=="twin"&&mode!=="native-sandbox")throw new FatalError("Unsupported Meta execution mode");
 if(mode!=="native-sandbox")return false;
 if(env.WORKFLOW!=="ad-campaign-preparation"||env.META_BASE_URL!=="https://graph.facebook.com"||!env.META_API_KEY||!env.META_PAGE_API_KEY)throw new FatalError("Native Meta sandbox requires preparation workflow, exact Graph host and both scoped credentials");
 const p=JSON.parse(env.AD_PREPARATION_POLICY_JSON??"null");
 if(!p||p.account!==NATIVE_META_SANDBOX.account||p.pageId!==NATIVE_META_SANDBOX.pageId||p.instagramUserId!==NATIVE_META_SANDBOX.instagramUserId||p.maxDailyBudgetMinor>1000||!Array.isArray(p.destinationHosts)||p.destinationHosts.length!==1||p.destinationHosts[0]!=="fetchsandbox.com")throw new FatalError("Native Meta policy is outside the qualified cost-free account and assets");
 return true;
}
export function assertNativeMetaWrite(account:string,edge:string,payload:Record<string,unknown>){
 if(account!==NATIVE_META_SANDBOX.account)throw new FatalError("Native Meta account is outside the qualified sandbox");
 if(!["campaigns","adsets","adcreatives","ads"].includes(edge))throw new FatalError("Unsupported native Meta effect");
 if(edge!=="adcreatives"&&payload.status!=="PAUSED")throw new FatalError("Native Meta activation is disabled");
 if(edge==="adsets"&&(!Number.isInteger(Number(payload.daily_budget))||Number(payload.daily_budget)<=0||Number(payload.daily_budget)>1000))throw new FatalError("Native Meta sandbox budget exceeded");
 if(edge==="adcreatives"){
  const s=payload.object_story_spec as Record<string,any>|undefined;
  if(!s||s.page_id!==NATIVE_META_SANDBOX.pageId||(s.instagram_user_id!==undefined&&s.instagram_user_id!==NATIVE_META_SANDBOX.instagramUserId)||s.link_data?.link!=="https://fetchsandbox.com/mcp")throw new FatalError("Native Meta creative assets or destination are outside the qualification scope");
 }
}
