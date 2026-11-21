import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const fixtureItems = [];
for (const name of ['sidebar-data.json', 'component-data.json']) {
  const fixture = JSON.parse(await readFile(new URL(`evidence/${name}`, root), 'utf8'));
  fixtureItems.push(...fixture.items);
}
const seeds = Object.fromEntries(
  fixtureItems.filter(item => item.response?.success === true || item.response?.code === 0)
    .map(item => [item.key, item.response.data]),
);
// 使用主线程本地化后的数据；尚未写出的新键由同次真实采集补足测试 fetch 边界。
Object.assign(seeds, JSON.parse(await readFile(new URL('app/business-data.json', root), 'utf8')));
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const cache = new Map();
let fetchCount = 0;
let failWrites = false;
globalThis.localStorage = {
  getItem: key => cache.get(key) ?? null,
  setItem: (key, value) => {
    if (failWrites) throw new Error('test storage quota');
    cache.set(key, String(value));
  },
};
globalThis.fetch = async url => {
  assert.equal(new URL(String(url)).pathname.endsWith('/app/business-data.json'), true);
  fetchCount++;
  return new Response(JSON.stringify(seeds), { status: 200 });
};

try {
  const { initializeBusiness, requestBusiness } = await import('../../app/offline-business.js');
  const call = async (path, data = {}) => {
    const result = await requestBusiness(path, data);
    assert.ok(result, `未实现已捕获契约 ${path}`);
    assert.equal(result.success, true, `${path}: ${result.msg}`);
    assert.equal(result.errCode, 0);
    assert.equal(result.code, 0);
    return result.data;
  };
  const promptPath = '/agent-microapp/promptTemplate';
  await initializeBusiness();
  assert.equal(fetchCount, 1);
  assert.equal(await requestBusiness('/agent-microapp/not-captured', {}), undefined);
  const promptsBefore = await call(`${promptPath}/findListByCondition`);
  assert.equal(promptsBefore.length, 27);
  await call(`/decision${promptPath}/create`, {
    promptName: '本地公开测试提示词', description: '初始说明', promptLabel: '饮食', prompt: '初始正文',
  });
  const added = await call(`${promptPath}/findListByCondition`, { promptName: '本地公开测试提示词' });
  assert.equal(added.length, 1);
  const id = added[0].promptId;
  assert.ok(id);
  assert.equal(added[0].promptContent, '初始正文');
  await call(`${promptPath}/update`, {
    promptId: id, promptName: '已修改本地提示词', description: '修改说明', promptLabel: '运动', promptContent: '修改正文',
  });
  assert.equal((await call(`${promptPath}/findListByCondition`, { promptName: '已修改', promptLabel: '运动' })).length, 1);
  assert.equal((await call(`${promptPath}/findListByCondition`, { description: '修改说明', promptLabel: '饮食' })).length, 0);
  await initializeBusiness();
  assert.equal((await call(`${promptPath}/findById`, { promptId: id })).promptContent, '修改正文');
  await call(`${promptPath}/deleteById`, { promptId: id });
  await initializeBusiness();
  assert.equal((await call(`${promptPath}/findListByCondition`, { promptName: '已修改本地提示词' })).length, 0);
  assert.equal((await call(`${promptPath}/findListByCondition`)).length, 27);
  assert.equal((await requestBusiness(`${promptPath}/findById`, { promptId: id })).success, false);

  const roles = await call('/agent-microapp/plugin/getAllList', { pageNum: 1, pageSize: 100 });
  assert.equal(roles.total, 1);
  assert.equal(roles.records[0].pluginName, 'AICoach');
  assert.equal((await call('/agent-microapp/plugin/getAllList', { searchKey: '美肤', tagName: '美业' })).total, 1);
  assert.equal((await call('/agent-microapp/plugin/getAllList', { searchKey: '不存在角色' })).total, 0);
  const teams = await call('/agent-microapp/pluginCollection/getPageList', { pageNum: 1, pageSize: 10 });
  assert.deepEqual(teams.records, []);
  assert.equal(teams.total, 0);
  const mcp = await call('/decision/agent-mcp/mcpManage/api/listPage?pageNum=2&pageSize=3');
  assert.equal(mcp.pageNum, 2);
  assert.equal(mcp.pageSize, 3);
  assert.equal(mcp.totalSize, 10);
  assert.equal(mcp.data.length, 3);
  assert.equal(mcp.data[0].id, seeds.mcp.data[3].id);
  assert.equal((await call('/agent-mcp/mcpManage/api/listPage', { mcpServerName: seeds.mcp.data[0].mcpServerName })).data[0].id, seeds.mcp.data[0].id);
  assert.equal((await call(`/agent-mcp/mcpManage/api/getById/${seeds.mcp.data[0].id}`)).id, seeds.mcp.data[0].id);
  const mcpDetail = await call(`/agent-mcp/mcpManage/api/getMcpToolDetailById/${seeds.mcp.data[0].id}`);
  assert.equal(mcpDetail.id, seeds.mcp.data[0].id);
  assert.deepEqual(mcpDetail.mcpToolList, seeds.mcp.data[0].mcpToolList);
  const toolsPage = await call(`/agent-mcp/system/mcpToolsInfo/getByMcpServerIdPage/${mcpDetail.id}`, { pageNum: 1, pageSize: 100 });
  assert.equal(toolsPage.total, mcpDetail.mcpToolList.length);
  assert.deepEqual(toolsPage.list, mcpDetail.mcpToolList);
  if (toolsPage.total > 0) {
    assert.deepEqual(await call(`/agent-mcp/system/mcpToolsInfo/getById/${toolsPage.list[0].id}`), toolsPage.list[0]);
  }

  const emptyKnowledge = seeds.knowledge.find(row => Number(row.docCount) === 0);
  const populatedKnowledge = seeds.knowledge.find(row => Number(row.docCount) > 0);
  assert.ok(emptyKnowledge && populatedKnowledge, '真实知识库样本须同时覆盖空库和非空库');
  assert.deepEqual(await call('/agent-kg/doc/list', { baseId: emptyKnowledge.baseId }), []);
  const unavailableDocs = await requestBusiness('/agent-kg/doc/list', { baseId: populatedKnowledge.baseId });
  assert.equal(unavailableDocs.success, false);
  assert.match(unavailableDocs.msg, /文档明细尚未采集/);
  assert.equal((await requestBusiness('/agent-kg/doc/deploy', { baseId: emptyKnowledge.baseId })).success, false);

  const superPath = '/agent-microapp/superAgent/config';
  const original = await call(`${superPath}/detail`, { microAppVersionId: 5110 });
  assert.deepEqual(original.appInfo, seeds.superAgent.appInfo);
  await call(`${superPath}/save`, {
    microAppId: original.config.microAppId, microAppVersionId: 5110, leadAgentPrompt: '本地总控提示词', plugins: [],
  });
  await call(`${superPath}/save`, { microAppId: original.config.microAppId, microAppVersionId: 9999, leadAgentPrompt: '另一版本', plugins: [] });
  await initializeBusiness();
  const saved = await call(`${superPath}/detail`, { microAppVersionId: '5110' });
  assert.equal(saved.config.leadAgentPrompt, '本地总控提示词');
  assert.deepEqual(saved.appInfo, original.appInfo);
  assert.equal((await call(`${superPath}/detail`, { microAppVersionId: 9999 })).config.leadAgentPrompt, '另一版本');

  // 每个已捕获 CRUD 契约均从公共请求边界验证，不直接查看内部快照。
  const cases = [
    { base: '/agent-microapp/pluginCollection', create: 'add', list: 'getPageList', detail: 'getDetails', remove: 'delete', id: 'collectionId', name: 'collectionName', fields: { collectionDescription: '本地说明', industryList: [{ tagName: '测试行业' }] } },
    { base: '/agent-microapp/plugin', create: 'add', list: 'getAllList', detail: 'getDetails', remove: 'delete', id: 'pluginId', name: 'pluginName', fields: { pluginNameCn: '本地角色', description: '本地说明', tags: ['测试行业'] } },
    { base: '/agent-microapp/skill', create: 'create', list: 'getPage', detail: 'findById', remove: 'deleteById', id: 'skillId', name: 'skillName', fields: { description: '本地说明', industryList: [{ tagName: '测试行业' }], initialVersion: 'v1.0.0', prompt: '本地技能说明' } },
    { base: '/agent-microapp/component', create: 'add', list: 'page', detail: 'get', remove: 'deleteById', id: 'compId', name: 'compName', detailId: 'id', removeId: 'id', fields: { releaseChannel: 0, description: '本地说明' } },
    { base: '/agent-kg/database', create: 'create', list: 'list', detail: 'baseDetails', remove: 'delete', id: 'baseId', name: 'baseName', fields: { description: '本地说明', baseType: 0 } },
  ];
  for (const spec of cases) {
    const listing = () => call(`${spec.base}/${spec.list}`, { pageNum: 1, pageSize: 1000 });
    const rows = result => Array.isArray(result) ? result : result.records;
    const before = rows(await listing()).length;
    await call(`${spec.base}/${spec.create}`, { [spec.name]: '公开本地CRUD', ...spec.fields });
    const created = rows(await listing()).find(row => row[spec.name] === '公开本地CRUD');
    assert.ok(created, spec.base);
    await call(`${spec.base}/update`, { ...created, [spec.name]: '公开本地CRUD已修改' });
    await initializeBusiness();
    const detail = await call(`${spec.base}/${spec.detail}`, { [spec.detailId || spec.id]: created[spec.id] });
    assert.equal(detail[spec.name], '公开本地CRUD已修改');
    await call(`${spec.base}/${spec.remove}`, { [spec.removeId || spec.id]: created[spec.id] });
    await initializeBusiness();
    assert.equal(rows(await listing()).length, before);
    assert.equal(rows(await listing()).some(row => String(row[spec.id]) === String(created[spec.id])), false);
  }
  await call('/agent-microapp/promptLabel/create', { labelName: '公开测试标签' });
  await initializeBusiness();
  assert.equal((await call('/agent-microapp/promptLabel/findListByCondition', { labelName: '公开测试标签' })).length, 1);
  const duplicate = await requestBusiness('/agent-microapp/promptLabel/create', { labelName: '公开测试标签' });
  assert.equal(duplicate.success, false);
  for (const path of ['/agent-microapp/component/release', '/agent-microapp/component/downComp', '/agent-microapp/skill/uploadSkill']) {
    assert.equal((await requestBusiness(path, {}))?.success === true, false);
  }
  failWrites = true;
  const failed = await requestBusiness(`${promptPath}/create`, { promptName: '不能保存的提示词', promptContent: '正文' });
  assert.equal(failed.success, false);
  assert.equal((await call(`${promptPath}/findListByCondition`, { promptName: '不能保存的提示词' })).length, 0);
  failWrites = false;
  const goodCache = cache.get('rea-business-snapshot');
  cache.set('rea-business-snapshot', '{broken json');
  await assert.rejects(initializeBusiness(), /rea-business-snapshot/);
  assert.equal(cache.get('rea-business-snapshot'), '{broken json');
  cache.set('rea-business-snapshot', JSON.stringify({ version: 1, data: { roles: null }, superAgents: {} }));
  await assert.rejects(initializeBusiness(), /rea-business-snapshot/);
  cache.set('rea-business-snapshot', goodCache);
  await initializeBusiness();
  console.log(JSON.stringify({ passed: true, promptCount: 27, roleCount: 1, teamCount: 0, mcpCount: 10, pluginCount: seeds.plugins.records.length, fetchCount, persistence: true, corruptCachePreserved: true }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
}
