import {createServer} from 'node:http';
import pg from 'pg';
import {randomUUID, createHash} from 'node:crypto';
const db=new pg.Pool({connectionString:process.env.DATABASE_URL});

createServer(async(req,res) => {
  if (req.url==='/health') {res.end('ok');return;}
  if (req.method!=='POST'||req.url!=='/messages') {res.writeHead(404);res.end();return;}
  if(req.headers.authorization!==`Bearer ${process.env.SINK_TOKEN}`){res.writeHead(401);res.end();return;}
  let body='';for await (const chunk of req){body+=chunk;if(body.length>20000){res.writeHead(413);res.end();return;}}
  const value=JSON.parse(body),hash=createHash('sha256').update(body).digest('hex');
  const key=req.headers['idempotency-key']??randomUUID();
  const c=await db.connect();
  let action;
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO attempts(event_id) VALUES ($1)',[value.eventId]);
    const control=await c.query('SELECT * FROM controls WHERE event_id=$1 FOR UPDATE',[value.eventId]);
    action=control.rows[0]?.action;
    if(action==='fail-once'){
      await c.query('DELETE FROM controls WHERE event_id=$1',[value.eventId]);await c.query('COMMIT');res.writeHead(503);res.end();return;
    }
    const r=await c.query(`INSERT INTO messages(idempotency_key,payload_hash,event_id,shopper_id,thread_id,text)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [key,hash,value.eventId,value.shopperId,value.threadId,value.text]);
    if(!r.rowCount){
      const old=await c.query('SELECT payload_hash FROM messages WHERE idempotency_key=$1',[key]);
      if(old.rows[0].payload_hash!==hash){await c.query('ROLLBACK');res.writeHead(409);res.end();return;}
    }
    if(action)await c.query('DELETE FROM controls WHERE event_id=$1',[value.eventId]);
    await c.query('COMMIT');
    if(action==='lose-response'){res.destroy();return;}
    res.writeHead(200);res.end(JSON.stringify({accepted:true}));
  } catch {await c.query('ROLLBACK');res.writeHead(500);res.end();}
  finally {c.release();}
}).listen(8080,'0.0.0.0',()=>console.log('sink listening'));
