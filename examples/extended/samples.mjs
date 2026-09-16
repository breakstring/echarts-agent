export const hierarchyData = [
  {id:'root',parent:'',name:'总投入',value:100},
  {id:'teaching',parent:'root',name:'教学活动',value:60},
  {id:'sports',parent:'root',name:'体育活动',value:40},
  {id:'language',parent:'teaching',name:'语言表达',value:35},
  {id:'art',parent:'teaching',name:'艺术创作',value:25},
];
export const extendedSamples = {
  gauge: {type:'gauge',title:'活动完成率',data:[{name:'本月完成率',value:78}],encoding:{name:'name',value:'value'},min:0,max:100,unit:'%'},
  funnel: {type:'funnel',title:'活动报名转化',data:[{stage:'浏览',count:1000},{stage:'咨询',count:600},{stage:'报名',count:300},{stage:'到场',count:240}],encoding:{name:'stage',value:'count'}},
  heatmap: {type:'heatmap',title:'班级活动次数',data:[{day:'周一',group:'小班',count:2},{day:'周二',group:'小班',count:5},{day:'周三',group:'小班',count:3},{day:'周一',group:'中班',count:4},{day:'周二',group:'中班',count:1},{day:'周三',group:'中班',count:6}],encoding:{x:'day',y:'group',value:'count'}},
  tree: {type:'tree',title:'活动层级',data:hierarchyData,encoding:{id:'id',parent:'parent',name:'name'}},
  treemap: {type:'treemap',title:'投入分布',data:hierarchyData,encoding:{id:'id',parent:'parent',name:'name',value:'value'}},
  sunburst: {type:'sunburst',title:'活动投入层级占比',data:hierarchyData,encoding:{id:'id',parent:'parent',name:'name',value:'value'}},
  sankey: {type:'sankey',title:'活动资源流向',data:[{source:'课程资源',target:'语言活动',value:35},{source:'课程资源',target:'艺术活动',value:25},{source:'体育资源',target:'运动活动',value:40},{source:'语言活动',target:'综合展示',value:35},{source:'艺术活动',target:'综合展示',value:25},{source:'运动活动',target:'综合展示',value:40}],encoding:{source:'source',target:'target',value:'value'}},
};
