import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { RenderPool } from '../dist/pool.js';
import { ChartService } from '../dist/service.js';
import { configuredPlanner } from '../dist/llm.js';
import { createServer } from '../dist/server.js';
import { extendedSamples } from '../examples/extended/samples.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config=configuredPlanner(process.env);assert.equal(config.status,'ready','需要已配置的 Provider');
const pool=new RenderPool({size:1});await pool.waitReady();
const app=createServer(new ChartService(pool,config.planner,config.status),{apiKey:'extended-live-only'});await app.listen({host:'127.0.0.1',port:0});
const base=`http://127.0.0.1:${app.server.address().port}`;const headers={authorization:'Bearer extended-live-only','content-type':'application/json'};
const intents={gauge:'请用仪表盘显示这一行完成率，范围0到100，%为显示后缀，不转换数值',funnel:'用漏斗图展示各阶段数量，保留原顺序和数量',heatmap:'用热力图展示班级group与日期day交叉的count，中文标题',tree:'用树图展示id与parent指定的父子层级，显示name，根parent为空字符串，不需要数值',treemap:'用矩形树图展示投入分布，id是节点，parent是父节点，name为显示名，value为面积，根parent为空字符串',sunburst:'用旭日图展示层级占比，id是节点，parent是父节点，name为显示名，value为大小，根parent为空字符串',sankey:'用桑基图显示资源流向，source是来源，target是去向，value是流量，不聚合不改写'};
const results=[];const client=new Client({name:'extended-live',version:'1'});
try{
 await mkdir('artifacts/extended-live',{recursive:true});
 for(const [type,sample] of Object.entries(extendedSamples)){
  const began=performance.now();const response=await fetch(`${base}/v1/generate`,{method:'POST',headers,body:JSON.stringify({data:sample.data,intent:intents[type],output:{format:'png'}})});const body=await response.json();assert.equal(response.status,200,body.error?.code);assert.equal(body.spec.type,type);assert.deepEqual(body.spec.data,sample.data);const png=Buffer.from(body.artifact.base64,'base64');assert.equal((await sharp(png).metadata()).width,960);await writeFile(`artifacts/extended-live/${type}.png`,png);const evidence={entry:'HTTP',type,durationMs:Math.round(performance.now()-began),bytes:png.length};results.push(evidence);console.log(JSON.stringify(evidence));
 }
 await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}}));
 const began=performance.now();const result=await client.callTool({name:'generate_chart',arguments:{data:extendedSamples.sankey.data,intent:intents.sankey,output:{format:'svg'}}});assert.equal(result.isError,undefined);assert.equal(result.structuredContent.spec.type,'sankey');assert.deepEqual(result.structuredContent.spec.data,extendedSamples.sankey.data);assert.match(result.content[0].text,/<svg/);results.push({entry:'MCP',type:'sankey',durationMs:Math.round(performance.now()-began),bytes:result.structuredContent.bytes});
 await writeFile('artifacts/extended-live/evidence.json',JSON.stringify({testedAt:new Date().toISOString(),model:process.env.LLM_MODEL??process.env.llm_default_model,results},null,2));console.log(JSON.stringify({extendedLive:'passed',requests:results.length}));
}catch(error){console.error(JSON.stringify({extendedLive:'failed',name:error.name,message:error.message?.slice(0,250)}));process.exitCode=1;}finally{await client.close();await app.close();}
