import { afterEach, expect, it, vi } from 'vitest';
import { ProviderHttp } from '../src/kit/http';
import { ZendeskClient } from '../src/providers/zendesk';
afterEach(()=>vi.unstubAllGlobals());
const client=()=>new ZendeskClient(new ProviderHttp({provider:'zendesk',baseUrl:'https://demo.zendesk.com',token:'test-only'}, {}, 0));
it('re-reads after an atomic conflict, preserves new tags, and uses the supported ticket fields', async()=>{
 const calls:any[]=[];let read=0,write=0;
 vi.stubGlobal('fetch',vi.fn(async(_url:string,opts:any)=>{
  if(opts.method==='GET')return new Response(JSON.stringify({ticket:{id:7,tags:++read===1?['existing']:['existing','concurrent'],updated_at:read===1?'v1':'v2'}}));
  const b=JSON.parse(opts.body).ticket;calls.push(b);return ++write===1?new Response(JSON.stringify({error:'UpdateConflict'}),{status:409}):new Response(JSON.stringify({ticket:{id:7,tags:b.tags}}));
 }));
 const result=await client().updateTicket(7,{tags:['triaged'],comment:{body:'internal test note',public:false}});
 expect(result.tags).toEqual(['existing','concurrent','triaged']);expect(calls[0]).toMatchObject({safe_update:true,updated_stamp:'v1'});expect(calls[1]).toMatchObject({safe_update:true,updated_stamp:'v2'});expect(calls.every(x=>!('additional_tags' in x))).toBe(true);
});
it('refuses to replace tags when the provider has no source version', async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ticket:{id:7,tags:['existing']}})));vi.stubGlobal('fetch',fetcher);await expect(client().updateTicket(7,{tags:['triaged']})).rejects.toThrow('refusing an unsafe tag replacement');expect(fetcher).toHaveBeenCalledTimes(1);
});
