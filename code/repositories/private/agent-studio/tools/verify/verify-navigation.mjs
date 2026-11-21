import assert from 'node:assert/strict';
const routes=['/agent/studio/app/app-manage','/agent/studio/agent/app-manage','/agent/studio/agent/agent-team','/agent/studio/agent/role-agent','/agent/studio/agent/agent-skill','/agent/studio/agent/mcp-service','/agent/studio/agent/plugin','/agent/studio/agent/prompt-word-library','/agent/studio/agent/knowledge','/agent/studio/agent/workflow','/agent/studio/agent/super-agent','/agent/studio/agent/standard-agent','/agent/studio/agent/low-code-chat','/agent/studio/agent/no-code-chat','/agent/studio/agent/task-app'];
for(const route of routes){
  const response=await fetch('http://127.0.0.1:4173'+route);
  assert.equal(response.status,200,'刷新页面应返回 SPA：'+route);
  assert.match(await response.text(),/src="\/main.js"/);
}
console.log('导航刷新：'+routes.length+' 条路由通过');
