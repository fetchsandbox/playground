import {describe,it,expect,vi} from 'vitest';
import {invokeN8n,N8N_PILOT_WEBHOOK} from '../n8n-lead-pilot/trigger';
// @ts-ignore Generated native source is deliberately plain JavaScript.
import {buildWorkflow} from '../n8n-lead-pilot/build-workflow.mjs';
// @ts-ignore The same decision source runs in native n8n.
import {advance} from '../n8n-lead-pilot/machine.mjs';
const workflow=buildWorkflow('https://adapter.example','friendly-pilot-mcp-20261106',{id:'fixture',name:'Fixture credential reference'});
const init=workflow.nodes.find((n:any)=>n.name==='Validate dummy lead').parameters.jsCode;
function nativeStart(body:unknown){return new Function('$json','$execution','Buffer',init)({body},{id:'native-fixture'},Buffer)[0].json;}
const bad=[null,[],{}, {lead_id:123},{lead_id:''},{lead_id:'bad value'},{lead_id:'x'.repeat(101)},{lead_id:'valid',unexpected:true},{lead_id:'valid',retry_failed:'yes'},{lead_id:'valid',retry_failed:1},{lead_id:'valid',input_rejected:false},JSON.parse('{"lead_id":"valid","__proto__":{}}')];
describe('native n8n first-input boundary (generated source, not a cloud receipt)',()=>{
 it.each(bad.map((value,i)=>({i,value})))('rejects invalid input $i before any state or provider request',({value})=>{
  const first=nativeStart(value);const next=advance(first);
  expect(next).toEqual({done:true,status:'rejected',reason:'invalid_input'});
  expect(next).not.toHaveProperty('request');expect(first).not.toHaveProperty('raw');
 });
 it.each([undefined,false,true])('preserves valid lead semantics with retry %s',retry=>{
  const first=nativeStart({_invocation:'fixture-only-ticket',lead_id:'ordinary-123',...(retry===undefined?{}:{retry_failed:retry})});
  expect(first).toMatchObject({lead_id:'ordinary-123',attempt:'native-fixture',retry_failed:retry===true});
  expect(Buffer.from(first.raw,'base64url').toString()).toContain('Message-ID: <ordinary-123@example.com>');
  expect(advance(first).request.kind).toBe('claim');
 });
 it('maps native rejection to HTTP 400 and valid workflow outcomes to 200',()=>{
  const expression=workflow.nodes.find((n:any)=>n.name==='Return observed workflow status').parameters.options.responseCode;
  expect(typeof expression).toBe('string');
  const status=new Function('$json','return ('+expression.slice(3,-2)+');');
  expect(status({status:'rejected'})).toBe(400);expect(status({status:'forbidden'})).toBe(403);
  for(const value of ['confirmed','unknown','failed','in_progress'])expect(status({status:value})).toBe(200);
 });
});

// Exercise both entry points with the same corpus to prevent validator drift.
it.each(bad.map((value,i)=>({i,value})))('adapter and generated native validator reject the same invalid input $i',async({value})=>{
 const transport=vi.fn();
 const result=await invokeN8n({n8n_webhook:N8N_PILOT_WEBHOOK,n8n_token:'fixture-only'},JSON.stringify(value),transport);
 expect(result.status).toBe(400);expect(transport).not.toHaveBeenCalled();
 expect(advance(nativeStart(value)).status).toBe('rejected');
});

it('native input without a trusted invocation stops before state or provider I/O',()=>{expect(advance(nativeStart({lead_id:'ordinary'}))).toEqual({done:true,status:'forbidden',reason:'caller_not_authorized'});});
