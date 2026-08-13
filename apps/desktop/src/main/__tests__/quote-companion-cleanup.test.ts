import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSessionCopyCleanupAuthority } from '../quote-companion-cleanup.js';

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
  it('releases a rejected creation lease so the same identity can retry', async () => {
    const workspaceRoot = await createWorkspace();
    let removalFails = true;
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        if (removalFails) throw new Error('temporary removal failure');
      },
    });
    await assert.rejects(authority.cleanup('fork-retry'), /temporary removal failure/);

    const creation = {
      sessionId: 'fork-retry',
      kind: 'branch' as const,
      sourceSessionId: 'source-session',
      sourceTurnId: 'source-turn',
      ownerId: 'web-contents:1',
    };
    await assert.rejects(
      authority.ownCreation(creation, async () => 'unreachable'),
      /scheduled for cleanup/,
    );

    removalFails = false;
    await authority.cleanup('fork-retry');
    assert.equal(await authority.ownCreation(creation, async () => 'created'), 'created');
  });

  it('orders cancellation after an in-flight copy reaches a known outcome', async () => {
    const workspaceRoot = await createWorkspace();
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const events: string[] = [];
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'process-current',
      resumeSessionCopy: async () => {
        events.push('resume');
      },
      removeSession: async () => {
        events.push('remove');
      },
    });
    const creation = authority.ownCreation(
      {
        sessionId: 'fork-racing-create',
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        ownerId: 'web-contents:1',
      },
      async () => {
        events.push('create');
        await creationGate;
        return 'created';
      },
    );

    await authority.schedule('fork-racing-create');
    assert.deepEqual(events, ['create']);
    releaseCreation();
    assert.equal(await creation, 'created');
    await authority.cleanup('fork-racing-create');

    assert.deepEqual(events, ['create', 'remove']);
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('resolves an unknown creating lease before removing it after restart', async () => {
    const workspaceRoot = await createWorkspace();
    const first = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'process-before-crash',
      removeSession: async () => {
        throw new Error('remove should belong to the successor');
      },
    });
    await assert.rejects(
      first.ownCreation(
        {
          sessionId: 'fork-unknown-create',
          kind: 'branch',
          sourceSessionId: 'source-session',
          sourceTurnId: 'source-turn',
          ownerId: 'web-contents:2',
        },
        async () => {
          throw new Error('response lost');
        },
      ),
      /response lost/,
    );

    const events: string[] = [];
    const successor = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'process-after-crash',
      resumeSessionCopy: async (creation) => {
        events.push(`resume:${creation.sessionId}:${creation.sourceTurnId}`);
      },
      removeSession: async (sessionId) => {
        events.push(`remove:${sessionId}`);
      },
    });

    assert.deepEqual(await successor.recover(), {
      removed: ['fork-unknown-create'],
      failed: [],
    });
    assert.deepEqual(events, [
      'resume:fork-unknown-create:source-turn',
      'remove:fork-unknown-create',
    ]);
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('abandons every live copy owned by a renderer that exits', async () => {
    const workspaceRoot = await createWorkspace();
    const removed: string[] = [];
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'process-current',
      removeSession: async (sessionId) => {
        removed.push(sessionId);
      },
    });
    await authority.ownCreation(
      {
        sessionId: 'fork-owned-renderer',
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        ownerId: 'web-contents:7',
      },
      async () => 'created',
    );

    await authority.abandonOwner('web-contents:7');
    await authority.cleanup('fork-owned-renderer');

    assert.deepEqual(removed, ['fork-owned-renderer']);
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('acknowledges abandon after the intent is durable without waiting for removal', async () => {
    const workspaceRoot = await createWorkspace();
    let releaseRemoval: (() => void) | undefined;
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      removeSession: async () => removal,
    });

    await authority.schedule('fork-scheduled');
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-scheduled']);

    releaseRemoval?.();
    await authority.cleanup('fork-scheduled');
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });
  it('persists a failed removal and recovers it through a new authority instance', async () => {
    const workspaceRoot = await createWorkspace();
    const first = createSessionCopyCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        throw new Error('temporary removal failure');
      },
    });

    await assert.rejects(first.cleanup('fork-1'), /temporary removal failure/);
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-1']);

    const removed: string[] = [];
    const afterRestart = createSessionCopyCleanupAuthority({
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
    const authority = createSessionCopyCleanupAuthority({
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
    const seed = createSessionCopyCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        throw new Error('offline');
      },
    });
    await assert.rejects(seed.cleanup('fork-a'));
    await assert.rejects(seed.cleanup('fork-b'));

    const authority = createSessionCopyCleanupAuthority({
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

  it('forgets a terminal retained Revision without reporting deletion', async () => {
    const workspaceRoot = await createWorkspace();
    const seed = createSessionCopyCleanupAuthority({
      workspaceRoot,
      removeSession: async () => {
        throw new Error('offline');
      },
    });
    await assert.rejects(seed.cleanup('retained-revision'));

    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      removeSession: async () => 'retained',
    });
    assert.deepEqual(await authority.recover(), { removed: [], failed: [] });
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });
});

async function readPendingIds(workspaceRoot: string): Promise<string[]> {
  const database = new DatabaseSync(join(workspaceRoot, 'runtime.sqlite'), { readOnly: true });
  try {
    return (
      database
        .prepare(`
          SELECT session_id AS sessionId
          FROM workflow_quote_companion_cleanup
          ORDER BY tracked_at, session_id
        `)
        .all() as Array<{ sessionId: string }>
    ).map(({ sessionId }) => sessionId);
  } finally {
    database.close();
  }
}
