import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {agentcardWebhook} from '@agent-cards/commerce-sdk';

const secret='synthetic-contract-test-secret';
const fixture=()=>({id:'evt_contract',type:'purchase.message',created:Math.floor(Date.now()/1000),livemode:false,
  data:{kind:'order_placed',user_id:'provider-a',external_user_id:'shopper-a',thread_id:'thread-a',text:'Test order confirmed.',connection:{client_id:'demo-client'}}});
function request(event,{stamp=Math.floor(Date.now()/1000),alter=false}={}){
  const body=JSON.stringify(event),signature=createHmac('sha256',secret).update(`${stamp}.${body}`).digest('hex');
  return new Request('http://localhost/webhooks/agentcard',{method:'POST',
    headers:{'agentcard-signature':`t=${stamp},v1=${signature}`},body:alter?body+' ':body});
}
test('pinned SDK reads the documented synthetic shopper/thread shape',async()=>{
  let observed;
  const handler=agentcardWebhook({secret,onMessage:(id,message)=>{observed={id,thread:message.threadId};}});
  assert.equal((await handler.fetch(request(fixture()))).status,200);
  assert.deepEqual(observed,{id:'shopper-a',thread:'thread-a'});
});
test('changed raw bytes do not authenticate even if JSON meaning is unchanged',async()=>{
  let calls=0;const handler=agentcardWebhook({secret,onMessage:()=>calls++,onError:()=>{}});
  assert.equal((await handler.fetch(request(fixture(),{alter:true}))).status,400);assert.equal(calls,0);
});
test('callback failure is retryable and not mistaken for a handled event',async()=>{
  let calls=0;const handler=agentcardWebhook({secret,onMessage:()=>{if(++calls===1)throw Error('test outage');},onError:()=>{}});
  assert.equal((await handler.fetch(request(fixture()))).status,500);
  assert.equal((await handler.fetch(request(fixture()))).status,200);assert.equal(calls,2);
});
