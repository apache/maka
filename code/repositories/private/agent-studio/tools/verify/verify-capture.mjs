import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDocuments, requestDocuments } from '../../app/offline-documents.js';

const root=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const directory=resolve(root,process.argv[2]??'evidence/capture-20261022');
const read=name=>readFile(join(directory,name),'utf8').then(JSON.parse);
const [agents,versions,knowledge,lists,documents,content]=await Promise.all([
  'agent-samples.json','versions-20261022.json','knowledge-list.json',
  'knowledge-document-lists.json','knowledge-documents.json','knowledge-content.json',
].map(read));
const unique=(rows,id)=>assert.equal(new Set(rows.map(row=>String(row[id]))).size,rows.length,`${id} 必须唯一`);
for(const capture of [agents,versions,knowledge,lists,documents])assert.equal(capture.status,'complete','采集元数据尚未完成');
assert.equal(agents.records.length,agents.total);
assert.equal(versions.items.length,versions.captured);
assert.equal(versions.captured,versions.total);
unique(agents.records,'microAppId');
unique(versions.items,'id');
const byVersion=new Map(versions.items.map(item=>[String(item.id),item.response]));
for(const row of agents.records){
  const response=byVersion.get(String(row.microAppVersionId));
  assert.equal(response?.success,true,'Agent 引用配置缺失或失败');
  assert.equal(String(response.data.microAppVersionId),String(row.microAppVersionId));
  assert.equal(String(response.data.microAppId),String(row.microAppId),'版本所属 Agent 不一致');
}
const bases=knowledge.response.data;
assert.equal(bases.length,knowledge.total);
assert.equal(lists.bases.length,lists.totalBases);
assert.equal(lists.totalBases,bases.length);
assert.equal(documents.bases.length,bases.length);
unique(bases,'baseId');
for(const base of bases){
  assert.equal(typeof base.baseId,'string','知识库 ID 必须保留源字符串');
  const listed=lists.bases.find(item=>item.baseId===base.baseId);
  assert.ok(listed,'缺少知识库文档列表');
  const metadata=documents.bases.find(item=>item.baseId===base.baseId);
  assert.deepEqual(metadata.response,listed.response,'最终文档列表必须与采集列表一致');
  for(const doc of listed.response.data)assert.equal(typeof doc.docId,'string','文档 ID 必须保留源字符串');
}
assert.equal(documents.documents.length,lists.documentCount);
for(const group of content.segments){
  const orders=group.response.data.map(row=>row.segmentOrder);
  assert.equal(new Set(orders).size,orders.length,'分段游标出现重复 '+group.docId);
  assert.ok(orders.every((order,index)=>index===0||order>orders[index-1]),'分段游标顺序错误 '+group.docId);
}
const originalFetch=globalThis.fetch;
const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
try{
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:undefined});
  globalThis.fetch=async path=>{
    assert.ok(['/knowledge-documents.json','/knowledge-content.json'].includes(path));
    return new Response(JSON.stringify(path==='/knowledge-documents.json'?documents:content));
  };
  const initialized=await initializeDocuments();
  assert.equal(initialized.success,true,initialized.msg);
  for(const doc of documents.documents){
    assert.deepEqual(await requestDocuments('/agent-kg/doc/getInfo',{docId:doc.docId}),doc.info);
    assert.deepEqual(await requestDocuments('/agent-kg/doc/getConfig',{docId:doc.docId}),doc.config);
  }
}finally{
  globalThis.fetch=originalFetch;
  if(originalStorage)Object.defineProperty(globalThis,'localStorage',originalStorage);
  else delete globalThis.localStorage;
}
const oldAgents=JSON.parse(await readFile(join(root,'evidence/agent-samples.json'),'utf8'));
const oldBases=JSON.parse(await readFile(join(root,'evidence/knowledge-documents.json'),'utf8'));
const modes=Object.fromEntries([...new Set(agents.records.map(row=>row.runMode))].sort().map(mode=>[mode,agents.records.filter(row=>row.runMode===mode).length]));
const result={
  checkedAt:new Date().toISOString(),directory,metadataValidated:true,
  checks:['Agent与版本唯一引用','知识库和文档源字符串ID','采集列表与最终元数据一致','现有文档模块初始化及每份info/config公开读取'],
  agentRecords:agents.records.length,currentVersionConfigs:versions.items.length,runModes:modes,
  oldAgentIdOverlap:agents.records.filter(row=>oldAgents.records.some(old=>String(old.microAppId)===String(row.microAppId))).length,
  oldBaseIdOverlap:bases.filter(row=>oldBases.bases.some(old=>old.baseId===row.baseId)).length,
  knowledgeBases:bases.length,documents:documents.documents.length,
  contentStatus:content.status,
  segmentGroups:content.segments.length,segments:content.segments.reduce((sum,group)=>sum+group.response.data.length,0),
  declaredSegments:lists.bases.reduce((sum,base)=>sum+base.response.data.reduce((total,doc)=>total+Number(doc.segmentCount??0),0),0),
  segmentDocumentsMissing:lists.bases.flatMap(base=>base.response.data).filter(doc=>Number(doc.segmentCount)>0&&!content.segments.some(group=>group.docId===doc.docId)).map(doc=>doc.docId),
  segmentCountDifferences:content.segments.flatMap(group=>{
    const doc=lists.bases.flatMap(base=>base.response.data).find(row=>row.docId===group.docId);
    return doc&&Number(doc.segmentCount)!==group.response.data.length?[{docId:group.docId,declared:Number(doc.segmentCount),captured:group.response.data.length}]:[];
  }),
  tableGroups:content.tables.length,qaGroups:content.qa.length,qaRows:content.qa.reduce((sum,group)=>sum+group.response.data.length,0),
  labelQueries:content.labels.length,
  captureErrors:[...(documents.errors??[]),...(content.errors??[])].length,
  runtimeActivated:false,
  limits:['结构与读取兼容验证不代表内容全量；缺口以采集报告为准','新上下文含模式7，未替换旧前端及用户快照'],
};
await writeFile(join(root,'evidence/capture-validation-20261022.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
