import {createHash} from 'node:crypto';
const roles=['gmail','google-calendar','hubspot','slack'];
/** Stable for restarts of one MCP session; distinct when its issued twins change. */
export function sessionScope(legs){
 if(!legs || Object.keys(legs).length===0)return null;
 if(Object.keys(legs).length!==roles.length)throw Error('Incomplete pilot session binding');
 const identities=roles.map(role=>{
  const leg=legs[role];
  if(!leg || typeof leg.sandbox_id!=='string' || !/^[a-zA-Z0-9_-]+$/.test(leg.sandbox_id) || leg.base_url!=='https://fetchsandbox.com/sandbox/'+leg.sandbox_id)throw Error('Invalid pilot session identity');
  return [role,leg.sandbox_id];
 });
 return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}
