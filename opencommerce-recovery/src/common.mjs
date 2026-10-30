import pg from 'pg';
import {createHash} from 'node:crypto';

export const db = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 5});
db.on('error', () => console.log(JSON.stringify({outcome:'database_connection_lost'})));
export const scope = 'demo-company:sandbox';
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function binding(shopperId, message) {
  if (message.livemode || message.clientId !== 'demo-client') return null;
  const r = await db.query(`SELECT shopper_id, provider_user_id, thread_id FROM bindings
    WHERE shopper_id=$1 AND provider_user_id=$2 AND thread_id=$3`,
  [shopperId, message.userId, message.threadId]);
  return r.rows[0] ?? null;
}

// Explicit local fault switch. No provider credential or purchase endpoint exists.
export async function checkpoint(phase, eventId) {
  if (process.env.DEMO_FAULT_PHASE === phase && process.env.DEMO_FAULT_EVENT === eventId) {
    console.log(JSON.stringify({checkpoint: phase, eventId}));
    await new Promise(() => {});
  }
}

export async function send(message, eventId, idempotent) {
  const r = await fetch(`${process.env.SINK_URL}/messages`, {
    method: 'POST', signal: AbortSignal.timeout(700),
    headers: {'content-type': 'application/json', 'authorization': `Bearer ${process.env.SINK_TOKEN}`,
      ...(idempotent ? {'idempotency-key': `${scope}:${eventId}`} : {})},
    body: JSON.stringify({eventId, shopperId: message.externalUserId, threadId: message.threadId, text: message.text}),
  });
  if (!r.ok) throw new Error('sink_delivery_failed');
  await checkpoint('after-sink', eventId);
}
