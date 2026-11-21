import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initializeBusiness} from '../../app/offline-business.js';
import {initializeDocuments} from '../../app/offline-documents.js';
import {initializeTask} from '../../app/offline-task.js';
import {request as publicRequest} from '../../app/offline-api.js';

let routeState={};
try{
  routeState=await import('../../app/route-state.js');
}catch(error){
  if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
}
assert.equal(typeof routeState.stateFromRouteUrl,'function','尚未恢复 URL 路由身份读取接口');
assert.equal(typeof routeState.urlWithRouteState,'function','尚未恢复路由身份写入接口');
assert.equal(typeof routeState.defaultModeForPath,'function','尚未恢复裸编辑路由默认模式接口');

const origin='http://127.0.0.1:4173';
const workflow='/agent/studio/agent/workflow';
const state={microAppId:'129992587288',microAppVersionId:'5433',runMode:4};
const mirrored=routeState.urlWithRouteState(workflow,{usr:state},origin);
assert.equal(mirrored,workflow+'?microAppId=129992587288&microAppVersionId=5433&runMode=4');
assert.deepEqual(routeState.stateFromRouteUrl(origin+mirrored),state);
assert.deepEqual(routeState.stateFromRouteUrl(origin+'/agent/studio/agent/low-code-chat?microAppId=1&microAppVersionId=2&graphType=2'),{microAppId:'1',microAppVersionId:'2',graphType:2});
assert.equal(routeState.stateFromRouteUrl(origin+workflow+'?microAppId=1'),null,'缺少版本 ID 不能恢复到错误 Agent');
assert.equal(routeState.stateFromRouteUrl(origin+'/agent/studio/agent/app-manage?microAppId=1&microAppVersionId=2'),null,'非编辑器页面不能注入编辑状态');
assert.equal(routeState.urlWithRouteState('/agent/studio/agent/app-manage',{usr:state},origin),'/agent/studio/agent/app-manage');
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/low-code-chat'),0);
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/no-code-chat'),1);
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/task-app'),3);
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/workflow'),4);
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/standard-agent'),5);
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/super-agent'),6);
assert.equal(routeState.defaultModeForPath('/agent/studio/agent/app-manage'),null);

const makeHost=(path,historyState={},cache={})=>{
  const location=new URL(origin+path);
  const history={state:historyState};
  for(const method of ['pushState','replaceState'])history[method]=(value,title,url)=>{
    history.state=value;
    location.href=new URL(url,location).href;
  };
  return {location,history,sessionStorage:{getItem:key=>cache[key]??null}};
};
const calls=[];
const request=async options=>{
  calls.push(options);
  return {success:true,data:{records:[{microAppId:'1935',microAppVersionId:'3950',runMode:0}]}};
};
const host=makeHost('/agent/studio/agent/low-code-chat');
await routeState.installRouteStateBridge(request,host);
assert.equal(host.history.state.usr.microAppVersionId,'3950','首次直接打开应读取对应模式真实版本');
assert.equal(host.location.searchParams.get('graphType'),'0');
assert.equal(calls[0].data.runMode,0);
host.history.pushState({usr:state},'',workflow);
assert.equal(host.location.searchParams.get('microAppVersionId'),'5433','管理页导航应自动写入 URL 身份');
const copiedLink=makeHost(workflow+'?microAppId=129992587288&microAppVersionId=5433&graphType=4',{usr:{microAppId:'stale',microAppVersionId:'stale'}});
await routeState.installRouteStateBridge(request,copiedLink);
assert.equal(copiedLink.history.state.usr.microAppVersionId,'5433','复制链接必须优先于旧历史状态');
const brokenCache=makeHost('/agent/studio/agent/low-code-chat',{}, {'rea-route:/agent/studio/agent/low-code-chat':'{broken'});
await routeState.installRouteStateBridge(request,brokenCache);
assert.equal(brokenCache.history.state.usr.microAppVersionId,'3950','损坏的路由缓存不能使页面白屏');
const root='/agent/studio/agent';
const rolePath=root+'/role-agent/detail';
const originalFetch=globalThis.fetch;
const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
const storage=new Map();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,String(value)),
}});
globalThis.fetch=async input=>{
  const name=new URL(String(input),origin).pathname.split('/').pop();
  assert.ok(['business-data.json','knowledge-documents.json','knowledge-content.json'].includes(name),'只读取本地 fixture');
  return new Response(await readFile(new URL('../../app/'+name,import.meta.url),'utf8'));
};
try{
  await initializeBusiness();
  assert.equal((await initializeDocuments()).success,true);
  const seed=JSON.parse(await readFile(new URL('../../app/business-data.json',import.meta.url),'utf8'));
  const read=async(url,data={})=>{
    const response=await publicRequest({url,data});
    assert.equal(response.success,true,response.msg);
    return response.data;
  };
  const roleA=seed.roles.records[0];
  const roleB=await read('/agent-microapp/plugin/add',{pluginName:'第二条路由专家',description:'复制链接目标'});
  const navigation=makeHost(root+'/role-agent');
  await routeState.installRouteStateBridge(publicRequest,navigation);
  for(const row of [roleA,roleB]){
    navigation.history.pushState({usr:row,key:'ui',idx:2},'',rolePath);
    assert.equal(navigation.location.searchParams.get('pluginIdStr'),String(row.pluginIdStr),'同一详情路由应分别镜像两个专家身份');
    assert.deepEqual([...navigation.location.searchParams.keys()],['pluginIdStr'],'只把必要身份写入 URL');
    const copied=makeHost(navigation.location.pathname+navigation.location.search,{usr:roleB},
      {['rea-route:'+rolePath]:JSON.stringify(roleB)});
    await routeState.installRouteStateBridge(publicRequest,copied);
    assert.equal(String(copied.history.state.usr.pluginIdStr),String(row.pluginIdStr),'复制 URL 应胜过旧 history 和路径缓存');
    assert.equal(copied.history.state.usr.pluginName,row.pluginName,'通过公共 request 重建基础 row');
    assert.equal(copied.history.state.key,'local-route');
  }
  const missing=makeHost(rolePath+'?pluginIdStr=not-found',{usr:roleA});
  await routeState.installRouteStateBridge(publicRequest,missing);
  assert.equal(missing.location.pathname,root+'/role-agent','未知身份安全回专家列表');
  assert.equal(missing.history.state.usr,null,'回列表时清除旧详情 state');
  assert.equal((await initializeTask()).success,true);
  const lowCode=root+'/low-code-chat';
  const flowA=seed.taskFlows.records[0];
  const flowB=await read('/agent-microapp/flow/create',{
    microAppId:flowA.microAppId,microAppVersionId:flowA.microAppVersionId,
    flowName:'第二条任务流程',data:'{"nodes":[],"edges":[]}',
  });
  for(const flow of [flowA,flowB]){
    const flowState={...flow,graphType:3};
    navigation.history.pushState({usr:flowState},'',lowCode+'?flowId=stale&runMode=0&graphType=2&unknown=old&token=secret');
    assert.equal(navigation.location.searchParams.get('flowId'),String(flow.flowId),'任务画布导航必须镜像 flowId');
    assert.deepEqual([...navigation.location.searchParams.keys()].sort(),['flowId','graphType','microAppId','microAppVersionId']);
    const copied=makeHost(navigation.location.pathname+navigation.location.search,{usr:{...flowA,graphType:3}});
    await routeState.installRouteStateBridge(publicRequest,copied);
    assert.equal(String(copied.history.state.usr.flowId),String(flow.flowId));
    assert.equal(copied.history.state.usr.flowUniqueId,flow.flowUniqueId,'从公共 request 恢复任务流 uniqueId');
    assert.equal(copied.history.state.usr.data,flow.data,'流程内容留在 state');
    assert.equal(copied.history.state.usr.graphType,3);
  }
  const wrongFlow=makeHost(lowCode+'?microAppId='+flowA.microAppId+'&microAppVersionId='+flowA.microAppVersionId+'&graphType=3&flowId=missing',{usr:{...flowA,graphType:3}});
  await routeState.installRouteStateBridge(publicRequest,wrongFlow);
  assert.equal(wrongFlow.location.pathname,root+'/task-app','未知任务流不能退回旧 flow 或默认 Agent');
  navigation.history.pushState({usr:{microAppId:'1',microAppVersionId:'2',graphType:0}},'',lowCode+'?flowId=stale&graphType=3&data=old');
  assert.equal(navigation.location.searchParams.has('flowId'),false,'离开任务画布时删除旧 flowId');

  const team=await read('/agent-microapp/pluginCollection/add',{collectionName:'路由团队'});
  const docs=JSON.parse(await readFile(new URL('../../app/knowledge-documents.json',import.meta.url),'utf8'));
  const docA=docs.documents[0].info.data;
  const docB=docs.documents[1].info.data;
  const baseA=await read('/agent-kg/database/baseDetails',{baseId:docA.baseId});
  const qaBase=seed.knowledge.find(row=>row.baseType===1);
  assert.ok(qaBase,'采集的 QA 知识库');
  const cases=[
    ['/role-agent/detail','pluginIdStr',roleA,'pluginName'],
    ['/agent-team/detail','collectionId',team,'collectionName'],
    ['/agent-skill/detail','skillId',seed.skills.records[0],'skillName'],
    ['/plugin/detail','id',{...seed.plugins.records[0],id:seed.plugins.records[0].compId},'compName'],
    ...['mcp-service','plugin'].flatMap(group=>[
      ...['mcp-details','edit-mcp'].map(page=>['/'+group+'/'+page,'id',seed.mcp.data[0],'mcpServerName']),
      ...['tool-details','edit-tool'].map(page=>['/'+group+'/'+page,'id',seed.mcp.data[0].mcpToolList[0],'toolName']),
    ]),
    ['/knowledge/doc','baseId',baseA,'baseName'],
    ['/knowledge/qa-database','baseId',qaBase,'baseName'],
    ['/knowledge/audio-video','baseId',baseA,'baseName'],
    ['/knowledge/doc/structure','baseId',baseA,'baseName'],
    ...['doc/import','tabledoc/import','audio-video/edit'].map(page=>['/knowledge/'+page,'baseId',{...baseA,...docA},'docName']),
    ...['doc/import-details','tabledoc/detail'].map(page=>['/knowledge/'+page,'docId',{...baseA,...docA},'docName']),
  ];
  for(const [suffix,key,row,label] of cases){
    const path=root+suffix;
    navigation.history.pushState({usr:{...row,token:'private',credentials:{apiKey:'never-in-url'},record:docA},key:'nav',idx:7},'',path+'?unknown=old&token=secret&flowId=stale&docId=stale');
    const expectedIdentity=key==='docId'||suffix.includes('/knowledge/')?['baseId','docId'].filter(field=>row[field]!=null)
      :suffix.endsWith('/tool-details')||suffix.endsWith('/edit-tool')?['id','mcpServerId']:[key];
    assert.deepEqual([...navigation.location.searchParams.keys()].sort(),expectedIdentity.sort(),suffix+' 仅镜像必要身份');
    assert.equal(navigation.location.searchParams.get(key),String(row[key]));
    assert.equal(routeState.stateFromRouteUrl(navigation.location.href)[key],String(row[key]));
    const copied=makeHost(navigation.location.pathname+navigation.location.search);
    assert.equal(await routeState.installRouteStateBridge(publicRequest,copied),undefined,'main 的 await 返回语义保持兼容');
    assert.equal(copied.location.pathname,path,suffix+' 无 history 的复制链接');
    assert.equal(String(copied.history.state.usr[key]),String(row[key]));
    assert.equal(copied.history.state.usr[label],row[label]);
    if(key==='docId'||row.docId)assert.equal(copied.history.state.usr.record.docName,row.docName,'重建 tabledoc 所读的 record');
    if(suffix.endsWith('/edit-tool'))assert.equal(copied.history.state.usr.httpToMcpEnabled,true,'工具编辑需恢复服务能力');
    const refresh=makeHost(path,{usr:{...copied.history.state.usr,checkTabs:'configMcpTool',step:2},key:'keep',idx:4});
    await routeState.installRouteStateBridge(publicRequest,refresh);
    assert.equal(refresh.history.state.usr.checkTabs,'configMcpTool','刷新保留同身份 history 的 UI state');
    assert.equal(refresh.history.state.usr.step,2);
    assert.equal(refresh.history.state.key,'keep');
    assert.equal(refresh.history.state.idx,4);
    const bare=makeHost(path,{}, {['rea-route:'+path]:JSON.stringify(row)});
    await routeState.installRouteStateBridge(publicRequest,bare);
    assert.notEqual(bare.location.pathname,path,'无身份不能误用按路径缓存 '+suffix);
    assert.equal(bare.history.state.usr,null);
    const unknown=makeHost(path+'?'+key+'=unknown',{usr:row},{['rea-route:'+path]:JSON.stringify(row)});
    await routeState.installRouteStateBridge(publicRequest,unknown);
    assert.notEqual(unknown.location.pathname,path,'未知 ID 失败且不回退旧 history '+suffix);
    assert.equal(unknown.history.state.usr,null);
  }
  for(const page of ['doc/import-details','tabledoc/detail']){
    const path=root+'/knowledge/'+page;
    for(const doc of [docA,docB]){
      const copied=makeHost(path+'?docId='+doc.docId,{usr:{...baseA,...docB,record:docB}});
      await routeState.installRouteStateBridge(publicRequest,copied);
      assert.equal(copied.history.state.usr.record.docName,doc.docName,'同一详情路由两个文档不串 record');
      assert.equal(String(copied.history.state.usr.baseId),String(doc.baseId),'仅 docId 可读取其所属知识库');
    }
  }
  const invalidDoc=makeHost(root+'/knowledge/tabledoc/detail?baseId='+baseA.baseId+'&docId=unknown',{usr:{...baseA,...docA}});
  await routeState.installRouteStateBridge(publicRequest,invalidDoc);
  assert.equal(invalidDoc.location.pathname,root+'/knowledge/doc','文档失效但知识库存在时回该库文档列表');
  assert.equal(invalidDoc.history.state.usr.baseName,baseA.baseName);
  const crossedDoc=makeHost(root+'/knowledge/tabledoc/detail?baseId='+docB.baseId+'&docId='+docA.docId);
  await routeState.installRouteStateBridge(publicRequest,crossedDoc);
  assert.notEqual(crossedDoc.location.pathname,root+'/knowledge/tabledoc/detail','不得混合不同库的文档');
  for(const id of [197,198]){
    const copied=makeHost(root+'/mcp-service/edit-tool?id='+id,{usr:{id:198,mcpServerId:164}});
    await routeState.installRouteStateBridge(publicRequest,copied);
    assert.equal(String(copied.history.state.usr.id),String(id),'同一路由两个 MCP 工具身份隔离');
    assert.equal(copied.history.state.usr.mcpServerId,164);
  }
  const crossedTool=makeHost(root+'/mcp-service/edit-tool?id=197&mcpServerId=288');
  await routeState.installRouteStateBridge(publicRequest,crossedTool);
  assert.equal(crossedTool.location.pathname,root+'/mcp-service','工具与服务归属不一致时失败');
  const createTool=makeHost(root+'/mcp-service/edit-tool?mcpServerId=288');
  await routeState.installRouteStateBridge(publicRequest,createTool);
  assert.equal(String(createTool.history.state.usr.mcpServerId),'288','工具新建保留父服务身份');
  assert.equal(createTool.history.state.usr.httpToMcpEnabled,false);
  assert.equal(createTool.history.state.usr.id,undefined);
  const incomplete=makeHost(rolePath+'?pluginIdStr=',{usr:roleA});
  await routeState.installRouteStateBridge(publicRequest,incomplete);
  assert.equal(incomplete.location.pathname,root+'/role-agent','显式空 ID 不能回退旧 history');
  const unavailable=makeHost(rolePath+'?pluginIdStr='+roleA.pluginIdStr);
  await routeState.installRouteStateBridge(async()=>{throw new Error('读取失败');},unavailable);
  assert.equal(unavailable.location.pathname,root+'/role-agent','request 异常安全回列表');
  for(const group of ['mcp-service','plugin']){
    const policy=makeHost(root+'/'+group+'/auth-policy-detail?id=not-captured');
    await routeState.installRouteStateBridge(publicRequest,policy);
    assert.equal(policy.location.pathname,root+'/'+group+'/auth-policy','未接入的鉴权详情明确回其列表');
    const copied=makeHost(root+'/'+group+'/auth-policy-detail?id=42');
    await routeState.installRouteStateBridge(async options=>{
      assert.equal(options.url,'/agent-mcp/system/mcpStrategy/getById/42');
      return {success:true,data:{id:42,strategyName:'公共读取的鉴权策略'}};
    },copied);
    assert.equal(copied.history.state.usr.id,'42');
  }
  const listState={usr:{baseId:'stale',pluginIdStr:'old'},key:'list',idx:5};
  const list=makeHost(root+'/knowledge?name=search',listState);
  await routeState.installRouteStateBridge(async()=>{assert.fail('非详情不能请求 row');},list);
  assert.strictEqual(list.history.state,listState);
  assert.equal(list.location.href,origin+root+'/knowledge?name=search');
  assert.equal(routeState.urlWithRouteState(root+'/knowledge?name=search',listState,origin),root+'/knowledge?name=search');
  assert.equal(routeState.stateFromRouteUrl(list.location.href),null);
  assert.equal(routeState.urlWithRouteState('https://example.invalid'+rolePath,{usr:roleA},origin),'https://example.invalid'+rolePath,'不向外部地址附带身份');
  const otherBase=seed.knowledge.find(row=>row.baseId!==baseA.baseId);
  navigation.history.replaceState({usr:otherBase},'',root+'/knowledge/doc?baseId='+baseA.baseId+'&docId='+docA.docId+'#keep');
  assert.equal(navigation.location.searchParams.has('docId'),false,'切换到另一知识库时清理旧文档 ID');
  assert.equal(navigation.location.hash,'#keep');
  const staleImport=makeHost(root+'/knowledge/doc/import?baseId='+baseA.baseId,{usr:{...baseA,...docA,record:docA,docIdList:[docA]}});
  await routeState.installRouteStateBridge(publicRequest,staleImport);
  assert.equal(staleImport.history.state.usr.docId,undefined,'同库的新导入链接不能复活 history 中的旧文档');
  assert.equal(staleImport.history.state.usr.record,undefined);
  const flowOnly=makeHost(lowCode+'?graphType=3&flowId='+flowA.flowId);
  await routeState.installRouteStateBridge(publicRequest,flowOnly);
  assert.equal(String(flowOnly.history.state.usr?.flowId),String(flowA.flowId),'flowId 可通过公共读取补齐 app/version 身份');
  const oldTaskUrl=makeHost(lowCode+'?microAppId='+flowA.microAppId+'&microAppVersionId='+flowA.microAppVersionId+'&graphType=3',{usr:{...flowB,graphType:3}});
  await routeState.installRouteStateBridge(publicRequest,oldTaskUrl);
  assert.equal(oldTaskUrl.location.pathname,root+'/task-app');
  assert.equal(String(oldTaskUrl.history.state.usr?.microAppVersionId),String(flowA.microAppVersionId),'旧任务画布 URL 缺 flowId 回任务应用时保留 URL 版本身份');
  assert.equal(String(oldTaskUrl.history.state.usr?.microAppId),String(flowA.microAppId));
  assert.equal(oldTaskUrl.history.state.usr.runMode,3);
  assert.equal(oldTaskUrl.history.state.usr.flowId,undefined);
  const variables=await read('/agent-microapp/agent/variable/findByCondition',oldTaskUrl.history.state.usr);
  assert.ok(Array.isArray(variables.records),'任务页公共读取可用于 reduce，不因空身份报错');
  navigation.history.pushState({usr:null},'',root+'/mcp-service/mcp-details');
  assert.equal(navigation.location.pathname,root+'/mcp-service','UI 打开缺少身份的详情也安全回列表');
}finally{
  globalThis.fetch=originalFetch;
  if(originalStorage)Object.defineProperty(globalThis,'localStorage',originalStorage);
  else delete globalThis.localStorage;
}
console.log('编辑器与业务详情 URL 身份镜像、公共 request 恢复和串记录保护通过');
