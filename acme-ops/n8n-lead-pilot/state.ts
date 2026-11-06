import type {KvStore, Item} from '../src/kit/store';

/** Reuses the repository conditional-write abstraction; no workflow decisions. */
export class LeadState {
  constructor(private store: KvStore) {}
  async claim(lead: string, owner: string) {
    const pk = `lead-pilot#${lead}`;
    const initial = {pk, owner, status:'in_progress', operations:Object.fromEntries(['contact','deal','gmail','calendar'].map(s=>[s,{status:'pending'}]))};
    if (await this.store.create(initial)) return {claimed:true,state:await this.store.get(pk)};
    const state = await this.store.get(pk);
    if (!state || !['unknown','failed'].includes(String(state.status))) return {claimed:false,state};
    if (!await this.store.replace({...state,owner,status:'in_progress'})) return {claimed:false};
    return {claimed:true,state:await this.store.get(pk)};
  }
  async save(lead:string, owner:string, supplied:Item) {
    const current = await this.store.get(`lead-pilot#${lead}`);
    if (!current || current.owner !== owner || supplied.pk !== current.pk || current.version !== supplied.version) return {saved:false};
    const saved = await this.store.replace({...supplied,owner});
    return {saved,state:saved ? await this.store.get(current.pk) : current};
  }
}
