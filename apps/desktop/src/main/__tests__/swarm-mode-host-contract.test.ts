import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';

describe('Desktop Swarm Mode host contract', () => {
  it('persists the session default through the validated IPC boundary', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readFile(
      fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url)),
      'utf8',
    );

    assert.match(main, /ipcMain\.handle\('sessions:setOrchestrationMode'/);
    assert.match(main, /if \(!isOrchestrationMode\(mode\)\)/);
    assert.match(main, /runtime\.setOrchestrationMode\(sessionId, mode\)/);
    assert.match(main, /const orchestrationMode = input\?\.orchestrationMode \?\? 'default'/);
    assert.ok(
      (main.match(/\s+orchestrationMode,\s/g) ?? []).length >= 2,
      'both fake and ai-sdk session creation must persist the selected orchestration mode',
    );
    assert.match(preload, /setOrchestrationMode\(sessionId: string, mode: OrchestrationMode\)/);
  });

  it('uses the shared parser and sends one-shot tasks as clean text plus trusted metadata', async () => {
    const renderer = await readRendererShellSources(['app-shell.tsx', 'app-shell-chat-actions.ts']);

    assert.match(renderer, /parseSwarmCommand\(text\)/);
    assert.match(renderer, /send\(swarmCommand\.task, pending, \{/);
    assert.match(renderer, /\.\.\.\(skillIds\.length > 0 \? \{ skillIds \} : \{\}\)/);
    assert.match(renderer, /turnOrchestration: \{ mode: 'swarm', source: 'slash_command' \}/);
    assert.match(renderer, /skillIds: \[\.\.\.skillIds\]/);
    assert.match(renderer, /turnOrchestration: options\.turnOrchestration/);
  });

  it('restores the effective switch from SessionSummary and seeds new sessions explicitly', async () => {
    const renderer = await readRendererShellSources(['app-shell.tsx', 'app-shell-chat-actions.ts']);

    assert.match(renderer, /activeSessionForView\?\.orchestrationMode \?\? 'default'/);
    assert.match(renderer, /newChatSwarmModeActive[\s\S]*\? 'swarm'[\s\S]*: 'default'/);
    assert.match(renderer, /orchestrationMode: newChatOrchestrationMode/);
  });
});
