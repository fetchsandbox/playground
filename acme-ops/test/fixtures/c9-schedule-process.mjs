await import('../../verify/runtime-schedule-preload.mjs');
const plan=JSON.parse(process.env.FS_PROOF_SCHEDULE_TARGET);
await fetch(plan.url,{method:'POST',headers:{authorization:'Bearer fixture-only'},body:JSON.stringify({email:plan.body_equals}),signal:AbortSignal.timeout(6000)});
process.disconnect?.();
