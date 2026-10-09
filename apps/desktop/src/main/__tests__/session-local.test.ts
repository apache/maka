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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { IpcMainInvokeEvent } from 'electron';
import { deferred } from '@maka/core/test-only/async-primitives';
import { AttachmentIngestBlockedError } from '@maka/core/attachments';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import type { SessionCatalogProjection, SessionCreateInput, TurnMessageSubmitInput, TurnMessageSubmitResult } from '@maka/runtime-host/protocol';
import { DesktopSessionLocalStore, type LocalMessageIntent } from '../session-local-store.js';
import {
  createSessionLocalChangedEmitter,
  DesktopSessionLocalService,
  desktopSessionLocalPartition,
  registerDesktopSessionLocalIpc,
  type DesktopSessionLocalTarget,
} from '../session-local-service.js';
import type { DesktopSessionSummaryInput } from '../../shared/desktop-session-projection.js';
import type { DesktopTranscriptReplicaSnapshot } from '../desktop-transcript-replica.js';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { parseDesktopSlashCommand } from '../../renderer/application/contracts/desktop-slash-command.js';
import { projectLocalMessageDraft } from '../../preload/session-local-draft.js';
import type { DesktopLocalMessageDraft } from '../../shared/session-local-contract.js';

const accepted: TurnMessageSubmitResult = {
  disposition: 'turn_started',
  turnId: 'turn-1',
  skillInvocation: { loaded: [], failed: [], receipts: [] },
};
const intent = (messageId = 'message-1', sessionId = 'session-1'): LocalMessageIntent => ({
  command: { sessionId, messageId, placement: 'current_turn', content: { text: 'hello' } },
  staged: [
    {
      name: 'note.txt',
      mimeType: 'text/plain',
      base64: Buffer.from('original bytes').toString('base64'),
    },
  ],
});

async function database(t: TestContext, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-local-'));
  const path = join(directory, 'client.sqlite');
  let store = new DesktopSessionLocalStore(path, now);
  const beforeClose: (() => void)[] = [];
  t.after(async () => {
    for (const close of beforeClose) close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    path,
    beforeClose,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new DesktopSessionLocalStore(path, now);
      return store;
    },
  };
}

function client(hostEpoch: string): NonNullable<DesktopSessionLocalTarget['client']> {
  return {
    hostEpoch,
    async getSession() {
      return null;
    },
    async listSessions() {
      return [];
    },
    async createSession() {
      throw new Error('Unexpected creation');
    },
    async ingestAttachment(input) {
      return {
        kind: 'doc',
        name: input.name,
        mimeType: input.mimeType,
        bytes: input.content.byteLength,
        ref: {
          kind: 'session_file',
          sessionId: input.sessionId,
          relativePath: 'artifacts/note.txt',
        },
      };
    },
  };
}

function swarmCatalogSession(backgroundActivity: 'running' | 'idle' = 'running'): SessionCatalogProjection {
  return {
    id: 'root', revision: 1, workspace: { target: { kind: 'host_path', path: '/workspace' }, hostCwd: '/workspace' },
    createdAt: 1, activityAt: 2, name: 'Swarm graph', isFlagged: false, isArchived: false,
    labels: [], labelsTruncated: false, hasUnread: false, status: 'active',
    liveRunState: { schemaVersion: 1, runningTurnIds: [] }, backgroundActivity,
    backend: 'ai-sdk', llmConnectionId: 'connection', llmConnectionSlug: 'test',
    connectionLocked: true, model: 'test', permissionMode: 'ask', collaborationMode: 'agent', orchestrationMode: 'swarm',
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail('Local state did not settle');
}

test('local acceptance survives restart with attachment bytes and an immutable dispatch epoch', async (t) => {
  const db = await database(t);
  const record = db.store.enqueue('authority-1', intent());
  assert.equal(record.state, 'saved');
  // POSIX permission bits do not describe Windows ACLs.
  if (process.platform !== 'win32') {
    assert.equal((await stat(db.path)).mode & 0o777, 0o600);
  }
  db.store.update({
    ...record,
    state: 'sending',
    intent: { ...record.intent, originHostEpoch: 'old-epoch' },
  });
  db.reopen();
  const restored = db.store.get('authority-1', record.messageId)!;
  assert.equal(restored.state, 'unknown');
  assert.equal(
    Buffer.from(db.store.stagedAttachments('authority-1', record.messageId)[0]!.content).toString(),
    'original bytes',
  );
  assert.ok(!JSON.stringify(restored).includes('original bytes'));
  assert.throws(
    () =>
      db.store.update({
        ...restored,
        intent: { ...restored.intent, originHostEpoch: 'new-epoch' },
      }),
    /Cannot retarget/,
  );
  assert.throws(() => db.store.cancel('authority-1', record.messageId), /Host may already own/);
});

test('ordinary send presentation survives local outbox restart', async (t) => {
  const db = await database(t);
  db.store.enqueue('authority-1', {
    ...intent(),
    command: { ...intent().command, placement: 'next_turn' },
    localDisplayPlacement: 'current_turn',
  });
  db.reopen();
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => [], changed() {}, onError: (error) => assert.fail(String(error)),
  });
  t.after(() => service.close());
  const [restored] = service.listMessages({
    partition: 'authority-1', profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
  }, 'session-1');
  assert.equal(restored?.placement, 'next_turn');
  assert.equal(restored.localDisplayPlacement, 'current_turn');
});

test('background activity is authoritative only in the Host epoch that supplied its catalog', async (t) => {
  const db = await database(t);
  const live = swarmCatalogSession();
  let target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
    client: { ...client('old-epoch'), listSessions: async () => [live] },
  };
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  await waitFor(() => db.store.sessions('authority').length === 1);
  assert.equal(service.catalog()[0]?.authoritative, true);
  assert.equal(service.catalog()[0]?.sessions[0]?.backgroundActivity, 'running');

  const nextCatalog = deferred<SessionCatalogProjection[]>();
  target = { ...target, client: { ...client('new-epoch'), listSessions: () => nextCatalog.promise } };
  const switched = service.catalog()[0]!;
  assert.equal(switched.authoritative, false);
  assert.equal(switched.sessions[0]?.localState, 'cached');
  assert.equal(switched.sessions[0]?.backgroundActivity, undefined);
  assert.equal(switched.sessions[0]?.runningTurnIds, undefined);
  service.close();
  nextCatalog.resolve([]);
  await nextTurn();

  db.reopen();
  assert.equal(db.store.sessions('authority')[0]?.backgroundActivity, 'running', 'the disk cache retains history');
  target = { ...target, client: undefined };
  const restored = new DesktopSessionLocalService(db.store, {
    targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => restored.close());
  const cached = restored.catalog()[0]!;
  assert.equal(cached.authoritative, false);
  assert.equal(cached.sessions[0]?.backgroundActivity, undefined, 'cached history cannot restart the blue pulse');
});

test('closing local recovery aborts catalog work and expires approvals without deleting the paused original', async (t) => {
  const db = await database(t);
  const reads = [deferred<SessionCatalogProjection[]>(), deferred<SessionCatalogProjection[]>()];
  const started: string[] = [];
  const aborts = t.mock.method(AbortController.prototype, 'abort');
  const targets = ['first', 'second', 'queued'].map((partition, index): DesktopSessionLocalTarget => ({
    partition, profileId: partition, scope: { hostId: partition, targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => {
      started.push(partition);
      return reads[index]?.promise ?? Promise.resolve([]);
    } },
  }));
  let notifications = 0;
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => targets, changed: () => { notifications++; }, onError: assert.fail,
  });
  db.beforeClose.push(() => service.close());
  const target = targets[0]!;
  const original = db.store.enqueue(target.partition, intent());
  const draft = service.cancelUnsentToDraft(target, 'session-1', original.messageId, 7);
  const owner = { senderId: 7, partition: target.partition, scope: target.scope, sessionId: 'session-1' };
  const prepared = service.attachmentRecovery.prepare(owner, draft.stagedAttachments);
  assert.deepEqual(prepared.items, intent().staged);
  service.catalog();
  assert.deepEqual(started, ['first', 'second'], 'the third partition waits for a catalog slot');
  const revision = db.store.revision;

  service.close();
  service.close();
  assert.ok(aborts.mock.calls.length >= reads.length, 'close cancels the pending catalog observations');
  for (const call of aborts.mock.calls) {
    assert.ok(call.this instanceof AbortController);
    assert.equal(call.this.signal.aborted, true);
  }
  assert.throws(() => service.attachmentRecovery.prepare(owner, draft.stagedAttachments), AttachmentIngestBlockedError);
  assert.throws(() => prepared.commit(() => assert.fail('a closed service cannot admit a leased recovery')), AttachmentIngestBlockedError);
  prepared.dispose();
  reads[0]!.resolve([swarmCatalogSession()]);
  reads[1]!.reject(new Error('late catalog failure after close'));
  await nextTurn();
  await nextTurn();
  assert.deepEqual(started, ['first', 'second'], 'closing cannot start the queued catalog request');
  assert.equal(notifications, 0, 'late catalog settlement cannot notify a closed service');
  assert.equal(db.store.revision, revision, 'late catalog settlement cannot mutate the local database');

  db.reopen();
  assert.equal(db.store.get(target.partition, original.messageId)?.state, 'paused');
  assert.equal(db.store.get(target.partition, original.messageId)?.intent.command.content.text, 'hello');
  assert.equal(Buffer.from(db.store.stagedAttachments(target.partition, original.messageId)[0]!.content).toString(), 'original bytes');
  const restored = new DesktopSessionLocalService(db.store, {
    targets: () => [], changed() {}, onError: assert.fail,
  });
  db.beforeClose.push(() => restored.close());
  const renewed = restored.cancelUnsentToDraft(target, 'session-1', original.messageId, 7);
  assert.equal(renewed.replacesLocalMessageId, original.messageId);
  assert.notEqual(renewed.stagedAttachments[0]?.approvalId, draft.stagedAttachments[0]?.approvalId);
});

for (const elapsed of [1_000, 6_000]) {
  for (const reuseClient of [false, true]) {
    test(`Owner reconnect after ${elapsed} ms needs a new catalog (${reuseClient ? 'reused' : 'new'} client)`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
      const db = await database(t);
      const recovered = deferred<SessionCatalogProjection[]>();
      let reads = 0;
      const listSessions = () => ++reads === 1
        ? Promise.resolve([swarmCatalogSession()]) : recovered.promise;
      const firstClient = { ...client('same-host-epoch'), listSessions };
      let target: DesktopSessionLocalTarget = {
        partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
        client: firstClient,
      };
      const service = new DesktopSessionLocalService(db.store, {
        targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
      });
      db.beforeClose.push(() => service.close());
      service.catalog();
      await waitFor(() => db.store.sessions('authority').length === 1);
      assert.equal(service.catalog()[0]?.authoritative, true);

      t.mock.timers.tick(elapsed);
      target = { ...target, client: undefined };
      service.connectionChanged(target);
      if (!reuseClient) {
        const offline = service.catalog()[0]!;
        assert.equal(offline.authoritative, false);
        assert.equal(offline.sessions[0]?.localState, 'cached');
        assert.equal(offline.sessions[0]?.backgroundActivity, undefined);
      }
      // The reused client case deliberately has no catalog read during the
      // outage: the production connection callback must retain that transition.
      target = { ...target, client: reuseClient ? firstClient : { ...client('same-host-epoch'), listSessions } };
      service.connectionChanged(target);
      const reconnecting = service.catalog()[0]!;
      assert.equal(reconnecting.authoritative, false);
      assert.equal(reconnecting.sessions[0]?.localState, 'cached');
      assert.equal(reconnecting.sessions[0]?.backgroundActivity, undefined);
      assert.equal(reconnecting.sessions[0]?.runningTurnIds, undefined);
      assert.equal(reads, 2, 'recovery bypasses the previous connection TTL');
      service.catalog();
      assert.equal(reads, 2, 'one current connection read is enough');

      recovered.resolve([swarmCatalogSession('idle')]);
      await waitFor(() => db.store.sessions('authority')[0]?.backgroundActivity === 'idle');
      service.connectionChanged(target);
      const live = service.catalog()[0]!;
      assert.equal(live.authoritative, true);
      assert.equal(live.sessions[0]?.localState, undefined);
      assert.equal(live.sessions[0]?.backgroundActivity, 'idle');
      assert.equal(reads, 2, 'duplicate ready notifications keep the current snapshot');
    });
  }
}

test('a new Owner client invalidates the same Host epoch even before a connection notification', async (t) => {
  const db = await database(t);
  let reads = 0;
  const recovered = deferred<SessionCatalogProjection[]>();
  let target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
    client: { ...client('same-host-epoch'), listSessions: async () => [swarmCatalogSession()] },
  };
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  await waitFor(() => db.store.sessions('authority').length === 1);
  target = { ...target, client: { ...client('same-host-epoch'), listSessions: () => {
    reads++;
    return recovered.promise;
  } } };
  const cached = service.catalog()[0]!;
  assert.equal(cached.authoritative, false);
  assert.equal(cached.sessions[0]?.backgroundActivity, undefined);
  assert.equal(reads, 1);
});

for (const [lateResult, reuseClient] of [
  ['running', false], ['removed', false], ['unauthorized', false], ['running', true],
] as const) {
  test(`a retired Owner catalog cannot apply late ${lateResult} (${reuseClient ? 'reused' : 'new'} client)`, async (t) => {
    const db = await database(t);
    const retired = deferred<SessionCatalogProjection[]>();
    const recovered = deferred<SessionCatalogProjection[]>();
    let oldReads = 0;
    let newReads = 0;
    let reconnected = false;
    const readRecovered = () => {
      newReads++;
      return recovered.promise;
    };
    const firstClient = { ...client('same-host-epoch'), listSessions: () => reconnected
      ? readRecovered() : ++oldReads === 1 ? Promise.resolve([swarmCatalogSession()]) : retired.promise };
    let target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
      client: firstClient,
    };
    const service = new DesktopSessionLocalService(db.store, {
      targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
    });
    db.beforeClose.push(() => service.close());
    service.catalog();
    await waitFor(() => db.store.sessions('authority').length === 1);
    service.changed(target.scope);
    service.catalog();
    assert.equal(oldReads, 2);

    target = { ...target, client: undefined };
    service.connectionChanged(target);
    reconnected = true;
    target = { ...target, client: reuseClient ? firstClient : { ...client('same-host-epoch'), listSessions: readRecovered } };
    service.connectionChanged(target);
    assert.equal(service.catalog()[0]?.authoritative, false);
    assert.equal(newReads, 1, 'the unresolved old read releases its catalog slot immediately');
    await nextTurn();
    service.catalog();
    assert.equal(newReads, 1, 'retired finally cannot remove the new read from deduplication');

    recovered.resolve([swarmCatalogSession('idle')]);
    await waitFor(() => db.store.sessions('authority')[0]?.backgroundActivity === 'idle');
    if (lateResult === 'unauthorized') {
      retired.reject(new RuntimeHostOperationError('session.catalog.query', 'unauthorized', 'old connection revoked'));
    } else {
      retired.resolve(lateResult === 'removed' ? [] : [swarmCatalogSession()]);
    }
    await nextTurn();
    const live = service.catalog()[0]!;
    assert.equal(live.authoritative, true);
    assert.equal(live.sessions[0]?.backgroundActivity, 'idle');
    assert.equal(db.store.sessions('authority').length, 1);
    assert.equal(newReads, 1);
  });
}

for (const staleResult of ['running', 'removed', 'failed'] as const) {
  test(`a dirty Owner catalog publishes a ${staleResult} observation and coalesces another read`, async (t) => {
    const db = await database(t);
    const stale = deferred<SessionCatalogProjection[]>();
    const current = deferred<SessionCatalogProjection[]>();
    const failure = new Error('superseded catalog unavailable');
    const errors: unknown[] = [];
    let notifications = 0;
    let reads = 0;
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
      client: { ...client('epoch'), listSessions: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve([swarmCatalogSession()]);
        return reads === 2 ? stale.promise : current.promise;
      } },
    };
    const service = new DesktopSessionLocalService(db.store, {
      targets: () => [target], changed() { notifications += 1; }, onError: (error) => errors.push(error),
    });
    db.beforeClose.push(() => service.close());
    service.catalog();
    await waitFor(() => db.store.sessions('authority').length === 1);
    await nextTurn();
    service.changed(target.scope);
    assert.equal(service.catalog()[0]?.authoritative, true);
    assert.equal(service.catalog()[0]?.sessions[0]?.backgroundActivity, 'running');
    assert.equal(reads, 2);
    const revision = db.store.revision;

    // Further Host changes dirty the observation without revoking its authority.
    service.changed(target.scope);
    service.changed(target.scope);
    service.catalog();
    assert.equal(db.store.revision, revision, 'Host invalidations do not mutate the local store');
    assert.equal(reads, 2, 'in-flight invalidations coalesce');
    if (staleResult === 'failed') stale.reject(failure);
    else stale.resolve(staleResult === 'removed' ? [] : [swarmCatalogSession()]);

    // No renderer refresh or new Host event is needed to start the trailing read.
    await waitFor(() => reads === 3);
    assert.equal(notifications, 2, 'publish the successful observation or notify authority loss');
    if (staleResult === 'failed') {
      assert.equal(db.store.revision, revision);
      assert.equal(service.catalog()[0]?.authoritative, false);
      assert.equal(service.catalog()[0]?.sessions[0]?.backgroundActivity, undefined);
    } else {
      assert.ok(db.store.revision > revision, 'successful dirty reads must make progress');
      assert.equal(service.catalog()[0]?.authoritative, true);
      assert.equal(db.store.sessions('authority').length, staleResult === 'removed' ? 0 : 1);
    }
    current.resolve([swarmCatalogSession('idle')]);
    await waitFor(() => db.store.sessions('authority')[0]?.backgroundActivity === 'idle');
    await nextTurn();
    const live = service.catalog()[0]!;
    assert.equal(live.authoritative, true);
    assert.equal(live.sessions[0]?.backgroundActivity, 'idle');
    assert.equal(reads, 3, 'one trailing read consumes both invalidations');
    assert.deepEqual(errors, staleResult === 'failed' ? [failure] : []);
  });
}

test('continuous Owner invalidations cannot starve successful catalog observations', async (t) => {
  const db = await database(t);
  const pending: ReturnType<typeof deferred<SessionCatalogProjection[]>>[] = [];
  let notifications = 0;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => {
      const read = deferred<SessionCatalogProjection[]>();
      pending.push(read);
      return read.promise;
    } },
  };
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => [target], changed() { notifications += 1; },
    onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  assert.equal(service.catalog()[0]?.authoritative, false);

  for (let index = 0; index < 8; index += 1) {
    const activity = index % 2 === 0 ? 'running' : 'idle';
    service.changed(target.scope);
    service.changed(target.scope);
    service.catalog();
    assert.equal(pending.length, index + 1, 'changes share the in-flight request');
    pending[index]!.resolve([swarmCatalogSession(activity)]);
    await waitFor(() => pending.length === index + 2);
    const catalog = service.catalog()[0]!;
    assert.equal(catalog.authoritative, true, 'publish before notifications become quiet');
    assert.equal(catalog.sessions[0]?.backgroundActivity, activity);
    assert.equal(notifications, index + 1);
  }

  pending[8]!.resolve([swarmCatalogSession('idle')]);
  await waitFor(() => notifications === 9);
  await nextTurn();
  assert.equal(service.catalog()[0]?.sessions[0]?.backgroundActivity, 'idle');
  assert.equal(pending.length, 9, 'stop refreshing after the final clean observation');
});

test('a queued Owner refresh clears stale activity as soon as a slot is free without another renderer read', async (t) => {
  const db = await database(t);
  const first = deferred<SessionCatalogProjection[]>();
  const second = deferred<SessionCatalogProjection[]>();
  let reads = 0;
  const third: DesktopSessionLocalTarget = {
    partition: 'third', profileId: 'profile', scope: { hostId: 'third', targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: async () => [swarmCatalogSession(++reads === 1 ? 'running' : 'idle')] },
  };
  let targets = [third];
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => targets, changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  await nextTurn();
  targets = [first, second].map((read, index): DesktopSessionLocalTarget => ({
    partition: `busy-${index}`, profileId: 'profile', scope: { hostId: `busy-${index}`, targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => read.promise },
  })).concat(third);
  service.changed(third.scope);
  const queued = service.catalog()[2]!;
  assert.equal(queued.authoritative, true);
  assert.equal(queued.sessions[0]?.backgroundActivity, 'running');
  assert.equal(reads, 1, 'the third partition must wait for a slot');
  first.resolve([]);
  await waitFor(() => db.store.sessions('third')[0]?.backgroundActivity === 'idle');
  assert.equal(reads, 2, 'freeing a slot must admit the queued refresh automatically');
});

test('waiting Owner partitions precede a busy partition trailing read and share the two-read limit', async (t) => {
  const db = await database(t);
  const reads = new Map<string, ReturnType<typeof deferred<SessionCatalogProjection[]>>[]>();
  const order: string[] = [];
  const targets = ['a', 'b', 'c'].map((partition): DesktopSessionLocalTarget => ({
    partition, profileId: 'profile', scope: { hostId: partition, targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => {
      const read = deferred<SessionCatalogProjection[]>();
      reads.set(partition, [...(reads.get(partition) ?? []), read]);
      order.push(partition);
      return read.promise;
    } },
  }));
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => targets, changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  service.catalog();
  assert.deepEqual(order, ['a', 'b']);
  service.changed(targets[0]!.scope);
  reads.get('a')![0]!.resolve([swarmCatalogSession()]);
  await nextTurn();
  assert.deepEqual(order, ['a', 'b', 'c'], 'a trailing refresh joins behind waiting partitions');
  reads.get('c')![0]!.resolve([]);
  await nextTurn();
  assert.deepEqual(order, ['a', 'b', 'c', 'a']);
  reads.get('a')![1]!.resolve([swarmCatalogSession('idle')]);
  await waitFor(() => db.store.sessions('a')[0]?.backgroundActivity === 'idle');
});

test('parallel Owner observations publish without fencing unrelated partitions', async (t) => {
  const db = await database(t);
  let active = 0;
  let maximumActive = 0;
  const targets = ['a', 'b', 'c', 'd'].map((partition): DesktopSessionLocalTarget => ({
    partition, profileId: 'profile', scope: { hostId: partition, targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: async () => {
      maximumActive = Math.max(maximumActive, ++active);
      await nextTurn();
      active -= 1;
      return [swarmCatalogSession('idle')];
    } },
  }));
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => targets, changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  await waitFor(() => targets.every(({ partition }) => db.store.sessions(partition)[0]?.backgroundActivity === 'idle'));
  assert.equal(maximumActive, 2);
  assert.ok(service.catalog().every((catalog) => catalog.authoritative));
});

test('continuous fast Owner invalidations cannot fence a slower partition catalog', async (t) => {
  const db = await database(t);
  const reads = new Map<string, ReturnType<typeof deferred<SessionCatalogProjection[]>>[]>();
  const target = (partition: string): DesktopSessionLocalTarget => ({
    partition, profileId: partition, scope: { hostId: partition, targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => {
      const read = deferred<SessionCatalogProjection[]>();
      reads.set(partition, [...(reads.get(partition) ?? []), read]);
      return read.promise;
    } },
  });
  const slow = target('slow');
  const fast = target('fast');
  let targets = [slow];
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => targets, changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  reads.get('slow')![0]!.resolve([swarmCatalogSession()]);
  await nextTurn();
  assert.equal(service.catalog()[0]?.authoritative, true);

  targets = [slow, fast];
  service.changed(slow.scope);
  service.catalog();
  for (let index = 0; index < 8; index += 1) {
    const activity = index % 2 === 0 ? 'idle' : 'running';
    service.changed(fast.scope);
    service.changed(slow.scope);
    // The fast authority commits while the slower authority's read is held.
    // Both keep getting invalidations, so each success starts a trailing read.
    reads.get('fast')![index]!.resolve([swarmCatalogSession(activity)]);
    await waitFor(() => reads.get('fast')!.length === index + 2);
    reads.get('slow')![index + 1]!.resolve([swarmCatalogSession(activity)]);
    await waitFor(() => reads.get('slow')!.length === index + 3);
    const catalog = service.catalog()[0]!;
    assert.equal(catalog.authoritative, true);
    assert.equal(catalog.sessions[0]?.backgroundActivity, activity,
      'a successful slow observation must publish while another authority remains busy');
  }

  reads.get('slow')![9]!.resolve([swarmCatalogSession('idle')]);
  await nextTurn();
  assert.equal(service.catalog()[0]?.sessions[0]?.backgroundActivity, 'idle');
  assert.equal(reads.get('slow')!.length, 10, 'the final clean observation stops trailing reads');
});

test('Owner mutation revisions advance only for their partition and survive purge', async (t) => {
  const { store } = await database(t);
  const summary = { id: 'draft', name: 'Pending task' } as DesktopSessionSummaryInput;
  store.saveSession('other', { ...summary, id: 'other' });
  const otherRevision = store.partitionRevision('other');
  const mutate = (operation: () => void) => {
    const globalRevision = store.revision;
    const partitionRevision = store.partitionRevision('authority');
    operation();
    assert.ok(store.revision > globalRevision, 'existing global mutation fences still advance');
    assert.ok(store.partitionRevision('authority') > partitionRevision);
    assert.equal(store.partitionRevision('other'), otherRevision,
      'another authority catalog must not be fenced by this mutation');
  };
  assert.equal(store.partitionRevision('authority'), 0);
  store.bindAuthority('profile', 'authority');
  mutate(() => store.saveSession('authority', summary, {
    sessionId: 'draft', workspace: { kind: 'host_path', path: '/workspace' },
  }));
  assert.ok(store.creation('authority', 'draft'));
  mutate(() => store.enqueue('authority', intent('draft-message', 'draft')));
  mutate(() => store.saveSession('authority', { ...summary, name: 'Host admitted task' }));
  assert.equal(store.creation('authority', 'draft'), undefined);
  mutate(() => store.saveCatalog('authority', [summary, { ...summary, id: 'second' }]));
  mutate(() => store.removeSession('authority', 'draft'));
  mutate(() => store.saveCatalog('authority', []));
  mutate(() => store.saveSession('authority', summary));
  mutate(() => store.purge('authority'));
  mutate(() => store.saveSession('authority', summary));
  mutate(() => store.bindAuthority('profile', 'replacement'));
  assert.equal(store.partitionRevision('replacement'), 0);
});

test('a retired queued Owner connection never starts a read', async (t) => {
  const db = await database(t);
  const held = deferred<SessionCatalogProjection[]>();
  let staleReads = 0;
  let currentReads = 0;
  const target = (partition: string, read: () => Promise<SessionCatalogProjection[]>): DesktopSessionLocalTarget => ({
    partition, profileId: 'profile', scope: { hostId: partition, targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: read },
  });
  const targets = [target('a', () => held.promise), target('b', () => held.promise),
    target('c', async () => { staleReads += 1; return []; })];
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => targets, changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  targets[2] = target('c', async () => { currentReads += 1; return []; });
  service.connectionChanged(targets[2]);
  service.catalog();
  held.resolve([]);
  await waitFor(() => currentReads === 1);
  assert.equal(staleReads, 0);
});

test('failed Owner recovery remains cached and retries without disturbing pending local work', async (t) => {
  const db = await database(t);
  const errors: unknown[] = [];
  let target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
    client: { ...client('same-host-epoch'), listSessions: async () => [swarmCatalogSession()] },
  };
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => [target], changed() {}, onError: (error) => errors.push(error),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  await waitFor(() => db.store.sessions('authority').length === 1);
  target = { ...target, client: undefined };
  service.connectionChanged(target);
  db.store.saveSession('authority', { id: 'draft', status: 'active', localState: 'pending' } as DesktopSessionSummaryInput, {
    sessionId: 'draft', workspace: { kind: 'host_path', path: '/workspace' },
  });
  const message = db.store.enqueue('authority', intent('draft-message', 'draft'));
  const recovered = deferred<SessionCatalogProjection[]>();
  let reads = 0;
  target = { ...target, client: { ...client('same-host-epoch'), listSessions: () => ++reads === 1
    ? Promise.reject(new Error('catalog unavailable')) : recovered.promise } };
  service.connectionChanged(target);
  service.catalog();
  await waitFor(() => errors.length === 1);
  await nextTurn();
  const cached = service.catalog()[0]!;
  assert.equal(cached.authoritative, false);
  assert.equal(cached.sessions.find(({ id }) => id === 'root')?.backgroundActivity, undefined);
  assert.equal(cached.sessions.find(({ id }) => id === 'root')?.localState, 'cached');
  assert.equal(cached.sessions.find(({ id }) => id === 'draft')?.localState, 'pending');
  assert.equal(reads, 2, 'the next catalog read retries unknown state without a TTL delay');
  assert.deepEqual(db.store.get('authority', message.messageId), message);

  recovered.resolve([swarmCatalogSession('idle')]);
  await waitFor(() => db.store.sessions('authority').some((session) => session.backgroundActivity === 'idle'));
  const live = service.catalog()[0]!;
  assert.equal(live.authoritative, true);
  assert.equal(live.sessions.find(({ id }) => id === 'draft')?.localState, 'pending');
  assert.deepEqual(db.store.get('authority', message.messageId), message);
  assert.equal(reads, 2);
});

test('a current Owner connection keeps its catalog TTL across ordinary reads', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const db = await database(t);
  const refreshed = deferred<SessionCatalogProjection[]>();
  let reads = 0;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => ++reads === 1
      ? Promise.resolve([swarmCatalogSession()]) : refreshed.promise },
  };
  const service = new DesktopSessionLocalService(db.store, {
    targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
  });
  db.beforeClose.push(() => service.close());
  service.catalog();
  await waitFor(() => db.store.sessions('authority').length === 1);
  t.mock.timers.tick(4_999);
  assert.equal(service.catalog()[0]?.authoritative, true);
  assert.equal(reads, 1);
  t.mock.timers.tick(2);
  assert.equal(service.catalog()[0]?.authoritative, true);
  assert.equal(reads, 2);
  service.catalog();
  assert.equal(reads, 2);
  refreshed.resolve([swarmCatalogSession('idle')]);
  await waitFor(() => db.store.sessions('authority')[0]?.backgroundActivity === 'idle');
  assert.equal(service.catalog()[0]?.sessions[0]?.backgroundActivity, 'idle');
});

for (const backgroundActivity of ['running', 'waiting_for_user'] as const) {
  test(`failed Owner TTL refresh clears ${backgroundActivity} until a successful retry`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const db = await database(t);
    const failed = deferred<SessionCatalogProjection[]>();
    const recovered = deferred<SessionCatalogProjection[]>();
    const errors: unknown[] = [];
    let reads = 0;
    let changes = 0;
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root-host', targetEpoch: 'target' },
      client: { ...client('epoch'), listSessions: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve([{
          ...swarmCatalogSession(), backgroundActivity,
          liveRunState: { schemaVersion: 1, runningTurnIds: ['turn-1'] },
        }]);
        return reads <= 3 ? failed.promise : recovered.promise;
      } },
    };
    const service = new DesktopSessionLocalService(db.store, {
      targets: () => [target], changed: () => { changes += 1; }, onError: (error) => errors.push(error),
    });
    db.beforeClose.push(() => service.close());
    service.catalog();
    await waitFor(() => changes === 1);
    assert.equal(service.catalog()[0]?.authoritative, true);

    t.mock.timers.tick(6_001);
    assert.equal(service.catalog()[0]?.authoritative, true, 'keep live state while refresh is pending');
    assert.equal(reads, 2);
    failed.reject(new Error('catalog unavailable'));
    await waitFor(() => errors.length === 1);
    await nextTurn();
    const cached = service.catalog()[0]!;
    assert.equal(cached.authoritative, false);
    assert.equal(cached.sessions[0]?.localState, 'cached');
    assert.equal(cached.sessions[0]?.backgroundActivity, undefined);
    assert.equal(cached.sessions[0]?.runningTurnIds, undefined);
    assert.equal(changes, 2, 'notify consumers when live state becomes unknown');
    assert.equal(reads, 3, 'retry cached state without another TTL delay');
    assert.equal(db.store.sessions('authority')[0]?.backgroundActivity, backgroundActivity, 'retain disk history');

    await waitFor(() => errors.length === 2);
    await nextTurn();
    assert.equal(changes, 2, 'repeated failures must not trigger a notification/retry loop');
    assert.equal(reads, 3);
    assert.equal(service.catalog()[0]?.authoritative, false);
    assert.equal(reads, 4);
    recovered.resolve([swarmCatalogSession('idle')]);
    await waitFor(() => changes === 3);
    const live = service.catalog()[0]!;
    assert.equal(live.authoritative, true);
    assert.equal(live.sessions[0]?.localState, undefined);
    assert.equal(live.sessions[0]?.backgroundActivity, 'idle');
    assert.deepEqual(live.sessions[0]?.runningTurnIds, []);
    assert.equal(reads, 4);
  });
}

test('local IDs bind content, retries are idempotent, and admission stays bounded', async (t) => {
  const { store } = await database(t);
  const first = store.enqueue('authority-1', intent());
  assert.deepEqual(store.enqueue('authority-1', intent()), first);
  assert.throws(
    () =>
      store.enqueue('authority-1', {
        ...intent(),
        command: { ...intent().command, content: { text: 'different' } },
      }),
    /different local intent/,
  );
  for (let index = 1; index < 256; index += 1)
    store.enqueue('authority-1', intent(`message-${index + 1}`));
  assert.throws(() => store.enqueue('authority-1', intent('overflow')), /storage is full/);
  assert.equal(store.list('authority-1').length, 256);
});

test('a credential or profile incarnation change cannot read the old local history', async (t) => {
  const { store } = await database(t);
  const first = desktopSessionLocalPartition({
    profileId: 'profile',
    hostId: 'root',
    incarnation: 'one',
    credential: 'secret-one',
  });
  const second = desktopSessionLocalPartition({
    profileId: 'profile',
    hostId: 'root',
    incarnation: 'one',
    credential: 'secret-two',
  });
  assert.notEqual(first, second);
  assert.ok(!first.includes('secret'));
  store.bindAuthority('profile', first);
  store.enqueue(first, intent());
  store.bindAuthority('profile', second);
  assert.deepEqual(store.list(first), []);
  assert.deepEqual(store.stagedAttachments(first, 'message-1'), []);
  assert.deepEqual(store.list(second), []);
});

test('cancelling an undispatched message removes its staged bytes as one database operation', async (t) => {
  const { store } = await database(t);
  store.enqueue('authority', intent());
  assert.equal(store.stagedAttachments('authority', 'message-1').length, 1);
  store.cancel('authority', 'message-1');
  assert.equal(store.get('authority', 'message-1'), undefined);
  assert.deepEqual(store.stagedAttachments('authority', 'message-1'), []);
});

test('normal application shutdown preserves intentions when the manager removes its in-memory targets', async (t) => {
  const { store } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  store.enqueue('authority', intent());
  service.close();
  service.purge(target);
  assert.equal(store.get('authority', 'message-1')?.state, 'saved');
  assert.equal(store.stagedAttachments('authority', 'message-1').length, 1);
});

test('a catalog read begun before local creation cannot erase that Session or its intent', async (t) => {
  const { store, beforeClose } = await database(t);
  const fresh = deferred<SessionCatalogProjection[]>();
  let reads = 0;
  const listed =
    deferred<
      Awaited<ReturnType<NonNullable<DesktopSessionLocalTarget['client']>['listSessions']>>
    >();
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => ++reads === 1 ? listed.promise : fresh.promise },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  service.catalog();
  store.saveSession('authority', { id: 'session-1', name: 'new' } as DesktopSessionSummaryInput);
  store.enqueue('authority', intent());
  listed.resolve([]);
  await nextTurn();
  assert.equal(store.sessions('authority').length, 1);
  assert.equal(store.list('authority').length, 1);
  assert.equal(reads, 2, 'the fenced read is retried without reusing its stale response');
  fresh.resolve([{ ...swarmCatalogSession(), id: 'session-1', name: 'Canonical' }]);
  await waitFor(() => store.sessions('authority')[0]?.name === 'Canonical');
  assert.equal(store.list('authority').length, 1, 'refreshing cannot discard the local message intent');
});

test('a dirty catalog read cannot restore a locally removed Session', async (t) => {
  const { store, beforeClose } = await database(t);
  const listed = deferred<SessionCatalogProjection[]>();
  const trailing = deferred<SessionCatalogProjection[]>();
  let reads = 0;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => ++reads === 1 ? listed.promise : trailing.promise },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target], changed() {}, onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  store.saveSession('authority', { id: 'root' } as DesktopSessionSummaryInput);
  service.catalog();
  service.changed(target.scope);
  store.removeSession('authority', 'root');
  listed.resolve([swarmCatalogSession()]);
  await waitFor(() => reads === 2);
  assert.equal(store.sessions('authority').length, 0);
  assert.equal(service.catalog()[0]?.authoritative, false);
  trailing.resolve([]);
  await nextTurn();
  assert.equal(service.catalog()[0]?.authoritative, true);
  assert.equal(store.sessions('authority').length, 0);
});

test('a locally-owned Session change signals a list refresh, not a targeted row read', async (t) => {
  const { store, beforeClose } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  const sent: { channel: string; payload: unknown }[] = [];
  const emit = createSessionLocalChangedEmitter({
    send: (channel, _scope, payload) => sent.push({ channel, payload }),
    locallyOwned: (scope, sessionId) => service.locallyOwned(scope, sessionId),
  });
  // The store still holds the creation intent, so no Host row exists for a
  // targeted `sessions.get` to read.
  store.saveSession(
    'authority',
    { id: 'session-1', name: 'task' } as DesktopSessionSummaryInput,
    { sessionId: 'session-1' } as SessionCreateInput,
  );
  emit(target.scope, 'session-1');
  assert.deepEqual(
    sent.map(({ channel, payload }) => [channel, (payload as { sessionId?: string }).sessionId]),
    [
      ['session-local:changed', 'session-1'],
      ['sessions:changed', undefined],
    ],
  );
  // Host admission clears the creation marker, so the targeted path resumes.
  store.saveSession('authority', { id: 'session-1', name: 'task' } as DesktopSessionSummaryInput);
  emit(target.scope, 'session-1');
  const last = sent[sent.length - 1]?.payload as { sessionId?: string } | undefined;
  assert.equal(last?.sessionId, 'session-1');
});

test('an authorization failure quarantines the still-connected authority from cache and admission', async (t) => {
  const { store, beforeClose } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
    client: client('epoch'),
    submit: async () => {
      throw new RuntimeHostOperationError('turn.message.submit', 'unauthorized', 'revoked');
    },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  store.enqueue('authority', intent());
  service.wake();
  await waitFor(() => store.list('authority').length === 0);
  assert.throws(() => service.target(target.scope), /different Host authority/);
  assert.deepEqual(service.catalog(), []);
  assert.deepEqual(store.stagedAttachments('authority', 'message-1'), []);
});

test('offline intents are dispatched only after connectivity returns', async (t) => {
  const { store, beforeClose } = await database(t);
  const calls: TurnMessageSubmitInput[] = [];
  let target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target-1' },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  store.enqueue('authority', intent());
  service.wake();
  await nextTurn();
  assert.equal(store.get('authority', 'message-1')?.state, 'saved');
  assert.equal(service.listMessages(target, 'session-1')[0]!.delivering, undefined);
  assert.equal(calls.length, 0);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  target = {
    ...target,
    client: client('epoch-1'),
    submit: async (input) => {
      calls.push(input);
      await released;
      return accepted;
    },
  };
  service.wake();
  await waitFor(() => calls.length === 1);
  store.enqueue('authority', intent('message-2'));
  service.wake();
  await nextTurn();
  const queued = service.listMessages(target, 'session-1').find((message) => message.messageId === 'message-2');
  assert.equal(queued?.state, 'saved', 'the second message waits behind the first');
  assert.equal(queued?.delivering, true);
  release();
  await waitFor(() => store.get('authority', 'message-2')?.state === 'accepted');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.originHostEpoch, 'epoch-1');
  assert.equal(calls[0]!.content.attachments?.length, 1);
});

for (const refusal of ['operation-error', 'blocked-skill'] as const) {
  test(`a retained ${refusal} local message does not block later sends`, async (t) => {
    const { store, beforeClose } = await database(t);
    const calls: string[] = [];
    const target: DesktopSessionLocalTarget = {
      partition: 'authority',
      profileId: 'profile',
      scope: { hostId: 'root', targetEpoch: 'target' },
      client: client('epoch'),
      submit: async (input) => {
        calls.push(input.messageId);
        if (input.messageId === 'message-1') {
          if (refusal === 'blocked-skill')
            return { disposition: 'blocked', skillInvocation: accepted.skillInvocation };
          throw new RuntimeHostOperationError('turn.message.submit', 'session_busy', 'busy');
        }
        return accepted;
      },
    };
    const service = new DesktopSessionLocalService(store, {
      targets: () => [target],
      changed() {},
      onError: (error) => assert.fail(String(error)),
    });
    beforeClose.push(() => service.close());
    store.enqueue('authority', intent());
    service.wake();
    await waitFor(() => store.get('authority', 'message-1')?.state === 'failed');
    const failed = store.get('authority', 'message-1');

    store.enqueue('authority', intent('message-2'));
    store.enqueue('authority', intent('message-3'));
    service.wake();
    await waitFor(() => store.get('authority', 'message-3')?.state === 'accepted');

    assert.deepEqual(calls, ['message-1', 'message-2', 'message-3']);
    assert.equal(store.get('authority', 'message-2')?.state, 'accepted');
    assert.deepEqual(store.get('authority', 'message-1'), failed);
    const retained = service.listMessages(target, 'session-1')[0]!;
    assert.equal(retained.state, 'failed');
    assert.equal(retained.text, 'hello');
    assert.equal(retained.canCancel, true);
    assert.ok(retained.error);
  });
}

test('an unknown Host outcome blocks later local sends until the original message is reconciled', async (t) => {
  const { store, beforeClose } = await database(t);
  const calls: string[] = [];
  const originalAck = deferred<TurnMessageSubmitResult>();
  let reconcile = false;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
    client: client('epoch'),
    submit: async (input) => {
      calls.push(input.messageId);
      if (input.messageId === 'message-1') {
        if (reconcile) return originalAck.promise;
        throw new RuntimeHostRequestInterruptedError(
          'turn.message.submit',
          'command',
          'dispatched',
          'connection_lost',
        );
      }
      return accepted;
    },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  store.enqueue('authority', intent());
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'unknown');
  store.enqueue('authority', intent('message-2'));
  store.enqueue('authority', intent('other-session', 'session-2'));
  service.wake();
  await waitFor(() => store.get('authority', 'other-session')?.state === 'accepted');
  assert.deepEqual(calls, ['message-1', 'other-session']);
  assert.equal(store.get('authority', 'message-2')?.state, 'saved');

  reconcile = true;
  service.reconcile(target, 'session-1', 'message-1');
  await waitFor(() => calls.length === 3);
  assert.equal(store.get('authority', 'message-2')?.state, 'saved');
  const checking = service.listMessages(target, 'session-1')[0]!;
  assert.equal(checking.state, 'unknown');
  assert.equal(checking.checking, true);
  assert.equal(checking.canCancel, false);
  assert.throws(() => service.readFailedMessage(target, 'session-1', 'message-1', 7), /definitively failed/);
  originalAck.resolve(accepted);
  await waitFor(() => store.get('authority', 'message-2')?.state === 'accepted');
  assert.deepEqual(calls, ['message-1', 'other-session', 'message-1', 'message-2']);
});

test('lost ACK recovery never changes epoch or ID and does not block another Session', async (t) => {
  const { store, beforeClose } = await database(t);
  const calls: TurnMessageSubmitInput[] = [];
  let target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target-1' },
    client: client('epoch-1'),
    submit: async (input) => {
      calls.push(input);
      throw new RuntimeHostRequestInterruptedError(
        'turn.message.submit',
        'command',
        'dispatched',
        'connection_lost',
      );
    },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  store.enqueue('authority', intent());
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'unknown');
  target = {
    ...target,
    client: client('epoch-2'),
    submit: async (input) => {
      calls.push(input);
      if (input.messageId === 'message-1')
        throw new RuntimeHostOperationError(
          'turn.message.submit',
          'outcome_unknown',
          'no durable proof',
        );
      return accepted;
    },
  };
  store.enqueue('authority', intent('message-2', 'session-2'));
  service.wake();
  await waitFor(() => store.get('authority', 'message-2')?.state === 'accepted');
  assert.deepEqual(
    calls.filter((call) => call.messageId === 'message-1').map((call) => call.originHostEpoch),
    ['epoch-1', 'epoch-1'],
  );
  assert.equal(store.get('authority', 'message-1')?.state, 'unknown');
  assert.equal(calls.find((call) => call.messageId === 'message-2')?.originHostEpoch, 'epoch-2');
});

test('a Message dispatched in a released epoch is settled from the Host, never replayed', async (t) => {
  const { store, beforeClose } = await database(t);
  const submissions: TurnMessageSubmitInput[] = [];
  const queried: string[][] = [];
  let quiescent = false;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target-1' },
    client: {
      ...client('epoch-2'),
      async queryMessageExecutions(input) {
        queried.push([...input.messageIds]);
        return {
          resolutions: [
            { messageId: 'message-1', state: 'owned', turnId: 'turn-recovered', runId: 'run-1' },
          ],
        };
      },
    },
    submit: async (input) => {
      submissions.push(input);
      return accepted;
    },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  // Dispatch once in the previous epoch, then lose the answer the way a Host
  // restart does: the local copy is left `unknown` with a dead dispatch epoch.
  const dispatched = store.enqueue('authority', intent());
  store.update({
    ...dispatched,
    state: 'unknown',
    intent: { ...dispatched.intent, originHostEpoch: 'epoch-1' },
  });
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'accepted');
  assert.deepEqual(queried, [['message-1']]);
  // The old epoch's submit is never replayed: that answer can only be
  // `outcome_unknown`, which would freeze the copy forever.
  assert.deepEqual(submissions, []);
  assert.equal(store.get('authority', 'message-1')?.result?.disposition, 'turn_started');
});

test('a stale-epoch Message the Host never admitted is retired so later sends proceed', async (t) => {
  const { store, beforeClose } = await database(t);
  const submissions: string[] = [];
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target-1' },
    client: {
      ...client('epoch-2'),
      async queryMessageExecutions(input) {
        // The Host holds no receipt, steering proof, tombstone, or admission
        // for this identity, so it reports that absence positively.
        return {
          resolutions: input.messageIds.map(
            (messageId) => ({ messageId, state: 'not_admitted' as const }),
          ),
        };
      },
    },
    submit: async (input) => {
      submissions.push(input.messageId);
      return accepted;
    },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  const dispatched = store.enqueue('authority', intent());
  store.update({
    ...dispatched,
    state: 'unknown',
    intent: { ...dispatched.intent, originHostEpoch: 'epoch-1' },
  });
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'failed');
  // A settled non-delivery releases the Session's ordering.
  store.enqueue('authority', intent('message-2'));
  service.wake();
  await waitFor(() => store.get('authority', 'message-2')?.state === 'accepted');
  assert.deepEqual(submissions, ['message-2']);
});

test('a running Host that cannot yet resolve a stale Message leaves the copy unresolved', async (t) => {
  const { store, beforeClose } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target-1' },
    client: {
      ...client('epoch-2'),
      async queryMessageExecutions() {
        throw new RuntimeHostOperationError('turn.message.execution.query', 'host_not_ready', 'busy');
      },
    },
    submit: async () => accepted,
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  const dispatched = store.enqueue('authority', intent());
  store.update({
    ...dispatched,
    state: 'unknown',
    intent: { ...dispatched.intent, originHostEpoch: 'epoch-1' },
  });
  service.wake();
  await nextTurn();
  // Guessing "never delivered" here would let the user resend a Message the
  // Host may already own, so the copy stays unresolved instead.
  assert.equal(store.get('authority', 'message-1')?.state, 'unknown');
});

test('an omitted resolution leaves the stale copy unresolved rather than failed', async (t) => {
  const { store, beforeClose } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target-1' },
    client: {
      ...client('epoch-2'),
      // The Host answered successfully but could not assert anything about the
      // identity, so it omitted it. That is "cannot say yet", not "not admitted".
      async queryMessageExecutions() {
        return { resolutions: [] };
      },
    },
    submit: async () => accepted,
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  const dispatched = store.enqueue('authority', intent());
  store.update({
    ...dispatched,
    state: 'unknown',
    intent: { ...dispatched.intent, originHostEpoch: 'epoch-1' },
  });
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'unknown');
  // Only a positive `not_admitted` may retire the copy; silence must not.
  assert.equal(store.get('authority', 'message-1')?.state, 'unknown');
});

test('a removed authority cannot be repopulated by an in-flight admission', async (t) => {
  const { store, beforeClose } = await database(t);
  const response = deferred<TurnMessageSubmitResult>();
  let targets: DesktopSessionLocalTarget[] = [
    {
      partition: 'authority',
      profileId: 'profile',
      scope: { hostId: 'root', targetEpoch: 'target' },
      client: client('epoch'),
      submit: () => response.promise,
    },
  ];
  const service = new DesktopSessionLocalService(store, {
    targets: () => targets,
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  store.enqueue('authority', intent());
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'sending');
  service.purge(targets[0]!);
  targets = [];
  response.resolve(accepted);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(store.list('authority'), []);
});

test('cache restoration expires independently of the outbox', async (t) => {
  let now = 1;
  const { store } = await database(t, () => now);
  store.enqueue('authority', intent());
  store.saveTranscript('authority', {
    sessionId: 'session-1',
    generation: 'generation',
    hostEpoch: 'epoch',
    durableThrough: 1,
    durable: [
      {
        sequence: 1,
        message: { type: 'user', id: 'durable-1', turnId: 'turn', ts: 1, text: 'persisted' },
      },
    ],
    hasOlder: false,
    beginsAtTurnBoundary: true,
  });
  assert.equal(store.transcript('authority', 'session-1')?.snapshot.durableThrough, 1);
  assert.equal(store.transcript('different-authority', 'session-1'), undefined);
  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(store.transcript('authority', 'session-1'), undefined);
  assert.equal(store.get('authority', 'message-1')?.state, 'saved');
});

test('durable Host evidence retires delivery independently of cache admission and submit ACK order', async (t) => {
  for (const ackFirst of [false, true]) {
    for (const cacheLoss of ['quota', 'revision', 'coalescing']) {
      await t.test(`ackFirst=${ackFirst}, cacheLoss=${cacheLoss}`, async (t) => {
        const db = await database(t);
        const response = deferred<TurnMessageSubmitResult>();
        const target: DesktopSessionLocalTarget = {
          partition: 'authority',
          profileId: 'profile',
          scope: { hostId: 'root', targetEpoch: 'target' },
          client: client('epoch'),
          submit: () => response.promise,
        };
        const service = new DesktopSessionLocalService(db.store, {
          targets: () => [target],
          changed() {},
          onError: (error) => assert.fail(String(error)),
        });
        db.beforeClose.push(() => service.close());
        db.store.enqueue('authority', intent());
        service.wake();
        await waitFor(() => db.store.get('authority', 'message-1')?.state === 'sending');
        if (ackFirst) {
          response.resolve(accepted);
          await waitFor(() => db.store.get('authority', 'message-1')?.state === 'accepted');
        }
        const snapshot: DesktopTranscriptReplicaSnapshot = {
          sessionId: 'session-1',
          generation: 'generation',
          hostEpoch: 'epoch',
          durableThrough: 1,
          durable: [
            {
              sequence: 1,
              message: {
                type: 'user',
                id: 'message-1',
                turnId: 'turn-1',
                ts: 1,
                text: cacheLoss === 'quota' ? 'x'.repeat(2 * 1024 * 1024) : 'hello',
              },
            },
          ],
          hasOlder: false,
          beginsAtTurnBoundary: true,
        };
        service.cacheTranscript(target.scope, snapshot);
        if (cacheLoss === 'revision') db.store.enqueue('other-authority', intent('other-message'));
        if (cacheLoss === 'coalescing')
          service.cacheTranscript(target.scope, { ...snapshot, durable: [], hasOlder: true });
        await nextTurn();
        assert.equal(db.store.get('authority', 'message-1'), undefined);
        response.resolve(accepted);
        await nextTurn();
        assert.equal(db.store.get('authority', 'message-1'), undefined);
        service.close();
        db.reopen();
        assert.deepEqual(db.store.list('authority'), []);
        assert.deepEqual(db.store.stagedAttachments('authority', 'message-1'), []);
      });
    }
  }
});

test('attachment retries across restart reuse committed uploads and release staged bytes after preparation', async (t) => {
  const db = await database(t);
  const baseClient = client('epoch');
  const uploads = new Map<string, Awaited<ReturnType<typeof baseClient.ingestAttachment>>>();
  let loseCommitAck = true;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
    client: {
      ...baseClient,
      async ingestAttachment(input) {
        const uploadId = input.uploadId ?? randomUUID();
        const existing = uploads.get(uploadId);
        if (existing) return existing;
        const attachment = {
          ...(await baseClient.ingestAttachment(input)),
          ref: {
            kind: 'session_file' as const,
            sessionId: input.sessionId,
            relativePath: `artifacts/${uploadId}.txt`,
          },
        };
        uploads.set(uploadId, attachment);
        if (uploads.size === 2 && loseCommitAck) {
          loseCommitAck = false;
          throw new RuntimeHostRequestInterruptedError(
            'artifact.ingest',
            'command',
            'dispatched',
            'connection_lost',
          );
        }
        return attachment;
      },
    },
    submit: async () => accepted,
  };
  const makeService = () => {
    const service = new DesktopSessionLocalService(db.store, {
      targets: () => [target],
      changed() {},
      onError: (error) => assert.fail(String(error)),
    });
    db.beforeClose.push(() => service.close());
    return service;
  };
  const original = intent();
  db.store.enqueue('authority', { ...original, staged: [...original.staged, ...original.staged] });
  const first = makeService();
  first.wake();
  await waitFor(() => db.store.get('authority', 'message-1')?.error !== undefined);
  assert.equal(db.store.stagedAttachments('authority', 'message-1').length, 2);
  first.close();
  db.reopen();
  const resumed = makeService();
  resumed.wake();
  await waitFor(() => db.store.get('authority', 'message-1')?.state === 'accepted');
  assert.equal(uploads.size, 2);
  assert.deepEqual(db.store.get('authority', 'message-1')?.intent.command.content.attachments, [
    ...uploads.values(),
  ]);
  assert.deepEqual(db.store.stagedAttachments('authority', 'message-1'), []);
});

test('local creation preserves a plugin executor in the pending Session projection', async (t) => {
  const { store, beforeClose } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
  let create!: Parameters<Ipc['handle']>[1];
  registerDesktopSessionLocalIpc({
    ipcMain: {
      handle: (channel, handler) => {
        if (channel === 'session-local:create') create = handler;
      },
    },
    service,
    approvals: createAttachmentApprovalRegistry(),
    resizeImage: async (bytes) => bytes,
    resolveWorkspace: async () => ({ kind: 'host_path', path: '/workspace' }),
    changed() {},
  });

  const summary = (await create(
    {} as IpcMainInvokeEvent,
    target.scope,
    { executorId: 'codex.app-server', executorConfig: { model: 'picked-model', mode: 'default' } },
  )) as DesktopSessionSummaryInput;
  assert.equal(summary.backend, 'plugin-executor');
  assert.equal(summary.executorId, 'codex.app-server');
  assert.equal(summary.llmConnectionId, undefined);
  assert.equal(summary.llmConnectionSlug, 'executor:codex.app-server');
  assert.equal(summary.model, 'picked-model');
  assert.deepEqual(summary.executorConfig, { model: 'picked-model', mode: 'default' });
  assert.deepEqual(store.sessions(target.partition)[0]?.executorConfig, summary.executorConfig);
  assert.equal(store.creation(target.partition, summary.id)?.executorId, 'codex.app-server');
  const legacy = (await create(
    {} as IpcMainInvokeEvent,
    target.scope,
    { executorId: 'codex.app-server', model: 'legacy-model' },
  )) as DesktopSessionSummaryInput;
  assert.equal(legacy.model, 'legacy-model');
  const defaultModel = (await create(
    {} as IpcMainInvokeEvent,
    target.scope,
    { executorId: 'codex.app-server' },
  )) as DesktopSessionSummaryInput;
  assert.equal(defaultModel.model, 'codex.app-server');
});

test('local submit preserves picked-file approvals until durable admission succeeds', async (t) => {
  const { store, path, beforeClose } = await database(t);
  const file = join(path, '..', 'picked.txt');
  await writeFile(file, 'x');
  const approvals = createAttachmentApprovalRegistry();
  const [picked] = approvals.issueApprovals(7, [{ path: file, name: 'picked.txt', size: 1 }]);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target],
    changed() {},
    onError: (error) => assert.fail(String(error)),
  });
  beforeClose.push(() => service.close());
  type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
  let submit!: Parameters<Ipc['handle']>[1];
  let resizeCalls = 0;
  registerDesktopSessionLocalIpc({
    ipcMain: {
      handle: (channel, handler) => {
        if (channel === 'session-local:submit') submit = handler;
      },
    },
    service,
    approvals,
    resizeImage: async (bytes) => {
      resizeCalls++;
      return bytes;
    },
    resolveWorkspace: async () => {
      throw new Error('Unexpected workspace request');
    },
    changed() {},
  });
  for (let index = 0; index < 256; index++)
    store.enqueue('authority', { ...intent(`full-${index}`), staged: [] });
  const draft = {
    messageId: 'picked-message',
    text: 'hello',
    attachmentItems: [picked],
    localDisplayPlacement: 'current_turn',
  };
  const send = () =>
    submit(
      { sender: { id: 7 } } as IpcMainInvokeEvent,
      target.scope,
      'session-1',
      'next_turn',
      draft,
    );
  await assert.rejects(
    () => submit(
      { sender: { id: 7 } } as IpcMainInvokeEvent,
      target.scope,
      'session-1',
      'next_turn',
      { ...draft, messageId: 'invalid-display', localDisplayPlacement: 'later' },
    ),
    /Invalid local display placement/,
  );
  assert.equal(store.get('authority', 'invalid-display'), undefined);
  await assert.rejects(send, /Local message storage is full/);
  store.cancel('authority', 'full-0');
  await send();
  assert.equal(store.get('authority', 'picked-message')?.state, 'saved');
  assert.equal(store.get('authority', 'picked-message')?.intent.command.placement, 'next_turn');
  assert.equal(store.get('authority', 'picked-message')?.intent.localDisplayPlacement, 'current_turn');
  assert.equal(
    Buffer.from(store.stagedAttachments('authority', 'picked-message')[0]!.content).toString(),
    'x',
  );
  assert.equal(approvals.peekApproval(7, picked!.approvalId), null);

  // Individually valid files exceed the aggregate budget. Main must reject
  // their stat sizes before reading/resizing/encoding even the first image.
  const largeFiles = [];
  for (const name of ['first.png', 'second.png']) {
    const imagePath = join(path, '..', name);
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await truncate(imagePath, 33 * 1024 * 1024);
    largeFiles.push({ path: imagePath, name, size: 33 * 1024 * 1024 });
  }
  const largePicked = approvals.issueApprovals(7, largeFiles);
  assert.deepEqual(
    await submit(
      { sender: { id: 7 } } as IpcMainInvokeEvent,
      target.scope,
      'session-1',
      'current_turn',
      { ...draft, messageId: 'too-large', attachmentItems: largePicked },
    ),
    { ok: false, reason: 'attachment_blocked', code: 'total_size_exceeded' },
  );
  assert.equal(resizeCalls, 0);
  assert.equal(store.get('authority', 'too-large'), undefined);
  for (const item of largePicked) assert.ok(approvals.peekApproval(7, item.approvalId));
});


test('editing a preparation failure preserves bytes across restart and a new send', async (t) => {
  const db = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const source = db.store.enqueue(target.partition, intent());
  db.store.update({ ...source, state: 'failed' });
  db.reopen();
  assert.equal(db.store.get(target.partition, source.messageId)?.state, 'failed');
  const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  db.beforeClose.push(() => service.close());
  type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
  const handlers = new Map<string, Parameters<Ipc['handle']>[1]>();
  registerDesktopSessionLocalIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    service, approvals: createAttachmentApprovalRegistry(), resizeImage: async (bytes) => bytes,
    resolveWorkspace: async () => { throw new Error('Unexpected workspace request'); }, changed() {},
  });
  const event = { sender: { id: 7 } } as IpcMainInvokeEvent;
  const draft = projectLocalMessageDraft(await handlers.get('session-local:edit')!(
    event, target.scope, 'session-1', source.messageId,
  ));
  assert.deepEqual(draft.stagedAttachments, [{
    approvalId: draft.stagedAttachments[0]!.approvalId, name: 'note.txt', mimeType: 'text/plain', size: 14,
  }]);
  assert.match(draft.stagedAttachments[0]!.approvalId, /^local-recovery:/);
  assert.equal(draft.attachments.length, 0);
  assert.equal(db.store.get(target.partition, source.messageId)?.state, 'failed');
  const send = (messageId: string, senderId = 7, sessionId = 'session-1') => handlers.get('session-local:submit')!(
    { sender: { id: senderId } } as IpcMainInvokeEvent, target.scope, sessionId, 'current_turn',
    { messageId, text: 'edited', attachmentItems: draft.stagedAttachments },
  );
  const blocked = { ok: false, reason: 'attachment_blocked', code: 'source_expired' };
  assert.deepEqual(await send('wrong-window', 8), blocked);
  assert.deepEqual(await send('wrong-session', 7, 'session-2'), blocked);
  // A failed durable admission must not consume recovery approvals.
  for (let index = 0; index < 255; index++)
    db.store.enqueue(target.partition, { ...intent(`full-${index}`), staged: [] });
  await assert.rejects(() => send('edited-message'), /Local message storage is full/);
  // The restored composer owns a Main-only snapshot even if the original row is deleted.
  db.store.cancel(target.partition, source.messageId);
  assert.equal((await send('edited-message')).disposition, 'locally_saved');
  assert.equal(db.store.get(target.partition, 'edited-message')?.state, 'saved');
  assert.equal(Buffer.from(db.store.stagedAttachments(target.partition, 'edited-message')[0]!.content).toString(), 'original bytes');
  assert.deepEqual(await send('replayed-message'), blocked);
});

for (const outcome of ['saved', 'resize-failed', 'store-full', 'authority-changed'] as const) {
  test(`recovery release during async IPC preparation retains only the in-flight send (${outcome})`, async (t) => {
    const db = await database(t);
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    };
    let activeTarget = target;
    const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const source = db.store.enqueue(target.partition, {
      ...intent(), staged: [{ name: 'image.png', mimeType: 'image/png', base64: Buffer.from(image).toString('base64') }],
    });
    db.store.update({ ...source, state: 'failed' });
    if (outcome === 'store-full') {
      for (let index = 0; index < 255; index += 1)
        db.store.enqueue(target.partition, { ...intent(`full-${index}`), staged: [] });
    }
    const service = new DesktopSessionLocalService(db.store, {
      targets: () => [activeTarget], changed() {}, onError: assert.fail,
    });
    db.beforeClose.push(() => service.close());
    const pickedPath = join(db.path, '..', 'picked.txt');
    await writeFile(pickedPath, 'picked bytes');
    const approvals = createAttachmentApprovalRegistry();
    const [picked] = approvals.issueApprovals(7, [{ path: pickedPath, name: 'picked.txt', size: 12 }]);
    const enteredResize = deferred<void>();
    const finishResize = deferred<void>();
    type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
    const handlers = new Map<string, Parameters<Ipc['handle']>[1]>();
    registerDesktopSessionLocalIpc({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
      service, approvals,
      resizeImage: async (bytes) => { enteredResize.resolve(); await finishResize.promise; return bytes; },
      resolveWorkspace: async () => { throw new Error('Unexpected workspace request'); }, changed() {},
    });
    const event = { sender: { id: 7 } } as IpcMainInvokeEvent;
    const draft = projectLocalMessageDraft(await handlers.get('session-local:edit')!(
      event, target.scope, 'session-1', source.messageId,
    ));
    const recoveryIds = draft.stagedAttachments.map((approval) => approval.approvalId);
    const release = handlers.get('session-local:release-attachments')!;
    // Neither another window nor a malformed batch can release this draft.
    await release({ sender: { id: 8 } } as IpcMainInvokeEvent, recoveryIds);
    assert.throws(() => release(event, [...recoveryIds, null]), AttachmentIngestBlockedError);
    const fillerOwner = { senderId: 7, partition: target.partition, scope: target.scope, sessionId: 'session-1' };
    const filler = { name: 'filler.txt', mimeType: 'text/plain', content: Uint8Array.of(1) };
    for (let count = 0; count < 999; count += 1) service.attachmentRecovery.issue(fillerOwner, [filler]);
    assert.deepEqual(await handlers.get('session-local:submit')!(event, target.scope, 'session-1', 'current_turn', {
      messageId: 'invalid-source', text: 'invalid source',
      attachmentItems: [...draft.stagedAttachments, { approvalId: 'missing-native-approval', name: 'missing.txt' }],
    }), { ok: false, reason: 'attachment_blocked', code: 'source_expired' },
    'ingest validation failure must dispose its recovery lease without consuming the draft');
    const pending = handlers.get('session-local:submit')!(event, target.scope, 'session-1', 'current_turn', {
      messageId: 'edited', text: 'edited', attachmentItems: [...draft.stagedAttachments, picked],
    }) as Promise<{ disposition: string }>;
    await enteredResize.promise;
    await release(event, [...recoveryIds, picked.approvalId]);
    assert.ok(approvals.peekApproval(7, picked.approvalId), 'recovery cleanup cannot release ordinary approvals');
    assert.throws(() => service.attachmentRecovery.issue(fillerOwner, [filler]), AttachmentIngestBlockedError,
      'the in-flight snapshot remains counted until the lease settles');
    assert.deepEqual(await handlers.get('session-local:submit')!(event, target.scope, 'session-1', 'current_turn', {
      messageId: 'replayed', text: 'replayed', attachmentItems: draft.stagedAttachments,
    }), { ok: false, reason: 'attachment_blocked', code: 'source_expired' });
    if (outcome === 'authority-changed') activeTarget = { ...target, partition: 'replacement-authority' };
    if (outcome === 'resize-failed') {
      const rejected = assert.rejects(pending, /resize failed/);
      finishResize.reject(new Error('resize failed'));
      await rejected;
    } else {
      finishResize.resolve();
      if (outcome === 'saved') assert.equal((await pending).disposition, 'locally_saved');
      else await assert.rejects(pending, outcome === 'store-full' ? /Local message storage is full/ : /Host authority changed/);
    }
    assert.equal(service.attachmentRecovery.issue(fillerOwner, [filler]).length, 1,
      'success and every failure path release the abandoned snapshot lease');
    await release(event, recoveryIds);
    if (outcome === 'saved') {
      assert.deepEqual(db.store.stagedAttachments(target.partition, 'edited')[0].content, image);
      assert.equal(approvals.peekApproval(7, picked.approvalId), null);
    } else {
      assert.equal(db.store.get(target.partition, 'edited'), undefined);
      assert.ok(approvals.peekApproval(7, picked.approvalId));
    }
  });
}

test('preload recovery projection rejects raw attachment bytes rather than forwarding them', () => {
  const draft: DesktopLocalMessageDraft = {
    messageId: 'failed', text: 'draft', attachments: [], directoryReferences: [], quotes: [], inlineReferences: [],
    stagedAttachments: [{ approvalId: 'local-recovery:test', name: 'note.txt', mimeType: 'text/plain', size: 1 }],
  };
  assert.deepEqual(projectLocalMessageDraft(draft), draft);
  for (const leaked of [
    { content: new Uint8Array([42]) }, { base64: 'Kg==' }, { path: '/secret/note.txt' },
    { bytes: { type: 'Buffer', data: [42] } },
  ]) {
    assert.throws(() => projectLocalMessageDraft({
      ...draft, stagedAttachments: [{ ...draft.stagedAttachments[0]!, ...leaked }],
    }), /Invalid local attachment recovery approval/);
  }
  assert.throws(() => projectLocalMessageDraft({
    ...draft, stagedAttachments: [{ name: 'note.txt', mimeType: 'text/plain', content: new Uint8Array([42]) }],
  } as unknown as DesktopLocalMessageDraft), /Invalid local attachment recovery approval/);
});

test('editing a one-shot orchestration failure restores the slash command before skills and references', async (t) => {
  const { store } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => service.close());
  for (const mode of ['swarm', 'graph'] as const) {
    const source = store.enqueue(target.partition, {
      ...intent(mode),
      command: { ...intent(mode).command, turnOrchestration: { mode, source: 'slash_command' },
        skillIds: ['audit'], content: { text: 'audit repository',
          inlineReferences: [{ kind: 'workspace_file', value: 'repository', label: 'repository', start: 6 }] } },
    });
    store.update({ ...source, state: 'failed' });
    const draft = service.readFailedMessage(target, 'session-1', mode, 7);
    assert.equal(draft.text, `/${mode} /skill:audit audit repository`);
    assert.equal(draft.inlineReferences[0]?.start, draft.text.indexOf('repository'));
    assert.deepEqual(parseDesktopSlashCommand(draft.text), {
      kind: mode, command: { kind: 'run_once', task: '/skill:audit audit repository' },
    });
    assert.equal(store.get(target.partition, mode)?.state, 'failed');
  }
});

test('Host retraction proof is scoped and remains retired after restart while offline', async (t) => {
  const db = await database(t);
  const scope = { hostId: 'root', targetEpoch: 'target' };
  const target: DesktopSessionLocalTarget = { partition: 'authority', profileId: 'profile', scope };
  for (const [partition, sessionId, messageId, epoch] of [
    ['authority', 'session-1', 'cancelled', 'epoch'],
    ['authority', 'session-2', 'other-session', 'epoch'],
    ['authority', 'session-1', 'other-epoch', 'older'],
    ['other-authority', 'session-1', 'cancelled', 'epoch'],
  ]) {
    const record = db.store.enqueue(partition!, intent(messageId!, sessionId!));
    db.store.update({ ...record, state: 'accepted', intent: { ...record.intent, originHostEpoch: epoch } });
  }
  const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  service.retireCancelledMessages({ ...scope, targetEpoch: 'stale' }, 'session-1', ['cancelled']);
  assert.ok(db.store.get('authority', 'cancelled'));
  service.retireCancelledMessages(scope, 'session-1', ['cancelled', 'other-session', 'other-epoch']);
  service.close();
  db.reopen();
  const offline = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => offline.close());
  assert.deepEqual(offline.listMessages(target, 'session-1'), []);
  assert.equal(offline.listMessages(target, 'session-2').length, 1);
  assert.ok(db.store.get('other-authority', 'cancelled'));
  assert.equal(db.store.stagedAttachments('authority', 'cancelled').length, 0);
});

test('durable cancellation proof retires an old Host epoch without crossing authority or session boundaries', async (t) => {
  const db = await database(t);
  const scope = { hostId: 'root', targetEpoch: 'new-target' };
  const target: DesktopSessionLocalTarget = { partition: 'authority', profileId: 'profile', scope };
  for (const [partition, sessionId, messageId] of [
    ['authority', 'session-1', 'cancelled'],
    ['authority', 'session-1', 'not-cancelled'],
    ['authority', 'session-2', 'other-session'],
    ['other-authority', 'session-1', 'cancelled'],
  ]) {
    const record = db.store.enqueue(partition!, intent(messageId!, sessionId!));
    db.store.update({ ...record, state: 'accepted', intent: { ...record.intent, originHostEpoch: 'old-epoch' } });
  }
  db.store.enqueue('authority', intent('never-dispatched'));
  const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  service.retireCancelledMessages({ ...scope, targetEpoch: 'stale-target' }, 'session-1', ['cancelled']);
  assert.ok(db.store.get('authority', 'cancelled'));
  service.retireCancelledMessages(scope, 'session-1', ['cancelled', 'other-session', 'never-dispatched']);
  service.close();
  db.reopen();
  assert.equal(db.store.get('authority', 'cancelled'), undefined);
  assert.equal(db.store.stagedAttachments('authority', 'cancelled').length, 0);
  assert.ok(db.store.get('authority', 'not-cancelled'));
  assert.ok(db.store.get('authority', 'never-dispatched'));
  assert.ok(db.store.get('authority', 'other-session'));
  assert.ok(db.store.get('other-authority', 'cancelled'));
});

test('cancellation cleanup preserves an already scheduled canonical transcript cache write', async (t) => {
  for (const epoch of ['epoch', 'old-epoch']) {
    const db = await database(t);
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    };
    const record = db.store.enqueue('authority', intent('cancelled'));
    db.store.update({ ...record, state: 'accepted', intent: { ...record.intent, originHostEpoch: epoch } });
    const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
    db.beforeClose.push(() => service.close());
    service.cacheTranscript(target.scope, {
      sessionId: 'session-1', generation: 'generation', hostEpoch: 'epoch', durableThrough: 1,
      durable: [{ sequence: 1, message: { type: 'user', id: 'completed', turnId: 'turn-1', ts: 1, text: 'keep history' } }],
      hasOlder: false, beginsAtTurnBoundary: true,
    });
    service.retireCancelledMessages(target.scope, 'session-1', ['cancelled']);
    await nextTurn();
    service.close();
    db.reopen();
    assert.equal(db.store.get('authority', 'cancelled'), undefined);
    assert.equal(db.store.transcript('authority', 'session-1')?.snapshot.durable[0]?.message.id, 'completed');
  }
});

test('retraction before the submit ACK fences the late completion without recreating the intent', async (t) => {
  const { store } = await database(t);
  const ack = deferred<TurnMessageSubmitResult>();
  let dispatched = false;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    client: client('epoch'), submit: async () => { dispatched = true; return ack.promise; },
  };
  const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => service.close());
  store.enqueue('authority', { ...intent(), staged: [] });
  service.wake();
  await waitFor(() => dispatched);
  service.retireCancelledMessages(target.scope, 'session-1', ['message-1']);
  ack.resolve(accepted);
  await nextTurn();
  await nextTurn();
  assert.equal(store.get('authority', 'message-1'), undefined);
});

for (const outcome of ['accepted', 'rejected', 'execution-proof'] as const) {
  test(`not_admitted settlement fences a late ${outcome} completion without discarding the local copy`, async (t) => {
    const db = await database(t);
    const ack = deferred<TurnMessageSubmitResult>();
    const proof = deferred<{ resolutions: [{ messageId: string; state: 'owned'; turnId: string; runId: string }] }>();
    let dispatched = false;
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
      client: {
        ...client('epoch'),
        queryMessageExecutions: async () => { dispatched = true; return proof.promise; },
      },
      submit: async () => { dispatched = true; return ack.promise; },
    };
    const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
    db.beforeClose.push(() => service.close());
    const record = db.store.enqueue('authority', { ...intent(), staged: [] });
    if (outcome === 'execution-proof') db.store.update({
      ...record, state: 'unknown', intent: { ...record.intent, originHostEpoch: 'old-epoch' },
    });
    service.wake();
    await waitFor(() => dispatched);
    service.failNotAdmittedMessages({ ...target.scope, targetEpoch: 'retired' }, 'session-1', ['message-1']);
    assert.notEqual(db.store.get('authority', 'message-1')?.state, 'failed');
    service.failNotAdmittedMessages(target.scope, 'session-1', ['message-1']);
    if (outcome === 'rejected') ack.reject(new Error('late interrupted submit'));
    else if (outcome === 'execution-proof') proof.resolve({
      resolutions: [{ messageId: 'message-1', state: 'owned', turnId: 'turn-1', runId: 'run-1' }],
    });
    else ack.resolve(accepted);
    await nextTurn();
    await nextTurn();
    service.close();
    db.reopen();
    assert.equal(db.store.get('authority', 'message-1')?.state, 'failed');
    assert.equal(db.store.get('authority', 'message-1')?.intent.command.content.text, 'hello');
    assert.equal(db.store.get('authority', 'message-1')?.result, undefined);
    assert.match(db.store.get('authority', 'message-1')?.error ?? '', /never admitted/);
  });
}

test('repeated not_admitted proof refreshes an already failed dispatched row without crossing ownership', async (t) => {
  const { store, beforeClose } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const changed: string[] = [];
  const service = new DesktopSessionLocalService(store, {
    targets: () => [target], changed: (_scope, sessionId) => { changed.push(sessionId!); }, onError: assert.fail,
  });
  beforeClose.push(() => service.close());
  for (const [partition, sessionId, messageId, dispatched] of [
    ['authority', 'session-1', 'failed', true],
    ['authority', 'session-1', 'never-dispatched', false],
    ['authority', 'session-2', 'other-session', true],
    ['other-authority', 'session-1', 'other-authority', true],
  ] as const) {
    const row = store.enqueue(partition, intent(messageId, sessionId));
    store.update({ ...row, state: 'failed', intent: { ...row.intent, ...(dispatched ? { originHostEpoch: 'old-epoch' } : {}) } });
  }
  service.failNotAdmittedMessages({ ...target.scope, targetEpoch: 'retired' }, 'session-1', ['failed']);
  service.failNotAdmittedMessages(target.scope, 'session-1', ['never-dispatched', 'other-session', 'other-authority', 'missing']);
  assert.deepEqual(changed, []);
  service.failNotAdmittedMessages(target.scope, 'session-1', ['failed']);
  service.failNotAdmittedMessages(target.scope, 'session-1', ['failed']);
  assert.deepEqual(changed, ['session-1', 'session-1']);
  assert.equal(store.get('authority', 'failed')?.state, 'failed');
  assert.equal(store.stagedAttachments('authority', 'failed').length, 1);
  store.cancel('authority', 'failed');
  service.failNotAdmittedMessages(target.scope, 'session-1', ['failed']);
  assert.equal(changed.length, 2, 'removed rows are never recreated or advertised as recoverable');
});

test('editing a never-dispatched draft retains a paused durable original and its attachment bytes', async (t) => {
  const { store } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => service.close());
  const source = store.enqueue(target.partition, intent());
  assert.throws(() => service.cancelUnsentToDraft(target, 'other-session', source.messageId, 7), /never-dispatched/);
  assert.ok(store.get(target.partition, source.messageId));
  const draft = service.cancelUnsentToDraft(target, 'session-1', source.messageId, 7);
  assert.equal(draft.text, 'hello');
  assert.equal(draft.stagedAttachments.length, 1);
  assert.deepEqual(projectLocalMessageDraft(draft), draft, 'only opaque approvals cross the preload boundary');
  assert.equal(store.get(target.partition, source.messageId)?.state, 'paused');
  assert.equal(draft.replacesLocalMessageId, source.messageId);
  assert.equal(store.stagedAttachments(target.partition, source.messageId).length, 1);
  const owner = { senderId: 7, partition: target.partition, scope: target.scope, sessionId: 'session-1' };
  assert.throws(() => service.attachmentRecovery.prepare({ ...owner, senderId: 8 }, draft.stagedAttachments), AttachmentIngestBlockedError);
  const prepared = service.attachmentRecovery.prepare(owner, draft.stagedAttachments);
  assert.deepEqual(prepared.items, intent().staged);
  prepared.commit(() => undefined);
  prepared.dispose();
  assert.throws(() => service.attachmentRecovery.prepare(owner, draft.stagedAttachments), AttachmentIngestBlockedError);
});

test('paused storage is inert to legacy readers while new readers retain pause semantics', async (t) => {
  const db = await database(t);
  const original = db.store.enqueue('authority', intent());
  db.store.update({ ...original, state: 'paused' });
  const raw = new DatabaseSync(db.path);
  db.beforeClose.push(() => raw.close());
  const row = () => raw.prepare('SELECT state, payload FROM outbox WHERE message_id = ?').get('message-1')!;
  assert.equal(row().state, 'failed', 'older delivery workers already skip failed records');
  assert.equal(JSON.parse(String(row().payload)).state, 'paused', 'the payload retains the new semantic state');
  assert.equal(db.store.get('authority', 'message-1')?.state, 'paused');
  assert.equal(db.store.list('authority')[0]?.state, 'paused');
  db.reopen();
  assert.equal(db.store.get('authority', 'message-1')?.state, 'paused');
  // A genuine failure, including an explicit write by an older reader, must
  // not inherit a pause marker from an earlier version of the record.
  const legacyRecord = { ...JSON.parse(String(row().payload)), state: row().state };
  raw.prepare('UPDATE outbox SET payload = ? WHERE message_id = ?').run(JSON.stringify(legacyRecord), 'message-1');
  assert.equal(db.store.get('authority', 'message-1')?.state, 'failed');
  db.store.update({ ...original, state: 'paused' });
  db.store.update({ ...db.store.get('authority', 'message-1')!, state: 'saved' });
  assert.equal(row().state, 'saved');
  assert.equal(JSON.parse(String(row().payload)).state, 'saved');
  assert.equal(db.reopen().get('authority', 'message-1')?.state, 'saved');
});

test('opening an existing paused database migrates only its storage state and preserves bytes', async (t) => {
  const db = await database(t);
  const original = db.store.enqueue('authority', intent());
  db.store.update({ ...original, state: 'paused' });
  const failed = db.store.enqueue('authority', intent('failed'));
  db.store.update({ ...failed, state: 'failed', error: 'real failure' });
  const raw = new DatabaseSync(db.path);
  db.beforeClose.push(() => raw.close());
  // Simulate the previously shipped paused representation.
  raw.prepare("UPDATE outbox SET state = 'paused' WHERE message_id = ?").run('message-1');
  const before = db.store.get('authority', 'message-1');
  const bytes = db.store.stagedAttachments('authority', 'message-1');
  db.reopen();
  assert.equal(raw.prepare('SELECT state FROM outbox WHERE message_id = ?').get('message-1')?.state, 'failed');
  assert.deepEqual(db.store.get('authority', 'message-1'), before);
  assert.deepEqual(db.store.stagedAttachments('authority', 'message-1'), bytes);
  assert.equal(db.store.get('authority', 'failed')?.state, 'failed');
  assert.equal(db.store.get('authority', 'failed')?.error, 'real failure');
  assert.deepEqual(db.reopen().get('authority', 'message-1'), before, 'migration is idempotent');
  db.store.cancel('authority', 'message-1');
  assert.equal(db.reopen().get('authority', 'message-1'), undefined);
});

test('paused originals survive approval expiry and restart without dispatching until explicitly resumed', async (t) => {
  const db = await database(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const submitted: string[] = [];
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    client: client('epoch'), submit: async (command) => { submitted.push(command.messageId); return accepted; },
  };
  let service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  db.beforeClose.push(() => service.close());
  db.store.enqueue(target.partition, intent());
  const draft = service.cancelUnsentToDraft(target, 'session-1', 'message-1', 7);
  now += 31 * 60 * 1000;
  const owner = { senderId: 7, partition: target.partition, scope: target.scope, sessionId: 'session-1' };
  assert.throws(() => service.attachmentRecovery.prepare(owner, draft.stagedAttachments), AttachmentIngestBlockedError);
  const renewed = service.cancelUnsentToDraft(target, 'session-1', 'message-1', 7);
  const prepared = service.attachmentRecovery.prepare(owner, renewed.stagedAttachments);
  assert.deepEqual(prepared.items, intent().staged);
  prepared.dispose();
  service.close();
  db.reopen();
  service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  service.wake();
  await nextTurn(); await nextTurn();
  assert.deepEqual(submitted, []);
  assert.equal(db.store.get(target.partition, 'message-1')?.state, 'paused');
  assert.equal(service.cancelUnsentToDraft(target, 'session-1', 'message-1', 7).stagedAttachments.length, 1);
  assert.throws(() => service.resumeMessage(target, 'other-session', 'message-1'), /paused/);
  service.resumeMessage(target, 'session-1', 'message-1');
  service.wake();
  await nextTurn(); await nextTurn();
  assert.deepEqual(submitted, ['message-1']);
  assert.equal(db.store.get(target.partition, 'message-1')?.state, 'accepted');
});

test('editing fences an in-flight attachment upload and retains bytes instead of dispatching', async (t) => {
  const db = await database(t);
  const entered = deferred<void>();
  const uploaded = deferred<void>();
  const base = client('epoch');
  let submits = 0;
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    client: { ...base, ingestAttachment: async (input) => {
      entered.resolve(); await uploaded.promise; return base.ingestAttachment(input);
    } },
    submit: async () => { submits++; return accepted; },
  };
  const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  db.beforeClose.push(() => service.close());
  db.store.enqueue(target.partition, intent());
  service.wake();
  await entered.promise;
  service.cancelUnsentToDraft(target, 'session-1', 'message-1', 7);
  uploaded.resolve();
  await nextTurn(); await nextTurn();
  assert.equal(submits, 0);
  assert.equal(db.store.get(target.partition, 'message-1')?.state, 'paused');
  assert.equal(Buffer.from(db.store.stagedAttachments(target.partition, 'message-1')[0]!.content).toString(), 'original bytes');
  // A paused original does not block unrelated later input in the same Session.
  db.store.enqueue(target.partition, { ...intent('later'), staged: [] });
  service.wake();
  await nextTurn(); await nextTurn();
  assert.equal(submits, 1);
  assert.equal(db.store.get(target.partition, 'message-1')?.state, 'paused');
});

test('local submit atomically replaces only a paused original, retaining it on failure', async (t) => {
  const db = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  db.beforeClose.push(() => service.close());
  db.store.enqueue(target.partition, intent());
  type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
  const handlers = new Map<string, Parameters<Ipc['handle']>[1]>();
  registerDesktopSessionLocalIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    service, approvals: createAttachmentApprovalRegistry(), resizeImage: async (bytes) => bytes,
    resolveWorkspace: async () => { throw new Error('Unexpected workspace request'); }, changed() {},
  });
  const event = { sender: { id: 7 } } as IpcMainInvokeEvent;
  const draft = projectLocalMessageDraft(await handlers.get('session-local:cancel')!(
    event, target.scope, 'session-1', 'message-1', { restoreDraft: true },
  ));
  const submit = (messageId: string, attachmentItems = draft.stagedAttachments, sessionId = 'session-1') =>
    handlers.get('session-local:submit')!(event, target.scope, sessionId, 'next_turn', {
      messageId, text: 'edited input', replacesLocalMessageId: draft.replacesLocalMessageId, attachmentItems,
    });
  assert.deepEqual(await submit('bad-attachment', [{ approvalId: 'local-recovery:expired', name: 'lost', size: 1 }]),
    { ok: false, reason: 'attachment_blocked', code: 'source_expired' });
  await assert.rejects(() => submit('wrong-session', [], 'session-2'), /no longer paused/);
  assert.equal(db.store.get(target.partition, 'message-1')?.state, 'paused');
  assert.equal(db.store.stagedAttachments(target.partition, 'message-1').length, 1);
  const connection = new DatabaseSync(db.path);
  try {
    connection.exec("CREATE TRIGGER reject_replacement BEFORE INSERT ON outbox WHEN NEW.message_id = 'replacement' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    await assert.rejects(() => submit('replacement'), /injected write failure/);
    assert.equal(db.store.get(target.partition, 'message-1')?.state, 'paused', 'rollback restores the deleted source row');
    assert.equal(db.store.stagedAttachments(target.partition, 'message-1').length, 1, 'cascade deletion also rolls back');
    assert.equal(db.store.get(target.partition, 'replacement'), undefined);
    connection.exec('DROP TRIGGER reject_replacement');
  } finally { connection.close(); }
  // Replacing one entry at the quota must not need space for a duplicate copy.
  for (let index = 0; index < 255; index++) db.store.enqueue(target.partition, { ...intent(`full-${index}`), staged: [] });
  assert.equal((await submit('replacement')).disposition, 'locally_saved');
  assert.equal(db.store.get(target.partition, 'message-1'), undefined);
  assert.equal(db.store.get(target.partition, 'replacement')?.state, 'saved');
  assert.equal(Buffer.from(db.store.stagedAttachments(target.partition, 'replacement')[0]!.content).toString(), 'original bytes');
  await assert.rejects(() => submit('duplicate', []), /no longer paused/);
  assert.equal(db.store.get(target.partition, 'duplicate'), undefined);
  service.close(); db.reopen();
  assert.equal(db.store.get(target.partition, 'message-1'), undefined);
  assert.equal(db.store.get(target.partition, 'replacement')?.state, 'saved');
});

test('withdrawing for editing never cancels dispatched or uncertain messages', async (t) => {
  const { store } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => service.close());
  for (const state of ['saved', 'sending', 'unknown', 'accepted', 'failed'] as const) {
    const source = store.enqueue(target.partition, intent(state));
    store.update({ ...source, state, intent: { ...source.intent, originHostEpoch: 'epoch' } });
    assert.throws(() => service.cancelUnsentToDraft(target, 'session-1', state, 7), /never-dispatched/);
    assert.ok(store.get(target.partition, state));
    assert.equal(store.stagedAttachments(target.partition, state).length, 1);
  }
});

test('editing a submitted failure retains references and rejects unsettled or differently owned messages', async (t) => {
  const { store } = await database(t);
  const target: DesktopSessionLocalTarget = {
    partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
  };
  const source = store.enqueue(target.partition, intent());
  const attachment = await client('epoch').ingestAttachment({ sessionId: 'session-1', uploadId: 'upload', name: 'note.txt', mimeType: 'text/plain', content: Buffer.from('original bytes') });
  store.update({ ...source, state: 'failed', intent: { ...source.intent, attachmentsPrepared: true, originHostEpoch: 'epoch', command: { ...source.intent.command, content: { text: 'hello', attachments: [attachment] } } } });
  const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => service.close());
  const draft = service.readFailedMessage(target, 'session-1', source.messageId, 7);
  assert.deepEqual(draft.attachments, [attachment]);
  assert.deepEqual(draft.stagedAttachments, []);
  assert.throws(() => service.readFailedMessage(target, 'other-session', source.messageId, 7), /definitively failed/);
  assert.throws(() => service.readFailedMessage({ ...target, partition: 'other-authority' }, 'session-1', source.messageId, 7), /definitively failed/);
  for (const state of ['saved', 'sending', 'unknown', 'accepted'] as const) {
    store.update({ ...store.get(target.partition, source.messageId)!, state });
    assert.throws(() => service.readFailedMessage(target, 'session-1', source.messageId, 7), /definitively failed/);
  }
});
