import {db, binding, scope, fingerprint, checkpoint, send} from './common.mjs';

export async function accept(shopperId, message, event) {
  if (!await binding(shopperId, message)) {
    await db.query(`INSERT INTO rejections(event_id, reason) VALUES ($1,'binding_denied')`,[event.id]);
    return;
  }
  await db.query(`INSERT INTO inbox(scope,event_id,payload_hash) VALUES ($1,$2,$3)
    ON CONFLICT (scope,event_id) DO NOTHING`,[scope,event.id,fingerprint(message)]);
  // The reference defect: acknowledge a volatile task and rely on SDK-local memory.
  setTimeout(async () => {
    await checkpoint('after-inbox',event.id);
    try { await send(message,event.id,false); } catch { /* the HTTP ack already left */ }
  }, 20);
}
export function start() { return () => {}; }
