import {db, binding, scope, fingerprint, checkpoint, send} from './common.mjs';

export async function accept(shopperId, message, event) {
  if (!await binding(shopperId, message)) {
    await db.query(`INSERT INTO rejections(event_id, reason) VALUES ($1,'binding_denied')`, [event.id]);
    return;
  }
  const payload = {externalUserId: shopperId, userId: message.userId, threadId: message.threadId, text: message.text};
  const hash = fingerprint(payload);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query(`INSERT INTO inbox(scope,event_id,payload_hash) VALUES ($1,$2,$3)
      ON CONFLICT (scope,event_id) DO NOTHING RETURNING event_id`, [scope,event.id,hash]);
    if (prior.rowCount) {
      await client.query(`INSERT INTO outbox(scope,event_id,payload) VALUES ($1,$2,$3)`,[scope,event.id,payload]);
    } else {
      const stored = await client.query('SELECT payload_hash FROM inbox WHERE scope=$1 AND event_id=$2',[scope,event.id]);
      if (stored.rows[0].payload_hash !== hash) throw new Error('event_identity_conflict');
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

let draining = false;
export async function drain() {
  if (draining) return;
  draining = true;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM outbox WHERE delivered_at IS NULL
      ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (r.rowCount) {
      const row = r.rows[0];
      await checkpoint('after-inbox',row.event_id);
      await send(row.payload,row.event_id,true);
      await client.query(`UPDATE outbox SET delivered_at=clock_timestamp() WHERE scope=$1 AND event_id=$2`,[row.scope,row.event_id]);
    }
    await client.query('COMMIT');
  } catch { await client.query('ROLLBACK'); }
  finally { client.release(); draining = false; }
}

export function start() { const timer=setInterval(() => drain().catch(() => {}), 60); return () => clearInterval(timer); }
