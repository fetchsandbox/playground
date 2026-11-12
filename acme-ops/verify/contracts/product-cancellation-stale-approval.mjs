import base from './product-cancellation.mjs';
import {action,all,check,command,eq,restart,runs,start} from './lib.mjs';

// Retain every existing cancellation check. The new controls are independent
// operator edits, never customer-app effects or a test route added to the app.
const ids=['stale_refund_amount','stale_refund_after_restart','fresh_refund_reapproval'];
const customer=id=>({email:`stale-${id}@example.test`,name:'Robin Example'});
const input=id=>({stage:'request',channel:'email',customer:customer(id),ticketId:2001,message:'Please cancel my subscription.',opsChannel:'C0BILLING01',approvers:['U_CX_LEAD']});
const request=id=>start(id,input(id),{runId:`${id}-request-{{run_id}}`});
const choice=(id,n=1)=>start(id,{...input(id),stage:'refund_choice',choice:'original_payment'},{runId:`${id}-choice-${n}-{{run_id}}`});
const edit={provider_input:{actor:'external_operator',provider:'stripe',method:'POST',path:'/v1/subscriptions/{{step1.output.subscriptionId}}',body:{metadata:{acme_cxl_amount:'110000'}}}};
const approve=step=>command('decide',step,{decision:'approve',userId:'U_CX_LEAD'});
const stale=runs([{select:'runId',contains:'-choice-1-',required:true},action('stripe.refund_original_payment','failed',1,[{select:'error',contains:'fresh approval',required:false}]),action('zendesk.refund_confirmation','skipped')]);
const extra=[
  check(ids[0],'Old approval cannot refund after the offered amount changes',[request(ids[0]),choice(ids[0]),structuredClone(edit),approve(2)],stale),
  check(ids[1],'Restart and replay cannot revive the stale refund approval',[request(ids[1]),choice(ids[1]),structuredClone(edit),restart,approve(2),approve(2),command('resume',2)],stale),
  check(ids[2],'Changed amount requires a fresh review; approved replay refunds exactly once',[request(ids[2]),choice(ids[2]),structuredClone(edit),approve(2),choice(ids[2],2),approve(2),command('resume',2),approve(5),approve(5),restart,command('resume',5)],all(runs([],3),stale,runs([{select:'runId',contains:'-choice-2-',required:true},{select:'output.refundMinor',equals:110000,required:false},action('stripe.refund_original_payment','applied',1,[eq('attempts',1)]),action('zendesk.refund_confirmation','applied')]))),
];
const checks=[...base.checks,...extra];
const providerCheck=(collection,where,count=1)=>({provider:'stripe',collection,assertion:{select:'records[*]',required:true,count,where}});
async function seed(legs,log,context){
  const old=await base.seed(legs,log,context);
  const call=async(provider,path,body)=>{
    const leg=legs[provider];const form=provider==='stripe';
    const r=await fetch(leg.base_url+path,{method:'POST',headers:{authorization:`Bearer ${leg.api_key}`,'content-type':form?'application/x-www-form-urlencoded':'application/json'},body:form?new URLSearchParams(body).toString():JSON.stringify(body)});
    const data=await r.json();if(!r.ok)throw Error(`Stale-approval fixture ${provider} ${path}: ${r.status}`);return data;
  };
  const product=await call('stripe','/v1/products',{name:'Annual cancellation rehearsal'});
  const price=await call('stripe','/v1/prices',{product:product.id,unit_amount:'120000',currency:'usd','recurring[interval]':'year'});
  for(const c of extra){
    const cus=await call('stripe','/v1/customers',customer(c.id));
    const sub=await call('stripe','/v1/subscriptions',{customer:cus.id,'items[0][price]':price.id});
    const pi=await call('stripe','/v1/payment_intents',{customer:cus.id,amount:'120000',currency:'usd',confirm:'true',payment_method:'pm_card_visa','metadata[subscription_id]':sub.id});
    if(pi.status!=='succeeded'||!pi.latest_charge)throw Error('Stale-approval payment fixture not accepted');
    const {ticket}=await call('zendesk','/api/v2/tickets.json',{ticket:{subject:`Stale approval ${c.id}`,requester:customer(c.id),comment:{body:'Please cancel.',public:false}}});
    for(const a of c.actions)if(a.body?.input)a.body.input.ticketId=ticket.id;
    c.provider_assertions=[providerCheck('refunds',[eq('payment_intent',pi.id),eq('amount',110000),eq('currency','usd')],c.id===ids[2]?1:0),providerCheck('subscriptions',[eq('id',sub.id),{select:'metadata.acme_cxl_amount',equals:'110000',required:false}])];
    // Assert zero refunds of ANY amount in the withheld cases, not only zero
    // matching the new amount (an old-amount refund must fail this contract).
    if(c.id!==ids[2])c.provider_assertions[0].assertion.where=[eq('payment_intent',pi.id)];
    else c.provider_assertions.push(providerCheck('refunds',[eq('payment_intent',pi.id)],1));
    old[c.id]={customer:cus.id,subscription:sub.id,paymentIntent:pi.id,ticket:ticket.id};
  }
  return old;
}
export default {...base,checks,seed,context:{...base.context,goal:base.context.goal+' Also reject an old refund review after an independent operator changes the offer; require a new approval and exactly one saved refund after replay/restart.'},scope_review:[...base.scope_review,...extra.map(c=>({check_id:c.id,classification:'in_scope',reason:'Reddit-requested stale approval and replay boundary.',evidence:['acme-ops/src/workflows/product-cancellation.ts']}))],coverage:{...base.coverage,ordering_and_stale_events:ids,duplicate_replay:[...base.coverage.duplicate_replay,ids[1],ids[2]],restart_and_durability:[...base.coverage.restart_and_durability,ids[1],ids[2]]}};
