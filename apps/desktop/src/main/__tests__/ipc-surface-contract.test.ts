import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

function extractChannels(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

describe('IPC surface contract', () => {
  it('keeps main handlers paired with preload invocations', async () => {
    const [main, preload] = await Promise.all([
      readMainProcessCombinedSource(),
      readRepo('apps/desktop/src/preload/preload.ts'),
    ]);
    const mainChannels = extractChannels(main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g);
    const preloadChannels = extractChannels(preload, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g);
    const mainSet = new Set(mainChannels);
    const preloadSet = new Set(preloadChannels);
    const missingMainHandlers = preloadChannels.filter((channel) => !mainSet.has(channel));
    const staleMainHandlers = mainChannels.filter((channel) => !preloadSet.has(channel));

    assert.deepEqual(missingMainHandlers, [], 'every preload invoke channel must have a main handler');
    assert.deepEqual(staleMainHandlers, [], 'main process must not expose stale invoke handlers outside the preload bridge');
  });

  it('exposes the bounded graph read model without renderer execution authority', async () => {
    const [main, preload, bridge] = await Promise.all([
      readMainProcessCombinedSource(),
      readRepo('apps/desktop/src/preload/preload.ts'),
      readRepo('apps/desktop/src/preload/bridge-contract.d.ts'),
    ]);
    for (const channel of [
      'graphs:getSnapshot',
      'graphs:inspectOperator',
      'graphs:stop',
    ]) {
      assert.match(main, new RegExp(`ipcMain\\.handle\\(\\s*['"]${channel}['"]`));
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\(\\s*['"]${channel}['"]`));
    }
    assert.match(main, /coordinator\.subscribeAll/);
    assert.match(preload, /payload\.rootSessionId === rootSessionId/);
    assert.match(bridge, /AgentGraphClientSnapshot/);
    assert.match(bridge, /AgentGraphOperatorInspection/);
    assert.doesNotMatch(bridge, /AgentGraphScheduleControlStore|RuntimeEventStore/);
  });

  it('exposes memory lifecycle IPC without renderer-forged metadata', async () => {
    const [main, preload] = await Promise.all([
      readMainProcessCombinedSource(),
      readRepo('apps/desktop/src/preload/preload.ts'),
    ]);
    for (const channel of [
      'memory:listProposals',
      'memory:propose',
      'memory:remember',
      'memory:approveProposal',
      'memory:rejectProposal',
      'memory:archiveEntry',
      'memory:restoreEntry',
    ]) {
      assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`));
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`));
    }

    const normalizeBlock = main.match(/function normalizeMemoryTextInput[\s\S]*?\n}\n\nfunction localMemoryOpenFailureCopy/)?.[0] ?? '';
    assert.match(normalizeBlock, /title/);
    assert.match(normalizeBlock, /content/);
    assert.match(normalizeBlock, /scope/);
    assert.doesNotMatch(normalizeBlock, /confirmedAt|status|sourceTurnId|source:/);
  });

  it('wires memory to main-owned privacy state and current-turn update tail', async () => {
    const [main, combinedMainProcess] = await Promise.all([
      readRepo('apps/desktop/src/main/main.ts'),
      readMainProcessCombinedSource(),
    ]);

    assert.match(main, /async function getWorkspacePrivacyContext\(\)/);
    assert.match(main, /settings\.privacy\.incognitoActive === true/);
    assert.match(main, /new LocalMemoryService\([\s\S]*getPrivacyContext: getWorkspacePrivacyContext/);
    assert.doesNotMatch(main, /defaultWorkspacePrivacyContext/);

    // The ai-sdk backend wiring lives in session-stream.ts and its shared tool
    // surface resolver; these pins target the combined main-process source.
    assert.match(
      combinedMainProcess,
      /systemPrompt: async \(\{ cwd, emitSkillCatalogTrace \}\) => \{/,
    );
    assert.match(combinedMainProcess, /const base = await systemPromptService\.buildBackendSystemPrompt\([\s\S]*ctx\.header,[\s\S]*cwd,[\s\S]*childInstruction: ctx\.systemPrompt/);
    assert.match(combinedMainProcess, /async function buildBackendSystemPrompt/);
    assert.match(combinedMainProcess, /childInstruction[\s\S]*memoryFragment: null, includePersonalization: false/);
    assert.match(combinedMainProcess, /子代理必须继承当前会话的权限、隐私、工作区和技能约束/);
    assert.match(combinedMainProcess, /子代理不会隐式继承父会话的本地记忆或个性化上下文/);
    assert.match(combinedMainProcess, /<memory-update>/);
    assert.match(
      combinedMainProcess,
      /const unscopedCandidateTools = input\.tools\s+\? \[\.\.\.input\.tools\]\s+: deps\.isComputerUseRealModelE2e/,
    );
    assert.match(
      combinedMainProcess,
      /const candidateTools =\s+!input\.tools && isDeepResearchSession\(input\.header\.labels\)\s+\? unscopedCandidateTools\.filter\(isDeepResearchToolAllowed\)\s+: unscopedCandidateTools/,
    );
    assert.match(
      combinedMainProcess,
      /const planControlTools = input\.tools\s+\? \[\]\s+: collaborationMode === 'plan'/,
    );
  });
});
