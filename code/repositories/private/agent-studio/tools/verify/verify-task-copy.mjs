import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initialize,request} from '../../app/offline-api.js';
import {initializeBusiness} from '../../app/offline-business.js';
import {initializeTask} from '../../app/offline-task.js';

const fixtures=new Map(await Promise.all(['agents.json','workflow-data.json','business-data.json'].map(async name=>[
  '/'+name,
  await readFile(new URL('../../app/'+name,import.meta.url),'utf8'),
])));
const cache=new Map();
let failedKey;
globalThis.localStorage={
  getItem:key=>cache.get(key)??null,
  setItem:(key,value)=>{
    if(key===failedKey)throw new Error('test storage quota');
    cache.set(key,String(value));
  },
};
globalThis.fetch=async path=>{
  const key='/'+String(path).split('/').pop();
  assert.ok(fixtures.has(key),'测试只允许读取本地 fixture：'+path);
  return new Response(fixtures.get(key));
};

const call=async(path,data={})=>{
  const response=await request({url:'/agent-microapp/'+path,data});
  assert.equal(response.success,true,response.msg??response.errMessage??path);
  return response.data;
};
const taskTables=[
  ['agent/variable/findByCondition','variable'],
  ['agent/entity/findByCondition','entity'],
  ['agent/intent/findPage','intent'],
  ['topic/getPage','topic'],
  ['flow/getPage','flow'],
];
const counts=async row=>Object.fromEntries(await Promise.all(taskTables.map(async([path,key])=>{
  const page=await call(path,{microAppId:row.microAppId,microAppVersionId:row.microAppVersionId,pageNum:1,pageSize:100});
  return [key,page.total];
})));

await initialize();
await initializeBusiness();
assert.equal((await initializeTask()).success,true);
const source=(await call('microApp/findMicroAppPage',{runMode:3,pageNum:1,pageSize:10})).records[0];
assert.ok(source,'真实 fixture 必须含任务型 Agent');
const sourceCounts=await counts(source);
assert.ok(Object.values(sourceCounts).some(Boolean),'真实任务型 Agent 必须含任务数据');

const copied=await call('microApp/copy',{microAppId:source.microAppId});
assert.deepEqual(await counts(copied),sourceCounts,'任务型副本必须复制变量、实体、意图、主题和流程');

await initialize();
assert.equal((await initializeTask()).success,true);
assert.deepEqual(await counts(copied),sourceCounts,'刷新后任务型副本配置不能丢失');
assert.deepEqual(await counts(source),sourceCounts,'复制副本不能修改源任务配置');

await call('microApp/deleteById',{id:copied.microAppId});
await initialize();
assert.equal((await initializeTask()).success,true);
assert.equal((await request({url:'/agent-microapp/microApp/findById',data:{id:copied.microAppId}})).success,false);
assert.deepEqual(await counts(copied),Object.fromEntries(Object.keys(sourceCounts).map(key=>[key,0])),'删除副本必须同步清理任务配置');
assert.deepEqual(await counts(source),sourceCounts,'删除副本不能修改源任务配置');

const beforePage=await call('microApp/findMicroAppPage',{runMode:3,pageNum:1,pageSize:100});
const taskCache=cache.get('rea-task-snapshot');
failedKey='rea-local-snapshot';
const rejected=await request({url:'/agent-microapp/microApp/copy',data:{id:source.microAppId}});
failedKey=undefined;
assert.equal(rejected.success,false,'Agent 快照写入失败必须报告复制失败');
assert.equal(cache.get('rea-task-snapshot'),taskCache,'复制失败不能遗留无所属 Agent 的任务副本');
await initialize();
assert.deepEqual(await call('microApp/findMicroAppPage',{runMode:3,pageNum:1,pageSize:100}),beforePage);

const empty=await call('microApp/create',{microAppName:'本地空任务型复制',runMode:3});
const emptyCopy=await call('microApp/copy',{id:empty.microAppId});
assert.deepEqual(await counts(emptyCopy),{variable:0,entity:0,intent:0,topic:0,flow:0},'新建空任务型也必须能复制');
await call('microApp/deleteById',{id:emptyCopy.microAppId});
await call('microApp/deleteById',{id:empty.microAppId});

console.log('任务型 Agent 复制、刷新、删除与快照失败回滚通过');
