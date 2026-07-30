import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';

describe('Desktop Graph Mode host contract', () => {
  it('uses the shared command parser and trusted one-turn override', async () => {
    const renderer = await readRendererShellSources(['app-shell.tsx', 'app-shell-chat-actions.ts']);
    assert.match(renderer, /parseGraphCommand\(text\)/);
    assert.match(renderer, /send\(graphCommand\.task, pending, \{/);
    assert.match(renderer, /turnOrchestration: \{ mode: 'graph', source: 'slash_command' \}/);
  });

  it('persists graph as the exclusive session orchestration mode', async () => {
    const renderer = await readRendererShellSources(['app-shell.tsx', 'app-shell-chat-actions.ts']);
    assert.match(renderer, /activeSessionForView\?\.orchestrationMode \?\? 'default'/);
    assert.match(renderer, /active \? 'graph' : 'default'/);
    assert.match(renderer, /newChatGraphModeActive[\s\S]*\? 'graph'/);
    assert.match(renderer, /if \(active\) setNewChatSwarmModeActive\(false\)/);
    assert.match(renderer, /if \(active\) setNewChatGraphModeActive\(false\)/);
  });

  it('renders the bounded graph read model and opens linked child Sessions', async () => {
    const panel = await readFile(
      fileURLToPath(new URL('../../../src/renderer/agent-graph-panel.tsx', import.meta.url)),
      'utf8',
    );
    const shell = await readRendererShellSources(['app-shell.tsx']);
    assert.match(panel, /\.getSnapshot\(props\.rootSessionId\)/);
    assert.match(panel, /window\.maka\.graphs\.subscribe\(props\.rootSessionId, refresh\)/);
    assert.match(panel, /subscribe\(props\.rootSessionId, refresh\);[\s\S]*refresh\(\)/);
    assert.match(panel, /refreshRef\.current = refresh/);
    assert.match(panel, /if \(refreshRef\.current === refresh\)/);
    assert.match(panel, /if \(!props\.enabled && !hasGraphActivity && !error\) return null/);
    assert.match(panel, /\{error \? \([\s\S]*copy\.loadFailed[\s\S]*refreshRef\.current\(\)/);
    assert.doesNotMatch(panel, /error && !snapshot/);
    assert.match(panel, /snapshot\.scheduleRevision > 0/);
    assert.match(panel, /window\.maka\.graphs\.stop\(props\.rootSessionId\)/);
    assert.match(panel, /props\.onOpenSession\(operator\.childSessionId\)/);
    assert.match(shell, /<AgentGraphPanel/);
    assert.match(shell, /activeId &&[\s\S]*activeSessionForView &&[\s\S]*!activeSessionForView\.subagentParent/);
  });

  it('keeps graph panel copy localized', async () => {
    const panel = await readFile(
      fileURLToPath(new URL('../../../src/renderer/agent-graph-panel.tsx', import.meta.url)),
      'utf8',
    );
    assert.match(panel, /正在读取 Graph 状态/);
    assert.match(panel, /Loading graph state/);
    assert.match(panel, /打开子会话/);
    assert.match(panel, /Open child session/);
    assert.match(panel, /可见 \$\{settled\}\/\$\{total\} 已结束/);
    assert.match(panel, /\$\{settled\}\/\$\{total\} visible settled/);
  });

  it('provides a host-owned Git worktree executor to linked child Sessions', async () => {
    const main = await readFile(
      fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url)),
      'utf8',
    );
    assert.match(main, /createGitWorktreeChildExecutor\(\{ storageRoot: workspaceRoot \}\)/);
    assert.match(main, /new SessionManager\(\{[\s\S]*worktreeChildExecutor,/);
  });
});
