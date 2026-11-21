import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test, {after} from 'node:test';
import {initialize, request} from '../../app/offline-api.js';

const fixtures = new Map(await Promise.all(['agents.json', 'workflow-data.json'].map(async name => [
  '/' + name,
  JSON.parse(await readFile(new URL('../../app/' + name, import.meta.url), 'utf8')),
])));
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'fetch', {configurable:true, writable:true, value:async path => {
  assert.ok(fixtures.has(path), '测试只允许读取真实本地 fixtures：' + path);
  return {json:async () => structuredClone(fixtures.get(path))};
}});
Object.defineProperty(globalThis, 'localStorage', {configurable:true, writable:true, value:undefined});
after(() => {
  for (const [name, descriptor] of [['fetch', originalFetch], ['localStorage', originalStorage]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem:key => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, String(value)),
  };
}
async function reset(initial = {}) {
  globalThis.localStorage = memoryStorage(initial);
  await initialize();
}
async function get(action, data = {}) {
  const result = await request({url:'/agent-microapp/' + action, data});
  assert.equal(result.success, true, result.errMessage ?? action);
  return result.data;
}

test('复制真实工作流 5433 并保存，刷新后副本列表和版本内容均保留', async () => {
  await reset();
  const original = await get('microAppVersion/findById', {id:5433});
  const copied = await get('microApp/copy', {microAppId:original.microAppId});
  const edited = JSON.parse(original.data);
  edited.nodes[0].position.x += 101;
  const savedGraph = JSON.stringify(edited);
  await get('microAppVersion/update', {microAppVersionId:copied.microAppVersionId, data:savedGraph});

  await initialize();
  const page = await get('microApp/findMicroAppPage', {pageSize:1000});
  assert.ok(page.records.some(row => row.microAppId === copied.microAppId), '刷新后列表必须保留已保存副本');
  assert.equal((await get('microApp/findById', {id:copied.microAppId})).microAppVersionId, copied.microAppVersionId);
  assert.equal((await get('microAppVersion/findById', {id:copied.microAppVersionId})).data, savedGraph);
  assert.equal((await get('microAppVersion/findById', {id:5433})).data, original.data, '保存副本不能修改原版本');
});

test('发布和取消发布后刷新，列表与已保存版本状态保持一致', async () => {
  await reset();
  const original = await get('microAppVersion/findById', {id:5433});
  for (const [action, status] of [['enable', 1], ['disable', 4]]) {
    await get('microAppVersion/' + action, {id:5433});
    await initialize();
    assert.equal((await get('microApp/findById', {id:original.microAppId})).status, status);
    assert.equal((await get('microAppVersion/findById', {id:5433})).status, status);
    assert.equal((await get('microAppVersion/findById', {id:5433})).data, original.data);
  }
});

test('删除已保存工作流时清除对应版本，刷新后不会复活', async () => {
  await reset();
  const original = await get('microAppVersion/findById', {id:5433});
  await get('microAppVersion/update', {microAppVersionId:5433, data:original.data});
  await get('microApp/deleteById', {id:original.microAppId});
  assert.equal((await request({url:'/agent-microapp/microAppVersion/findById', data:{id:5433}})).success, false, '删除后版本不能继续读取');
  await initialize();
  assert.equal((await request({url:'/agent-microapp/microApp/findById', data:{id:original.microAppId}})).success, false);
  assert.equal((await request({url:'/agent-microapp/microAppVersion/findById', data:{id:5433}})).success, false);
  const page = await get('microApp/findMicroAppPage', {pageSize:1000});
  assert.ok(page.records.every(row => row.microAppId !== String(original.microAppId)));
  for (const id of [5432, 5428]) assert.equal((await get('microAppVersion/findById', {id})).data, fixtures.get('/workflow-data.json').versions.find(version => version.microAppVersionId === id).data);
});

const capturedRows = fixtures.get('/agents.json');
const capturedVersions = fixtures.get('/workflow-data.json').versions;
const modeSamples = new Map([0, 1, 2, 3, 4, 5, 6].map(mode => {
  const version = capturedVersions.find(item => capturedRows.some(row => Number(row.runMode) === mode && String(row.microAppVersionId) === String(item.microAppVersionId)));
  assert.ok(version, '真实 fixtures 必须包含 runMode ' + mode);
  return [mode, version];
}));
function legacyVersions() {
  return Object.fromEntries(capturedVersions.filter(version => [5433, 5432, 5428].includes(Number(version.microAppVersionId))).map(version => {
    const graph = JSON.parse(version.data);
    graph.nodes[0].position.x += 37;
    return [String(version.microAppVersionId), {...version, data:JSON.stringify(graph)}];
  }));
}

test('旧 rea-local-workflows 的三个用户保存版本与副本均可恢复，迁移后删除不会被旧缓存复活', async () => {
  const legacy = legacyVersions();
  const localId = 'local-previous-copy';
  const versionId = 'local-version-' + localId;
  legacy[versionId] = {...legacy['5433'], id:'5433', microAppId:localId, microAppVersionId:versionId, microAppName:'之前保存的副本', runMode:4, status:1};
  legacy['5433'].status = 1;
  const originalCache = JSON.stringify(legacy);
  await reset({'rea-local-workflows':originalCache});
  for (const id of ['5433', '5432', '5428', versionId]) {
    const restored = await get('microAppVersion/findById', {id});
    assert.equal(restored.data, legacy[id].data);
    assert.equal(restored.id, id);
    assert.equal(restored.microAppVersionId, id);
    assert.equal(typeof restored.microAppId, 'string');
    assert.equal((await get('microApp/findById', {id:restored.microAppId})).status, legacy[id].status);
  }
  const page = await get('microApp/findMicroAppPage', {pageSize:1000});
  assert.ok(page.records.some(row => row.microAppId === localId));
  await get('microAppVersion/disable', {id:5433});
  await get('microApp/deleteById', {id:localId});
  await initialize();
  for (const id of ['5433', '5432', '5428']) assert.equal((await get('microAppVersion/findById', {id})).data, legacy[id].data);
  assert.equal((await get('microAppVersion/findById', {id:5433})).status, 4);
  assert.equal((await request({url:'/agent-microapp/microApp/findById', data:{id:localId}})).success, false);
  assert.equal((await request({url:'/agent-microapp/microAppVersion/findById', data:{id:versionId}})).success, false);
  assert.equal(globalThis.localStorage.getItem('rea-local-workflows'), originalCache, '迁移不能改写用户旧缓存');
});

test('固定 Date.now 连续复制与新建仍有独立 ID，副本可通过返回的版本 id 保存', async () => {
  await reset();
  const original = await get('microAppVersion/findById', {id:5433});
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  let first, second, created;
  try {
    first = await get('microApp/copy', {id:original.microAppId});
    second = await get('microApp/copy', {id:original.microAppId});
    created = await get('microApp/create', {microAppName:'持久化新建测试', runMode:4});
  } finally {
    Date.now = originalNow;
  }
  assert.equal(new Set([first.microAppId, second.microAppId, created.microAppId]).size, 3);
  assert.equal(new Set([first.microAppVersionId, second.microAppVersionId, created.microAppVersionId]).size, 3);
  const firstVersion = await get('microAppVersion/findById', {id:first.microAppVersionId});
  assert.equal(firstVersion.id, first.microAppVersionId);
  assert.equal(firstVersion.microAppVersionId, first.microAppVersionId);
  const edited = JSON.parse(firstVersion.data);
  edited.nodes[0].position.x += 203;
  const savedGraph = JSON.stringify(edited);
  await get('microAppVersion/update', {id:firstVersion.id, data:savedGraph});
  const createdVersion = await get('microAppVersion/findById', {id:created.microAppVersionId});
  await initialize();
  for (const row of [first, second, created]) assert.equal((await get('microApp/findById', {id:row.microAppId})).microAppVersionId, row.microAppVersionId);
  assert.equal((await get('microAppVersion/findById', {id:first.microAppVersionId})).data, savedGraph);
  assert.equal((await get('microAppVersion/findById', {id:second.microAppVersionId})).data, original.data);
  assert.equal((await get('microAppVersion/findById', {id:5433})).data, original.data);
  assert.equal((await get('microAppVersion/findById', {id:created.microAppVersionId})).data, createdVersion.data);
});

test('各真实 mode 版本可读取和保存，task/super 的 null 快照可刷新恢复', async () => {
  await reset();
  for (const [mode, sample] of modeSamples) {
    const id = sample.microAppVersionId;
    const version = await get('microAppVersion/findById', {id});
    assert.equal(version.data, sample.data, '真实 mode ' + mode + ' 数据不能被改写');
    const saved = version.data === null ? null : JSON.stringify({...JSON.parse(version.data), storageTest:'mode-' + mode});
    await get('microAppVersion/update', {id, data:saved});
    await initialize();
    assert.equal((await get('microAppVersion/findById', {id})).data, saved);
    assert.equal((await get('microApp/findById', {id:sample.microAppId})).runMode, mode);
    if (mode === 3 || mode === 6) {
      const record = JSON.stringify({prompt:'本地保存测试'});
      await get('microAppVersion/update', {id, data:record});
      await initialize();
      assert.equal((await get('microAppVersion/findById', {id})).data, record);
      await get('microAppVersion/update', {id, data:null});
    }
  }
});

test('保存按所属 row.runMode 校验：图模式必须有节点连线，其他模式必须为 record 或允许的 null', async () => {
  await reset();
  for (const [mode, sample] of modeSamples) {
    const invalid = ['{broken-json', '[]', '7', '"text"'];
    if ([0, 2, 4].includes(mode)) invalid.push('{}', '{"nodes":[],"edges":null}');
    if (![3, 6].includes(mode)) invalid.push(null, 'null');
    for (const data of invalid) {
      const result = await request({url:'/agent-microapp/microAppVersion/update', data:{id:sample.microAppVersionId, data}});
      assert.equal(result.success, false, 'mode ' + mode + ' 不应接受 ' + String(data));
      assert.ok(result.errMessage);
    }
    assert.equal((await get('microAppVersion/findById', {id:sample.microAppVersionId})).data, sample.data);
  }
});

test('本地新建全部 mode 使用对应初始数据，创建后未打开也能刷新读取', async () => {
  await reset();
  for (const mode of [0, 1, 2, 3, 4, 5, 6]) {
    const row = await get('microApp/create', {microAppName:'mode ' + mode + ' 新建测试', runMode:mode});
    await initialize();
    const version = await get('microAppVersion/findById', {id:row.microAppVersionId});
    assert.equal(version.id, row.microAppVersionId);
    if ([0, 2, 4].includes(mode)) {
      const graph = JSON.parse(version.data);
      assert.ok(Array.isArray(graph.nodes));
      assert.ok(Array.isArray(graph.edges));
    } else if (mode === 5) assert.deepEqual(JSON.parse(version.data), {});
    else if (mode === 1) assert.deepEqual(JSON.parse(version.data), {prompt:''});
    else assert.equal(version.data, null);
    await get('microAppVersion/update', {id:row.microAppVersionId, data:version.data});
    await initialize();
    assert.equal((await get('microAppVersion/findById', {id:row.microAppVersionId})).data, version.data);
  }
});

test('旧快照只补仍在列表中的新采集版本，保留用户编辑与删除结果', async () => {
  const saved = legacyVersions()['5433'];
  saved.status = 1;
  const removed = modeSamples.get(1);
  const snapshotRows = capturedRows.filter(row => row.microAppId !== String(removed.microAppId)).map(row => row.microAppVersionId === '5433' ? {...row, status:1} : row);
  const snapshot = {rows:snapshotRows, versions:{'5433':saved}};
  await reset({'rea-local-snapshot':JSON.stringify(snapshot)});
  for (const sample of capturedVersions) {
    const id = String(sample.microAppVersionId);
    const result = await request({url:'/agent-microapp/microAppVersion/findById', data:{id}});
    if (id === String(removed.microAppVersionId)) assert.equal(result.success, false, '补全不能复活已删除版本');
    else {
      assert.equal(result.success, true, result.errMessage);
      assert.equal(result.data.data, id === '5433' ? saved.data : sample.data);
    }
  }
  assert.equal((await request({url:'/agent-microapp/microApp/findById', data:{id:removed.microAppId}})).success, false);
  assert.equal((await get('microAppVersion/findById', {id:5433})).status, 1);
  await get('microAppVersion/update', {id:5433, data:saved.data});
  await initialize();
  for (const mode of [0, 2, 3, 5, 6]) {
    const sample = modeSamples.get(mode);
    assert.equal((await get('microAppVersion/findById', {id:sample.microAppVersionId})).data, sample.data);
  }
  assert.equal((await get('microAppVersion/findById', {id:5433})).data, saved.data);
  assert.equal((await request({url:'/agent-microapp/microAppVersion/findById', data:{id:removed.microAppVersionId}})).success, false);
});

test('存储写入失败明确返回失败，不改变列表、版本内容或发布状态', async () => {
  await reset();
  const original = await get('microAppVersion/findById', {id:5433});
  const copied = await get('microApp/copy', {id:original.microAppId});
  const before = globalThis.localStorage.getItem('rea-local-snapshot');
  const originalSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {throw new Error('QuotaExceededError');};
  const graph = JSON.parse(original.data);
  graph.nodes[0].position.x += 301;
  const operations = [
    ['microAppVersion/update', {id:5433, data:JSON.stringify(graph)}],
    ['microAppVersion/enable', {id:5433}],
    ['microApp/deleteById', {id:copied.microAppId}],
    ['microApp/create', {microAppName:'写入失败的新建', runMode:4}],
  ];
  try {
    for (const [action, data] of operations) {
      const result = await request({url:'/agent-microapp/' + action, data});
      assert.equal(result.success, false);
      assert.match(result.errMessage, /本地保存失败.*QuotaExceededError/);
    }
    assert.equal((await get('microAppVersion/findById', {id:5433})).data, original.data);
    assert.equal((await get('microAppVersion/findById', {id:5433})).status, original.status);
    assert.equal((await get('microApp/findById', {id:original.microAppId})).status, original.status);
    assert.equal((await get('microApp/findById', {id:copied.microAppId})).microAppVersionId, copied.microAppVersionId);
    assert.equal((await get('microApp/findMicroAppPage', {microAppName:'写入失败的新建'})).total, 0);
    assert.equal(globalThis.localStorage.getItem('rea-local-snapshot'), before);
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
  }
  await initialize();
  assert.equal((await get('microAppVersion/findById', {id:5433})).data, original.data);
  assert.equal((await get('microApp/findById', {id:copied.microAppId})).microAppVersionId, copied.microAppVersionId);
});

for (const [key, value] of [['rea-local-workflows', '{broken-json'], ['rea-local-snapshot', '{broken-json'], ['rea-local-workflows', 'null'], ['rea-local-snapshot', '{"rows":[],"versions":[]}']]) {
  test('损坏缓存明确报错且阻止后续写入：' + key + ' = ' + value, async () => {
    await reset();
    const before = globalThis.localStorage;
    before.setItem(key, value);
    await assert.rejects(initialize(), error => error.message.includes(key) && /损坏|无效/.test(error.message));
    const result = await request({url:'/agent-microapp/microApp/create', data:{microAppName:'不允许覆盖损坏缓存', runMode:4}});
    assert.equal(result.success, false);
    assert.match(result.errMessage, /损坏|无效/);
    assert.equal(before.getItem(key), value);
    if (key === 'rea-local-workflows') assert.equal(before.getItem('rea-local-snapshot'), null);
  });
}
