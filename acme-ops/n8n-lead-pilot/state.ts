import type {KvStore, Item} from '../src/kit/store';

export type RecoveryPolicy = {maxLookups:number; windowMs:number; quietNotifications:boolean};
type LeaseOptions = {now?:()=>number; leaseMs?:number; recoveryPolicy?:RecoveryPolicy};
/** Claims and dispatch fences use the existing store's conditional writes.
 * FileStore is single-process only; independent workers require DynamoStore.
 * Expiration permits reconciliation, never blind replay of an uncertain write.
 */
export class LeadState {
  private readonly now:()=>number;
  private readonly leaseMs:number;
  private readonly recoveryPolicy?:RecoveryPolicy;
  constructor(private store: KvStore, private scope:string, options:LeaseOptions={}) {
    if(typeof scope!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(scope))throw Error('Bound session scope required');
    this.now=options.now??Date.now;this.leaseMs=options.leaseMs??30000;
    if(!Number.isSafeInteger(this.leaseMs)||this.leaseMs<100||this.leaseMs>300000)throw Error('Invalid lease duration');
    const p=options.recoveryPolicy;
    if(p!==undefined && (!p||typeof p!=='object'||!Number.isSafeInteger(p.maxLookups)||p.maxLookups<2||p.maxLookups>10||!Number.isSafeInteger(p.windowMs)||p.windowMs<1000||p.windowMs>86400000||typeof p.quietNotifications!=='boolean'))throw Error('Invalid recovery policy');
    this.recoveryPolicy=p?structuredClone(p):undefined;
  }
  private key(lead:string){return `lead-pilot#${this.scope}#${lead}`;}
  private live(item:Item){return typeof item.lease_expires_at==='number' && item.lease_expires_at>this.now();}
  async records(lead:string){const item=await this.store.get(this.key(lead));return item?[item]:[];}
  async recordsFor(lead:string,requester:string){
    const records=await this.records(lead);return records.length && records[0]!.requester!==requester ? {denied:true} : {records};
  }
  async claim(lead: string, owner: string, retryFailed = false, requester = 'pilot-team:pilot-owner') {
    const pk=this.key(lead);
    const initial={pk,owner,requester,status:'in_progress',epoch:1,lease_expires_at:this.now()+this.leaseMs,
      ...(this.recoveryPolicy?{recovery_policy:this.recoveryPolicy}:{}),
      operations:Object.fromEntries(['contact','deal','gmail','calendar'].map(s=>[s,{status:'pending'}]))};
    if(await this.store.create(initial))return {claimed:true,state:await this.store.get(pk)};
    const state=await this.store.get(pk);
    if(!state)return {claimed:false,state};
    if(state.requester!==requester)return {claimed:false,denied:true};
    // The business policy persists with the lead. Redelivery cannot reset its
    // lookup budget or bypass a future reconciliation time / human handoff.
    if(state.status==='needs_human')return {claimed:false,state};
    if(state.recovery_policy && state.status==='unknown' && typeof state.next_reconcile_at==='number' && state.next_reconcile_at>this.now())return {claimed:false,state};
    const notification=state.notification as {status?:string;retry_not_before?:string}|undefined;
    const deadline=Date.parse(notification?.retry_not_before??'');
    const notificationDue=state.status==='confirmed' && notification?.status==='rate_limited'
      && retryFailed && Number.isFinite(deadline) && deadline<=this.now();
    // Legacy abandoned rows without a lease are not silently taken over.
    const interrupted=state.status==='in_progress' || (state.status==='confirmed' && notification?.status!=='confirmed' && notification?.status!=='rate_limited');
    const abandoned=interrupted && typeof state.lease_expires_at==='number' && !this.live(state);
    if(!['unknown','failed'].includes(String(state.status))&&!notificationDue&&!abandoned)return {claimed:false,state};
    const next=structuredClone(state);
    if(abandoned){
      const ops=next.operations as Record<string,{status:string}>;
      for(const op of Object.values(ops))if(op.status==='in_flight')op.status='unknown';
      const notice=next.notification as {status?:string}|undefined;
      if(notice?.status==='in_flight')notice.status='unknown';
    }
    Object.assign(next,{owner,status:'in_progress',epoch:Number(state.epoch??0)+1,lease_expires_at:this.now()+this.leaseMs});
    if(!await this.store.replace(next))return {claimed:false};
    const saved=await this.store.get(pk);
    return {claimed:saved?.owner===owner && saved?.epoch===next.epoch,state:saved};
  }
  /** Timer transport enumerates persisted due work; native n8n still makes
   * every business decision under a fresh short-lived invocation ticket. */
  async due(limit=25){
    const rows=await this.store.list(`lead-pilot#${this.scope}#`);
    return rows.filter(row=>row.recovery_policy && !(typeof row.transport_retry_not_before==='number' && row.transport_retry_not_before>this.now()) && ((row.status==='unknown' && typeof row.next_reconcile_at==='number' && row.next_reconcile_at<=this.now()) || (row.status==='in_progress' && typeof row.lease_expires_at==='number' && !this.live(row))))
      .slice(0,limit).map(row=>({lead_id:row.pk.slice(`lead-pilot#${this.scope}#`.length),requester:String(row.requester)}));
  }
  async deferDue(lead:string,requester:string){
    const row=await this.store.get(this.key(lead));
    // A transport failure is not a business failure. Do not overwrite a native
    // execution that already took ownership or completed during the timeout.
    if(!row||row.requester!==requester||!(row.status==='unknown'||(row.status==='in_progress'&&!this.live(row))))return false;
    return this.store.replace({...row,transport_retry_not_before:this.now()+60000,reconciliation_transport_error:{status:'unconfirmed',observed_at:this.now()}});
  }
  async save(lead:string, owner:string, supplied:Item, requester = 'pilot-team:pilot-owner') {
    const current=await this.store.get(this.key(lead));
    if(!current||!this.live(current)||current.requester!==requester||supplied.requester!==current.requester||current.owner!==owner||supplied.pk!==current.pk||current.version!==supplied.version||supplied.epoch!==current.epoch)return {saved:false};
    const saved=await this.store.replace({...supplied,owner,epoch:current.epoch,lease_expires_at:this.now()+this.leaseMs});
    return {saved,state:saved?await this.store.get(current.pk):current};
  }
  /** CAS at dispatch, not a stale read followed by an unguarded provider call.
   * Cannot recall an already issued HTTP request; recovered in-flight writes
   * must reconcile or stay unknown, even if an old call finishes late.
   */
  async authorizeProvider(lead:string,owner:string,version:number,requester:string){
    const current=await this.store.get(this.key(lead));
    if(!current||!this.live(current)||current.requester!==requester||current.owner!==owner||current.version!==version)return {allowed:false};
    const ok=await this.store.replace({...current,lease_expires_at:this.now()+this.leaseMs});
    if(!ok)return {allowed:false};
    const state=await this.store.get(current.pk);
    return {allowed:state?.owner===owner&&state?.epoch===current.epoch,state};
  }
}
