import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemPromptMainService } from '../system-prompt-main.js';

// Entry-level prompt-order contract tests (#2352 review). Several fragments are
// position-semantic: a Side Chat isolation boundary is a trailing assertion
// that constrains everything before it, so it must remain last. The identity
// fragment must lead. These tests pin that order so a future "unify the order"
// refactor cannot silently weaken the boundary.
async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-order-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('desktop system prompt order', () => {
  it('leads with the product identity', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const service = createSystemPromptMainService({
        settingsStore: {
          get: async () => ({ personalization: {}, workspaceInstructions: { enabled: false } }) as never,
        },
        workspaceRoot,
        localMemory: {
          getState: async () => ({ status: 'ok', agentReadEnabled: false, content: '' }) as never,
          consumePendingPromptUpdates: () => [],
        },
        taskLedger: { list: async () => [] },
      });
      const out = await service.buildBackendSystemPrompt({ labels: [] }, workspaceRoot, {
        memoryFragment: null,
      });
      assert.ok(out);
      assert.match(out, /^You are Maka,/);
    });
  });

  it('keeps the Side Chat isolation boundary last, after skills and AGENTS.md', async () => {
    await withWorkspace(async (workspaceRoot) => {
      // Seed an AGENTS.md so the workspace-instructions fragment is present and
      // the test proves the boundary lands after it (not before).
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(join(workspaceRoot, 'AGENTS.md'), '- secret project rule');
      const service = createSystemPromptMainService({
        settingsStore: {
          get: async () =>
            ({ personalization: {}, workspaceInstructions: { enabled: true } }) as never,
        },
        workspaceRoot,
        localMemory: {
          getState: async () => ({ status: 'ok', agentReadEnabled: false, content: '' }) as never,
          consumePendingPromptUpdates: () => [],
        },
        taskLedger: { list: async () => [] },
      });
      const out = await service.buildBackendSystemPrompt(
        { labels: ['mode:side_conversation'] },
        workspaceRoot,
        { memoryFragment: null },
      );
      assert.ok(out);
      assert.match(out, /Side conversation boundary:/);
      assert.match(out, /<workspace-instructions/);
      // The boundary is the trailing assertion: it must come AFTER the workspace
      // instructions block. Verify by index.
      const boundaryIndex = out.indexOf('Side conversation boundary:');
      const instructionsIndex = out.indexOf('<workspace-instructions');
      assert.ok(boundaryIndex > instructionsIndex, 'Side Chat boundary must follow AGENTS.md');
      // And the boundary must be the LAST non-empty fragment.
      const tail = out.slice(boundaryIndex).trim();
      assert.ok(tail.startsWith('Side conversation boundary:'));
      assert.ok(!/<workspace-instructions/.test(tail), 'nothing may follow the boundary');
    });
  });

  it('does not inject the identity into a child-instruction prompt', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const service = createSystemPromptMainService({
        settingsStore: {
          get: async () => ({ personalization: {}, workspaceInstructions: { enabled: false } }) as never,
        },
        workspaceRoot,
        localMemory: {
          getState: async () => ({ status: 'ok', agentReadEnabled: false, content: '' }) as never,
          consumePendingPromptUpdates: () => [],
        },
        taskLedger: { list: async () => [] },
      });
      const out = await service.buildBackendSystemPrompt({ labels: [] }, workspaceRoot, {
        memoryFragment: null,
        childInstruction: 'You are a foreground local-read child agent.',
      });
      assert.ok(out);
      assert.doesNotMatch(out, /^You are Maka,/);
    });
  });
});
