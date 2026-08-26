/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSessionCopyCleanupAuthority } from '../session-copy-cleanup.js';
import type {
  ProcessLifetimeOwner,
  ProcessLifetimeRecoveryClaim,
} from '../process-lifetime-owner.js';

const roots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-copy-cleanup-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session copy cleanup authority', () => {
  it('forgets a known rejected creation without trying to resume or remove it', async () => {
    const workspaceRoot = await createWorkspace();
    let resumes = 0;
    let removals = 0;
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      resumeSessionCopy: async () => {
        resumes += 1;
      },
      removeSession: async () => {
        removals += 1;
      },
    });
    const creation = {
      sessionId: 'fork-rejected',
      kind: 'branch' as const,
      sourceSessionId: 'source-session',
      sourceTurnId: 'source-turn',
      intent: 'side_conversation' as const,
      ownerId: 'web-contents:1',
    };

    await assert.rejects(
      authority.ownCreation(creation, async () => {
        throw new Error('session busy');
      }),
      /session busy/,
    );
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-rejected']);

    await authority.rejectCreation('fork-rejected');

    assert.deepEqual(await readPendingIds(workspaceRoot), []);
    assert.equal(resumes, 0);
    assert.equal(removals, 0);
    assert.equal(await authority.ownCreation(creation, async () => 'retried'), 'retried');
  });

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
          intent: 'side_conversation',
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
        events.push(`resume:${creation.sessionId}:${creation.sourceTurnId}:${creation.intent}`);
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
      'resume:fork-unknown-create:source-turn:side_conversation',
      'remove:fork-unknown-create',
    ]);
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('does not recover a live copy whose owning process is still active', async () => {
    const workspaceRoot = await createWorkspace();
    const owner = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:101',
      removeSession: async () => {},
    });
    await owner.ownCreation(
      {
        sessionId: 'fork-live-owner',
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        ownerId: 'tui-side',
      },
      async () => 'created',
    );
    const removed: string[] = [];
    const concurrent = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:202',
      isOwnerProcessActive: (ownerProcessId) => ownerProcessId === 'tui:101',
      removeSession: async (sessionId) => {
        removed.push(sessionId);
      },
    });

    assert.deepEqual(await concurrent.recover(), { removed: [], failed: [] });
    assert.deepEqual(removed, []);
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-live-owner']);
  });

  it('claims one released process incarnation across all of its copies', async () => {
    const workspaceRoot = await createWorkspace();
    const original = fakeLifetimeOwner('lock-v1:11111111-1111-4111-8111-111111111111');
    const owner = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:101',
      processLifetimeOwner: original.owner,
      removeSession: async () => {},
    });
    for (const sessionId of ['fork-lifetime-a', 'fork-lifetime-b']) {
      await owner.ownCreation(
        {
          sessionId,
          kind: 'branch',
          sourceSessionId: 'source-session',
          sourceTurnId: 'source-turn',
          ownerId: 'tui-side',
        },
        async () => 'created',
      );
    }

    const successor = fakeLifetimeOwner('lock-v1:22222222-2222-4222-8222-222222222222');
    const removed: string[] = [];
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:202',
      processLifetimeOwner: successor.owner,
      removeSession: async (sessionId) => {
        assert.equal(successor.claimClosed, false);
        removed.push(sessionId);
      },
    });

    assert.deepEqual(await authority.recover(), {
      removed: ['fork-lifetime-a', 'fork-lifetime-b'],
      failed: [],
    });
    assert.deepEqual(removed, ['fork-lifetime-a', 'fork-lifetime-b']);
    assert.equal(successor.claimAttempts, 1);
    assert.equal(successor.claimRetired, true);
    assert.deepEqual(await readPendingIds(workspaceRoot), []);
  });

  it('holds the released owner claim while recovering a cleanup-phase copy', async () => {
    const workspaceRoot = await createWorkspace();
    const original = fakeLifetimeOwner('lock-v1:77777777-7777-4777-8777-777777777777');
    const owner = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:707',
      processLifetimeOwner: original.owner,
      removeSession: async () => {},
    });
    await owner.ownCreation(
      {
        sessionId: 'fork-cleanup-phase',
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        ownerId: 'tui-side',
      },
      async () => 'created',
    );
    updatePendingLease(workspaceRoot, 'fork-cleanup-phase', (record) => ({
      ...record,
      phase: 'cleanup',
      cancelRequested: true,
    }));

    const successor = fakeLifetimeOwner('lock-v1:88888888-8888-4888-8888-888888888888');
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:808',
      processLifetimeOwner: successor.owner,
      removeSession: async () => {
        assert.equal(successor.claimClosed, false);
      },
    });

    assert.deepEqual(await authority.recover(), {
      removed: ['fork-cleanup-phase'],
      failed: [],
    });
    assert.equal(successor.claimAttempts, 1);
    assert.equal(successor.claimRetired, true);
  });

  it('falls back to process liveness for an unsupported owner reference version', async () => {
    const workspaceRoot = await createWorkspace();
    const original = fakeLifetimeOwner('lock-v1:99999999-9999-4999-8999-999999999999');
    const owner = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:909',
      processLifetimeOwner: original.owner,
      removeSession: async () => {},
    });
    await owner.ownCreation(
      {
        sessionId: 'fork-future-owner',
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        ownerId: 'tui-side',
      },
      async () => 'created',
    );
    updatePendingLease(workspaceRoot, 'fork-future-owner', (record) => ({
      ...record,
      ownerLifetimeRef: 'lock-v2:future-owner',
    }));

    let claimAttempts = 0;
    const removed: string[] = [];
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:1001',
      processLifetimeOwner: {
        reference: 'lock-v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tryClaimReleased: async () => {
          claimAttempts += 1;
          throw new Error('unsupported owner reference must use the PID fallback');
        },
        retireUnreferencedReleasedOwners: async () => {},
        close: async () => {},
      },
      isOwnerProcessActive: () => false,
      removeSession: async (sessionId) => {
        removed.push(sessionId);
      },
    });

    assert.deepEqual(await authority.recover(), {
      removed: ['fork-future-owner'],
      failed: [],
    });
    assert.equal(claimAttempts, 0);
    assert.deepEqual(removed, ['fork-future-owner']);
  });

  it('asks the process owner to retire released files with no database references', async () => {
    const workspaceRoot = await createWorkspace();
    let referenced: ReadonlySet<string> | undefined;
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processLifetimeOwner: {
        reference: 'lock-v1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        tryClaimReleased: async () => undefined,
        retireUnreferencedReleasedOwners: async (current) => {
          referenced = current;
        },
        close: async () => {},
      },
      removeSession: async () => {},
    });

    assert.deepEqual(await authority.recover(), { removed: [], failed: [] });
    assert.ok(referenced);
    assert.deepEqual([...referenced], []);
  });

  it('fails closed when process-incarnation ownership cannot be inspected', async () => {
    const workspaceRoot = await createWorkspace();
    const original = fakeLifetimeOwner('lock-v1:33333333-3333-4333-8333-333333333333');
    const owner = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:303',
      processLifetimeOwner: original.owner,
      removeSession: async () => {},
    });
    await owner.ownCreation(
      {
        sessionId: 'fork-unknown-owner',
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        ownerId: 'tui-side',
      },
      async () => 'created',
    );

    const failure = new Error('native lock unavailable');
    const authority = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:404',
      processLifetimeOwner: {
        reference: 'lock-v1:44444444-4444-4444-8444-444444444444',
        tryClaimReleased: async () => {
          throw failure;
        },
        retireUnreferencedReleasedOwners: async () => {},
        close: async () => {},
      },
      removeSession: async () => {
        throw new Error('must not remove an indeterminate owner');
      },
    });

    const recovery = await authority.recover();
    assert.deepEqual(recovery.removed, []);
    assert.deepEqual(recovery.failed, [{ sessionId: 'fork-unknown-owner', error: failure }]);
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-unknown-owner']);
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

  it('abandons only copies owned by the current process incarnation', async () => {
    const workspaceRoot = await createWorkspace();
    const firstLifetime = fakeLifetimeOwner('lock-v1:55555555-5555-4555-8555-555555555555');
    const secondLifetime = fakeLifetimeOwner('lock-v1:66666666-6666-4666-8666-666666666666');
    const first = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:505',
      processLifetimeOwner: firstLifetime.owner,
      removeSession: async () => {},
    });
    const removed: string[] = [];
    const second = createSessionCopyCleanupAuthority({
      workspaceRoot,
      processId: 'tui:505',
      processLifetimeOwner: secondLifetime.owner,
      removeSession: async (sessionId) => {
        removed.push(sessionId);
      },
    });
    for (const [authority, sessionId] of [
      [first, 'fork-first-incarnation'],
      [second, 'fork-second-incarnation'],
    ] as const) {
      await authority.ownCreation(
        {
          sessionId,
          kind: 'branch',
          sourceSessionId: 'source-session',
          sourceTurnId: 'source-turn',
          ownerId: 'tui-side',
        },
        async () => 'created',
      );
    }

    await second.abandonOwner('tui-side');
    await second.cleanup('fork-second-incarnation');

    assert.deepEqual(removed, ['fork-second-incarnation']);
    assert.deepEqual(await readPendingIds(workspaceRoot), ['fork-first-incarnation']);
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

function updatePendingLease(
  workspaceRoot: string,
  sessionId: string,
  update: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const database = new DatabaseSync(join(workspaceRoot, 'runtime.sqlite'));
  try {
    const row = database
      .prepare(
        'SELECT record_json AS recordJson FROM workflow_quote_companion_cleanup WHERE session_id = ?',
      )
      .get(sessionId) as { recordJson: string } | undefined;
    assert.ok(row);
    database
      .prepare('UPDATE workflow_quote_companion_cleanup SET record_json = ? WHERE session_id = ?')
      .run(
        JSON.stringify(update(JSON.parse(row.recordJson) as Record<string, unknown>)),
        sessionId,
      );
  } finally {
    database.close();
  }
}

function fakeLifetimeOwner(reference: string): {
  owner: ProcessLifetimeOwner;
  readonly claimAttempts: number;
  readonly claimClosed: boolean;
  readonly claimRetired: boolean;
} {
  let claimAttempts = 0;
  let claimClosed = false;
  let claimRetired = false;
  const claim: ProcessLifetimeRecoveryClaim = {
    retire: async () => {
      claimRetired = true;
      claimClosed = true;
    },
    close: async () => {
      claimClosed = true;
    },
  };
  return {
    owner: {
      reference,
      tryClaimReleased: async () => {
        claimAttempts += 1;
        return claim;
      },
      retireUnreferencedReleasedOwners: async () => {},
      close: async () => {},
    },
    get claimAttempts() {
      return claimAttempts;
    },
    get claimClosed() {
      return claimClosed;
    },
    get claimRetired() {
      return claimRetired;
    },
  };
}
