import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { RenderPool } from '../dist/pool.js';
import { ChartService } from '../dist/service.js';
import { configuredPlanner } from '../dist/llm.js';
import { createServer } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config=configuredPlanner(process.env);
assert.equal(config.status,'ready','需要根目录 .env.local 的完整模型配置');
const pool=new RenderPool({size:1});await pool.waitReady();
const app=createServer(new ChartService(pool,config.planner,config.status),{apiKey:'local-smoke-only'});await app.listen({host:'127.0.0.1',port:0});
const base=`http://127.0.0.1:${app.server.address().port}`;const headers={authorization:'Bearer local-smoke-only','content-type':'application/json'};
const cases=[
 {name:'trend',data:[{month:'一月',count:12},{month:'二月',count:18},{month:'三月',count:25}],intent:'用中文标题和折线图呈现各月数量趋势，保留原始数量',type:'line',format:'svg'},
 {name:'share',data:[{category:'产品甲',amount:40},{category:'产品乙',amount:60}],intent:'请用环形图呈现两个产品的占比，中文标题，显示真实数量',type:'pie',format:'png'},
];
const evidence=[];
try{
 await mkdir('artifacts/live',{recursive:true});
 for(const item of cases){const began=performance.now();const response=await fetch(`${base}/v1/generate`,{method:'POST',headers,body:JSON.stringify({data:item.data,intent:item.intent,output:{format:item.format}})});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body.error));assert.equal(body.spec.type,item.type);assert.deepEqual(body.spec.data,item.data);const artifact=body.artifact;if(artifact.svg)assert.match(artifact.svg,/<svg/);else assert.equal((await sharp(Buffer.from(artifact.base64,'base64')).metadata()).width,960);await writeFile(`artifacts/live/${item.name}.${item.format}`,artifact.svg??Buffer.from(artifact.base64,'base64'));evidence.push({entry:'HTTP',case:item.name,chartType:body.spec.type,format:item.format,durationMs:Math.round(performance.now()-began),bytes:artifact.bytes});}
 const client=new Client({name:'live-smoke',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}}));
 try{assert.ok((await client.listTools()).tools.some(t=>t.name==='generate_chart'));const began=performance.now();const result=await client.callTool({name:'generate_chart',arguments:{data:cases[0].data,intent:'使用柱状图比较各月数量',output:{format:'png'}}});assert.equal(result.isError,undefined);assert.equal(result.content[0].type,'image');assert.deepEqual(result.structuredContent.spec.data,cases[0].data);await writeFile('artifacts/live/mcp.png',Buffer.from(result.content[0].data,'base64'));evidence.push({entry:'MCP',chartType:result.structuredContent.spec.type,format:'png',durationMs:Math.round(performance.now()-began),bytes:result.structuredContent.bytes});}finally{await client.close();}
 await writeFile('artifacts/live/evidence.json',JSON.stringify({testedAt:new Date().toISOString(),provider:process.env.LLM_PROVIDER??process.env.llm_provider,model:process.env.LLM_MODEL??process.env.llm_default_model,results:evidence},null,2));console.log(JSON.stringify({live:'passed',results:evidence}));
}catch(error){console.error(JSON.stringify({live:'failed',name:error.name,message:error.message?.slice(0,500)}));process.exitCode=1;}finally{await app.close();}
