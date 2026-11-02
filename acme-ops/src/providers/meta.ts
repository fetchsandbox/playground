import {FatalError} from "../kit/errors";
import type {ProviderHttp} from "../kit/http";
import {assertNativeMetaWrite,NATIVE_META_SANDBOX} from "./meta-native-sandbox";
export type MetaAd={id:string;name:string;account_id:string;adset_id:string;creative:{id:string};status:string};
export type MetaCreative={id:string;account_id:string;name:string;object_story_spec:Record<string,unknown>};
export class MetaClient {
 constructor(readonly http:ProviderHttp,readonly pageHttp?:ProviderHttp) {}
 private forFields(fields:string){return fields.split(",").includes("object_story_spec")&&this.pageHttp?this.pageHttp:this.http;}
 private checkAccount(account:string){if(this.pageHttp&&account!==NATIVE_META_SANDBOX.account)throw new FatalError("Native Meta account is outside the qualified sandbox");}
 async creative(id:string):Promise<MetaCreative>{return await this.node(id,"id,name,account_id,object_story_spec") as MetaCreative;}
 async ad(id:string):Promise<MetaAd>{return await this.node(id,"id,name,account_id,adset_id,creative,status") as MetaAd;}
 async ads(account:string):Promise<MetaAd[]>{return await this.nodes(account,"ads","id,name,account_id,adset_id,creative,status") as unknown as MetaAd[];}
 async nodes(account:string,edge:"campaigns"|"adsets"|"adcreatives"|"ads",fields:string):Promise<Record<string,unknown>[]> {
  this.checkAccount(account);
  const result:Record<string,unknown>[]=[];let after:string|undefined;const seen=new Set<string>();
  for(let page=0;page<50;page++){
   const {body}=await this.forFields(fields).request<{data:Record<string,unknown>[];paging?:{next?:string;cursors?:{after?:string}}}>("GET",`/v26.0/${account}/${edge}`,{query:{fields,limit:100,after}});
   if(!Array.isArray(body.data))throw new FatalError("Meta list did not return data");
   for(const row of body.data){if(this.pageHttp&&row.account_id!==NATIVE_META_SANDBOX.account.slice(4))throw new FatalError("Native Meta scan returned a different or unverified account");const id=String(row.id??"");if(!id||seen.has(id))throw new FatalError("Meta scan repeated a node; recovery held");seen.add(id);result.push(row);}
   if(!body.paging?.next)return result;
   const cursor=body.paging.cursors?.after;if(!cursor||cursor===after)throw new FatalError("Meta pagination is incomplete; recovery held");after=cursor;
  }
  throw new FatalError("Meta scan exceeded page bound; recovery held");
 }
 async node(id:string,fields:string):Promise<Record<string,unknown>> {const row=(await this.forFields(fields).request<Record<string,unknown>>("GET",`/v26.0/${encodeURIComponent(id)}`,{query:{fields}})).body;if(this.pageHttp&&row.account_id!==NATIVE_META_SANDBOX.account.slice(4))throw new FatalError("Native Meta read returned a different or unverified account");return row;}
 async prepare(account:string,edge:"campaigns"|"adsets"|"adcreatives"|"ads",payload:Record<string,unknown>):Promise<string> {
  if(this.pageHttp)assertNativeMetaWrite(account,edge,payload);
  const form=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,typeof v==="object"?JSON.stringify(v):v])) as Record<string,string|number>;
  const transport=this.pageHttp&&["adcreatives","ads"].includes(edge)?this.pageHttp:this.http;
  const {body}=await transport.request<{id?:string}>("POST",`/v26.0/${account}/${edge}`,{form,retry:false,timeoutMs:Number(process.env.META_WRITE_TIMEOUT_MS??1500)});
  if(!body.id)throw new FatalError("Meta preparation not confirmed; observe before retry");return body.id;
 }
 async create(account:string,payload:{name:string;adset_id:string;creative:{creative_id:string};status:"PAUSED"}):Promise<string>{
  if(this.pageHttp)return this.prepare(account,"ads",payload);
  const {body}=await this.http.request<{id?:string}>("POST",`/v26.0/${account}/ads`,{form:{name:payload.name,adset_id:payload.adset_id,creative:JSON.stringify(payload.creative),status:payload.status},retry:false,timeoutMs:Number(process.env.META_WRITE_TIMEOUT_MS??1500)});
  if(!body?.id)throw new FatalError("Meta creation not confirmed; verify before retry");
  return body.id;
 }
}
