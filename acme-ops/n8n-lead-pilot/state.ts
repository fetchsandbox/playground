import type {KvStore, Item} from '../src/kit/store';

/** Reuses the repository conditional-write abstraction; no workflow decisions. */
export class LeadState {
  constructor(private store: KvStore, private scope:string) {
    if(typeof scope!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(scope))throw Error('Bound session scope required');
  }
  private key(lead:string){return `lead-pilot#${this.scope}#${lead}`;}
  async records(lead:string){const item=await this.store.get(this.key(lead));return item?[item]:[];}
  async recordsFor(lead:string,requester:string){
    const records=await this.records(lead);return records.length && records[0]!.requester!==requester ? {denied:true} : {records};
  }
  async claim(lead: string, owner: string, retryFailed = false, requester = 'pilot-team:pilot-owner') {
    const pk = this.key(lead);
    const initial = {pk, owner, requester, status:'in_progress', operations:Object.fromEntries(['contact','deal','gmail','calendar'].map(s=>[s,{status:'pending'}]))};
    if (await this.store.create(initial)) return {claimed:true,state:await this.store.get(pk)};
    const state = await this.store.get(pk);
    if (!state) return {claimed:false,state};
    if(state.requester!==requester)return {claimed:false,denied:true};
    const notification=state.notification as {status?:string;retry_not_before?:string}|undefined;
    const deadline=Date.parse(notification?.retry_not_before ?? '');
    const notificationDue=state.status==='confirmed' && notification?.status==='rate_limited'
      && retryFailed && Number.isFinite(deadline) && deadline<=Date.now();
    if (!['unknown','failed'].includes(String(state.status)) && !notificationDue) return {claimed:false,state};
    if (!await this.store.replace({...state,owner,status:'in_progress'})) return {claimed:false};
    return {claimed:true,state:await this.store.get(pk)};
  }
  async save(lead:string, owner:string, supplied:Item, requester = 'pilot-team:pilot-owner') {
    const current = await this.store.get(this.key(lead));
    if (!current || current.requester!==requester || supplied.requester!==current.requester || current.owner !== owner || supplied.pk !== current.pk || current.version !== supplied.version) return {saved:false};
    const saved = await this.store.replace({...supplied,owner});
    return {saved,state:saved ? await this.store.get(current.pk) : current};
  }
}
