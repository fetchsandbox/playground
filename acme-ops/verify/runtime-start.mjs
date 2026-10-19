import {createServer} from 'node:net';
export async function requireFreePort(port){await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(resolve));});}
export async function waitForOwnListener(child,port,workflow,timeoutMs=10000){return new Promise((resolve,reject)=>{
 let buffer='';const timer=setTimeout(()=>done(Error('Owned runtime did not report listening')),timeoutMs);
 const exit=()=>done(Error('Owned runtime exited before listening'));const error=()=>done(Error('Owned runtime could not start'));
 const data=chunk=>{buffer+=chunk.toString();if(buffer.length>65536)return done(Error('Owned startup output exceeded limit'));let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const v=JSON.parse(line);if(v.msg==='listening'&&v.port===port&&v.workflow===workflow)return done();}catch{}}};
 function done(err){clearTimeout(timer);child.stdout.off('data',data);child.off('exit',exit);child.off('error',error);err?reject(err):resolve();}
 child.stdout.on('data',data);child.once('exit',exit);child.once('error',error);
});}
