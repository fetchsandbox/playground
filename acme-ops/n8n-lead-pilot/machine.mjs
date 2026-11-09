/** Pure n8n decision logic. HTTP Request nodes perform every I/O operation.
 * pending -> in_flight -> confirmed | failed | unknown.
 * An in-flight operation found on resume is unknown, never safe to repeat.
 */
export function advance(input) {
  // This marker is emitted only after the native first-node validator rejects
  // the external body. It must terminate before claim, save or provider I/O.
  if (input?.input_denied===true || input?.result?.denied===true)return {done:true,status:'forbidden',reason:'caller_not_authorized'};
  if (input?.input_rejected === true) return {done:true,status:'rejected',reason:'invalid_input'};
  // n8n Cloud Code sandbox does not expose structuredClone.
  const c = JSON.parse(JSON.stringify(input.context ?? input));
  const r = input.result;
  if (r?.saved === true && r.state) c.state = r.state;
  const request = (kind, data, next) => ({ context: { ...c, stage: next }, request: { kind, ...data } });
  const save = (next) => request('save', { state: c.state }, next);
  const stop = (reason) => ({ done: true, lead_id: c.lead_id, status: c.state?.status ?? 'unknown', reason, state: c.state });
  const provider = (step, method, path, body, next) => request('provider', { provider: step, method, path, body }, next);
  const failed = () => !r || r.status < 200 || r.status >= 300;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(c.lead_id ?? '')) throw new Error('Invalid lead_id');
  if (c.stage === undefined) return request('claim', {}, 'claimed');
  if (c.stage === 'claimed') {
    c.state = r?.state;
    if (!r?.claimed) return stop('Existing execution owns this lead, or lead is already complete');
    c.state.owner = c.attempt;
    for (const op of Object.values(c.state.operations)) if (op.status === 'in_flight') op.status = 'unknown';
    c.index = 0;
    return save('choose');
  }
  if (c.stage === 'saved' || c.stage === 'choose') {
    if (r && r.saved === false) return stop('State compare-and-swap conflict; no next provider write');
    const steps = ['contact', 'deal', 'gmail', 'calendar'];
    while (c.index < steps.length && c.state.operations[steps[c.index]].status === 'confirmed') c.index++;
    if (c.index === steps.length) { c.state.status = 'confirmed'; c.blocked = null; return save('notify'); }
    c.step = steps[c.index];
    const op = c.state.operations[c.step];
    if (op.status === 'unknown') {
      // Reliable positive read-back can confirm; absence does not authorize resend.
      if (c.step === 'contact') return provider('hubspot','POST','/crm/v3/objects/contacts/search',{after:'0',limit:100,properties:['email','firstname'],sorts:[],filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:c.lead_id+'@example.com'}]}]},'reconciled_contact');
      if (c.step === 'gmail') return provider('gmail', 'GET', '/gmail/v1/users/me/messages?q=' + encodeURIComponent('rfc822msgid:' + c.lead_id + '@example.com'), null, 'reconciled');
      if (c.step === 'deal') return provider('hubspot', 'POST', '/crm/v3/objects/deals/search', {filterGroups:[{filters:[{propertyName:'dealname',operator:'EQ',value:'Pilot '+c.lead_id}]}],properties:['dealname','pipeline','dealstage']}, 'reconciled');
      c.state.status = 'unknown'; c.blocked = c.step; return save('notify');
    }
    if (op.status === 'failed' && !c.retry_failed) { c.state.status = 'failed'; c.blocked = c.step; return save('notify'); }
    // Calendar is never eligible until modeled Gmail acceptance is confirmed.
    if (c.step === 'calendar' && c.state.operations.gmail.status !== 'confirmed') throw new Error('Calendar gate violated');
    op.status = 'in_flight'; c.state.status = 'in_progress';
    return save('dispatch');
  }
  if (c.stage === 'dispatch') {
    if (!r?.saved) return stop('State save failed; provider write withheld');
    if (c.step === 'contact') return provider('hubspot','POST','/crm/v3/objects/contacts/search',{after:'0',limit:100,properties:['email','firstname'],sorts:[],filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:c.lead_id+'@example.com'}]}]},'contact_found');
    if (c.step === 'deal') return provider('hubspot','POST','/crm/v3/objects/deals',{properties:{dealname:'Pilot '+c.lead_id,pipeline:'default',dealstage:'appointmentscheduled'},associations:[{to:{id:c.state.operations.contact.id},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:3}]}]},'effect');
    if (c.step === 'gmail') return provider('gmail','POST','/gmail/v1/users/me/messages/send',{raw:c.raw},'effect');
    return provider('google-calendar','POST','/calendars/primary/events',{summary:'Pilot '+c.lead_id,start:{dateTime:'2026-12-01T16:00:00Z'},end:{dateTime:'2026-12-01T16:15:00Z'},attendees:[{email:c.lead_id+'@example.com'}]},'effect');
  }
  if (c.stage === 'contact_found') {
    if (failed()) { c.step = 'contact'; c.stage = 'effect'; return advance({context:c,result:r}); }
    const records = r.body?.results ?? [];
    if (records.length === 1) return advance({context:{...c,stage:'effect'},result:{status:200,body:records[0]}});
    if (records.length > 1) return stop('Ambiguous contact lookup');
    return provider('hubspot','POST','/crm/v3/objects/contacts',{properties:{email:c.lead_id+'@example.com',firstname:'Pilot'},associations:[]},'effect');
  }
  if (c.stage === 'effect') {
    const op = c.state.operations[c.step];
    if (c.step === 'deal' && !failed() && r.body?.id) {
      op.status='unknown';op.id=r.body.id;op.client_status=r.status;
      // Keep the claim while reading the accepted Deal's actual relationship.
      return save('read_deal');
    }
    const isRejection = r?.status >= 400 && r.status < 500 && ![408,409,429].includes(r.status);
    op.status = !failed() && r.body?.id ? 'confirmed' : isRejection ? 'failed' : 'unknown';
    if (op.status === 'confirmed') op.id = r.body.id;
    op.client_status = r?.status ?? null;
    if (op.status !== 'confirmed') { c.state.status = op.status; c.blocked = c.step; return save('notify'); }
    c.index++;
    return save('choose');
  }
  if (c.stage === 'reconciled_contact') {
    const records=r?.body?.results;
    if(!failed() && records?.length===1 && records[0].id && records[0].properties?.email===c.lead_id+'@example.com'){
      c.state.operations.contact={status:'confirmed',id:records[0].id,confirmation:'positive_readback'};
      c.index++;return save('choose');
    }
    c.state.status='unknown';c.blocked='contact';return save('notify');
  }
  if (c.stage === 'reconciled') {
    const records = c.step === 'gmail' ? r?.body?.messages : r?.body?.results;
    if (!failed() && records?.length === 1 && records[0].id) {
      if (c.step === 'gmail') return provider('gmail','GET','/gmail/v1/users/me/messages/'+encodeURIComponent(records[0].id),null,'reconciled_message');
      if (records[0].properties?.dealname !== 'Pilot '+c.lead_id) { c.state.status='unknown';c.blocked=c.step;return save('notify'); }
      c.state.operations.deal.id=records[0].id;
      return provider('hubspot','GET','/crm/v3/objects/deals/'+encodeURIComponent(records[0].id)+'?associations=contacts',null,'reconciled_deal');
    }
    c.state.status = 'unknown'; c.blocked = c.step; return save('notify');
  }
  if (c.stage === 'read_deal') {
    if (!r?.saved) return stop('Deal checkpoint failed; downstream writes withheld');
    return provider('hubspot','GET','/crm/v3/objects/deals/'+encodeURIComponent(c.state.operations.deal.id)+'?associations=contacts',null,'reconciled_deal');
  }
  if (c.stage === 'reconciled_deal') {
    const links=r?.body?.associations?.contacts?.results;
    if (!failed() && r.body?.id===c.state.operations.deal.id && r.body.properties?.dealname==='Pilot '+c.lead_id && links?.length===1 && links[0].id===c.state.operations.contact.id) {
      c.state.operations.deal={status:'confirmed',id:r.body.id,confirmation:'positive_readback'};
      c.index++;return save('choose');
    }
    c.state.status='unknown';c.blocked='deal';return save('notify');
  }
  if (c.stage === 'reconciled_message') {
    const headers = r?.body?.payload?.headers ?? [];
    const header = name => headers.find(h=>h.name.toLowerCase()===name)?.value;
    if (!failed() && r.body?.id && r.body.labelIds?.includes('SENT') && header('message-id') === '<'+c.lead_id+'@example.com>' && header('to') === c.lead_id+'@example.com') {
      c.state.operations.gmail={status:'confirmed',id:r.body.id,confirmation:'positive_readback'};
      c.index++;return save('choose');
    }
    c.state.status='unknown';c.blocked='gmail';return save('notify');
  }
  if (c.stage === 'notify') {
    if (!r?.saved) return stop('Final state save failed');
    const notice=c.state.notification;
    const same=notice?.outcome===c.state.status && notice?.blocked_step===(c.blocked??null);
    if(same && ['confirmed','unknown','in_flight'].includes(notice.status))return stop('Notification already accepted or outcome unknown; no duplicate send');
    c.state.notification={status:'in_flight',outcome:c.state.status,blocked_step:c.blocked??null};
    return save('dispatch_notification');
  }
  if(c.stage === 'dispatch_notification'){
    if(!r?.saved)return stop('Notification checkpoint failed; send withheld');
    return provider('slack','POST','/chat.postMessage',{channel:'C_PILOT',text:JSON.stringify({lead_id:c.lead_id,status:c.state.status,blocked_step:c.blocked})},'notified');
  }
  if (c.stage === 'notified') {
    c.state.notification = {...c.state.notification,status:r?.status === 200 && r.body?.ok === true ? 'confirmed' : 'unknown',client_status:r?.status ?? null};
    if (r?.status===429 && Number.isSafeInteger(r.retry_after_seconds) && r.retry_after_seconds>=0
      && r.retry_after_seconds<=86400 && Number.isFinite(Date.parse(r.retry_not_before))) {
      c.state.notification={...c.state.notification,status:'rate_limited',client_status:429,retry_after_seconds:r.retry_after_seconds,retry_not_before:r.retry_not_before};
    }
    return save('notification_saved');
  }
  if (c.stage === 'notification_saved') return stop(r?.saved && c.state.notification?.status === 'confirmed' ? 'Status notification accepted by twin' : 'Status notification unconfirmed');
  throw new Error('Unsupported state');
}
