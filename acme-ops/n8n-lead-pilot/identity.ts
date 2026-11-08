import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
export type Requester={subject:string;tenant:string};
export type CallerBinding=Requester & {token:string};
export function equalSecret(actual:string,expected:string|undefined){
 if(!expected)return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length && timingSafeEqual(a,b);
}
export function requesterFor(token:string,callers:CallerBinding[]):Requester|null{
 const match=callers.find(c=>equalSecret(token,c.token));return match?{subject:match.subject,tenant:match.tenant}:null;
}
export function requesterKey(p:Requester){return p.tenant+':'+p.subject;}
/** Private runtime authorization bound to session, caller and business input.
 * The native Header Auth credential alone cannot authorize state/provider I/O. */
export class InvocationAuthority{
 constructor(private key:string,private scope:string){if(key.length<32 || !scope)throw Error('Private invocation binding required');}
 mint(principal:Requester,input:{lead_id:string;retry_failed?:boolean},now=Date.now()){
  const body=Buffer.from(JSON.stringify({v:1,scope:this.scope,principal,lead_id:input.lead_id,retry_failed:input.retry_failed===true,expires:now+90000,nonce:randomUUID()})).toString('base64url');return body+'.'+this.sign(body);
 }
 private sign(body:string){return createHmac('sha256',this.key).update(body).digest('base64url');}
 verify(ticket:unknown,input:{lead_id?:unknown;retry_failed?:unknown},now=Date.now()):Requester|null{
  if(typeof ticket!=='string' || ticket.length>2048)return null;
  const [body,sig,...rest]=ticket.split('.');if(!body||!sig||rest.length||!equalSecret(sig,this.sign(body)))return null;
  try{const x=JSON.parse(Buffer.from(body,'base64url').toString());if(x.v!==1||x.scope!==this.scope||!Number.isSafeInteger(x.expires)||x.expires<=now||x.expires>now+90000||x.lead_id!==input.lead_id||x.retry_failed!==(input.retry_failed===true)||!x.principal||typeof x.principal.subject!=='string'||typeof x.principal.tenant!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(x.principal.subject)||!/^[-a-zA-Z0-9_]{1,80}$/.test(x.principal.tenant))return null;return {subject:x.principal.subject,tenant:x.principal.tenant};}catch{return null;}
 }
}
