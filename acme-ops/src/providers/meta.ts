import {FatalError} from "../kit/errors";
import type {ProviderHttp} from "../kit/http";
export type MetaAd={id:string;name:string;account_id:string;adset_id:string;creative:{id:string};status:string};
export type MetaCreative={id:string;account_id:string;name:string;object_story_spec:Record<string,unknown>};
export class MetaClient {
 constructor(readonly http:ProviderHttp) {}
 async creative(id:string):Promise<MetaCreative>{return (await this.http.request<MetaCreative>("GET",`/v26.0/${encodeURIComponent(id)}`,{query:{fields:"id,name,account_id,object_story_spec"}})).body;}
 async ad(id:string):Promise<MetaAd>{return (await this.http.request<MetaAd>("GET",`/v26.0/${encodeURIComponent(id)}`,{query:{fields:"id,name,account_id,adset_id,creative,status"}})).body;}
 async ads(account:string):Promise<MetaAd[]>{return await this.nodes(account,"ads","id,name,account_id,adset_id,creative,status") as unknown as MetaAd[];}
 async nodes(account:string,edge:"campaigns"|"adsets"|"adcreatives"|"ads",fields:string):Promise<Record<string,unknown>[]> {
  const result:Record<string,unknown>[]=[];let after:string|undefined;const seen=new Set<string>();
  for(let page=0;page<50;page++){
   const {body}=await this.http.request<{data:Record<string,unknown>[];paging?:{next?:string;cursors?:{after?:string}}}>("GET",`/v26.0/${account}/${edge}`,{query:{fields,limit:100,after}});
   if(!Array.isArray(body.data))throw new FatalError("Meta list did not return data");
   for(const row of body.data){const id=String(row.id??"");if(!id||seen.has(id))throw new FatalError("Meta scan repeated a node; recovery held");seen.add(id);result.push(row);}
   if(!body.paging?.next)return result;
   const cursor=body.paging.cursors?.after;if(!cursor||cursor===after)throw new FatalError("Meta pagination is incomplete; recovery held");after=cursor;
  }
  throw new FatalError("Meta scan exceeded page bound; recovery held");
 }
 async node(id:string,fields:string):Promise<Record<string,unknown>> {return (await this.http.request<Record<string,unknown>>("GET",`/v26.0/${encodeURIComponent(id)}`,{query:{fields}})).body;}
 async prepare(account:string,edge:"campaigns"|"adsets"|"adcreatives"|"ads",payload:Record<string,unknown>):Promise<string> {
  const form=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,typeof v==="object"?JSON.stringify(v):v])) as Record<string,string|number>;
  const {body}=await this.http.request<{id?:string}>("POST",`/v26.0/${account}/${edge}`,{form,retry:false,timeoutMs:Number(process.env.META_WRITE_TIMEOUT_MS??1500)});
  if(!body.id)throw new FatalError("Meta preparation not confirmed; observe before retry");return body.id;
 }
 async create(account:string,payload:{name:string;adset_id:string;creative:{creative_id:string};status:"PAUSED"}):Promise<string>{
  const {body}=await this.http.request<{id?:string}>("POST",`/v26.0/${account}/ads`,{form:{name:payload.name,adset_id:payload.adset_id,creative:JSON.stringify(payload.creative),status:payload.status},retry:false,timeoutMs:Number(process.env.META_WRITE_TIMEOUT_MS??1500)});
  if(!body?.id)throw new FatalError("Meta creation not confirmed; verify before retry");
  return body.id;
 }
}
