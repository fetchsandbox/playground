/** Owned-child fault controller. Observations must be independently supplied.
 * A matching app message alone is never permission to count a qualified crash.
 */
export function watchAcceptedWriteCrash({child,plan,witness,record,restart}){
 let used=false;
 const done=new Promise((resolve,reject)=>{
  child.on('message',async message=>{
   if(used||message?.type!=='proof_provider_accepted'||message.nonce!==plan.nonce)return;
   used=true;
   try{
    const evidence=await witness(message.effect_id);
    if(evidence?.provider_accepted!==true||evidence?.checkpoint_pending!==true)throw Error('Independent provider/checkpoint witness missing');
    const pid=child.pid;
    if(!pid||child.exitCode!==null||child.signalCode!==null)throw Error('Owned process already exited; no qualified kill');
    const exited=new Promise(resolveExit=>child.once('exit',(code,signal)=>resolveExit({code,signal})));
    if(!child.kill('SIGKILL'))throw Error('Could not kill owned process');
    const exit=await exited;
    if(exit.signal!=='SIGKILL')throw Error('Owned process did not exit by SIGKILL');
    const observation={...evidence,effect_id:message.effect_id,pid_before:pid,signal:exit.signal,accepted_observed_at:message.observed_at,killed_at:new Date().toISOString()};
    await record(observation);
    const after=await restart();
    if(!after?.pid||after.pid===pid)throw Error('Replacement process identity not changed');
    const result={...observation,pid_after:after.pid,restarted_at:new Date().toISOString()};
    await record(result);resolve(result);
   }catch(error){
    if(child.connected)child.send({type:'proof_crash_release',nonce:plan.nonce});
    reject(error);
   }
  });
 });
 return {done,get triggered(){return used;}};
}
