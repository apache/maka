import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 只替换浏览器的 I/O 边界；所有期望数据均来自真实采集文件。
const fixture = JSON.parse(await readFile(new URL('../../evidence/knowledge-documents.json', import.meta.url), 'utf8'));
assert.equal(fixture.bases.length, 29);
assert.equal(fixture.documents.length, 55);
const content = JSON.parse(await readFile(new URL('../../evidence/knowledge-content.json', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const cache = new Map();
let failWrites = false;
let fixtureResponse = () => new Response(JSON.stringify(fixture));
globalThis.fetch = async path => {
  if (path === '/knowledge-content.json') return new Response(JSON.stringify(content));
  assert.equal(path, '/knowledge-documents.json', '只允许读取本地 fixture');
  return fixtureResponse();
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
  let api = {};
  try {
    api = await import('../../app/offline-documents.js');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof api.initializeDocuments, 'function', '缺少 initializeDocuments 公共接口');
  assert.equal(typeof api.requestDocuments, 'function', '缺少 requestDocuments 公共接口');
  assert.deepEqual(Object.keys(api).sort(), ['initializeDocuments', 'requestDocuments']);
  const ok = response => {
    assert.ok(response, '已声明的文档路由必须返回 envelope');
    assert.equal(response.code, 0, response.msg);
    assert.notEqual(response.success, false);
    return response.data;
  };
  const failure = response => {
    assert.ok(response);
    assert.equal(response.success, false);
    assert.notEqual(response.code, 0);
    assert.notEqual(response.errCode, 0);
    assert.equal(response.data, null);
    assert.ok(response.msg.length);
    return response;
  };
  const call = async (action, data = {}) => ok(await api.requestDocuments('/agent-kg/doc/' + action, data));
  failure(await api.requestDocuments('/agent-kg/doc/getInfo', { docId: fixture.documents[0].docId }));
  ok(await api.initializeDocuments());
  for (const base of fixture.bases) {
    const response = await api.requestDocuments('/decision/agent-kg/doc/list?baseId=' + base.baseId);
    assert.deepEqual(response, base.response, '列表原 envelope 与采集数据一致');
  }
  for (const document of fixture.documents) {
    assert.deepEqual(await api.requestDocuments('/agent-kg/doc/getInfo', { docId: document.docId }), document.info);
    assert.deepEqual(await api.requestDocuments('/decision/agent-kg/doc/getConfig', { docId: document.docId }), document.config);
  }
  const ids = ['1932020527385976833', '1930246135844872194'];
  assert.deepEqual(await call('getInfoList', { docIds: ids }), ids.map(id => fixture.documents.find(doc => doc.docId === id).info.data));
  assert.deepEqual(await call('getInfoList', { docIds: [] }), []);
  const baseId = '1930233180000526337';
  assert.equal((await call('list', { baseId, status: 0 })).length, 5);
  assert.deepEqual((await call('list', { baseId, name: 'AI面诊', status: 3, extension: 'xlsx' })).map(row => row.docId), ['1932020527385976833']);
  assert.deepEqual((await call('list', { baseId, status: 1 })).map(row => row.docId), ['1930246135844872194']);
  assert.equal((await call('list', { baseId, status: 4 })).length, 3);
  // released 页面的 draft 固定传 status:5；docStatus:0 的处理中样本不等于编辑稿。
  assert.deepEqual(await call('list', { baseId, status: 5 }), []);
  assert.equal((await call('list', { baseId: '1963505867706990594', extension: 'PDF' })).length, 2);
  assert.equal((await call('list', { baseId: '1963505867706990594', extension: '.txt', name: 'Termux' })).length, 1);
  const isolated = await call('getInfo', { docId: ids[0] });
  isolated.docName = '不能通过响应对象修改原数据';
  assert.equal((await call('getInfo', { docId: ids[0] })).docName, 'AI面诊分析知识库1.xlsx');
  for (const [action, data] of [
    ['list', {}], ['list', { baseId: 'not-captured' }], ['list', { baseId, status: 'invalid' }],
    ['getInfo', { docId: 'not-captured' }], ['getConfig', {}],
    ['getInfo', { docId: ids[0], baseId: '2096852633310441474' }],
    ['getInfoList', { docIds: [ids[0], 'not-captured'] }], ['getInfoList', { docIds: 'not-an-array' }],
  ]) failure(await api.requestDocuments('/agent-kg/doc/' + action, data));
  for (const path of ['/unknown', '/agent-kg/doc/list/extra', '/agent-kg/doc/list/', '/agent-kg/doc/getInfoOther',
    '/prefix/agent-kg/doc/list', '/decision/decision/agent-kg/doc/list', '/decisionx/agent-kg/doc/list']) {
    assert.equal(await api.requestDocuments(path, {}), undefined, path);
  }
  const contentCall = async (path, data) => ok(await api.requestDocuments(path, data));
  for (const group of content.segments) {
    assert.deepEqual(await api.requestDocuments('/agent-kg/segment/list', { docId: group.docId, position: -1, size: 10000 }), group.response);
  }
  for (const group of content.tables) {
    assert.deepEqual(await api.requestDocuments('/decision/agent-kg/doc/docTablePreview', { docId: group.docId }), group.response);
  }
  for (const group of content.labels) {
    assert.deepEqual(await api.requestDocuments('/agent-kg/database/selectLabels', { baseId: group.baseId, uid: '' }), group.response);
  }
  for (const group of content.qa) {
    assert.deepEqual(await api.requestDocuments('/agent-kg/qa/list', { baseId: group.baseId, current: 1, pageSize: 10000 }), group.response);
  }
  const segmentDocId = '1963514498154364930';
  const realSegments = content.segments.find(group => group.docId === segmentDocId).response.data;
  assert.deepEqual(await contentCall('/agent-kg/segment/list', { docId: segmentDocId, position: -1, size: 5 }), realSegments.slice(0, 5));
  assert.deepEqual(await contentCall('/agent-kg/segment/list', { docId: segmentDocId, position: 5, size: 5 }), realSegments.slice(5, 10));
  const qaBaseId = '2048942469296054274';
  const qaRow = content.qa[0].response.data[0];
  assert.deepEqual(await contentCall('/agent-kg/qa/get', { qaId: qaRow.qaId }), qaRow);
  assert.equal((await contentCall('/agent-kg/qa/list', { baseId: qaBaseId, questionContent: '你是谁', answerContent: '我是' })).length, 1);
  assert.deepEqual(await contentCall('/agent-kg/qa/list', { baseId: qaBaseId, current: 2, pageSize: 10 }), content.qa[0].response.data,
    '原页面从完整筛选数组计算 total，离线接口不能再次截页');
  for (const [path, data] of [
    ['/agent-kg/segment/list', { docId: '2046582977505943554' }],
    ['/agent-kg/segment/list', { docId: segmentDocId, size: 0 }],
    ['/agent-kg/doc/docTablePreview', { docId: segmentDocId }],
    ['/agent-kg/qa/list', { baseId }], ['/agent-kg/qa/get', { qaId: 'missing' }],
    ['/agent-kg/database/selectLabels', { baseId: 'not-captured', uid: '' }],
    ['/agent-kg/database/selectLabels', { baseId: '2046582770244411393', uid: 'not-captured' }],
  ]) failure(await api.requestDocuments(path, data));
  assert.deepEqual((await contentCall('/agent-kg/database/selectLabels', {
    baseId: '2046582770244411393', uid: '89a61b28-f473-4ffb-b5d6-c71b87abf157',
  })).labels, [], '已存在的叶子标签应成功返回空子节点');
  const refresh = async () => {
    api = await import('../../app/offline-documents.js?refresh=' + crypto.randomUUID());
    ok(await api.initializeDocuments());
  };
  const firstSegment = realSegments[0];
  await contentCall('/agent-kg/segment/modify', { docId: segmentDocId, segmentId: firstSegment.segmentId, content: '本地分段正文' });
  await refresh();
  let localSegments = await contentCall('/agent-kg/segment/list', { docId: segmentDocId });
  assert.equal(localSegments[0].content, '本地分段正文');
  assert.equal(localSegments[0].version, 1);
  assert.equal(localSegments[0].docId, segmentDocId);
  assert.equal((await call('getInfo', { docId: segmentDocId })).step, 5);
  assert.equal((await call('list', { baseId: '1963505867706990594', status: 5 })).length, 1);
  await contentCall('/agent-kg/segment/modify', { docId: segmentDocId, segmentId: firstSegment.segmentId, content: '本地第二次编辑' });
  await contentCall('/decision/agent-kg/segment/enable', { segmentId: firstSegment.segmentId, enable: 0 });
  await refresh();
  localSegments = await contentCall('/agent-kg/segment/list', { docId: segmentDocId });
  assert.equal(localSegments[0].version, 2);
  assert.equal(localSegments[0].enable, 0);
  const beforeSegmentFailure = cache.get('rea-document-snapshot');
  failWrites = true;
  failure(await api.requestDocuments('/agent-kg/segment/modify', { docId: segmentDocId, segmentId: firstSegment.segmentId, content: '失败正文' }));
  failure(await api.requestDocuments('/agent-kg/segment/enable', { segmentId: firstSegment.segmentId, enable: 1 }));
  failure(await api.requestDocuments('/agent-kg/segment/restOrig', { segmentId: firstSegment.segmentId }));
  failWrites = false;
  assert.equal(cache.get('rea-document-snapshot'), beforeSegmentFailure);
  assert.equal((await contentCall('/agent-kg/segment/list', { docId: segmentDocId }))[0].content, '本地第二次编辑');
  for (const [action, data] of [
    ['modify', { docId: segmentDocId, segmentId: 'missing', content: '无效' }],
    ['modify', { docId: ids[0], segmentId: firstSegment.segmentId, content: '错误文档' }],
    ['modify', { docId: segmentDocId, segmentId: firstSegment.segmentId, content: '' }],
    ['enable', { segmentId: firstSegment.segmentId, enable: 2 }], ['restOrig', { segmentId: 'missing' }],
  ]) failure(await api.requestDocuments('/agent-kg/segment/' + action, data));
  assert.equal(await contentCall('/agent-kg/segment/restOrig', { segmentId: firstSegment.segmentId }), firstSegment.content);
  await refresh();
  assert.equal((await contentCall('/agent-kg/segment/list', { docId: segmentDocId }))[0].version, 0);
  await call('deleteEdit', { docId: segmentDocId });
  await refresh();
  assert.deepEqual(await contentCall('/agent-kg/segment/list', { docId: segmentDocId }), realSegments);
  assert.equal((await call('getInfo', { docId: segmentDocId })).step, 4);
  const qaPayload = { baseId: qaBaseId, questionContent: '本地问题', answerContent: '本地答案', similarQuestion: [{ similarQuestion: '本地相似问题' }], userId: null };
  const createdQa = await contentCall('/agent-kg/qa/add', qaPayload);
  assert.ok(String(createdQa.qaId).startsWith('local-qa-'));
  assert.notEqual(createdQa.qaStatus, 2, '本地新增不能宣称已云向量化');
  await refresh();
  assert.equal((await contentCall('/agent-kg/qa/get', { qaId: createdQa.qaId })).questionContent, '本地问题');
  await contentCall('/agent-kg/qa/modify', { ...qaPayload, qaId: createdQa.qaId, answerContent: '本地修改答案' });
  await refresh();
  assert.equal((await contentCall('/agent-kg/qa/get', { qaId: createdQa.qaId })).answerContent, '本地修改答案');
  const beforeQaFailure = cache.get('rea-document-snapshot');
  failWrites = true;
  failure(await api.requestDocuments('/agent-kg/qa/add', qaPayload));
  failure(await api.requestDocuments('/agent-kg/qa/modify', { ...qaPayload, qaId: createdQa.qaId, answerContent: '丢弃失败答案' }));
  failure(await api.requestDocuments('/agent-kg/qa/del', { baseId: qaBaseId, qaId: createdQa.qaId }));
  failWrites = false;
  assert.equal(cache.get('rea-document-snapshot'), beforeQaFailure);
  assert.equal((await contentCall('/agent-kg/qa/get', { qaId: createdQa.qaId })).answerContent, '本地修改答案');
  for (const [action, data] of [
    ['add', { ...qaPayload, baseId }], ['add', { ...qaPayload, questionContent: '' }],
    ['add', { ...qaPayload, similarQuestion: ['invalid'] }], ['modify', { ...qaPayload, qaId: 'missing' }],
    ['del', { baseId: qaBaseId, qaId: 'missing' }], ['uploadQAExcel', { baseId: qaBaseId }],
  ]) failure(await api.requestDocuments('/agent-kg/qa/' + action, data));
  await contentCall('/agent-kg/qa/del', { baseId: qaBaseId, qaId: createdQa.qaId });
  await contentCall('/agent-kg/qa/del', { baseId: qaBaseId, qaId: qaRow.qaId });
  await refresh();
  failure(await api.requestDocuments('/agent-kg/qa/get', { qaId: createdQa.qaId }));
  failure(await api.requestDocuments('/agent-kg/qa/get', { qaId: qaRow.qaId }));
  assert.equal((await contentCall('/agent-kg/qa/list', { baseId: qaBaseId })).length, 26);
  await call('editInfo', { docId: ids[0], baseId, docIds: [], docName: '本地信息编辑.xlsx',
    docTitle: '本地标题', labels: [{ uid: 'local-label', labelName: '本地' }],
    docAttribute: JSON.stringify({ author: '本地作者', version: 'metadata-v2' }) });
  await refresh();
  assert.equal((await call('getInfo', { docId: ids[0] })).docName, '本地信息编辑.xlsx');
  assert.equal((await call('list', { baseId, name: '本地信息编辑' }))[0].docId, ids[0]);
  assert.equal(JSON.parse((await call('getInfo', { docId: ids[0] })).docAttribute).version, 'metadata-v2');
  assert.equal((await call('getInfo', { docId: ids[0] })).docStatus, 2);
  await call('config', { baseId, docSeparator: '\\n', maxLength: 888, minLength: 88,
    docList: [{ docId: ids[0], docType: 1, segmentType: 0 }, { docId: ids[1], docType: 2, segmentType: 1 }] });
  await refresh();
  assert.equal((await call('getConfig', { docId: ids[0] })).maxLength, 888);
  assert.equal((await call('getConfig', { docId: ids[1] })).docType, 2);
  assert.equal((await call('getInfo', { docId: ids[1] })).segmentType, 1);
  await call('editInfo', { docId: ids[0], baseId, docIds: ids, docDomain: '本地共享领域' });
  assert.ok((await call('getInfoList', { docIds: ids })).every(row => row.docDomain === '本地共享领域'));
  assert.equal((await call('getConfig', { docId: '1966705122926678018' })).maxLength, null);
  assert.equal(await api.requestDocuments('/agent-kg/segment/list/extra', {}), undefined);
  assert.equal(await api.requestDocuments('/prefix/agent-kg/qa/list', {}), undefined);
  const saved = cache.get('rea-document-snapshot');
  assert.ok(saved);
  assert.deepEqual([...cache.keys()], ['rea-document-snapshot']);
  for (const [action, data] of [
    ['editInfo', { docId: 'missing', docTitle: '不能创建虚构文档' }],
    ['editInfo', { docId: ids[0], docName: '' }],
    ['editInfo', { docId: ids[0], docAttribute: '{bad' }],
    ['editInfo', { docId: ids[0], docIds: [ids[0], 'missing'], docDomain: '不能部分保存' }],
    ['config', { docList: [{ docId: ids[0] }, { docId: 'missing' }], maxLength: 999 }],
    ['config', { docId: 'missing', maxLength: 999 }],
    ['delete', { docId: 'missing' }], ['deleteEdit', { docId: 'missing' }], ['unline', { docId: 'missing' }],
  ]) {
    failure(await api.requestDocuments('/agent-kg/doc/' + action, data));
    assert.equal(cache.get('rea-document-snapshot'), saved);
  }
  failWrites = true;
  for (const [action, data] of [
    ['editInfo', { docId: ids[0], docTitle: '丢弃失败编辑' }],
    ['config', { docList: [{ docId: ids[0] }], maxLength: 999 }],
    ['delete', { docId: ids[0] }], ['deleteEdit', { docId: ids[1] }], ['unline', { docId: ids[0] }],
  ]) failure(await api.requestDocuments('/agent-kg/doc/' + action, data));
  failWrites = false;
  assert.equal(cache.get('rea-document-snapshot'), saved);
  assert.equal((await call('getInfo', { docId: ids[0] })).docTitle, '本地标题');
  assert.equal((await call('getConfig', { docId: ids[0] })).maxLength, 888);
  assert.equal((await call('getInfo', { docId: ids[0] })).step, 4);
  await call('unline', { docId: ids[0] });
  await refresh();
  assert.equal((await call('getInfo', { docId: ids[0] })).step, 6);
  assert.equal((await call('list', { baseId, status: 4, name: '本地信息编辑' })).length, 1);
  await call('delete', { docId: ids[0] });
  await call('deleteEdit', { docId: ids[1] });
  await refresh();
  failure(await api.requestDocuments('/agent-kg/doc/getInfo', { docId: ids[0] }));
  failure(await api.requestDocuments('/agent-kg/doc/getConfig', { docId: ids[1] }));
  assert.equal((await call('list', { baseId })).length, 3);
  assert.deepEqual(await api.requestDocuments('/agent-kg/doc/getInfo', { docId: '1966705122926678018' }),
    fixture.documents.find(doc => doc.docId === '1966705122926678018').info);
  const valid = cache.get('rea-document-snapshot');
  for (const broken of ['{bad', '{}', JSON.stringify({ version: 999, bases: [], documents: [] })]) {
    cache.set('rea-document-snapshot', broken);
    failure(await api.requestDocuments('/agent-kg/doc/delete', { docId: '1966705122926678018' }));
    assert.equal(cache.get('rea-document-snapshot'), broken);
    failure(await api.initializeDocuments());
    failure(await api.requestDocuments('/agent-kg/doc/getInfo', { docId: '1966705122926678018' }));
    assert.equal(await api.requestDocuments('/unknown'), undefined);
    assert.equal(cache.get('rea-document-snapshot'), broken);
    cache.set('rea-document-snapshot', valid);
    ok(await api.initializeDocuments());
  }
  for (const action of ['upload', 'createDocRecord', 'deploy', 'toSegment', 'testSplit', 'downLoadFile', 'getString', 'sensitiveKeys']) {
    failure(await api.requestDocuments('/decision/agent-kg/doc/' + action, { docId: '1966705122926678018' }));
    assert.equal(cache.get('rea-document-snapshot'), valid);
  }
  fixtureResponse = () => new Response('unavailable', { status: 503 });
  failure(await api.initializeDocuments());
  assert.equal(cache.get('rea-document-snapshot'), valid);
  fixtureResponse = () => new Response(JSON.stringify(fixture));
  ok(await api.initializeDocuments());
  console.log('文档契约通过：真实读取与筛选、信息/配置批量编辑、删除/下架刷新持久化、失败不修改和损坏快照保护。');
} finally {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
}
