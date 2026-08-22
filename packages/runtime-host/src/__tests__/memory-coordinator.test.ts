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
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parseLocalMemoryMarkdown } from '@maka/core/local-memory';
import { openInteractiveMemoryBundleStoreForWrite } from '@maka/storage/memory-bundle-store';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  decodeHostFrame,
  MemoryMutateInput,
  MemoryMutateResult,
  MemoryQueryInput,
  MemoryQueryResult,
} from '../protocol/index.js';
import { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

describe('Host Memory coordinator', () => {
  test('initializes only when current policy permits Memory access', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, policyStores, context }) => {
      await setIncognito(policyStores, true);
      await coordinator.recover();
      assert.equal((await memoryStore.read()).memory.kind, 'missing');
      assert.deepEqual(await query(coordinator, { kind: 'state' }, context), {
        kind: 'blocked',
        reason: 'incognito_active',
      });

      await setIncognito(policyStores, false);
      await setMemoryPolicy(policyStores, false, false);
      await coordinator.refreshAfterPolicyMutation();
      assert.equal((await memoryStore.read()).memory.kind, 'missing');
      assert.deepEqual(await query(coordinator, { kind: 'state' }, context), {
        kind: 'blocked',
        reason: 'disabled',
      });

      await setMemoryPolicy(policyStores, true, false);
      await coordinator.refreshAfterPolicyMutation();
      const initialized = await memoryStore.read();
      assert.equal(initialized.memory.kind, 'document');
      assert.equal(initialized.pending.kind, 'missing');
    });
  });

  test('preserves session ownership through semantic proposal approval and prompt projection', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, policyStores, context }) => {
      await setMemoryPolicy(policyStores, true, true);
      await coordinator.recover();
      const initial = await state(coordinator, context);

      const workspace = await mutate(
        coordinator,
        {
          kind: 'remember',
          expectedRevision: initial.revision,
          title: 'Workspace preference sk-ant-api03-title123456789abcdef',
          content: 'Use concise answers.',
          scope: { kind: 'workspace' },
        },
        context,
      );
      const redacted = await memoryStore.read();
      assert.equal(redacted.memory.kind, 'document');
      if (redacted.memory.kind === 'document') {
        assert.doesNotMatch(
          new TextDecoder().decode(redacted.memory.bytes),
          /sk-ant-api03-title123456789abcdef/,
        );
      }
      const sessionA = await mutate(
        coordinator,
        {
          kind: 'remember',
          expectedRevision: mutationRevision(workspace),
          title: 'Session A preference',
          content: 'Prefer examples for session A.',
          scope: { kind: 'session', sessionId: 'session-a' },
        },
        context,
      );
      const sessionB = await mutate(
        coordinator,
        {
          kind: 'remember',
          expectedRevision: mutationRevision(sessionA),
          title: 'Session B preference',
          content: 'Prefer tables for session B.',
          scope: { kind: 'session', sessionId: 'session-b' },
        },
        context,
      );

      const promptA = await coordinator.readPromptProjection(
        'session-a',
        await policyStores.runtimePolicy.getSnapshot(),
      );
      assert.match(promptA.body ?? '', /Workspace preference/);
      assert.match(promptA.body ?? '', /Session A preference/);
      assert.doesNotMatch(promptA.body ?? '', /Session B preference/);

      const proposed = await mutate(
        coordinator,
        {
          kind: 'propose',
          expectedRevision: mutationRevision(sessionB),
          title: 'Reviewed preference',
          content: 'Keep the reviewed preference session-local.',
          scope: { kind: 'session', sessionId: 'session-a' },
          sourceTurnId: 'turn-1',
        },
        context,
      );
      const proposals = await query(
        coordinator,
        { kind: 'entries_start', view: 'proposals' },
        context,
      );
      assert.equal(proposals.kind, 'entries_page');
      if (proposals.kind !== 'entries_page') return;
      assert.equal(proposals.items.length, 1);
      assert.equal(proposals.items[0]?.sessionId, 'session-a');
      const proposalId = proposals.items[0]?.proposalId;
      assert.ok(proposalId);
      if (!proposalId) return;

      const approved = await mutate(
        coordinator,
        {
          kind: 'approve',
          expectedRevision: mutationRevision(proposed),
          proposalId,
        },
        context,
      );
      assert.equal(approved.kind, 'committed');
      const snapshot = await memoryStore.read();
      assert.equal(snapshot.memory.kind, 'document');
      assert.equal(snapshot.pending.kind, 'document');
      if (snapshot.memory.kind !== 'document' || snapshot.pending.kind !== 'document') return;
      const memory = parseLocalMemoryMarkdown(new TextDecoder().decode(snapshot.memory.bytes));
      const pending = parseLocalMemoryMarkdown(new TextDecoder().decode(snapshot.pending.bytes));
      const approvedEntry = memory.entries.find((entry) => entry.proposalId === proposalId);
      assert.equal(approvedEntry?.scope, 'session');
      assert.equal(approvedEntry?.sessionId, 'session-a');
      assert.equal(
        pending.entries.some((entry) => entry.proposalId === proposalId),
        false,
      );

      const stale = await mutate(
        coordinator,
        {
          kind: 'remember',
          expectedRevision: initial.revision,
          title: 'Stale write',
          content: 'Must not overwrite current Memory.',
          scope: { kind: 'workspace' },
        },
        context,
      );
      assert.equal(stale.kind, 'revision_conflict');
    });
  });

  test('accepts bounded idempotent raw chunks, binds uploads to one connection, and redacts before commit', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const content = [
        '# Maka Memory',
        '',
        '## Large preference',
        '<!-- maka-memory: id=large status=active scope=workspace -->',
        'a'.repeat(40_000),
        'Authorization: Bearer sk-live-secret-token-value',
        '',
      ].join('\n');
      const bytes = Buffer.from(content);
      const opened = await mutate(
        coordinator,
        {
          kind: 'replace_begin',
          expectedRevision: initial.revision,
          totalBytes: bytes.byteLength,
          contentSha256: revision(bytes),
        },
        context,
      );
      assert.equal(opened.kind, 'upload_opened');
      if (opened.kind !== 'upload_opened') return;

      const first = bytes.subarray(0, 32 * 1024);
      const second = bytes.subarray(first.byteLength);
      const otherConnection = { ...context, connectionId: 'connection-2' };
      assert.deepEqual(
        await mutate(
          coordinator,
          {
            kind: 'replace_chunk',
            uploadId: opened.uploadId,
            offset: 0,
            chunkBase64: first.toString('base64'),
          },
          otherConnection,
        ),
        { kind: 'rejected', reason: 'upload_not_found' },
      );

      const firstAccepted = await mutate(
        coordinator,
        {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: 0,
          chunkBase64: first.toString('base64'),
        },
        context,
      );
      const duplicate = await mutate(
        coordinator,
        {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: 0,
          chunkBase64: first.toString('base64'),
        },
        context,
      );
      assert.deepEqual(duplicate, firstAccepted);
      assert.deepEqual(
        await mutate(
          coordinator,
          {
            kind: 'replace_chunk',
            uploadId: opened.uploadId,
            offset: 1,
            chunkBase64: Buffer.from('different').toString('base64'),
          },
          context,
        ),
        { kind: 'rejected', reason: 'upload_conflict' },
      );
      await mutate(
        coordinator,
        {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: first.byteLength,
          chunkBase64: second.toString('base64'),
        },
        context,
      );
      const committed = await mutate(
        coordinator,
        { kind: 'replace_commit', uploadId: opened.uploadId },
        context,
      );
      assert.equal(committed.kind, 'committed');

      const snapshot = await memoryStore.read();
      assert.equal(snapshot.memory.kind, 'document');
      if (snapshot.memory.kind !== 'document') return;
      const stored = new TextDecoder().decode(snapshot.memory.bytes);
      assert.match(stored, /Authorization: Bearer \[redacted\]/);
      assert.doesNotMatch(stored, /sk-live-secret-token-value/);
    });
  });

  test('bounds externally edited entry metadata into a valid Client projection', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, context }) => {
      await coordinator.recover();
      const initial = await memoryStore.read();
      const title = '界'.repeat(300);
      const tag = '标'.repeat(32);
      await memoryStore.commit({
        expectedRevision: initial.revision,
        memory: Buffer.from(
          [
            '# Maka Memory',
            '',
            `## ${title}`,
            `<!-- maka-memory: id=custom.id status=active scope=session sessionId=会话 createdAt=1.5 tags=${tag} -->`,
            'Externally edited content.',
            '',
          ].join('\n'),
        ),
        pending: null,
      });

      const projected = await query(
        coordinator,
        { kind: 'entries_start', view: 'active' },
        context,
      );
      assert.equal(projected.kind, 'entries_page');
      if (projected.kind !== 'entries_page') return;
      const entry = projected.items[0];
      assert.equal(entry?.id, 'custom.id');
      assert.equal(entry?.sessionId, '会话');
      assert.equal(entry?.createdAt, undefined);
      assert.ok(Buffer.byteLength(entry?.title ?? '', 'utf8') <= 512);
      assert.ok(Buffer.byteLength(entry?.tags[0] ?? '', 'utf8') <= 64);
      assert.doesNotThrow(() =>
        decodeHostFrame({
          requestId: 'external-entry',
          operation: 'memory.query',
          ok: true,
          result: projected,
        }),
      );
    });
  });

  test('projects backup candidates and restores the selected Memory document', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const remembered = await mutate(
        coordinator,
        {
          kind: 'remember',
          expectedRevision: initial.revision,
          title: 'Recoverable preference',
          content: 'Keep this preference after backup restoration.',
          scope: { kind: 'workspace' },
        },
        context,
      );
      const reset = await mutate(
        coordinator,
        {
          kind: 'reset',
          expectedRevision: mutationRevision(remembered),
        },
        context,
      );
      const beforeRestore = await state(coordinator, context);
      assert.deepEqual(
        new Set(beforeRestore.backups.map((backup) => backup.kind)),
        new Set(['save', 'reset']),
      );
      const resetBackup = beforeRestore.backups.find((backup) => backup.kind === 'reset');
      assert.ok(resetBackup);

      const restored = await mutate(
        coordinator,
        {
          kind: 'restore_backup',
          expectedRevision: mutationRevision(reset),
          backupKind: 'reset',
          expectedBackupRevision: resetBackup.revision,
        },
        context,
      );
      assert.equal(restored.kind, 'committed');
      const snapshot = await memoryStore.read();
      assert.equal(snapshot.memory.kind, 'document');
      if (snapshot.memory.kind !== 'document') return;
      assert.match(new TextDecoder().decode(snapshot.memory.bytes), /Recoverable preference/);
      assert.deepEqual(
        new Set((await state(coordinator, context)).backups.map((backup) => backup.kind)),
        new Set(['save', 'reset', 'restore']),
      );
    });
  });

  test('reports a stale backup candidate without restoring replacement content', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const remembered = await mutate(
        coordinator,
        {
          kind: 'remember',
          expectedRevision: initial.revision,
          title: 'Current preference',
          content: 'Keep the current candidate.',
          scope: { kind: 'workspace' },
        },
        context,
      );
      assert.equal(remembered.kind, 'committed');

      const selectedState = await state(coordinator, context);
      const selected = selectedState.backups.find((backup) => backup.kind === 'save');
      assert.ok(selected);
      const snapshot = await memoryStore.read();
      assert.equal(snapshot.memory.kind, 'document');
      assert.notEqual(snapshot.pending.kind, 'safe_mode');
      if (snapshot.memory.kind !== 'document' || snapshot.pending.kind === 'safe_mode') return;
      const unchanged = await memoryStore.commit({
        expectedRevision: snapshot.revision,
        memory: snapshot.memory.bytes,
        pending: snapshot.pending.kind === 'document' ? snapshot.pending.bytes : null,
        backup: 'save',
      });
      assert.equal(unchanged.changed, false);

      const currentState = await state(coordinator, context);
      assert.equal(currentState.revision, selectedState.revision);
      const replacement = currentState.backups.find((backup) => backup.kind === 'save');
      assert.ok(replacement);
      assert.notEqual(replacement.revision, selected.revision);
      assert.deepEqual(
        await mutate(
          coordinator,
          {
            kind: 'restore_backup',
            expectedRevision: selectedState.revision,
            backupKind: 'save',
            expectedBackupRevision: selected.revision,
          },
          context,
        ),
        {
          kind: 'backup_revision_conflict',
          backupKind: 'save',
          expectedRevision: selected.revision,
          actualRevision: replacement.revision,
        },
      );
      assert.equal((await state(coordinator, context)).revision, selectedState.revision);
    });
  });

  test('resets a safe-mode Memory document while preserving a readable PENDING document', async () => {
    await withCoordinator(async ({ coordinator, root, context }) => {
      await coordinator.recover();
      const pending = '# Maka Pending Memory\n\n## Candidate\nKeep this proposal.\n';
      await writeFile(join(root, 'memory', 'MEMORY.md'), Buffer.from([0xff]));
      await writeFile(join(root, 'memory', 'PENDING.md'), pending);
      const damaged = await state(coordinator, context);
      assert.equal(damaged.status, 'safe_mode');

      const reset = await mutate(
        coordinator,
        { kind: 'reset', expectedRevision: damaged.revision },
        context,
      );
      assert.equal(reset.kind, 'committed');
      assert.equal((await state(coordinator, context)).status, 'ok');
      const preserved = await query(
        coordinator,
        { kind: 'document_start', document: 'pending' },
        context,
      );
      assert.equal(preserved.kind, 'document_page');
      if (preserved.kind === 'document_page') {
        assert.equal(Buffer.from(preserved.chunkBase64, 'base64').toString('utf8'), pending);
      }
    });
  });

  test('keeps an incomplete upload available for its owning Client to finish', async () => {
    await withCoordinator(async ({ coordinator, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const bytes = Buffer.from('# Maka Memory\n');
      const opened = await mutate(
        coordinator,
        {
          kind: 'replace_begin',
          expectedRevision: initial.revision,
          totalBytes: bytes.byteLength,
          contentSha256: revision(bytes),
        },
        context,
      );
      assert.equal(opened.kind, 'upload_opened');
      if (opened.kind !== 'upload_opened') return;

      await mutate(
        coordinator,
        {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: 0,
          chunkBase64: bytes.subarray(0, 4).toString('base64'),
        },
        context,
      );
      assert.deepEqual(
        await mutate(coordinator, { kind: 'replace_commit', uploadId: opened.uploadId }, context),
        { kind: 'rejected', reason: 'upload_incomplete' },
      );
      await mutate(
        coordinator,
        {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: 4,
          chunkBase64: bytes.subarray(4).toString('base64'),
        },
        context,
      );
      assert.equal(
        (await mutate(coordinator, { kind: 'replace_commit', uploadId: opened.uploadId }, context))
          .kind,
        'committed',
      );
    });
  });

  test('bounds aggregate staged upload capacity and reclaims it on abort', async () => {
    await withCoordinator(async ({ coordinator, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const uploadIds: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const opened = await mutate(
          coordinator,
          {
            kind: 'replace_begin',
            expectedRevision: initial.revision,
            totalBytes: 128 * 1024,
            contentSha256: revision(Buffer.alloc(0)),
          },
          context,
        );
        assert.equal(opened.kind, 'upload_opened');
        if (opened.kind === 'upload_opened') uploadIds.push(opened.uploadId);
      }
      assert.deepEqual(
        await mutate(
          coordinator,
          {
            kind: 'replace_begin',
            expectedRevision: initial.revision,
            totalBytes: 1,
            contentSha256: revision(Buffer.alloc(0)),
          },
          context,
        ),
        { kind: 'rejected', reason: 'upload_conflict' },
      );

      await mutate(coordinator, { kind: 'replace_abort', uploadId: uploadIds[0]! }, context);
      assert.equal(
        (
          await mutate(
            coordinator,
            {
              kind: 'replace_begin',
              expectedRevision: initial.revision,
              totalBytes: 1,
              contentSha256: revision(Buffer.alloc(0)),
            },
            context,
          )
        ).kind,
        'upload_opened',
      );
    });
  });

  test('drops staged uploads when Memory policy access changes', async () => {
    await withCoordinator(async ({ coordinator, policyStores, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const opened = await mutate(
        coordinator,
        {
          kind: 'replace_begin',
          expectedRevision: initial.revision,
          totalBytes: 4,
          contentSha256: revision(Buffer.from('test')),
        },
        context,
      );
      assert.equal(opened.kind, 'upload_opened');
      if (opened.kind !== 'upload_opened') return;

      await setIncognito(policyStores, true);
      await coordinator.refreshAfterPolicyMutation();
      await setIncognito(policyStores, false);
      await coordinator.refreshAfterPolicyMutation();

      assert.deepEqual(
        await mutate(
          coordinator,
          {
            kind: 'replace_chunk',
            uploadId: opened.uploadId,
            offset: 0,
            chunkBase64: Buffer.from('test').toString('base64'),
          },
          context,
        ),
        { kind: 'rejected', reason: 'upload_not_found' },
      );
    });
  });

  test('drain rejects new work and drops incomplete uploads', async () => {
    await withCoordinator(async ({ coordinator, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const opened = await mutate(
        coordinator,
        {
          kind: 'replace_begin',
          expectedRevision: initial.revision,
          totalBytes: 4,
          contentSha256: revision(Buffer.from('test')),
        },
        context,
      );
      assert.equal(opened.kind, 'upload_opened');
      coordinator.beginDrain();
      const outcome = await coordinator.handlers['memory.query']({ kind: 'state' }, context);
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      });
      await coordinator.close();
    });
  });

  test('drain preserves staged uploads until already accepted mutations settle', async () => {
    await withCoordinator(async ({ coordinator, memoryStore, activation, context }) => {
      await coordinator.recover();
      const initial = await state(coordinator, context);
      const bytes = Buffer.from('# Maka Memory\n\n## Accepted replacement\nCommit during drain.\n');
      const opened = await mutate(
        coordinator,
        {
          kind: 'replace_begin',
          expectedRevision: initial.revision,
          totalBytes: bytes.byteLength,
          contentSha256: revision(bytes),
        },
        context,
      );
      assert.equal(opened.kind, 'upload_opened');
      if (opened.kind !== 'upload_opened') return;
      await mutate(
        coordinator,
        {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: 0,
          chunkBase64: bytes.toString('base64'),
        },
        context,
      );

      const blockerEntered = deferred<void>();
      const releaseBlocker = deferred<void>();
      const blocker = activation.runMutation(async () => {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      });
      await blockerEntered.promise;
      const acceptedCommit = mutate(
        coordinator,
        { kind: 'replace_commit', uploadId: opened.uploadId },
        context,
      );

      coordinator.beginDrain();
      assert.deepEqual(await coordinator.handlers['memory.query']({ kind: 'state' }, context), {
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      });
      releaseBlocker.resolve();
      await blocker;
      assert.equal((await acceptedCommit).kind, 'committed');
      await coordinator.close();

      const snapshot = await memoryStore.read();
      assert.equal(snapshot.memory.kind, 'document');
      if (snapshot.memory.kind === 'document') {
        assert.deepEqual(Buffer.from(snapshot.memory.bytes), bytes);
      }
    });
  });
});

type PolicyStores = Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;

async function withCoordinator(
  run: (input: {
    coordinator: HostMemoryCoordinator;
    memoryStore: Awaited<ReturnType<typeof openInteractiveMemoryBundleStoreForWrite>>;
    policyStores: PolicyStores;
    activation: RuntimePolicyActivationGate;
    root: string;
    context: ConnectionContext;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-memory-coordinator-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let uploadSequence = 0;
  const context: ConnectionContext = {
    hostEpoch: 'memory-test-epoch',
    connectionId: 'connection-1',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
  try {
    const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const memoryStore = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
    const activation = new RuntimePolicyActivationGate();
    const coordinator = new HostMemoryCoordinator({
      store: memoryStore,
      runtimePolicyStores: policyStores,
      activation,
      newId: () => `upload-${++uploadSequence}`,
      now: () => 1_700_000_000_000 + uploadSequence,
    });
    await run({ coordinator, memoryStore, policyStores, activation, root, context });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function query(
  coordinator: HostMemoryCoordinator,
  input: MemoryQueryInput,
  context: ConnectionContext,
): Promise<MemoryQueryResult> {
  const outcome = await coordinator.handlers['memory.query'](input, context);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.result;
}

async function state(
  coordinator: HostMemoryCoordinator,
  context: ConnectionContext,
): Promise<Extract<MemoryQueryResult, { kind: 'state' }>> {
  const result = await query(coordinator, { kind: 'state' }, context);
  if (result.kind !== 'state') throw new Error('Expected Memory state');
  return result;
}

async function mutate(
  coordinator: HostMemoryCoordinator,
  input: MemoryMutateInput,
  context: ConnectionContext,
): Promise<MemoryMutateResult> {
  const outcome = await coordinator.handlers['memory.mutate'](input, context);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.result;
}

function mutationRevision(result: MemoryMutateResult) {
  assert.ok(result.kind === 'committed' || result.kind === 'unchanged');
  if (result.kind !== 'committed' && result.kind !== 'unchanged') {
    throw new Error(`Expected committed mutation, received ${result.kind}`);
  }
  return result.revision;
}

async function setMemoryPolicy(
  stores: PolicyStores,
  enabled: boolean,
  agentReadEnabled: boolean,
): Promise<void> {
  const current = await stores.runtimePolicy.getSnapshot();
  const result = await stores.runtimePolicy.mutate({
    expectedRevision: current.revision,
    operation: { kind: 'set_memory', value: { enabled, agentReadEnabled } },
  });
  assert.equal(result.kind, 'committed');
}

async function setIncognito(stores: PolicyStores, incognitoActive: boolean): Promise<void> {
  const current = await stores.runtimePolicy.getSnapshot();
  const result = await stores.runtimePolicy.mutate({
    expectedRevision: current.revision,
    operation: { kind: 'set_privacy', value: { incognitoActive } },
  });
  assert.equal(result.kind, 'committed');
}

function revision(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
