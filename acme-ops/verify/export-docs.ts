/** Read definitions and saved artifacts only; never run agents or call providers. */
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadWorkflow } from '../src/kit/load';
const ids=readdirSync(new URL('../src/workflows/',import.meta.url)).filter(f=>f.endsWith('.ts')&&f!=='shared.ts').map(f=>f.slice(0,-3)).sort();
const output=[];
for(const id of ids){
 const wf=await loadWorkflow(id);if(!wf)throw new Error(`Cannot load ${id}`);
 const contract=(await import(`./contracts/${id}.mjs`)).default;
 const receipt=JSON.parse(readFileSync(new URL(`./receipts/${id}.json`,import.meta.url),'utf8'));
 const baseline=contract.checks.find((c:any)=>c.id==='baseline');
 const start=baseline?.actions?.find((a:any)=>a.body?.action==='start');
 if(!start || !wf.input.safeParse(start.body.input).success)throw new Error(`Invalid baseline example for ${id}`);
 output.push({id,title:wf.title,department:wf.org,team:wf.team,business:wf.description,agents:wf.agents.map(a=>({name:a.name,providers:a.needs})),compose:wf.compose?.name??null,actions:wf.catalog,input:z.toJSONSchema(wf.input,{unrepresentable:'any'}),example:baseline?.actions?.find((a:any)=>a.body?.action==='start')?.body??null,checks:contract.checks.map((c:any)=>({id:c.id,label:c.name,blocked:c.blocker??null})),receipt});
}
process.stdout.write(JSON.stringify(output,null,2));
