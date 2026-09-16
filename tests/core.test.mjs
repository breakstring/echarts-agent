import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ChartService } from '../dist/service.js';
import { RenderPool } from '../dist/pool.js';
import { createServer } from '../dist/server.js';
import { compile } from '../dist/compiler.js';
import { prepareOption, validateSvg } from '../dist/policy.js';
import { chartRequestSchema, outputSchema } from '../dist/contracts.js';
import { configuredPlanner } from '../dist/llm.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const samples = {
  bar: { type: 'bar', title: '月度数量 · 中文 English', data: [{month:'一月', count:12, prior:9},{month:'二月',count:18,prior:11},{month:'三月',count:25,prior:19}], encoding: {x:'month',y:['count','prior']}, labels:{count:'本期数量',prior:'上期数量'} },
  line: {type:'line', title:'数量趋势', data:[{date:'2026-01-01',value:0},{date:'2026-02-01',value:-2},{date:'2026-03-01',value:8}],encoding:{x:'date',y:['value']},xType:'time',area:true},
  pie: {type:'pie', title:'类别占比',data:[{name:'类别甲',value:30},{name:'类别乙',value:70}],encoding:{name:'name',value:'value'},donut:true},
  scatter:{type:'scatter', title:'数值关系',data:[{a:1,b:2},{a:2,b:6},{a:3,b:4}],encoding:{x:'a',y:'b'}},
  radar:{type:'radar',title:'发展维度',data:[{name:'甲组',运动:85,语言:70,艺术:90},{name:'乙组',运动:65,语言:90,艺术:75}],encoding:{name:'name',metrics:['运动','语言','艺术']},max:100},
};
const raw = {option:{xAxis:{type:'category',data:['一月','二月']},yAxis:{type:'value'},series:[{type:'bar',data:[12,18]}]}};
let pool, service, app;
test.before(async()=>{pool=new RenderPool({size:2});await pool.waitReady();service=new ChartService(pool);app=createServer(service,{apiKey:'test-key'});await app.listen({host:'127.0.0.1',port:0});});
test.after(async()=>{await app.close();});
const auth={authorization:'Bearer test-key'};
test('五类图表 SVG/PNG、中文、真实像素及主题',async()=>{
  await mkdir('artifacts/acceptance',{recursive:true});
  for(const [type,spec] of Object.entries(samples)){
    const original=JSON.stringify(spec);
    const svg=await service.chart({spec});assert.match(svg.svg,/<svg/);assert.match(svg.svg,new RegExp(spec.title));
    validateSvg(svg.svg);
    const png=await service.chart({spec,style:{theme:type==='line'?'dark':type==='radar'?'report':'light'},output:{format:'png',width:960,height:540,pixelRatio:2}});
    const buffer=Buffer.from(png.base64,'base64');const meta=await sharp(buffer).metadata();assert.equal(meta.width,1920);assert.equal(meta.height,1080);
    assert.equal(JSON.stringify(spec),original);
    await writeFile(`artifacts/acceptance/${type}.png`,buffer);await writeFile(`artifacts/acceptance/${type}.svg`,svg.svg);
  }
});
test('原始 option、style 优先级和数组替换',async()=>{
  const result=prepareOption({...raw.option,color:['#ff0000'],textStyle:{fontSize:20}},{theme:'dark',fontSize:14,palette:['#000000','#ffffff']});
  assert.deepEqual(result.color,['#ff0000']);assert.equal(result.textStyle.fontSize,20);assert.equal(result.textStyle.fontFamily,'Noto Sans CJK SC');assert.equal(result.animation,false);
  assert.match((await service.raw(raw)).svg, /一月/);
});
test('非法输入与安全边界',async()=>{
  const cases=[
    {spec:{...samples.bar,data:[]}}, {spec:{...samples.bar,data:[{month:'一月',count:1,prior:2},{month:'一月',count:2,prior:3}]}},
    {spec:{...samples.bar,encoding:{x:'month',y:['missing']}}}, {spec:{...samples.pie,data:[{name:'甲',value:-1}]}},
    {spec:{...samples.pie,data:[{name:'甲',value:0}]}}, {spec:{...samples.radar,max:50}},
    {spec:samples.bar,output:{format:'svg',pixelRatio:2}}, {spec:samples.bar,output:{format:'png',width:2400,height:2400,pixelRatio:3}},
  ];for(const c of cases)await assert.rejects(()=>service.chart(c));
  for(const bad of [ {series:[{type:'custom',data:[1]}]}, {...raw.option,graphic:{type:'image',style:{image:'https://example.com/x'}}}, {...raw.option,title:{text:'<script>alert(1)</script>'}}, JSON.parse('{"series":[{"type":"bar","data":[1]}],"__proto__":{"polluted":true}}') ])await assert.rejects(()=>service.raw({option:bad}));
  assert.equal({}.polluted,undefined);
  for(const svg of ['<svg><script/></svg>','<svg><foreignObject/></svg>','<svg><path onclick="x()"/></svg>','<svg><use href="https://x"/></svg>','<!DOCTYPE svg><svg/>'])assert.throws(()=>validateSvg(svg));
});
test('HTTP 鉴权、错误状态、OpenAPI、无模型能力',async()=>{
  assert.equal((await app.inject({method:'POST',url:'/v1/render',payload:raw})).statusCode,401);
  const res=await app.inject({method:'POST',url:'/v1/render',headers:auth,payload:raw});assert.equal(res.statusCode,200);assert.match(res.headers['content-type'],/image\/svg\+xml/);assert.ok(res.headers['x-request-id']);assert.equal(res.headers['cache-control'],'no-store');
  const invalid=await app.inject({method:'POST',url:'/v1/charts',headers:auth,payload:{spec:{...samples.bar,data:[]}}});assert.equal(invalid.statusCode,422);assert.equal(invalid.json().error.code,'INVALID_INPUT');
  assert.equal((await app.inject({method:'POST',url:'/v1/render',headers:{...auth,'content-type':'application/json'},payload:'{bad'})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/v1/render',headers:{...auth,'content-type':'application/json'},payload:' '.repeat(1024*1024+1)})).statusCode,413);
  assert.equal((await app.inject({method:'POST',url:'/v1/generate',headers:auth,payload:{data:[{x:1}],intent:'test'}})).statusCode,503);
  const schema=(await app.inject({url:'/openapi.json',headers:auth})).json();assert.equal(schema.openapi,'3.1.0');assert.ok(schema.components.schemas.ChartRequest);
  assert.equal(configuredPlanner({LLM_ENABLED:'false'}).status,'disabled');assert.equal(configuredPlanner({LLM_ENABLED:'true'}).status,'misconfigured');
});
test('真实 MCP 握手、工具列举、PNG/SVG 内容与拒绝鉴权',async()=>{
  const url=new URL(`http://127.0.0.1:${app.server.address().port}/mcp`);
  const unauth=new Client({name:'unauth',version:'1'});await assert.rejects(()=>unauth.connect(new StreamableHTTPClientTransport(url)));await unauth.close();
  const client=new Client({name:'acceptance',version:'1'});await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:auth}}));
  try{
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['get_chart_capabilities','render_chart','render_echarts']);
    const svg=await client.callTool({name:'render_echarts',arguments:raw});assert.equal(svg.isError,undefined);assert.match(svg.content[0].text,/<svg/);assert.equal(svg.structuredContent.mimeType,'image/svg+xml');
    const png=await client.callTool({name:'render_chart',arguments:{spec:samples.bar,output:{format:'png',width:480,height:300}}});assert.equal(png.content[0].type,'image');assert.equal((await sharp(Buffer.from(png.content[0].data,'base64')).metadata()).width,480);
    const bad=await client.callTool({name:'render_chart',arguments:{spec:{...samples.pie,data:[{name:'x',value:-1}]}}});assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).error.code,'INVALID_INPUT');
  }finally{await client.close();}
});
test('模型字段纠错最多两次、原始数据绑定与上游失败',async()=>{
  let calls=0;const ai=new ChartService(pool,async()=>{calls++;return calls===1?{type:'bar',encoding:{x:'month',y:['invented']}}:{type:'bar',encoding:{x:'month',y:['count']}};});
  const result=await ai.generate({data:samples.bar.data,intent:'数量比较'});assert.equal(calls,2);assert.deepEqual(result.spec.data,samples.bar.data);assert.deepEqual(result.option.series[0].data,[12,18,25]);
  calls=0;const invalid=new ChartService(pool,async()=>{calls++;return {type:'bar',encoding:{x:'month',y:['invented']}};});await assert.rejects(()=>invalid.generate({data:samples.bar.data,intent:'x'}),{code:'AI_INVALID_PLAN'});assert.equal(calls,2);
  calls=0;const broken=new ChartService(pool,async()=>{calls++;throw new Error('secret raw provider failure');});await assert.rejects(()=>broken.generate({data:samples.bar.data,intent:'x'}),e=>e.code==='AI_FAILED'&&!e.message.includes('secret'));assert.equal(calls,1);
});
test('进程超时真实终止、恢复、队列满、取消和崩溃',async()=>{
  process.env.LLM_API_KEY='must-not-reach-worker';
  const p=new RenderPool({size:1,queueLimit:1,timeoutMs:300,workerUrl:new URL('./fixtures/worker.mjs',import.meta.url)});await p.waitReady();
  const job=mode=>({option:{mode},output:outputSchema.parse({})});
  try{
    const baseline=JSON.parse((await p.render(job('ok'))).svg);assert.equal(baseline.hasSecret,false);
    const hung=p.render(job('hang'));const rejected=assert.rejects(hung,{code:'RENDER_TIMEOUT'});
    const queued=p.render(job('ok'));const queuedResult=queued.catch(e=>e);
    await assert.rejects(()=>p.render(job('ok')),{code:'QUEUE_FULL'});await rejected;await queuedResult;
    await new Promise(r=>setTimeout(r,150));await p.waitReady();assert.throws(()=>process.kill(baseline.pid,0),{code:'ESRCH'});
    assert.notEqual(JSON.parse((await p.render(job('ok'))).svg).pid,baseline.pid);
    const controller=new AbortController();const cancel=p.render(job('hang'),controller.signal);controller.abort();await assert.rejects(cancel,{code:'CANCELLED'});
    await new Promise(r=>setTimeout(r,150));await p.waitReady();await assert.rejects(()=>p.render(job('crash')),{code:'WORKER_CRASHED'});
    await new Promise(r=>setTimeout(r,150));await p.waitReady();assert.ok(await p.render(job('ok')));
  }finally{delete process.env.LLM_API_KEY;await p.close();}
});

test('透明背景、长中文标题、换行与罕见字符样例',async()=>{
 const spec={...samples.bar,title:'长标题排版验证：中文与 English 混排\n第二行说明和罕见字符 𠮷',labels:{count:'本期数量很长的中文系列名称',prior:'上期数量很长的中文系列名称'}};
 const transparent=await service.chart({spec,style:{background:'transparent'},output:{format:'png'}});
 const buffer=Buffer.from(transparent.base64,'base64');const {data,info}=await sharp(buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(data[3],0);assert.equal(info.width,960);await writeFile('artifacts/acceptance/text-layout.png',buffer);
});

test('无状态 MCP 连接关闭会终止执行中的 Worker',async()=>{
 const p=new RenderPool({size:1,timeoutMs:3000,workerUrl:new URL('./fixtures/worker.mjs',import.meta.url)});await p.waitReady();
 const server=createServer(new ChartService(p),{apiKey:'cancel-test'});await server.listen({host:'127.0.0.1',port:0});
 const client=new Client({name:'cancel-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.server.address().port}/mcp`),{requestInit:{headers:{authorization:'Bearer cancel-test'}}}));
 try{
 const pending=client.callTool({name:'render_echarts',arguments:{option:{...raw.option,mode:'hang'}}}).catch(e=>e);
 const end=Date.now()+1000;while(p.stats.active===0&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(p.stats.active,1);
 await client.close();await pending;
 const deadline=Date.now()+1000;while(p.stats.restarts===0&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(p.stats.restarts,1);await p.waitReady();
 }finally{await client.close();await server.close();}
});
