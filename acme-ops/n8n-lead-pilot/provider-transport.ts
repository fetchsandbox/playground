/** Pilot-only egress policy. Provider bindings come from the private MCP handoff;
 * callers choose an allowed operation, never a URL, credential or redirect. */
export type TwinLeg={base_url:string;api_key:string};
const routes:Record<string,Record<string,RegExp>>={
 hubspot:{POST:/^\/crm\/v3\/objects\/(contacts|deals)(\/search)?$/,GET:/^\/crm\/v3\/objects\/(contacts|deals)\/[a-zA-Z0-9_-]+(\?associations=contacts)?$/},
 gmail:{POST:/^\/gmail\/v1\/users\/me\/messages\/send$/,GET:/^\/gmail\/v1\/users\/me\/messages(\/[a-zA-Z0-9_-]+|\?q=[a-zA-Z0-9%_.~-]+)?$/},
 'google-calendar':{POST:/^\/calendars\/primary\/events$/},
 slack:{POST:/^\/chat.postMessage$/},
};
export function allowedProviderOperation(q:{provider?:unknown;method?:unknown;path?:unknown}){
 if(typeof q?.provider!=='string' || !Object.hasOwn(routes,q.provider) || typeof q.method!=='string' || typeof q.path!=='string')return false;
 const methods=routes[q.provider];
 if(!methods || !Object.hasOwn(methods,q.method))return false;
 return methods[q.method]?.test(q.path)===true;
}
export async function callTwin(leg:TwinLeg,q:{method:string;path:string;body?:unknown},flowId?:string,transport:typeof fetch=fetch){
 // Exact issued namespace shape, not merely a first-party host prefix.
 if(!leg || typeof leg.base_url!=='string' || !/^https:\/\/fetchsandbox\.com\/sandbox\/[a-zA-Z0-9_-]+\/?$/.test(leg.base_url) || typeof leg.api_key!=='string' || !leg.api_key || /[\r\n]/.test(leg.api_key))throw Error('non-twin binding refused');
 try{
  const out=await transport(leg.base_url.replace(/\/$/,'')+q.path,{method:q.method,redirect:'error',headers:{authorization:`Bearer ${leg.api_key}`,'content-type':'application/json','user-agent':'fetchsandbox-n8n-pilot/1.0','x-sandbox-strict-validation':'1',...(flowId?{'x-flow-run-id':flowId}:{})},body:q.method==='POST'?JSON.stringify(q.body):undefined,signal:AbortSignal.timeout(6000)});
  return {status:out.status,body:await out.json()};
 }catch{return {status:0,body:null,transport:'unknown'};}
}
