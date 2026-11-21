import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initialize, request } from '../../app/offline-api.js';
import { initializeBusiness } from '../../app/offline-business.js';
import { initializeDocuments } from '../../app/offline-documents.js';

// 只替换 I/O 边界；行为断言统一经过页面使用的主 request。
const fixtures = new Map(await Promise.all([
  'agents.json', 'workflow-data.json', 'business-data.json',
  'knowledge-documents.json', 'knowledge-content.json',
].map(async name => [name, await readFile(new URL('../../app/' + name, import.meta.url), 'utf8')])));
const documents = JSON.parse(fixtures.get('knowledge-documents.json'));
const content = JSON.parse(fixtures.get('knowledge-content.json'));
const cache = new Map();
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let rejectWrite = () => false;
let passed = 0;
const BUSINESS = 'rea-business-snapshot';
const DOCUMENTS = 'rea-document-snapshot';
const KG = '/agent-kg/database/';
const DOC = '/agent-kg/doc/';
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => {
      if (rejectWrite(key)) throw new Error('test storage quota: ' + key);
      cache.set(key, String(value));
    },
    removeItem: key => cache.delete(key),
  },
});
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async path => {
    const url = path instanceof URL ? path : new URL(String(path), 'http://127.0.0.1');
    assert.ok(url.protocol === 'file:' || url.origin === 'http://127.0.0.1', '禁止外部请求');
    const name = url.pathname.split('/').pop();
    assert.ok(fixtures.has(name), '只允许读取本地 fixture：' + path);
    return new Response(fixtures.get(name));
  },
});
const send = (url, data = {}, params = {}) => request({ url, data, params });
const ok = response => {
  assert.ok(response, '公共请求必须返回 envelope');
  assert.notEqual(response.success, false, response.msg);
  assert.equal(response.code, 0, response.msg);
  return response.data;
};
const call = async (...args) => ok(await send(...args));
const failure = response => {
  assert.equal(response?.success, false, '失败必须明确返回，不能宣称保存成功');
  assert.notEqual(response.code, 0);
  assert.ok(response.msg);
  return response;
};
async function refresh() {
  await initialize();
  await initializeBusiness();
  ok(await initializeDocuments());
}
async function check(name, run) {
  if (process.argv[2] && process.argv[2] !== name) return;
  cache.clear(); // 仅清理本脚本的内存 Map，绝不接触浏览器存储。
  rejectWrite = () => false;
  await refresh();
  await run();
  console.log('PASS ' + name);
  passed++;
}

try {
  await check('create', async () => {
    for (const baseType of [0, 1, 2]) {
      const created = await call('/decision' + KG + 'create', { name: '本地生命周期-' + baseType, baseType });
      assert.equal(typeof created.baseId, 'string');
      assert.deepEqual(await call(DOC + 'list?baseId=' + created.baseId), [], '新库必须可查询空文档列表');
      if (baseType === 2) assert.deepEqual(await call('/decision/agent-kg/qa/list', {}, { baseId: created.baseId }), []);
      assert.equal((await call(KG + 'baseDetails', { baseId: created.baseId })).docCount, 0);
      await refresh();
      assert.deepEqual(await call(DOC + 'list', { baseId: created.baseId }), [], '刷新后新库仍可读');
      if (baseType === 2) {
        const qa = await call('/agent-kg/qa/add', { baseId: created.baseId, questionContent: '本地问题', answerContent: '本地答案' });
        await refresh();
        assert.equal((await call('/agent-kg/qa/get', { qaId: qa.qaId })).answerContent, '本地答案');
      }
    }
    for (const base of documents.bases) assert.deepEqual(await send(DOC + 'list', { baseId: base.baseId }), base.response, '已有字符串归属与原 envelope 保持一致');
  });
  await check('delete-base', async () => {
    for (const baseId of ['1963505867706990594', '1930233180000526337', content.qa[0].baseId]) {
      const removed = documents.documents.filter(doc => doc.baseId === baseId);
      const others = documents.bases.filter(base => ![baseId, '1963505867706990594', '1930233180000526337'].includes(base.baseId));
      const before = await Promise.all(others.map(base => send(DOC + 'list', { baseId: base.baseId })));
      await call('/decision' + KG + 'delete', {}, { id: baseId });
      failure(await send(DOC + 'list', { baseId }));
      failure(await send('/agent-kg/database/selectLabels', { baseId }));
      for (const doc of removed) {
        for (const action of ['getInfo', 'getConfig', 'docTablePreview']) failure(await send(DOC + action, { docId: doc.docId }));
        failure(await send('/agent-kg/segment/list', { docId: doc.docId }));
        failure(await send('/agent-kg/segment/modify', { segmentId: content.segments.find(group => group.docId === doc.docId)?.response.data[0]?.segmentId, content: '不能编辑已删除文档' }));
      }
      if (baseId === content.qa[0].baseId) {
        failure(await send('/agent-kg/qa/list', { baseId }));
        failure(await send('/agent-kg/qa/get', { qaId: content.qa[0].response.data[0].qaId }));
      }
      await refresh();
      failure(await send(KG + 'baseDetails', { baseId }));
      for (const doc of removed) failure(await send(DOC + 'getInfo', { docId: doc.docId }));
      assert.deepEqual(await Promise.all(others.map(base => send(DOC + 'list', { baseId: base.baseId }))), before, '删除知识库不能影响其他库');
    }
  });
  await check('delete-document', async () => {
    const baseId = '1930233180000526337';
    const other = await send(DOC + 'list', { baseId: '1963505867706990594' });
    assert.equal((await call(KG + 'baseDetails', { baseId })).docCount, 5);
    for (const [action, docId, count] of [['delete', '1932020527385976833', 4], ['deleteEdit', '1930246135844872194', 3]]) {
      await call(DOC + action, { docId });
      failure(await send(DOC + 'getInfo', { docId }));
      assert.equal((await call(KG + 'baseDetails', { baseId })).docCount, count, '详情计数必须与删除同步');
      assert.equal((await call(KG + 'list')).find(row => row.baseId === baseId).docCount, count, '列表计数必须与删除同步');
      await refresh();
      assert.equal((await call(DOC + 'list', { baseId })).length, count);
      assert.equal((await call(KG + 'baseDetails', { baseId })).docCount, count);
      failure(await send(DOC + 'docTablePreview', { docId }));
    }
    assert.deepEqual(await send(DOC + 'list', { baseId: '1963505867706990594' }), other);
  });
  await check('qa-list', async () => {
    const group = content.qa[0];
    assert.equal(group.response.data.length, 27);
    for (const current of [1, 2, 3]) assert.deepEqual(await call('/agent-kg/qa/list', { baseId: group.baseId, current, pageSize: 10 }), group.response.data, '原页面用完整筛选数组计算总数并在客户端分页');
    assert.equal((await call('/agent-kg/qa/list', { baseId: group.baseId, questionContent: '你是谁', answerContent: '我是', pageSize: 1 })).length, 1);
  });
  await check('qa-local', async () => {
    const baseId = content.qa[0].baseId;
    const payload = { baseId, questionContent: '本地生命周期问题', answerContent: '本地答案' };
    const created = await call('/agent-kg/qa/add', payload);
    assert.equal(created.localOnly, true);
    assert.equal(created.qaStatus, 0);
    const modified = await call('/agent-kg/qa/modify', { ...payload, qaId: content.qa[0].response.data[0].qaId });
    assert.equal(modified.localOnly, true);
    assert.equal(modified.qaStatus, 0);
    await refresh();
    assert.equal((await call('/agent-kg/qa/get', { qaId: modified.qaId })).localOnly, true);
  });
  await check('rollback', async () => {
    // 先保存正常数据，再验证任一快照写失败时已有状态逐字不变。
    await call(KG + 'create', { name: 'rollback基准', baseType: 0 });
    const baseId = '1930233180000526337';
    const docId = '1932020527385976833';
    for (const key of [BUSINESS, DOCUMENTS]) {
      for (const [url, data] of [
        [KG + 'create', { name: '失败新库', baseType: 2 }],
        [KG + 'delete', { baseId }], [DOC + 'delete', { docId }],
      ]) {
        const before = new Map(cache);
        const knowledge = await call(KG + 'list');
        const docs = await call(DOC + 'list', { baseId });
        rejectWrite = candidate => candidate === key;
        failure(await send(url, data));
        rejectWrite = () => false;
        assert.deepEqual(cache, before, key + ' 写入失败后应恢复完整持久化状态');
        assert.deepEqual(await call(KG + 'list'), knowledge, '失败不能改变内存业务状态');
        assert.deepEqual(await call(DOC + 'list', { baseId }), docs, '失败不能改变内存文档状态');
        await refresh();
        assert.deepEqual(await call(KG + 'list'), knowledge);
        assert.deepEqual(await call(DOC + 'list', { baseId }), docs);
      }
    }
  });
  await check('deleted-state', async () => {
    await call(KG + 'create', { name: '旧快照基准', baseType: 0 });
    const baseId = '1963505867706990594';
    // 模拟旧业务层已删除知识库，文档侧仍留着原始采集数据。
    const saved = JSON.parse(cache.get(BUSINESS));
    saved.data.knowledge = saved.data.knowledge.filter(row => row.baseId !== baseId);
    cache.set(BUSINESS, JSON.stringify(saved));
    await refresh();
    failure(await send(DOC + 'list', { baseId }));
    failure(await send(DOC + 'getInfo', { docId: '1963514498154364930' }));
    failure(await send('/agent-kg/segment/list', { docId: '1963514498154364930' }));
    await call(KG + 'create', { name: '不复活删除数据', baseType: 0 });
    await refresh();
    failure(await send(DOC + 'getInfo', { docId: '1963514498154364930' }));
  });
  await check('first-write-rollback', async () => {
    const before = await call(KG + 'list');
    for (const [url, data, key] of [
      [KG + 'create', { name: '首次保存失败', baseType: 2 }, DOCUMENTS],
      [KG + 'delete', { baseId: '1930233180000526337' }, BUSINESS],
      [DOC + 'delete', { docId: '1932020527385976833' }, BUSINESS],
    ]) {
      assert.equal(cache.size, 0);
      rejectWrite = candidate => candidate === key;
      failure(await send(url, data));
      rejectWrite = () => false;
      assert.equal(cache.size, 0, '首次保存失败不能遗留空快照或部分提交');
      await refresh();
      assert.deepEqual(await call(KG + 'list'), before);
      assert.equal((await call(DOC + 'list', { baseId: '1930233180000526337' })).length, 5);
    }
  });
  await check('rollback-failure', async () => {
    await call(KG + 'create', { name: '回滚失败基准', baseType: 0 });
    const businessBefore = cache.get(BUSINESS);
    let documentWrites = 0;
    rejectWrite = key => key === BUSINESS || (key === DOCUMENTS && ++documentWrites > 1);
    const response = failure(await send(DOC + 'delete', { docId: '1932020527385976833' }));
    assert.match(response.msg, /回滚失败/, '回滚自身失败必须明确提示');
    rejectWrite = () => false;
    assert.equal(cache.get(BUSINESS), businessBefore);
    const partial = new Map(cache);
    assert.match(failure(await send(DOC + 'delete', { docId: '1930246135844872194' })).msg, /回滚失败/, '快照状态不一致时阻止继续修改');
    assert.deepEqual(cache, partial);
  });
  await check('corrupt-snapshot', async () => {
    const knowledge = await call(KG + 'list');
    cache.set(DOCUMENTS, '{broken json');
    const before = new Map(cache);
    failure(await send(KG + 'create', { name: '不能覆盖坏缓存', baseType: 2 }));
    assert.deepEqual(cache, before, '创建失败必须保留坏文档快照并回滚业务记录');
    assert.deepEqual(await call(KG + 'list'), knowledge);
    failure(await initializeDocuments());
    failure(await send(KG + 'delete', { baseId: '1930233180000526337' }));
    assert.deepEqual(cache, before);
  });
  assert.ok(passed > 0, '没有匹配的验证用例');
  console.log('知识库生命周期通过：' + passed + ' 组；全部操作使用主 request 和内存 Map。');
} finally {
  for (const [name, descriptor] of [['fetch', originalFetch], ['localStorage', originalStorage]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
