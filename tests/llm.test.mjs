import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ChartService } from '../dist/service.js';
import { configuredPlanner } from '../dist/llm.js';
const request={data:[{name:'甲',value:12}],intent:'数量比较'};
const pool={render:async()=>({svg:'<svg/>',mimeType:'image/svg+xml',width:960,height:540,bytes:6})};
test('真实模型适配器 HTTP 失败不会隐式重试或暴露上游报文',async()=>{
 let calls=0;const upstream=createServer((_req,res)=>{calls++;res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'private-provider-payload',type:'server_error'}}));});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 try{const {planner,status}=configuredPlanner({LLM_API_KEY:'local-test',LLM_MODEL:'test',LLM_BASE_URL:`http://127.0.0.1:${upstream.address().port}/v1`});assert.equal(status,'ready');const service=new ChartService(pool,planner);await assert.rejects(()=>service.generate(request),error=>error.code==='AI_FAILED'&&!error.message.includes('private'));assert.equal(calls,1);}finally{await new Promise(r=>upstream.close(r));}
});
test('LLM 总时限、取消和并发上限',async()=>{
 let aborts=0;const planner=async(_request,_feedback,signal)=>new Promise((_resolve,reject)=>{if(signal.aborted){aborts++;reject(new Error('aborted'));}else signal.addEventListener('abort',()=>{aborts++;reject(new Error('aborted'));},{once:true});});
 const service=new ChartService(pool,planner,'ready',80);
 const a=service.generate(request);const b=service.generate(request);const outcomes=Promise.allSettled([a,b]);
 await assert.rejects(()=>service.generate(request),{code:'AI_BUSY'});
 // AbortSignal.timeout 不保活进程；模拟请求 socket 的存活期。
 const hold=setInterval(()=>{},1000);try{const settled=await outcomes;for(const entry of settled){assert.equal(entry.status,'rejected');assert.equal(entry.reason.code,'AI_TIMEOUT');}assert.equal(aborts,2);
 const controller=new AbortController();const pending=service.generate(request,controller.signal);controller.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(aborts,3);
 }finally{clearInterval(hold);}
});
