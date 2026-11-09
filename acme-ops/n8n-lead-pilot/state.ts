import type {KvStore, Item} from '../src/kit/store';

type LeaseOptions = {now?:()=>number; leaseMs?:number};
/** Claims and dispatch fences use the existing store's conditional writes.
 * FileStore is single-process only; independent workers require DynamoStore.
 * Expiration permits reconciliation, never blind replay of an uncertain write.
 */
export class LeadState {
  private readonly now:()=>number;
  private readonly leaseMs:number;
  constructor(private store: KvStore, private scope:string, options:LeaseOptions={}) {
    if(typeof scope!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(scope))throw Error('Bound session scope required');
    this.now=options.now??Date.now;this.leaseMs=options.leaseMs??30000;
    if(!Number.isSafeInteger(this.leaseMs)||this.leaseMs<100||this.leaseMs>300000)throw Error('Invalid lease duration');
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
      operations:Object.fromEntries(['contact','deal','gmail','calendar'].map(s=>[s,{status:'pending'}]))};
    if(await this.store.create(initial))return {claimed:true,state:await this.store.get(pk)};
    const state=await this.store.get(pk);
    if(!state)return {claimed:false,state};
    if(state.requester!==requester)return {claimed:false,denied:true};
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
