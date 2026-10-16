import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root='http://127.0.0.1:3000';const headers={authorization:'Bearer container-smoke-only','content-type':'application/json'};
const spec={type:'bar',title:'容器中文验收',data:[{month:'一月',count:12},{month:'二月',count:18}],encoding:{x:'month',y:['count']}};
const raw={option:{xAxis:{type:'category',data:['一月','二月']},yAxis:{type:'value'},series:[{type:'bar',data:[12,18]}]}};
for(let i=0;i<100;i++){try{if((await fetch(`${root}/health/ready`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
assert.equal((await fetch(`${root}/v1/capabilities`)).status,401);
for(const [path,body,format] of [['render',raw,'svg'],['charts',{spec,output:{format:'png',pixelRatio:2}},'png']]){
 const res=await fetch(`${root}/v1/${path}`,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,200);const b=Buffer.from(await res.arrayBuffer());if(format==='png'){const meta=await sharp(b).metadata();assert.equal(meta.width,1920);assert.equal(meta.height,1080);}else assert.match(b.toString(),/一月/);
}
for(const spec of Object.values(extendedSamples)){const res=await fetch(`${root}/v1/charts`,{method:'POST',headers,body:JSON.stringify({spec,output:{format:'png'}})});assert.equal(res.status,200);assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width,960);}
console.log(JSON.stringify({extendedCharts:'passed',types:Object.keys(extendedSamples)}));
const client=new Client({name:'container-smoke',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${root}/mcp`),{requestInit:{headers}}));
try{const r=await client.callTool({name:'render_chart',arguments:{spec,output:{format:'png'}}});assert.equal(r.content[0].type,'image');assert.equal((await sharp(Buffer.from(r.content[0].data,'base64')).metadata()).width,960);}finally{await client.close();}
if(process.env.A2A_ENABLED==='true'){
 const {SendMessageRequest,GetTaskRequest,TaskState}=await import('@a2a-js/sdk');
 const {ClientFactory,JsonRpcTransportFactory,DefaultAgentCardResolver}=await import('@a2a-js/sdk/client');
 const fetchImpl=(url,init)=>{const requestHeaders=new Headers(init?.headers);requestHeaders.set('authorization',headers.authorization);return fetch(url,{...init,headers:requestHeaders});};
 const cardResolver=new DefaultAgentCardResolver({fetchImpl});
 const card=await cardResolver.resolve(root);
 assert.ok(card.supportedInterfaces.some(iface=>iface.protocolBinding==='JSONRPC'&&iface.protocolVersion==='1.0'&&iface.url===`${root}/a2a`));
 const a2a=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl})],cardResolver}).createFromAgentCard(card);
 assert.equal(a2a.protocolVersion,'1.0');
 const legacyCardResponse=await fetch(`${root}/.well-known/agent-card.json`,{headers});assert.equal(legacyCardResponse.status,200);
 const legacyCard=await legacyCardResponse.json();assert.equal(legacyCard.protocolVersion,'0.3.0');
 const started=performance.now();
 const input=process.env.SMOKE_LIVE==='true'?{operation:'generate',request:{data:extendedSamples.sankey.data,intent:'用桑基图展示资源流向',output:{format:'png'}}}:{operation:'chart',request:{spec:extendedSamples.sankey,output:{format:'png'}}};
 const task=await a2a.sendMessage(SendMessageRequest.fromJSON({message:{messageId:crypto.randomUUID(),role:'ROLE_USER',parts:[{data:input}]}}));
 assert.equal(task.status?.state,TaskState.TASK_STATE_COMPLETED);const image=task.artifacts[0].parts[0];assert.equal(image.content?.$case,'raw');assert.equal(image.mediaType,'image/png');assert.equal((await sharp(image.content.value).metadata()).width,960);
 assert.equal((await a2a.getTask(GetTaskRequest.fromJSON({id:task.id}))).status?.state,TaskState.TASK_STATE_COMPLETED);
 console.log(JSON.stringify({a2a:'passed',protocol:a2a.protocolVersion,legacyCardProtocol:legacyCard.protocolVersion,live:process.env.SMOKE_LIVE==='true',durationMs:Math.round(performance.now()-started)}));
}else assert.equal((await fetch(`${root}/.well-known/agent-card.json`,{headers})).status,404);
const timings=[];
for(let round=0;round<5;round++)await Promise.all(Array.from({length:4},async()=>{const start=performance.now();const r=await fetch(`${root}/v1/charts`,{method:'POST',headers,body:JSON.stringify({spec,output:{format:'png'}})});assert.equal(r.status,200);await r.arrayBuffer();timings.push(performance.now()-start);}));
const caps=await (await fetch(`${root}/v1/capabilities`,{headers})).json();
if(process.env.SMOKE_LIVE==='true'){
 assert.equal(caps.ai.status,'ready');const started=performance.now();const res=await fetch(`${root}/v1/generate`,{method:'POST',headers,body:JSON.stringify({data:spec.data,intent:'用折线图显示数量趋势，中文标题',output:{format:'png'}})});const body=await res.json();assert.equal(res.status,200,body.error?.code);assert.deepEqual(body.spec.data,spec.data);assert.equal((await sharp(Buffer.from(body.artifact.base64,'base64')).metadata()).width,960);console.log(JSON.stringify({live:'passed',durationMs:Math.round(performance.now()-started)}));
}else{assert.equal(caps.ai.status,'disabled');assert.equal((await fetch(`${root}/v1/generate`,{method:'POST',headers,body:JSON.stringify({data:spec.data,intent:'test'})})).status,503);}
timings.sort((a,b)=>a-b);console.log(JSON.stringify({smoke:'passed',arch:process.arch,uid:process.getuid(),requests:timings.length,concurrency:4,p50Ms:Math.round(timings[9]),p95Ms:Math.round(timings[18])}));
