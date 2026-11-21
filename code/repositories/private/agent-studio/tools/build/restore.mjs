import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { format } from 'prettier';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = join(root, 'upstream/captured');
const output = join(root, 'app');
const assetBase = 'https://ai-copilot.cos.clife.cn/web-agent-paas/';
const fallback = 'https://meiye.cos.clife.cn/material/T000000/209e1407eeb1485fa761eaf7aacff8ac.png';
await mkdir(output, { recursive: true });
await cp(join(source, 'assets'), join(output, 'assets'), { recursive: true });

const manifest = JSON.parse(await readFile(join(root, 'evidence/asset-manifest.json'), 'utf8'));
const navigationAssets = JSON.parse(await readFile(join(root, 'evidence/navigation-asset-manifest.json'), 'utf8'));
const images = JSON.parse(await readFile(join(root, 'evidence/image-manifest.json'), 'utf8'));
const localize = text => images.reduce((value,image) => image.path ? value.replaceAll(image.url,'/'+image.path) : value,text).replaceAll(assetBase,'/');
const changes = [];
for (const file of await readdir(join(output, 'assets/js'))) {
  if (!file.endsWith('.js')) continue;
  const path = join(output, 'assets/js', file);
  let text = await readFile(path, 'utf8');
  text = localize(text);
  if (file === 'request-Cb6e7tFu.js') {
    const start = text.lastIndexOf('X=e=>{');
    const end = text.lastIndexOf(';export{');
    if (start < 0 || end < start) throw new Error('未找到原请求适配器边界');
    text = `import { request as offlineRequest } from '../../offline-api.js';\n` + text.slice(0, start) + 'X=e=>Y.from(offlineRequest(e))' + text.slice(end);
    changes.push({file,change:'请求发送替换为离线数据适配器，保留原导出接口'});
  }
  if(file==='client-BfElcTb7.js'){
    const boundary='var Q=R;export{';
    if(!text.includes(boundary))throw new Error('未找到原账号 SDK 导出边界');
    text=`import {request as offlineRequest} from '../../offline-api.js';\n`+text.replace(boundary,`var Q={getToken:()=>null,request:options=>offlineRequest(options),getOrgList:async()=>[{orgId:'local',orgCode:'local',orgName:'美业行业租户',children:[]}],getTenantList:async()=>({list:[{tenantCode:'local',tenantName:'美业行业租户'}]})};export{`);
    changes.push({file,change:'账号 SDK 使用本地租户展示数据，请求仍统一经过离线边界'});
  }
  if (file === 'low-code-chat-D6fop61f.js') {
    const fieldChanges=[...text.matchAll(/onFieldsChange:Zn\(([A-Za-z_$][\w$]*),\d+\)/g)];
    if(fieldChanges.length!==11)throw new Error('旧图编辑器表单变更边界不匹配');
    // 抽屉关闭会卸载表单，延迟取值会把空对象写回节点。
    text=text.replace(/onFieldsChange:Zn\(([A-Za-z_$][\w$]*),\d+\)/g,'onFieldsChange:$1');
    changes.push({file,change:'节点表单同步提交当前值，避免抽屉卸载后的延迟回调清空配置'});
  }
  if (file === 'qa-daatabase-CouSE0St.js') {
    const stateColumn='title:`状态`,dataIndex:`qaStatus`,hideInSearch:!0,valueEnum:$';
    if(!text.includes(stateColumn))throw new Error('未找到问答状态列边界');
    text=text.replace(stateColumn,stateColumn+',render:(value,row)=>row.localOnly||String(row.qaId).startsWith(`local-qa-`)?`本地保存（未向量化）`:$[row.qaStatus]');
    changes.push({file,change:'本地问答配置显示实际保存状态，不暗示后台向量化正在运行'});
  }
  if (file === 'index.B_LPe2F7.js') {
    const start = text.lastIndexOf('C(),P(()=>import(');
    const end = text.lastIndexOf('export{');
    if (start < 0 || end < start) throw new Error('未找到原程序启动边界');
    const mount = `
// ponytail: 复用完整发布页面及菜单路由，只替换登录启动和网络数据边界。
export function mountRecovered(target, resources, categories) {
  Io.setup();
  const userInfo={org:{orgId:'local',orgCode:'local',orgName:'美业行业租户',orgType:1},tenant:{tenantCode:'local',tenantName:'美业行业租户'},userAccount:{userId:'local'},employee:{nickname:'美业开发者',employeeId:'local'},userName:'美业开发者',userId:'local',isAuth:1};
  const menuList=Af(resources);
  jf.pageButtonMap={};
  jf.formatMenu(menuList);
  jf.update({token:'local-offline',menuList,menuInfoList:menuList,userInfo,loading:false});
  Fs.setState({menuList,userInfo,roleList:[]});
  Is.setState({tenantOptions:[],tenantOptionsLoaded:true});
  us=async()=>({success:true,data:categories});
  df=async(method,url,data)=>offlineRequest({method,url,data});
  for(const method of ['get','delete','head','options'])Y[method]=(url,options={})=>offlineRequest({...options,url,method});
  for(const method of ['post','put','patch'])Y[method]=(url,data,options={})=>offlineRequest({...options,url,method,data});
  Y.request=options=>offlineRequest(options);
  function RecoveredRoutes(){
    const route=q();
    L.useLayoutEffect(()=>{
      if(route.state)sessionStorage.setItem('rea-route:'+location.pathname,JSON.stringify(route.state));
    },[route.pathname,route.state]);
    return X.jsxs(Xu,{children:[X.jsx(J,{path:'/agent/*',element:X.jsx(hh,{})}),X.jsx(J,{path:'*',element:X.jsx(qu,{to:G.AGENT_APP_MANAGE,replace:true})})]});
  }
  jo.createRoot(target).render(X.jsx(O,{locale:ge,theme:Io.theme,children:X.jsx(Ao,{stores:jf,flowStore:Kh,children:X.jsx(yl,{store:Mh,children:X.jsx(vh,{children:X.jsx(cd,{basename:Ad(),children:X.jsx(al.AliveScope,{children:X.jsx(L.Suspense,{fallback:Rh,children:X.jsx(RecoveredRoutes,{})})})})})})})}));
}
`;
    text = `import { request as offlineRequest } from '../../offline-api.js';\n` + text.slice(0, start) + mount + text.slice(end);
    changes.push({file,change:'移除真实账号登录启动，恢复原 Layout 与全部编辑路由；原生 request、df、Axios 风格方法和账号 SDK 四个请求入口都使用离线数据'});
  }
  await writeFile(path, text);
}
for (const file of await readdir(join(output,'assets/css'))) {
  if(file.endsWith('.css')) {
    const path = join(output,'assets/css',file);
    await writeFile(path,(await readFile(path,'utf8')).replaceAll(assetBase,'/'));
  }
}
const sample = JSON.parse(await readFile(join(root,'evidence/agent-samples.json'),'utf8'));
const records = sample.records.map(row=>({...row,microAppId:String(row.microAppId),microAppVersionId:String(row.microAppVersionId),picUrl:localize(row.picUrl||fallback)}));
await writeFile(join(output,'agents.json'),JSON.stringify(records,null,2));
const workflowCapture=JSON.parse(await readFile(join(root,'evidence/workflow-api.json'),'utf8'));
const workflowData=Object.fromEntries(workflowCapture.items.filter(item=>item.response).map(item=>[item.key,item.response.data]));
workflowData.version.picUrl=localize(workflowData.version.picUrl||fallback);
const workflowVersions=JSON.parse(await readFile(join(root,'evidence/workflow-versions.json'),'utf8'));
const modeVersions=JSON.parse(await readFile(join(root,'evidence/agent-mode-versions.json'),'utf8'));
const versionBatches=await Promise.all([1,2,3,4].map(async batch=>JSON.parse(await readFile(join(root,'evidence/versions-'+batch+'.json'),'utf8'))));
workflowData.versions=[workflowData.version,...workflowVersions.items.filter(item=>item.data).map(item=>item.data),...modeVersions.items.filter(item=>item.response?.success).map(item=>item.response.data),...versionBatches.flatMap(batch=>batch.items.filter(item=>item.response?.success).map(item=>item.response.data))].map(item=>({...item,picUrl:localize(item.picUrl||fallback)}));
await writeFile(join(output,'workflow-data.json'),JSON.stringify(workflowData,null,2));
const businessCaptures=await Promise.all(['sidebar-data','component-data','mode-support-data'].map(async file=>JSON.parse(await readFile(join(root,'evidence/'+file+'.json'),'utf8'))));
const businessData=Object.fromEntries(businessCaptures.flatMap(capture=>capture.items.filter(item=>item.response.data!=null).map(item=>[item.key,item.response.data])));
const componentDetails=JSON.parse(await readFile(join(root,'evidence/component-details.json'),'utf8'));
for(const [key,id] of [['plugins','compId'],['roles','pluginId']]){
  for(const item of componentDetails[key]){
    const row=businessData[key].records.find(row=>String(row[id])===String(item[id]));
    if(row&&item.response.data)Object.assign(row,item.response.data);
  }
}
await writeFile(join(output,'business-data.json'),localize(JSON.stringify(businessData,null,2)));
const knowledgeDocuments=JSON.parse(await readFile(join(root,'evidence/knowledge-documents.json'),'utf8'));
await writeFile(join(output,'knowledge-documents.json'),localize(JSON.stringify(knowledgeDocuments,null,2)));
const knowledgeContent=JSON.parse(await readFile(join(root,'evidence/knowledge-content.json'),'utf8'));
await writeFile(join(output,'knowledge-content.json'),localize(JSON.stringify(knowledgeContent,null,2)));

const navigation=JSON.parse(await readFile(join(root,'evidence/navigation-resources.json'),'utf8'));
await writeFile(join(output,'navigation.json'),localize(JSON.stringify(navigation.menuData.filter(item=>item.permissionCode==='application_development'),null,2)));
const resources=JSON.parse(await readFile(join(root,'evidence/workflow-resources.json'),'utf8'));
const links=resources.styles.map(url=>`<link rel="stylesheet" href="${url.replace(assetBase,'/')}">`).join('\n');
const page=`<!doctype html>\n<html lang="zh-CN" class="global-custom-scroll-bar scroll-dom">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>智能体云平台 · REA 本地还原</title>\n${links}\n<link rel="stylesheet" href="/runtime.css"><link rel="stylesheet" href="/local.css"></head>\n<body><div id="recovered-app"></div><script type="module" src="/main.js"></script></body></html>`;
await writeFile(join(output,'index.html'),page);
await writeFile(join(output,'runtime.css'),localize((await readFile(join(root,'evidence/runtime.css'),'utf8'))+'\n'+(await readFile(join(root,'evidence/workflow-runtime.css'),'utf8'))));

const readable=join(root,'readable');
await mkdir(readable,{recursive:true});
const sharedFiles=['AgentTable-DMLUccn2.js','src-_hjT3BN9.js','constants-DGERUyiC.js','agent-C0JAlTor.js','status-dict-D3T8Xf4E.js','ListLayout-B8lj_6O3.js','LayoutHeader-DwNjoN8b.js','micro-app-DNjru_4h.js','Graph-B6k8QY9W.js','utils-DS1Vnd25.js','config-KnGHEPxL.js','hooks-C9yyjErO.js','intelligentEngine-BhRFRjx8.js','src--QpPaBte.js'];
const appFiles=[...new Set([...navigationAssets.entries,...sharedFiles])];
for(const file of appFiles){
  const text=await readFile(join(source,'assets/js',file),'utf8');
  await writeFile(join(readable,file),await format(text,{parser:'babel'}));
}
const graphs=workflowData.versions.map(version=>{
  try{return JSON.parse(version.data)}catch{return null}
}).filter(value=>value&&Array.isArray(value.nodes)&&Array.isArray(value.edges));
const businessCounts=Object.fromEntries(['prompts','promptLabels','teams','roles','skills','mcp','plugins','knowledge'].map(key=>{
  const value=businessData[key];
  const list=Array.isArray(value)?value:Array.isArray(value?.records)?value.records:Array.isArray(value?.data)?value.data:[];
  return [key,list.length];
}));
await writeFile(join(root,'evidence/restoration-manifest.json'),JSON.stringify({
  reaVersion:'6.4.0',
  capturedAssets:navigationAssets.assets.filter(asset=>asset.path).length,
  sourceMapStatus:'未在已采集脚本中声明 sourceMappingURL',
  readableFiles:appFiles,
  changes,
  agentRecords:records.length,
  versions:workflowData.versions.length,
  runModes:[...new Set(records.map(row=>Number(row.runMode)))].sort(),
  workflowGraphs:{count:graphs.length,nodes:graphs.reduce((sum,graph)=>sum+graph.nodes.length,0),edges:graphs.reduce((sum,graph)=>sum+graph.edges.length,0)},
  businessCounts,
  knowledgeCounts:{
    bases:knowledgeDocuments.bases.length,
    documents:knowledgeDocuments.documents.length,
    segmentGroups:knowledgeContent.segments.length,
    segments:knowledgeContent.segments.reduce((sum,group)=>sum+group.response.data.length,0),
    tableGroups:knowledgeContent.tables.length,
    qaRows:knowledgeContent.qa.reduce((sum,group)=>sum+group.response.data.length,0),
    labelQueries:knowledgeContent.labels.length,
  },
  scope:'原发布 Layout、完整侧栏、7 种 Agent 模式编辑器与业务页面离线运行；服务端执行能力不在恢复范围',
  upstreamMissingAssets:navigationAssets.summary.missing,
},null,2));
console.log(`已生成 ${output}；可读模块 ${appFiles.length} 个，Agent ${records.length} 条，版本 ${workflowData.versions.length} 个。`);
