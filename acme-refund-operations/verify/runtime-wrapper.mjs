import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env,ACME_LOCAL_VERIFY:'true',POLICY_DIR:join(root,'policies'),APPROVER_USER_IDS:'U_ACME_MANAGER',HUBSPOT_ACCESS_TOKEN:process.env.HUBSPOT_API_KEY,SLACK_BOT_TOKEN:process.env.SLACK_API_KEY};
const p=spawn(process.env.PROOF_PYTHON??'python3',['-m','uvicorn','refund_ops.app:app','--host','127.0.0.1','--port',process.env.PORT??'8080','--no-access-log'],{cwd:root,env,stdio:'inherit'});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>p.kill(sig));p.on('exit',c=>process.exit(c??1));
