import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createQuoteCompanionCleanupAuthority } from '../quote-companion-cleanup.js';

const roots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-quote-companion-cleanup-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('quote companion cleanup authority', () => {
  it('persists a failed removal and recovers it through a new authority instance', async () => {
    const workspaceRoot = await createWorkspace();
    const first = createQuoteCompanionCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        throw new Error('temporary removal failure');
      },
    });

    await assert.rejects(first.cleanup('fork-1'), /temporary removal failure/);
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-1']);

    const removed: string[] = [];
    const afterRestart = createQuoteCompanionCleanupAuthority({
      workspaceRoot,
      removeSession: async (sessionId) => {
        removed.push(sessionId);
      },
    });
    const recovery = await afterRestart.recover();

    assert.deepEqual(removed, ['fork-1']);
    assert.deepEqual(recovery, { removed: ['fork-1'], failed: [] });
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('clears the durable intent only after the complete removal succeeds', async () => {
    const workspaceRoot = await createWorkspace();
    let pendingDuringRemoval: string[] = [];
    const authority = createQuoteCompanionCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        pendingDuringRemoval = await readPendingIds(workspaceRoot);
      },
    });

    await authority.cleanup('fork-2');

    assert.deepEqual(pendingDuringRemoval, ['fork-2']);
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('continues recovering other companions when one removal still fails', async () => {
    const workspaceRoot = await createWorkspace();
    const seed = createQuoteCompanionCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        throw new Error('offline');
      },
    });
    await assert.rejects(seed.cleanup('fork-a'));
    await assert.rejects(seed.cleanup('fork-b'));

    const authority = createQuoteCompanionCleanupAuthority({
      workspaceRoot,
      removeSession: async (sessionId) => {
        if (sessionId === 'fork-a') throw new Error('still offline');
      },
    });
    const recovery = await authority.recover();

    assert.deepEqual(recovery.removed, ['fork-b']);
    assert.deepEqual(
      recovery.failed.map(({ sessionId }) => sessionId),
      ['fork-a'],
    );
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-a']);
  });
});

async function readPendingIds(workspaceRoot: string): Promise<string[]> {
  const raw = await readFile(join(workspaceRoot, 'quote-companion-cleanup.json'), 'utf8');
  return (JSON.parse(raw) as { pendingSessionIds: string[] }).pendingSessionIds;
}
