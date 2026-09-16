import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RenderPool } from '../dist/pool.js';
import { ChartService } from '../dist/service.js';
import { createServer } from '../dist/server.js';
import { compile } from '../dist/compiler.js';
import { chartRequestSchema, planSchema, chartTypes } from '../dist/contracts.js';
import { prepareOption, validateSvg } from '../dist/policy.js';
import { extendedSamples, hierarchyData } from '../examples/extended/samples.mjs';
let pool, service, app;
const auth={authorization:'Bearer extended-test'};
const parsed=spec=>chartRequestSchema.parse({spec}).spec;
test.before(async()=>{pool=new RenderPool({size:2});await pool.waitReady();service=new ChartService(pool);app=createServer(service,{apiKey:'extended-test'});await app.listen({host:'127.0.0.1',port:0});await mkdir('artifacts/extended',{recursive:true});});
test.after(async()=>app.close());
for(const [type,spec] of Object.entries(extendedSamples))test(`新增 ${type} 的 ChartSpec/option、SVG/PNG 和原数据`,async()=>{
 const original=JSON.stringify(spec);const option=compile(parsed(spec));
 const svg=await service.chart({spec});assert.match(svg.svg,new RegExp(spec.title));validateSvg(svg.svg);
 assert.match((await service.raw({option})).svg,new RegExp(spec.title));
 const png=await service.chart({spec,output:{format:'png',pixelRatio:2}});const bytes=Buffer.from(png.base64,'base64');const metadata=await sharp(bytes).metadata();assert.equal(metadata.width,1920);assert.equal(metadata.height,1080);
 const stats=await sharp(bytes).stats();assert.ok(stats.channels.some(channel=>channel.stdev>10));
 await writeFile(`artifacts/extended/${type}.svg`,svg.svg);await writeFile(`artifacts/extended/${type}.png`,bytes);
 const dark=await service.chart({spec,style:{theme:'dark'},output:{format:'png'}});await writeFile(`artifacts/extended/${type}-dark.png`,Buffer.from(dark.base64,'base64'));
 assert.equal(JSON.stringify(spec),original);
 // generate 返回的最终 option 也必须能重新提交到原始渲染入口。
 const final=prepareOption(option,{theme:'light',fontSize:14});assert.match((await service.raw({option:final})).svg,/<svg/);
});
test('字段绑定保序、不聚合、不修改原始数值',()=>{
 const gauge=compile(parsed(extendedSamples.gauge));assert.equal(gauge.series[0].data[0].value,78);
 const funnel=compile(parsed({...extendedSamples.funnel,data:[{stage:'甲',count:30},{stage:'乙',count:50},{stage:'丙',count:0}]}));assert.deepEqual(funnel.series[0].data.map(d=>d.value),[30,50,0]);assert.equal(funnel.series[0].sort,'none');
 const heat=compile(parsed({...extendedSamples.heatmap,data:[{day:'周三',group:'乙',count:-2},{day:'周一',group:'甲',count:0}]}));assert.deepEqual(heat.xAxis.data,['周三','周一']);assert.deepEqual(heat.yAxis.data,['乙','甲']);assert.deepEqual(heat.series[0].data,[[0,0,-2],[1,1,0]]);
 const tree=compile(parsed(extendedSamples.treemap)).series[0].data[0];assert.equal(tree.value,100);assert.deepEqual(tree.children.map(n=>n.id),['teaching','sports']);assert.deepEqual(tree.children[0].children.map(n=>n.value),[35,25]);
 const flow=compile(parsed(extendedSamples.sankey)).series[0];assert.deepEqual(flow.links,extendedSamples.sankey.data);assert.deepEqual(flow.data.map(n=>n.name),['课程资源','语言活动','艺术活动','体育资源','运动活动','综合展示']);
});
test('层级关系错误、数值及深度限制覆盖 ChartSpec 和 option',async()=>{
 const template=extendedSamples.treemap;
 const decimal={...template,data:[{id:'root',parent:'',name:'总额',value:0.3},{id:'a',parent:'root',name:'甲',value:0.1},{id:'b',parent:'root',name:'乙',value:0.2}]};
 assert.match((await service.chart({spec:decimal})).svg,/<svg/);
 const cases=[
 [{id:'root',parent:'',name:'根',value:10},{id:'root',parent:'',name:'重复',value:1}],
 [{id:'root',parent:'',name:'根',value:10},{id:'x',parent:'missing',name:'孤立',value:1}],
 [{id:'root',parent:'',name:'根',value:10},{id:'x',parent:'y',name:'甲',value:1},{id:'y',parent:'x',name:'乙',value:1}],
 [{id:'x',parent:'y',name:'甲',value:1},{id:'y',parent:'x',name:'乙',value:1}],
 [{id:'root',parent:'',name:'根',value:10},{id:'x',parent:'root',name:'子',value:11}],
 [{id:'root',parent:'',name:'根',value:-1}],
 [{id:'root',parent:'',name:'根',value:0}],
 Array.from({length:9},(_,i)=>({id:`n${i}`,parent:i?`n${i-1}`:'',name:`节点${i}`,value:1})),
 ];for(const data of cases)await assert.rejects(()=>service.chart({spec:{...template,data}}),{code:'INVALID_INPUT'});
 await assert.rejects(()=>service.raw({option:{series:[{type:'treemap',data:[{name:'父',value:1,children:[{name:'子',value:2}]}]}]}}),{code:'INVALID_INPUT'});
 await assert.rejects(()=>service.raw({option:{series:[{type:'tree',data:[{name:'根',children:Array.from({length:1000},(_,i)=>({name:`子${i}`}))}]}]}}),{code:'INVALID_INPUT'});
});
test('桑基图拒绝环、自环、重复边、非正流量和缺失节点',async()=>{
 for(const data of [
 [{source:'甲',target:'乙',value:1},{source:'乙',target:'甲',value:1}],
 [{source:'甲',target:'甲',value:1}],
 [{source:'甲',target:'乙',value:1},{source:'甲',target:'乙',value:2}],
 [{source:'甲',target:'乙',value:0}],
 [{source:'甲',target:'乙',value:-1}],
 ])await assert.rejects(()=>service.chart({spec:{...extendedSamples.sankey,data}}),{code:'INVALID_INPUT'});
 await assert.rejects(()=>service.raw({option:{series:[{type:'sankey',data:[{name:'甲'}],links:[{source:'甲',target:'不存在',value:1}]}]}}),{code:'INVALID_INPUT'});
 const option=compile(parsed(extendedSamples.sankey));option.series[0].edges=[{source:'综合展示',target:'课程资源',value:1}];await assert.rejects(()=>service.raw({option}),{code:'INVALID_INPUT'});
});
test('仪表盘/漏斗/热力图数值边界及安全 visualMap',async()=>{
 for(const spec of [
 {...extendedSamples.gauge,data:[{name:'甲',value:101}]}, {...extendedSamples.gauge,min:100,max:0},
 {...extendedSamples.gauge,data:[{name:'甲',value:1},{name:'乙',value:2}]},
 {...extendedSamples.funnel,data:[{stage:'甲',count:0}]},
 {...extendedSamples.heatmap,data:[{day:'周一',group:'甲',count:1},{day:'周一',group:'甲',count:2}]},
 ])await assert.rejects(()=>service.chart({spec}));
 const zeroHeat={...extendedSamples.heatmap,data:[{day:'周一',group:'甲',count:0}]};assert.match((await service.chart({spec:zeroHeat})).svg,/<svg/);
 const option=compile(parsed(extendedSamples.heatmap));
 for(const bad of [{...option.visualMap,calculable:true},{...option.visualMap,type:'piecewise'},{...option.visualMap,inRange:{color:['#ffffff','url(https://example.com/x)']}},{...option.visualMap,formatter:'function(x){return x}'},{...option.visualMap,min:10,max:1}])await assert.rejects(()=>service.raw({option:{...option,visualMap:bad}}));
 for(const type of ['map','custom','bar3D','graphGL'])await assert.rejects(()=>service.raw({option:{series:[{type,data:[1]}]}}),{code:'INVALID_INPUT'});
});
test('HTTP/MCP 能力与 Schema 一致，真实工具返回新增图表',async()=>{
 assert.equal(chartTypes.length,12);const caps=(await app.inject({url:'/v1/capabilities',headers:auth})).json();assert.deepEqual(caps.chartTypes,chartTypes);
 const openapi=(await app.inject({url:'/openapi.json',headers:auth})).json();assert.equal(openapi.components.schemas.ChartSpec.oneOf.length,12);
 const response=await app.inject({method:'POST',url:'/v1/charts',headers:auth,payload:{spec:extendedSamples.sankey,output:{format:'png'}}});assert.equal(response.statusCode,200);assert.equal((await sharp(response.rawPayload).metadata()).width,960);
 const client=new Client({name:'extended',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.address().port}/mcp`),{requestInit:{headers:auth}}));
 try{
 const tools=await client.listTools();const schema=tools.tools.find(t=>t.name==='render_chart').inputSchema;assert.ok(JSON.stringify(schema).includes('sunburst'));
 for(const type of ['heatmap','treemap','sankey']){const result=await client.callTool({name:'render_chart',arguments:{spec:extendedSamples[type],output:{format:'png'}}});assert.equal(result.isError,undefined);assert.equal(result.content[0].type,'image');assert.equal((await sharp(Buffer.from(result.content[0].data,'base64')).metadata()).width,960);}
 }finally{await client.close();}
});
test('新增七类 ChartPlan 由程序绑定原数据',async()=>{
 for(const sample of Object.values(extendedSamples)){
 const {data,...plan}=sample;const ai=new ChartService(pool,async()=>planSchema.parse(plan));const result=await ai.generate({data,intent:`生成 ${sample.type}`});assert.equal(result.spec.type,sample.type);assert.deepEqual(result.spec.data,data);
 }
});
