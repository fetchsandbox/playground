import {writeFileSync} from 'node:fs';
// Test fixture resolver only. The crash preload itself calls real fetch unchanged.
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>original(process.env.FIXTURE_ORIGIN+'/effect',init);
await import('../../verify/runtime-crash-preload.mjs');
const plan=JSON.parse(process.env.FIXTURE_PLAN);
const response=await fetch(plan.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({properties:{dealname:plan.body_equals}})});
const effect=await response.json();
writeFileSync(process.env.FIXTURE_CHECKPOINT,JSON.stringify(effect));
process.disconnect?.();
