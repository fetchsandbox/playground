let input=''; for await(const c of process.stdin)input+=c;
const r=JSON.parse(input);
try {
  const response=await fetch(r.url,{method:r.method??'GET',headers:r.headers,body:r.body,
    signal:AbortSignal.timeout(4000)});
  console.log(JSON.stringify({status:response.status,body:await response.text()}));
} catch {console.log(JSON.stringify({status:null,error:'connection_unavailable'}));}
