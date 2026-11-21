import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initialize,request} from '../../app/offline-api.js';
const rows=JSON.parse(await readFile(new URL('../../app/agents.json',import.meta.url),'utf8'));
const expected=JSON.parse(await readFile(new URL('../../app/workflow-data.json',import.meta.url),'utf8')).versions;
const sample=JSON.parse(await readFile(new URL('../../evidence/agent-samples.json',import.meta.url),'utf8'));
assert.equal(rows.length,sample.records.length,'生成列表不能漏掉采集记录');
assert.equal(new Set(rows.map(row=>row.microAppId)).size,rows.length,'Agent ID 必须唯一');
assert.equal(new Set(expected.map(version=>String(version.microAppVersionId))).size,expected.length,'新旧采集批次必须按版本 ID 去重');
globalThis.fetch=async path=>({json:async()=>JSON.parse(await readFile(new URL('../../app'+path,import.meta.url),'utf8'))});
await initialize();
let nodes=0,edges=0;
for(const row of rows){
 const result=await request({url:'/agent-microapp/microAppVersion/findById',data:{id:row.microAppVersionId}});
 assert.equal(result.success,true,row.microAppName);
 assert.equal(result.data.data,expected.find(version=>String(version.microAppVersionId)===row.microAppVersionId).data);
 const config=JSON.parse(result.data.data??'{}');nodes+=config.nodes?.length??0;edges+=config.edges?.length??0;
}
assert.deepEqual([...new Set(rows.map(row=>Number(row.runMode)))].sort(),[0,1,2,3,4,5,6]);
console.log(JSON.stringify({versions:rows.length,capturedVersions:expected.length,nodes,edges,runModes:[...new Set(rows.map(row=>row.runMode))]}));
