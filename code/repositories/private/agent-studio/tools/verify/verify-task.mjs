import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../../app/business-data.json', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const cache = new Map();
let failWrites = false;
let fetchCount = 0;
globalThis.fetch = async path => {
  assert.equal(path, '/business-data.json');
  fetchCount++;
  return new Response(JSON.stringify(fixture));
};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('test storage quota');
      cache.set(key, String(value));
    },
  },
});

try {
  let task = {};
  try {
    task = await import('../../app/offline-task.js');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof task.initializeTask, 'function', '尚未恢复 initializeTask 公共接口');
  assert.equal(typeof task.requestTask, 'function', '尚未恢复 requestTask 公共接口');
  const { initializeTask, requestTask } = task;
  const ok = response => {
    assert.ok(response);
    assert.equal(response.success, true, response.msg);
    assert.equal(response.code, 0);
    assert.equal(response.errCode, 0);
    assert.equal(response.msg, 'success');
    return response.data;
  };
  const call = async (path, data = {}) => ok(await requestTask(path, data));
  const fail = response => {
    assert.equal(response.success, false);
    assert.notEqual(response.code, 0);
    assert.notEqual(response.errCode, 0);
    assert.equal(typeof response.msg, 'string');
    assert.ok(response.msg.length);
  };
  const version = { microAppVersionId: '4762', microAppId: '127988688202' };
  const other = { microAppVersionId: 'local-task-version', microAppId: 'local-task-agent' };
  const variable = '/agent-microapp/agent/variable';
  const entity = '/agent-microapp/agent/entity';
  const intent = '/agent-microapp/agent/intent';
  const topic = '/agent-microapp/topic';
  const flow = '/agent-microapp/flow';
  const config = '/agent-microapp/agent/config';
  const tables = [
    [variable, 'findByCondition', 9],
    [entity, 'findByCondition', 2],
    [intent, 'findPage', 3],
    [topic, 'getPage', 1],
    [flow, 'getPage', 1],
  ];

  ok(await initializeTask());
  assert.equal(fetchCount, 1);
  for (const [base, list, count] of tables) {
    const page = await call(`/decision${base}/${list}`, { ...version, pageNum: 1, pageSize: 100 });
    assert.equal(page.total, count);
    assert.equal(page.records.length, count);
    assert.deepEqual((await call(`${base}/${list}`, other)).records, []);
  }
  assert.equal(await requestTask('/agent-microapp/agent/startTaskSOP', version), undefined);
  assert.equal(await requestTask(`${variable}/not-captured`, version), undefined);
  fail(await requestTask(`${variable}/findByCondition`, {}));

  const created = await call(`${variable}/create`, { ...version, variableName: '本地变量', value: '初值' });
  assert.ok(created.variableId);
  assert.ok(created.variableUniqueId);
  await call(`${variable}/update`, { variableId: created.variableId, variableName: '修改后变量', value: '保留值' });
  ok(await initializeTask());
  assert.equal((await call(`${variable}/findById`, { variableId: created.variableId })).value, '保留值');
  const filtered = await call(`${variable}/findByCondition`, { ...version, variableName: '修改后', pageNum: 1, pageSize: 1 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.records[0].variableId, created.variableId);
  fail(await requestTask(`${variable}/findById`, { ...other, variableId: created.variableId }));
  fail(await requestTask(`${variable}/update`, { ...other, variableId: created.variableId, value: '越界' }));
  await call(`${variable}/deleteById`, { variableId: created.variableId });
  ok(await initializeTask());
  fail(await requestTask(`${variable}/findById`, { variableId: created.variableId }));
  assert.equal((await call(`${variable}/findByCondition`, version)).total, 9);

  // 实体确实沿用 variable 字段；意图的 id 查询可由主 API 合并，模块也接受原始 URL。
  for (const [base, id, name, get] of [
    [entity, 'variableId', 'variableName', 'findById'],
    [intent, 'intentId', 'intentName', 'findById'],
    [topic, 'topicId', 'topicName', 'getById'],
  ]) {
    const row = await call(`${base}/create`, { ...other, [name]: '本地条目', topicCode: 'local-topic' });
    assert.ok(row[id]);
    await call(`${base}/update`, { ...other, [id]: row[id], [name]: '已修改条目' });
    ok(await initializeTask());
    const detail = base === intent
      ? await call(`${base}/${get}?id=${encodeURIComponent(row[id])}`, other)
      : await call(`${base}/${get}`, { ...other, [id]: row[id] });
    assert.equal(detail[name], '已修改条目');
    await call(`${base}/deleteById`, base === intent ? { id: row[id] } : { [id]: row[id] });
    ok(await initializeTask());
    fail(await requestTask(`${base}/${get}`, { [id]: row[id] }));
  }

  const originalFlow = (await call(`${flow}/getPage`, version)).records[0];
  const identity = { flowId: originalFlow.flowId, flowUniqueId: originalFlow.flowUniqueId };
  const graph = JSON.parse((await call(`${flow}/getById`, identity)).data);
  assert.equal(graph.nodes.length, 4);
  graph.nodes[0].position.x += 123;
  const savedGraph = JSON.stringify(graph);
  await call(`${flow}/updateData`, { ...version, ...identity, data: savedGraph });
  ok(await initializeTask());
  assert.equal((await call(`${flow}/getById`, identity)).data, savedGraph);
  fail(await requestTask(`${flow}/getById`, { ...identity, flowUniqueId: '不存在的流程' }));
  const beforeInvalid = cache.get('rea-task-snapshot');
  for (const data of ['{bad', JSON.stringify({ nodes: [], edges: {} })]) {
    fail(await requestTask(`${flow}/updateData`, { ...identity, data }));
    assert.equal(cache.get('rea-task-snapshot'), beforeInvalid);
  }
  const newFlow = await call(`${flow}/create`, { ...other, flowName: '本地流程' });
  assert.ok(newFlow.flowUniqueId);
  assert.deepEqual(JSON.parse(newFlow.data).nodes, []);
  await call(`${flow}/update`, { flowId: newFlow.flowId, flowName: '本地改名流程' });
  assert.equal((await call(`${flow}/getById`, { flowUniqueId: newFlow.flowUniqueId })).flowName, '本地改名流程');
  await call(`${flow}/deleteById`, { flowId: newFlow.flowId });
  ok(await initializeTask());
  assert.equal((await call(`${flow}/getPage`, other)).total, 0);

  assert.equal((await call(`${config}/getByVersionId`, version)).entityConfidence, 0.6);
  assert.deepEqual(await call(`${config}/getByVersionId`, other), {});
  await call(`${config}/setting`, { ...other, entityConfidence: 0.9, intentConfigs: { globalNoMatchType: 1 } });
  ok(await initializeTask());
  assert.equal((await call(`${config}/getByVersionId`, other)).entityConfidence, 0.9);
  assert.equal((await call(`${config}/getByVersionId`, version)).entityConfidence, 0.6);

  const beforeQuota = cache.get('rea-task-snapshot');
  failWrites = true;
  fail(await requestTask(`${variable}/create`, { ...other, variableName: '不可保存变量' }));
  fail(await requestTask(`${flow}/updateData`, { ...identity, data: JSON.stringify({ nodes: [], edges: [] }) }));
  failWrites = false;
  assert.equal(cache.get('rea-task-snapshot'), beforeQuota);
  assert.equal((await call(`${variable}/findByCondition`, other)).total, 0);
  assert.equal((await call(`${flow}/getById`, identity)).data, savedGraph);

  // 缓存损坏或结构无效必须明确失败，不能用 fixture 覆盖用户保存的数据。
  for (const broken of ['{broken', '{}']) {
    cache.set('rea-task-snapshot', broken);
    fail(await initializeTask());
    fail(await requestTask(`${variable}/create`, { ...other, variableName: '禁止覆盖' }));
    assert.equal(cache.get('rea-task-snapshot'), broken);
    assert.equal(await requestTask('/unknown', {}), undefined);
  }
  cache.set('rea-task-snapshot', beforeQuota);
  ok(await initializeTask());
  assert.equal((await call(`${flow}/getById`, identity)).data, savedGraph);
  console.log('任务契约验证通过：真实样本、五表读写、刷新/删除持久化、版本隔离、流程校验、配置及存储失败保护。');
} finally {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
}
