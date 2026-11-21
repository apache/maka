import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, beforeEach } from 'node:test';
import { initializeBusiness, requestBusiness } from '../../app/offline-business.js';

const seed = JSON.parse(await readFile(new URL('../../app/business-data.json', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const cache = new Map();
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
  return new Response(JSON.stringify(seed), { status: 200 });
};
beforeEach(async () => {
  cache.clear();
  failWrites = false;
  await initializeBusiness();
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
});

const plugin = '/agent-microapp/plugin';
const mcp = '/agent-mcp/mcpManage/api';
const tools = '/agent-mcp/system/mcpToolsInfo';
const role = seed.roles.records[0];
const call = async (path, data = {}) => {
  const result = await requestBusiness(path, data);
  assert.ok(result, `未实现已捕获契约 ${path}`);
  assert.equal(result.success, true, `${path}: ${result.msg}`);
  assert.equal(result.code, 0);
  assert.equal(result.errCode, 0);
  return result.data;
};
const roleDetail = () => call(`${plugin}/getDetails`, { id: role.pluginIdStr });

test('旧业务快照补入新增详情字段，保留已保存值且不复活删除记录', async () => {
  await call(`${plugin}/update`, { pluginId: role.pluginIdStr, description: '用户保留的说明' });
  const saved = JSON.parse(cache.get('rea-business-snapshot'));
  const existing = saved.data.roles.records.find(item => item.pluginId === role.pluginIdStr);
  delete existing.addWay;
  const removed = saved.data.plugins.records.pop();
  cache.set('rea-business-snapshot', JSON.stringify(saved));
  await initializeBusiness();
  const detail = await roleDetail();
  assert.equal(detail.addWay, seed.roles.records[0].addWay);
  assert.equal(detail.description, '用户保留的说明');
  const plugins = await call('/agent-microapp/component/page', { pageNum: 1, pageSize: 1000 });
  assert.equal(plugins.records.some(item => item.compId === removed.compId), false);
});

test('专家版本开关按 pluginVersionId 和 activePlugin 启停并在刷新后保留', async () => {
  await call(`/decision${plugin}/activePlugin`, { pluginVersionId: role.pluginVersionId, activePlugin: 0 });
  await initializeBusiness();
  let detail = await roleDetail();
  assert.equal(detail.pluginVersionDetails.find(item => item.pluginVersionId === role.pluginVersionId).inEffect, 0);
  await call(`${plugin}/activePlugin`, { pluginVersionId: role.pluginVersionId, activePlugin: 1 });
  await initializeBusiness();
  detail = await roleDetail();
  assert.equal(detail.pluginVersionDetails.find(item => item.pluginVersionId === role.pluginVersionId).inEffect, 1);
  assert.equal(detail.status, role.status, '专家整体状态与版本开关隔离');
});

test('专家详情表单不传 version 也能新增，按版本 ID 编辑并隔离其他版本', async () => {
  const original = await call(`${plugin}/getVersionDetail`, { pluginVersionId: role.pluginVersionId });
  const association = [{ mcpServiceId: 164, mcpServerName: '本地关联服务', sortValue: 1,
    tools: [{ mcptoolsInfoId: 197, toolName: 'get-employee', sortValue: 1 }] }];
  const payload = { pluginId: role.pluginIdStr, description: '本地新增版本', path: '',
    skills: [{ skillId: seed.skills.records[0].skillId, name: '本地选择技能' }], mcps: association };
  await call(`${plugin}/addVersion`, payload);
  await initializeBusiness();
  let detail = await roleDetail();
  assert.equal(detail.pluginVersionDetails.length, 2);
  const added = detail.pluginVersionDetails.find(item => item.description === '本地新增版本');
  assert.ok(added?.pluginVersionId);
  assert.notEqual(added.pluginVersionId, role.pluginVersionId);
  assert.ok(added.version);
  assert.notEqual(added.version, original.version);
  assert.equal(added.inEffect, 0);
  let version = await call(`${plugin}/getVersionDetail`, { pluginVersionId: added.pluginVersionId });
  assert.equal(version.versionCode, added.version, '编辑表单读取 versionCode');
  assert.equal(version.packageUrl, '', '编辑表单读取 packageUrl');
  assert.equal(version.skills[0].skillName, '本地选择技能');
  assert.deepEqual(version.mcps, association);
  await call(`${plugin}/addVersion`, { ...payload, pluginVersionId: added.pluginVersionId,
    description: '本地编辑版本', skills: [], mcps: [] });
  await initializeBusiness();
  version = await call(`${plugin}/getVersionDetail`, { pluginVersionId: added.pluginVersionId });
  assert.equal(version.description, '本地编辑版本');
  assert.equal(version.versionCode, added.version);
  assert.deepEqual(version.skills, []);
  assert.deepEqual(version.mcps, []);
  assert.deepEqual(await call(`${plugin}/getVersionDetail`, { pluginVersionId: role.pluginVersionId }), original);
  detail = await roleDetail();
  assert.equal(detail.pluginVersionDetails.length, 2, '编辑不能追加重复版本');
  await call(`${plugin}/activePlugin`, { pluginVersionId: added.pluginVersionId, activePlugin: 1 });
  await initializeBusiness();
  detail = await roleDetail();
  assert.deepEqual(detail.pluginVersionDetails.filter(item => item.inEffect === 1).map(item => item.pluginVersionId), [added.pluginVersionId]);
  await call(`${plugin}/activePlugin`, { pluginVersionId: added.pluginVersionId, activePlugin: 0 });
  await initializeBusiness();
  assert.equal((await roleDetail()).pluginVersionDetails.filter(item => item.inEffect === 1).length, 0);
});

test('MCP 工具分页按路径服务 ID 隔离并返回详情配置页读取的 list 和 total', async () => {
  const first = await call(`/decision${tools}/getByMcpServerIdPage/164?pageNum=1&pageSize=1`);
  assert.equal(first.total, 2);
  assert.deepEqual(first.list.map(item => item.id), [197]);
  const second = await call(`${tools}/getByMcpServerIdPage/164`, { mcpServerId: 288, pageNum: 2, pageSize: 1 });
  assert.equal(second.total, 2, '路径中的服务 ID 不能被请求体覆盖');
  assert.deepEqual(second.list.map(item => item.id), [198]);
  const other = await call(`${tools}/getByMcpServerIdPage/288`, { pageNum: 1, pageSize: 10 });
  assert.equal(other.total, 4);
  assert.equal(other.list.every(item => item.mcpServerId === 288), true);
  assert.deepEqual((await call(`${tools}/getByMcpServerIdPage/164`, { pageNum: 3, pageSize: 1 })).list, []);
  assert.deepEqual(await call(`${tools}/getByMcpServerIdPage/320`, { pageNum: 1, pageSize: 10 }), { list: [], total: 0 });
  assert.equal((await requestBusiness(`${tools}/getByMcpServerIdPage/missing`)).code, 404);
  assert.equal((await requestBusiness(`${tools}/getByMcpServerIdPage/164?pageNum=0&pageSize=1`)).code, 400);
});

test('MCP 工具 getById 返回原始配置且不混淆服务 ID 与工具 ID', async () => {
  const source = seed.mcp.data.find(item => item.id === 164).mcpToolList.find(item => item.id === 197);
  const detail = await call(`/decision${tools}/getById/197`, { id: 198 });
  assert.deepEqual(detail, source);
  assert.equal(typeof detail.inputSchema, 'string');
  assert.equal(typeof detail.outputSchema, 'string');
  assert.equal(typeof detail.responseTemplate, 'string');
  detail.toolName = '不能污染快照';
  assert.equal((await call(`${tools}/getById/197`)).toolName, 'get-employee');
  assert.equal((await call(`${tools}/getById/356`)).mcpServerId, 294);
  assert.equal((await call(`${mcp}/getById/356`)).mcpServerName, seed.mcp.data.find(item => item.id === 356).mcpServerName);
  assert.equal((await requestBusiness(`${tools}/getById/164`)).code, 404);
  assert.equal((await requestBusiness(`${tools}/getById/missing`)).code, 404);
});

test('MCP 新建工具按原编辑表单保存配置，服务详情与工具列表读取同一份持久化数据', async () => {
  const payload = { toolName: 'offline_lookup', toolNameCn: '本地查询', toolDesc: '只保存配置', isOpen: 1,
    mcpServerId: 320, inputSchema: '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}',
    outputSchema: '{"type":"object","properties":{"result":{"type":"string"}}}',
    responseTemplate: '{"requestTemplate":{"url":"https://example.invalid/offline","method":"GET"},"responseTemplate":{"responseBody":"{{.}}"}}' };
  await call(`${tools}/add`, payload);
  await call(`${tools}/add`, { ...payload, mcpServerId: 164, toolDesc: '另一个服务的同名工具' });
  await initializeBusiness();
  const page = await call(`${tools}/getByMcpServerIdPage/320`);
  assert.equal(page.total, 1);
  const created = page.list[0];
  assert.ok(created.id);
  assert.equal(created.source, 3, '用户新建工具的接入类型');
  for (const [key, value] of Object.entries(payload)) assert.deepEqual(created[key], value, key);
  const other = (await call(`${tools}/getByMcpServerIdPage/164`)).list.find(item => item.toolName === payload.toolName);
  assert.ok(other);
  assert.notEqual(created.id, other.id);
  assert.equal(other.toolDesc, '另一个服务的同名工具');
  assert.deepEqual(await call(`${tools}/getById/${created.id}`), created);
  const detail = await call(`${mcp}/getMcpToolDetailById/320`);
  assert.equal(detail.id, 320);
  assert.equal(detail.mcpServerName, seed.mcp.data.find(item => item.id === 320).mcpServerName);
  assert.deepEqual(detail.mcpToolList, [created], '服务详情读取 mcpToolList 而非工具分页结构');
  assert.deepEqual((await call(`${mcp}/getById/320`)).mcpToolList, [created]);
  assert.equal((await requestBusiness(`${mcp}/getMcpToolDetailById/${created.id}`)).code, 404, '服务详情路径不接受工具 ID');
});

test('MCP 工具更新配置按工具 ID 隔离，同名工具与其他服务配置不变', async () => {
  const original = await call(`${tools}/getById/327`);
  const sameName = await call(`${tools}/getById/329`);
  const payload = { id: '327', mcpServerId: 292, toolName: original.toolName, toolNameCn: '本机顾客查询',
    toolDesc: '本地修改描述', isOpen: 0, inputSchema: '{"type":"object","properties":{},"required":[]}',
    outputSchema: '[]', responseTemplate: '{"responseTemplate":{"responseBody":"offline"}}' };
  await call(`${tools}/update`, payload);
  await initializeBusiness();
  let detail = await call(`${tools}/getById/327`);
  for (const [key, value] of Object.entries(payload)) assert.deepEqual(detail[key], key === 'id' ? 327 : value, key);
  assert.equal(detail.source, original.source);
  assert.deepEqual(await call(`${tools}/getById/329`), sameName);
  assert.equal((await call(`${mcp}/getMcpToolDetailById/292`)).mcpToolList.find(item => item.id === 327).toolDesc, '本地修改描述');
  detail.inputSchema = '不能写回返回值';
  assert.equal((await call(`${tools}/getById/327`)).inputSchema, payload.inputSchema);
});

test('MCP 工具启停读取 query id，刷新后服务详情和分页状态一致', async () => {
  const other = await call(`${tools}/getById/198`);
  await call(`/decision${tools}/disableTool?id=197`);
  await initializeBusiness();
  assert.equal((await call(`${tools}/getById/197`)).isOpen, 0);
  assert.equal((await call(`${tools}/getByMcpServerIdPage/164`)).list.find(item => item.id === 197).isOpen, 0);
  assert.equal((await call(`${mcp}/getMcpToolDetailById/164`)).mcpToolList.find(item => item.id === 197).isOpen, 0);
  await call(`${tools}/enableTool?id=197`);
  await initializeBusiness();
  assert.equal((await call(`${tools}/getById/197`)).isOpen, 1);
  assert.deepEqual(await call(`${tools}/getById/198`), other);
  assert.equal((await requestBusiness(`${tools}/disableTool?id=missing`)).code, 404);
});

test('MCP 工具删除从所属服务移除并持久化，不删除其他同名工具或服务', async () => {
  const other = await call(`${tools}/getById/329`);
  await call(`${tools}/disableTool?id=327`);
  await call(`/decision${tools}/delete/327`, { id: 329 });
  await initializeBusiness();
  assert.equal((await requestBusiness(`${tools}/getById/327`)).code, 404);
  assert.equal((await call(`${tools}/getByMcpServerIdPage/292`)).total, 1);
  assert.deepEqual((await call(`${mcp}/getMcpToolDetailById/292`)).mcpToolList.map(item => item.id), [331]);
  assert.equal((await call(`${mcp}/listPage`, { pageSize: 100 })).totalSize, 10);
  assert.deepEqual(await call(`${tools}/getById/329`), other);
  assert.equal((await requestBusiness(`${tools}/delete/missing`)).code, 404);
});

test('MCP 工具编辑不能把已有工具改挂到其他服务，失败不污染任一服务配置', async () => {
  const original = await call(`${tools}/getById/327`);
  const first = await call(`${tools}/getByMcpServerIdPage/292`);
  const second = await call(`${tools}/getByMcpServerIdPage/294`);
  const result = await requestBusiness(`${tools}/update`, { id: 327, mcpServerId: 294, toolDesc: '不能串到其他服务' });
  assert.equal(result.success, false);
  assert.equal(result.code, 409);
  await initializeBusiness();
  assert.deepEqual(await call(`${tools}/getById/327`), original);
  assert.deepEqual(await call(`${tools}/getByMcpServerIdPage/292`), first);
  assert.deepEqual(await call(`${tools}/getByMcpServerIdPage/294`), second);
  assert.equal((await requestBusiness(`${tools}/add`, { mcpServerId: 'missing', toolName: 'orphan_tool' })).code, 404);
});

test('专家版本保存后保留已采集技能的说明和图标供详情卡片读取', async () => {
  const skill = seed.skills.records[0];
  const created = await call(`${plugin}/addVersion`, { pluginId: role.pluginIdStr, description: '含已采集技能', path: '',
    skills: [{ skillId: skill.skillId, name: skill.skillName }], mcps: [] });
  await initializeBusiness();
  const version = await call(`${plugin}/getVersionDetail`, { pluginVersionId: created.pluginVersionId });
  assert.equal(version.skills[0].skillName, skill.skillName);
  assert.equal(version.skills[0].skillDescription, skill.description);
  assert.equal(version.skills[0].iconUrl, skill.icon);
  const card = (await roleDetail()).pluginVersionDetails.find(item => item.pluginVersionId === created.pluginVersionId);
  assert.deepEqual(card.skills, version.skills);
});

test('专家启用新版本后列表展示同一版本和已保存的技能、MCP 关联数量', async () => {
  const added = await call(`${plugin}/addVersion`, { pluginId: role.pluginIdStr, description: '本地启用版本', path: '',
    skills: [{ skillId: seed.skills.records[0].skillId, name: '本地技能' }],
    mcps: [{ mcpServiceId: 164, mcpServerName: '本地关联', tools: [] }] });
  await call(`${plugin}/activePlugin`, { pluginVersionId: added.pluginVersionId, activePlugin: 1 });
  await initializeBusiness();
  const listing = await call(`${plugin}/getAllList`, { pageNum: 1, pageSize: 100 });
  const summary = listing.records.find(item => item.pluginId === role.pluginId);
  assert.equal(summary.pluginVersionId, added.pluginVersionId);
  assert.equal(summary.version, added.version);
  assert.equal(summary.bindSkillCount, 1);
  assert.equal(summary.bindMcpCount, 1);
  assert.equal(summary.status, role.status);
  assert.equal((await call(`${plugin}/getVersionDetail`, { pluginVersionId: role.pluginVersionId })).inEffect, 0);
});

test('专家版本和 MCP 工具写入配额失败时公开读取与刷新后的数据保持不变', async () => {
  const added = await call(`${plugin}/addVersion`, { pluginId: role.pluginIdStr, description: '配额验证版本', path: '', skills: [], mcps: [] });
  const before = await roleDetail();
  const server = await call(`${mcp}/getMcpToolDetailById/164`);
  failWrites = true;
  for (const [path, data] of [
    [`${plugin}/activePlugin`, { pluginVersionId: role.pluginVersionId, activePlugin: 0 }],
    [`${plugin}/addVersion`, { pluginId: role.pluginIdStr, description: '不能新增', path: '', skills: [], mcps: [] }],
    [`${plugin}/addVersion`, { pluginId: role.pluginIdStr, pluginVersionId: added.pluginVersionId, description: '不能更新' }],
    [`${tools}/add`, { mcpServerId: 164, toolName: 'cannot_save', isOpen: 1 }],
    [`${tools}/update`, { id: 197, toolDesc: '不能更新' }],
    [`${tools}/disableTool?id=197`, {}],
    [`${tools}/delete/197`, {}],
  ]) {
    const result = await requestBusiness(path, data);
    assert.equal(result.success, false, path);
    assert.equal(result.code, 507, path);
    assert.match(result.msg, /数据未变更/);
    assert.deepEqual(await roleDetail(), before);
    assert.deepEqual(await call(`${mcp}/getMcpToolDetailById/164`), server);
  }
  failWrites = false;
  await initializeBusiness();
  assert.deepEqual(await roleDetail(), before);
  assert.deepEqual(await call(`${mcp}/getMcpToolDetailById/164`), server);
});

test('专家版本拒绝缺失、错误或跨专家的版本 ID 和无效开关参数', async () => {
  const before = await roleDetail();
  const other = await call(`${plugin}/add`, { pluginName: '另一个本地专家' });
  for (const [path, data, code] of [
    [`${plugin}/activePlugin`, { activePlugin: 0 }, 404],
    [`${plugin}/activePlugin`, { pluginVersionId: 'missing', activePlugin: 1 }, 404],
    [`${plugin}/activePlugin`, { pluginVersionId: role.pluginVersionId, activePlugin: 2 }, 400],
    [`${plugin}/addVersion`, { pluginId: role.pluginIdStr, pluginVersionId: 'missing', description: '不能插入' }, 404],
    [`${plugin}/addVersion`, { pluginId: other.pluginId, pluginVersionId: role.pluginVersionId, description: '不能跨专家改写' }, 404],
    [`${plugin}/addVersion`, { pluginId: role.pluginIdStr, skills: {} }, 400],
  ]) {
    const result = await requestBusiness(path, data);
    assert.equal(result.success, false, path);
    assert.equal(result.code, code, path);
  }
  await initializeBusiness();
  assert.deepEqual(await roleDetail(), before);
});

test('现有 MCP 服务别名和空知识库文档契约保持不变，发布上传明确失败', async () => {
  const server = await call(`${mcp}/getById/164`);
  assert.deepEqual(await call(`/decision${mcp}/getMcpToolDetailById/164`), server);
  assert.equal(await requestBusiness(`${tools}/unknownOperation`), undefined);
  for (const path of [`${mcp}/release`, `${plugin}/uploadPlugin`, '/agent-microapp/skill/uploadSkill']) {
    assert.equal((await requestBusiness(path)).code, 501, path);
  }
  const empty = seed.knowledge.find(item => Number(item.docCount) === 0);
  const nonempty = seed.knowledge.find(item => Number(item.docCount) > 0);
  assert.deepEqual(await call('/agent-kg/doc/list', { baseId: empty.baseId }), []);
  const docs = await requestBusiness('/agent-kg/doc/list', { baseId: nonempty.baseId });
  assert.equal(docs.code, 503);
  assert.match(docs.msg, /文档明细尚未采集/);
});

const team = '/agent-microapp/pluginCollection';

test('专家团队新增把标签对象转成列表可渲染的字符串', async () => {
  const created = await call(`${team}/add`, {
    collectionName: '标签结构验收团队', collectionDescription: '职责', industry: 3,
    tags: [{ tagId: 3, tagName: '美业' }, { tagId: 1, tagName: '康养' }], versionDescription: '初始版本', plugins: [],
  });
  const page = await call(`${team}/getPageList`, { pageNum: 1, pageSize: 100 });
  const row = page.records.find(item => item.collectionId === created.collectionId);
  // 原列表把 tags 直接当 React children，对象会导致渲染报错。
  assert.equal(typeof row.tags, 'string');
  assert.equal(row.tags, '美业,康养');
  await call(`${team}/delete`, { collectionId: created.collectionId });
});

test('专家团队版本新增、编辑和启停按版本 ID 隔离并在刷新后保留', async () => {
  const created = await call(`${team}/add`, {
    collectionName: '版本接口验收团队', collectionDescription: '职责', industry: 3, versionDescription: '初始版本', plugins: [],
  });
  const first = created.collectionVersionId;
  const added = await call(`${team}/addVersion`, { collectionId: created.collectionId, description: '第二个版本', plugins: [] });
  assert.notEqual(added.collectionVersionId, first);
  await call(`/decision${team}/activeVersion`, { collectionId: created.collectionId, collectionVersionId: added.collectionVersionId, activeVersion: 1 });
  await initializeBusiness();
  const detail = await call(`${team}/getDetails`, { collectionId: created.collectionId });
  const versions = detail.collectionVersionDetails;
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.filter(item => item.inEffect === 1).map(item => item.collectionVersionId), [added.collectionVersionId]);
  assert.equal(detail.collectionVersionId, added.collectionVersionId);
  for (const [path, data, code] of [
    [`${team}/addVersion`, { collectionId: created.collectionId, collectionVersionId: 'missing' }, 404],
    [`${team}/activeVersion`, { collectionId: created.collectionId, collectionVersionId: added.collectionVersionId, activeVersion: 2 }, 400],
  ]) {
    assert.equal((await requestBusiness(path, data)).code, code, path);
  }
  await call(`${team}/delete`, { collectionId: created.collectionId });
});

test('专家团队版本启停读页面实际提交的 activeCollection 字段', async () => {
  const created = await call(`${team}/add`, {
    collectionName: '启停字段验收团队', collectionDescription: '职责', industry: 3, versionDescription: '初始版本', plugins: [],
  });
  const added = await call(`${team}/addVersion`, { collectionId: created.collectionId, description: '第二版本', plugins: [] });
  // readable/team-detail-C_ltYyhx.js:310 提交的是 activeCollection，不是 activeVersion。
  await call(`${team}/activeVersion`, { collectionVersionId: added.collectionVersionId, activeCollection: 1 });
  await initializeBusiness();
  const detail = await call(`${team}/getDetails`, { collectionId: created.collectionId });
  assert.deepEqual(detail.collectionVersionDetails.filter(item => item.inEffect === 1).map(item => item.collectionVersionId), [added.collectionVersionId]);
  await call(`${team}/activeVersion`, { collectionVersionId: added.collectionVersionId, activeCollection: 0 });
  await call(`${team}/delete`, { collectionId: created.collectionId });
});

test('原子技能新增版本接受页面不含 version 的提交体', async () => {
  const skill = seed.skills.records[0];
  // readable/skill-detail-DnwZcdYV.js:1014-1022 的新增体任何层级都没有 version。
  const added = await call('/agent-microapp/skill/version/add', {
    skillId: skill.skillId, description: '无版本号提交', mcpList: [],
    skillList: [{ path: '/p', skillName: 'n', prompt: '' }],
  });
  assert.match(added.version, /^local-skill-version-/);
  assert.equal(added.state, 0);
  await initializeBusiness();
  const detail = await call('/agent-microapp/skill/findById', { skillId: skill.skillId });
  assert.equal(detail.versionList.length, skill.versionList.length + 1);
  assert.ok(detail.versionList.some(item => item.version === added.version));
});

test('原子技能编辑版本只在 skillList 内传 skillVersionId 也能命中', async () => {
  const skill = seed.skills.records[0];
  const target = skill.versionList[0];
  // readable/skill-detail-DnwZcdYV.js:1025-1032 的编辑体顶层没有 skillVersionId，
  // 但顶层传 description/mcpList，需要合并到嵌套定位的版本。
  await call('/agent-microapp/skill/version/update', {
    skillId: skill.skillId, description: '顶层描述', mcpList: [],
    skillList: [{ path: '/p', skillName: 'n', prompt: '', skillVersionId: target.skillVersionId }],
  });
  await initializeBusiness();
  const detail = await call('/agent-microapp/skill/findById', { skillId: skill.skillId });
  const saved = detail.versionList.find(item => String(item.skillVersionId) === String(target.skillVersionId));
  assert.equal(saved.description, '顶层描述', '顶层 description 与嵌套 skillVersionId 合并');
  assert.equal(saved.path, '/p');
});

test('原子技能版本按表单嵌套的 skillList 取版本号和版本 ID', async () => {
  const skill = seed.skills.records[0];
  // 新增表单不传顶层 version，编辑表单只在 skillList[0] 里带 skillVersionId。
  const added = await call('/agent-microapp/skill/version/add', {
    skillId: skill.skillId, skillList: [{ version: 'v9.9.9-local', description: '嵌套取值新增' }],
  });
  assert.equal(added.version, 'v9.9.9-local');
  await call('/agent-microapp/skill/version/update', {
    skillList: [{ skillVersionId: added.skillVersionId, description: '嵌套取值编辑' }],
  });
  await initializeBusiness();
  const detail = await call('/agent-microapp/skill/findById', { skillId: skill.skillId });
  const saved = detail.versionList.find(item => String(item.skillVersionId) === String(added.skillVersionId));
  assert.equal(saved.description, '嵌套取值编辑');
  assert.equal(detail.versionList.length, skill.versionList.length + 1);
  const autoGen = await call('/agent-microapp/skill/version/add', { skillId: skill.skillId, skillList: [{ description: '无版本号也能新增' }] });
  assert.match(autoGen.version, /^local-skill-version-/);
  assert.equal((await requestBusiness('/agent-microapp/skill/version/update', { skillList: [{ skillVersionId: 'missing' }] })).code, 404);
});
