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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  WORKSPACE_AUTHORITY_SESSION_ID,
  buildWorkspaceBaselineAuthorityEvents,
  workspaceAuthorityIdentity,
  type WorkspaceBaselineAuthorityInput,
} from '@maka/core/workspace-version-authority';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createConversationOperationalStateStore } from '../conversation-operational-state.js';
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';
import {
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
} from '../workspace-version-authority-internal.js';

const TEST_STORAGE_ROOT_ID = 'a'.repeat(64);

describe('workspace version persistence authority', () => {
  it('does not expose the unverified baseline writer on the public SQLite store', () => {
    const store = createSqliteRuntimeStore(':memory:');
    try {
      // @ts-expect-error Raw baseline authority is an internal persistence seam.
      assert.equal(store.commitWorkspaceBaseline, undefined);
    } finally {
      store.close();
    }
  });

  it('cannot be purged through the ordinary conversation lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workspace-authority-purge-'));
    const store = createConversationOperationalStateStore(root);
    try {
      await assert.rejects(
        store.purge(WORKSPACE_AUTHORITY_SESSION_ID),
        /cannot be purged as a conversation/i,
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads canonical facts and projections from one SQLite snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workspace-authority-snapshot-'));
    const dbPath = join(root, 'runtime.sqlite');
    const input = baselineInput();
    const writer = createSqliteRuntimeStore(dbPath);
    bindWorkspaceBaselineAuthorityStoreRootInternal(writer, TEST_STORAGE_ROOT_ID);
    let writePromise: ReturnType<typeof commitWorkspaceBaselineInternal> | undefined;
    let injected = false;
    const reader = createSqliteRuntimeStore(dbPath, {
      failpoint: (point) => {
        if (point !== 'after_workspace_canonical_scan' || injected) return;
        injected = true;
        writePromise = commitWorkspaceBaselineInternal(writer, input);
      },
    });
    try {
      assert.equal(
        await reader.readWorkspaceHead(input.epoch.workspaceId, input.epoch.workspaceEpochId),
        undefined,
      );
      assert.ok(writePromise);
      await writePromise;
      assert.equal(
        (await reader.readWorkspaceHead(input.epoch.workspaceId, input.epoch.workspaceEpochId))
          ?.workspaceVersionId,
        input.baseline.workspaceVersionId,
      );
    } finally {
      reader.close();
      writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically opens a baseline and makes only an exact retry idempotent', async () => {
    await withDatabase(async ({ dbPath, store }) => {
      const input = baselineInput();
      const first = await commitWorkspaceBaselineInternal(store, input);
      assert.equal(first.created, true);
      assert.equal(first.head.workspaceVersionId, input.baseline.workspaceVersionId);
      assert.equal(first.head.revision, 1);

      assert.equal(
        (await store.readWorkspaceEpoch(input.epoch.workspaceId, input.epoch.workspaceEpochId))
          ?.initialWorkspaceVersionId,
        input.baseline.workspaceVersionId,
      );
      assert.equal(
        (await store.readWorkspaceVersion(input.baseline.workspaceVersionId))?.origin.kind,
        'baseline',
      );
      assert.deepEqual(
        await store.readWorkspaceHead(input.epoch.workspaceId, input.epoch.workspaceEpochId),
        first.head,
      );

      const retry = await commitWorkspaceBaselineInternal(store, input);
      assert.deepEqual(retry, { ...first, created: false });

      const conflict = baselineInput({
        baselineAcceptedEventId: 'workspace-version-event-conflict',
        baseline: {
          ...input.baseline,
          workspaceVersionId: 'version_99999999999999999999999999999999',
          commitOid: '9'.repeat(40),
        },
      });
      await assert.rejects(
        commitWorkspaceBaselineInternal(store, conflict),
        /workspace baseline authority conflict/i,
      );

      const raw = new DatabaseSync(dbPath);
      try {
        assert.equal(count(raw, 'runtime_workspace_epochs'), 1);
        assert.equal(count(raw, 'runtime_workspace_versions'), 1);
        assert.equal(count(raw, 'runtime_workspace_heads'), 1);
        assert.equal(
          countWhere(raw, 'runtime_events', 'session_id = ?', WORKSPACE_AUTHORITY_SESSION_ID),
          2,
        );
      } finally {
        raw.close();
      }
    });
  });

  it('refuses to silently claim unbound workspace authority facts for another root', async () => {
    await withDatabase(async ({ dbPath, store }) => {
      await commitWorkspaceBaselineInternal(store, baselineInput());
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec('DELETE FROM runtime_storage_root_binding');
      } finally {
        raw.close();
      }
      await assert.rejects(
        commitWorkspaceBaselineInternal(store, baselineInput()),
        /durable storage-root binding changed/u,
      );
      assert.throws(
        () => bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'b'.repeat(64)),
        /require explicit storage-root adoption/u,
      );
    });
  });

  it('refuses to silently claim an unbound database with ordinary runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-unbound-operational-state-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const event: RuntimeEvent = {
        id: 'ordinary-existing-runtime-event',
        sessionId: 'session-existing',
        invocationId: 'invocation-existing',
        runId: 'run-existing',
        turnId: 'turn-existing',
        ts: 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'existing root-owned state' },
      };
      await store.appendRuntimeEvent(event.sessionId, event.runId, event);
      assert.throws(
        () => bindWorkspaceBaselineAuthorityStoreRootInternal(store, TEST_STORAGE_ROOT_ID),
        /unbound operational data require explicit storage-root adoption/iu,
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const failpoint of [
    'after_workspace_epoch_event_insert',
    'after_workspace_version_event_insert',
    'after_workspace_epoch_projection_insert',
    'after_workspace_version_projection_insert',
    'after_workspace_head_projection_insert',
  ] satisfies SqliteRuntimeStoreFailpoint[]) {
    it(`rolls the entire baseline back at ${failpoint}`, async () => {
      await withDatabase(async ({ dbPath, store, setFailpoint }) => {
        setFailpoint(failpoint);
        await assert.rejects(commitWorkspaceBaselineInternal(store, baselineInput()), /failpoint/);
        store.close();

        const reopened = createSqliteRuntimeStore(dbPath);
        try {
          assert.equal(
            await reopened.readWorkspaceHead(
              baselineInput().epoch.workspaceId,
              baselineInput().epoch.workspaceEpochId,
            ),
            undefined,
          );
          assert.deepEqual(
            await reopened.readRuntimeEvents(
              WORKSPACE_AUTHORITY_SESSION_ID,
              workspaceAuthorityIdentity(baselineInput().epoch.workspaceEpochId).runId,
            ),
            [],
          );
        } finally {
          reopened.close();
        }
      });
    });
  }

  it('rebuilds disposable projections from strict RuntimeEvents and detects corruption', async () => {
    await withDatabase(async ({ dbPath, store }) => {
      const input = baselineInput();
      const committed = await commitWorkspaceBaselineInternal(store, input);
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec(`
          DELETE FROM runtime_workspace_heads;
          DELETE FROM runtime_workspace_versions;
          DELETE FROM runtime_workspace_epochs;
        `);
      } finally {
        raw.close();
      }

      await assert.rejects(
        store.readWorkspaceHead(input.epoch.workspaceId, input.epoch.workspaceEpochId),
        /projection is incomplete/i,
      );
      assert.deepEqual(await store.rebuildWorkspaceVersionProjections(), {
        epochs: 1,
        versions: 1,
        heads: 1,
      });
      assert.deepEqual(
        await store.readWorkspaceHead(input.epoch.workspaceId, input.epoch.workspaceEpochId),
        committed.head,
      );

      const corrupt = new DatabaseSync(dbPath);
      try {
        corrupt
          .prepare(`UPDATE runtime_events SET run_id = 'workspace_run_corrupt' WHERE event_id = ?`)
          .run(input.epochOpenedEventId);
      } finally {
        corrupt.close();
      }
      await assert.rejects(
        store.rebuildWorkspaceVersionProjections(),
        /row\/payload identity mismatch/i,
      );
      const afterFailedRebuild = new DatabaseSync(dbPath);
      try {
        const head = afterFailedRebuild
          .prepare(`
            SELECT workspace_version_id, accepted_event_id
            FROM runtime_workspace_heads
            WHERE workspace_id = ? AND workspace_epoch_id = ?
          `)
          .get(input.epoch.workspaceId, input.epoch.workspaceEpochId) as
          | { workspace_version_id: string; accepted_event_id: string }
          | undefined;
        assert.deepEqual(head && { ...head }, {
          workspace_version_id: committed.head.workspaceVersionId,
          accepted_event_id: committed.head.acceptedEventId,
        });
      } finally {
        afterFailedRebuild.close();
      }
    });
  });

  it('rejects workspace facts through generic RuntimeEvent writers', async () => {
    await withDatabase(async ({ store, root }) => {
      const { epochOpenedEvent } = buildWorkspaceBaselineAuthorityEvents(baselineInput());
      await assert.rejects(
        store.appendRuntimeEvent(
          epochOpenedEvent.sessionId,
          epochOpenedEvent.runId,
          epochOpenedEvent,
        ),
        /workspace version authority writer/i,
      );
      await assert.rejects(
        store.importRuntimeEventsBatch({
          sessionId: epochOpenedEvent.sessionId,
          runId: epochOpenedEvent.runId,
          events: [epochOpenedEvent],
        }),
        /workspace version authority writer/i,
      );
      await assert.rejects(
        store.importConversationCopyRuntimeEvents(epochOpenedEvent.sessionId, [
          { runId: epochOpenedEvent.runId, events: [epochOpenedEvent] },
        ]),
        /workspace version authority writer/i,
      );

      const args = { path: 'notes.txt' };
      const argsHash = canonicalToolArgsHash('Read', args);
      const boundFact = epochOpenedEvent.actions!.workspaceFact!;
      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'workspace-bypass-operation',
          journalEventId: 'workspace-bypass-prepared',
          runtimeEvent: {
            id: 'workspace-bypass-call',
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            runId: 'run-1',
            turnId: 'turn-1',
            ts: 1,
            partial: false,
            role: 'model',
            author: 'agent',
            content: { kind: 'function_call', id: 'call-1', name: 'Read', args },
            actions: { workspaceFact: boundFact },
            refs: { operationId: 'workspace-bypass-operation', toolCallId: 'call-1' },
          },
          dispatchRuntimeEvent: {
            id: 'workspace-bypass-dispatch',
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            runId: 'run-1',
            turnId: 'turn-1',
            ts: 1,
            partial: false,
            role: 'system',
            author: 'system',
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'workspace-bypass-operation',
                providerToolCallId: 'call-1',
                toolName: 'Read',
                canonicalArgsHash: argsHash,
                recoveryMode: 'replay_safe',
              },
            },
            refs: { operationId: 'workspace-bypass-operation', toolCallId: 'call-1' },
          },
          providerToolCallId: 'call-1',
          toolName: 'Read',
          canonicalArgsHash: argsHash,
          recoveryMode: 'replay_safe',
          committedAt: 1,
        }),
        /workspace version authority writer/i,
      );
      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'workspace-bypass-operation',
          journalEventId: 'workspace-bypass-outcome',
          committedAt: 2,
          runtimeEvent: {
            id: 'workspace-bypass-response',
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            runId: 'run-1',
            turnId: 'turn-1',
            ts: 2,
            partial: false,
            role: 'tool',
            author: 'tool',
            content: { kind: 'function_response', id: 'call-1', name: 'Read', result: 'ok' },
            actions: { workspaceFact: boundFact },
            refs: { operationId: 'workspace-bypass-operation', toolCallId: 'call-1' },
          },
        }),
        /workspace version authority writer/i,
      );
      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'workspace-bypass-operation',
          reconcileRuntimeEvent: epochOpenedEvent,
          decisionRuntimeEvent: {
            ...epochOpenedEvent,
            id: 'workspace-bypass-decision',
          },
        }),
        /workspace version authority writer/i,
      );
    });
  });

  it('rejects ordinary RuntimeEvents that try to occupy the authority stream', async () => {
    await withDatabase(async ({ store }) => {
      const input = baselineInput();
      const identity = workspaceAuthorityIdentity(input.epoch.workspaceEpochId);
      const ordinary: RuntimeEvent = {
        id: 'ordinary-authority-event',
        ...identity,
        ts: input.committedAt,
        partial: false,
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'not an authority fact' },
      };
      await assert.rejects(
        store.appendRuntimeEvent(ordinary.sessionId, ordinary.runId, ordinary),
        /reserved workspace authority stream/i,
      );
    });
  });

  it('fails closed when the workspace authority capability is missing or unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workspace-capability-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = createSqliteRuntimeStore(dbPath);
    store.close();
    try {
      for (const version of [undefined, 2] as const) {
        const raw = new DatabaseSync(dbPath);
        try {
          raw
            .prepare(`
              DELETE FROM runtime_capabilities
              WHERE capability = 'runtime_workspace_version_authority'
            `)
            .run();
          if (version !== undefined) {
            raw
              .prepare(`
                INSERT INTO runtime_capabilities(capability, version)
                VALUES ('runtime_workspace_version_authority', ?)
              `)
              .run(version);
          }
        } finally {
          raw.close();
        }
        assert.throws(
          () => createSqliteRuntimeStore(dbPath),
          /runtime_workspace_version_authority@1 is unavailable/,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withDatabase(
  run: (input: {
    root: string;
    dbPath: string;
    store: ReturnType<typeof createSqliteRuntimeStore>;
    setFailpoint: (failpoint: SqliteRuntimeStoreFailpoint | undefined) => void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-workspace-authority-'));
  const dbPath = join(root, 'runtime.sqlite');
  let activeFailpoint: SqliteRuntimeStoreFailpoint | undefined;
  const store = createSqliteRuntimeStore(dbPath, {
    failpoint(point) {
      if (point === activeFailpoint) throw new Error(`failpoint:${point}`);
    },
  });
  bindWorkspaceBaselineAuthorityStoreRootInternal(store, TEST_STORAGE_ROOT_ID);
  try {
    await run({
      root,
      dbPath,
      store,
      setFailpoint(value) {
        activeFailpoint = value;
      },
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function baselineInput(
  overrides: Partial<WorkspaceBaselineAuthorityInput> = {},
): WorkspaceBaselineAuthorityInput {
  const base: WorkspaceBaselineAuthorityInput = {
    epochOpenedEventId: 'workspace-epoch-event-1',
    baselineAcceptedEventId: 'workspace-version-event-1',
    committedAt: 1_700_000_000_000,
    epoch: {
      repositoryId: 'repository_11111111111111111111111111111111',
      workspaceId: 'workspace_22222222222222222222222222222222',
      workspaceEpochId: 'epoch_33333333333333333333333333333333',
      workspaceInstanceId: 'instance_44444444444444444444444444444444',
      mode: 'managed_worktree',
      objectFormat: 'sha1',
      sourceCommitOid: '1'.repeat(40),
      sourceTreeOid: '2'.repeat(40),
      materializationProfileDigest: `sha256:${'3'.repeat(64)}`,
      materializationSemantics: 'git_tree_materialized_with_fixed_config_v1',
      policyHash: `sha256:${'4'.repeat(64)}`,
    },
    baseline: {
      workspaceVersionId: 'version_55555555555555555555555555555555',
      commitOid: '5'.repeat(40),
      treeOid: '2'.repeat(40),
      treeDeltaDigest: `sha256:${'6'.repeat(64)}`,
      changedFileCount: 7,
      deletedFileCount: 0,
    },
  };
  return {
    ...base,
    ...overrides,
    epoch: overrides.epoch ?? base.epoch,
    baseline: overrides.baseline ?? base.baseline,
  };
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function countWhere(db: DatabaseSync, table: string, where: string, value: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(value) as {
      count: number;
    }
  ).count;
}
