import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk-v0_3/client';
import { ChartService } from '../dist/service.js';
import { RenderPool } from '../dist/pool.js';
import { createServer } from '../dist/server.js';
import { EphemeralTaskStore } from '../dist/a2a.js';
import { extendedSamples } from '../examples/extended/samples.mjs';
const spec={type:'bar',data:[{name:'甲',value:12},{name:'乙',value:18}],encoding:{x:'name',y:['value']}};
const message=data=>({message:{kind:'message',messageId:randomUUID(),role:'user',parts:[{kind:'data',data}]}});
let app,client,base,pool;
let cancelled=false;
test.before(async()=>{
 const probe=httpServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;
 pool=new RenderPool({size:1});await pool.waitReady();
 const service=new ChartService(pool,async(request,_feedback,signal)=>{if(request.intent==='等待取消')await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(new Error('cancelled'));},{once:true}));return {type:'bar',encoding:{x:'name',y:['value']}};});
 app=createServer(service,{apiKey:'a2a-test',a2aPublicUrl:base});await app.listen({port,host:'127.0.0.1'});
 const fetchImpl=(url,init)=>fetch(url,{...init,headers:{...init?.headers,authorization:'Bearer a2a-test'}});
 client=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl})],cardResolver:new DefaultAgentCardResolver({fetchImpl})}).createFromUrl(base);
});
test.after(async()=>{await app.close();});
test('A2A 0.3 发现、图像 artifact 和 task 获取',async()=>{
 const card=await (await fetch(`${base}/.well-known/agent-card.json`,{headers:{authorization:'Bearer a2a-test'}})).json();assert.equal(card.protocolVersion,'0.3.0');assert.equal(card.capabilities.streaming,false);assert.equal(card.capabilities.pushNotifications,false);
 for(const format of ['svg','png']){
 const task=await client.sendMessage(message({operation:'chart',request:{spec,output:{format}}}));assert.equal(task.kind,'task');assert.equal(task.status.state,'completed');
 const bytes=Buffer.from(task.artifacts[0].parts[0].file.bytes,'base64');if(format==='svg')assert.match(bytes.toString(),/<svg/);else assert.equal((await sharp(bytes).metadata()).width,960);
 const stored=await client.getTask({id:task.id,historyLength:0});assert.equal(stored.status.state,'completed');assert.equal(stored.history.length,0);
 }
});
test('A2A 七种新增静态图表交付 PNG',async()=>{
 for(const spec of Object.values(extendedSamples)){
 const task=await client.sendMessage(message({operation:'chart',request:{spec,output:{format:'png'}}}));assert.equal(task.status.state,'completed');
 assert.equal((await sharp(Buffer.from(task.artifacts[0].parts[0].file.bytes,'base64')).metadata()).width,960);
 }
});
test('A2A 字段失败、缺失任务、错误凭据与不支持方法',async()=>{
 const task=await client.sendMessage(message({operation:'chart',request:{spec:{...spec,encoding:{x:'name',y:['missing']}}}}));assert.equal(task.status.state,'failed');assert.equal(task.status.message.parts[0].data.error.code,'INVALID_INPUT');
 await assert.rejects(()=>client.getTask({id:randomUUID()}));
 assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status,401);
 assert.equal((await fetch(`${base}/a2a`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer wrong'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tasks/get',params:{id:task.id}})})).status,401);
 const unsupported=await fetch(`${base}/a2a`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer a2a-test'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'message/stream',params:{}})});assert.equal((await unsupported.json()).error.code,-32601);
});
test('A2A 非阻塞提交、取消下游操作并保持终态',async()=>{
 const task=await client.sendMessage({...message({operation:'generate',request:{data:spec.data,intent:'等待取消'}}),configuration:{blocking:false}});assert.equal(task.status.state,'working');
 const cancel=await client.cancelTask({id:task.id});assert.equal(cancel.status.state,'canceled');assert.equal(cancelled,true);
 assert.equal((await client.getTask({id:task.id})).status.state,'canceled');await assert.rejects(()=>client.cancelTask({id:task.id}));
});
test('A2A 任务过期与重启丢失',async()=>{
 const store=new EphemeralTaskStore(5);const task={kind:'task',id:randomUUID(),contextId:randomUUID(),status:{state:'completed'},history:[{secret:'not-retained'}]};await store.save(task);assert.deepEqual((await store.load(task.id)).history,[]);await new Promise(r=>setTimeout(r,10));assert.equal(await store.load(task.id),undefined);
 await store.save(task);assert.equal(await new EphemeralTaskStore().load(task.id),undefined);
});
