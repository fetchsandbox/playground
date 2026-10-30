import {createServer} from 'node:http';
import {agentcardWebhook} from '@agent-cards/commerce-sdk';
import {db} from './common.mjs';
import {accept, start} from './delivery.mjs';

const webhook = agentcardWebhook({secret: process.env.AGENTCARD_WEBHOOK_SECRET,
  onMessage: accept, onError: () => console.log(JSON.stringify({outcome:'callback_or_verification_failed'}))});
const server = createServer((req,res) => {
  if (req.url === '/health' && req.method === 'GET') {
    db.query('SELECT 1').then(() => {res.writeHead(200);res.end('ok');},() => {res.writeHead(503);res.end();});
  } else if (req.url === '/webhooks/agentcard' && req.method === 'POST') {
    webhook(req,res);
  } else {res.writeHead(404);res.end();}
});
const stop = start();
server.listen(8080,'0.0.0.0',()=>console.log('listening'));
process.on('SIGTERM',() => {stop();server.close();db.end().finally(()=>process.exit(0));});
