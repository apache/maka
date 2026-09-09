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
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { IpcMainInvokeEvent } from 'electron';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import type { TurnMessageSubmitInput, TurnMessageSubmitResult } from '@maka/runtime-host/protocol';
import { DesktopSessionLocalStore, type LocalMessageIntent } from '../session-local-store.js';
import {
  DesktopSessionLocalService,
  desktopSessionLocalPartition,
  registerDesktopSessionLocalIpc,
  type DesktopSessionLocalTarget,
} from '../session-local-service.js';
import type { DesktopSessionSummaryInput } from '../../shared/desktop-session-projection.js';
import type { DesktopTranscriptReplicaSnapshot } from '../desktop-transcript-replica.js';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { parseDesktopSlashCommand } from '../../renderer/desktop-slash-command.js';

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
  // Windows reports synthetic mode bits; chmod permissions are a POSIX assertion.
  if (process.platform !== 'win32') assert.equal((await stat(db.path)).mode & 0o777, 0o600);
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
  const listed =
    deferred<
      Awaited<ReturnType<NonNullable<DesktopSessionLocalTarget['client']>['listSessions']>>
    >();
  const target: DesktopSessionLocalTarget = {
    partition: 'authority',
    profileId: 'profile',
    scope: { hostId: 'root', targetEpoch: 'target' },
    client: { ...client('epoch'), listSessions: () => listed.promise },
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
  assert.equal(calls.length, 0);
  target = {
    ...target,
    client: client('epoch-1'),
    submit: async (input) => {
      calls.push(input);
      return accepted;
    },
  };
  service.wake();
  await waitFor(() => store.get('authority', 'message-1')?.state === 'accepted');
  assert.equal(calls.length, 1);
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
  assert.throws(() => service.readFailedMessage(target, 'session-1', 'message-1'), /definitively failed/);
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

test('cache restoration never includes live overlay and expires independently of the outbox', async (t) => {
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
    overlay: [{ type: 'user', id: 'live-1', turnId: 'turn', ts: 2, text: 'in flight' }],
    hasOlder: false,
    hasNewer: false,
  });
  assert.deepEqual(store.transcript('authority', 'session-1')?.snapshot.overlay, []);
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
          overlay: [],
          hasOlder: false,
          hasNewer: false,
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
  const draft = { messageId: 'picked-message', text: 'hello', attachmentItems: [picked] };
  const send = () =>
    submit(
      { sender: { id: 7 } } as IpcMainInvokeEvent,
      target.scope,
      'session-1',
      'current_turn',
      draft,
    );
  await assert.rejects(send, /Local message storage is full/);
  store.cancel('authority', 'full-0');
  await send();
  assert.equal(store.get('authority', 'picked-message')?.state, 'saved');
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
  await assert.rejects(
    () =>
      submit(
        { sender: { id: 7 } } as IpcMainInvokeEvent,
        target.scope,
        'session-1',
        'current_turn',
        { ...draft, messageId: 'too-large', attachmentItems: largePicked },
      ),
    /attachment_ingest:total_size_exceeded/,
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
  const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  const draft = service.readFailedMessage(target, 'session-1', source.messageId);
  assert.equal(Buffer.from(draft.stagedAttachments[0]!.content).toString(), 'original bytes');
  assert.equal(draft.attachments.length, 0);
  assert.equal(db.store.get(target.partition, source.messageId)?.state, 'failed');
  service.close();
  db.reopen();
  assert.equal(db.store.get(target.partition, source.messageId)?.state, 'failed');
  const resend = db.store.enqueue(target.partition, {
    command: { sessionId: 'session-1', messageId: 'edited-message', placement: 'current_turn', content: { text: 'edited', attachments: [...draft.attachments] } },
    staged: draft.stagedAttachments.map((item) => ({ name: item.name, mimeType: item.mimeType, base64: Buffer.from(item.content).toString('base64') })),
  });
  assert.equal(resend.state, 'saved');
  assert.equal(Buffer.from(db.store.stagedAttachments(target.partition, resend.messageId)[0]!.content).toString(), 'original bytes');
  db.store.cancel(target.partition, source.messageId);
  assert.equal(db.store.get(target.partition, resend.messageId)?.state, 'saved');
  assert.equal(db.store.stagedAttachments(target.partition, resend.messageId).length, 1);
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
    const draft = service.readFailedMessage(target, 'session-1', mode);
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
  service.retireRetractedMessages({ ...scope, targetEpoch: 'stale' }, 'epoch', 'session-1', ['cancelled']);
  assert.ok(db.store.get('authority', 'cancelled'));
  service.retireRetractedMessages(scope, 'epoch', 'session-1', ['cancelled', 'other-session', 'other-epoch']);
  service.close();
  db.reopen();
  const offline = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
  t.after(() => offline.close());
  assert.deepEqual(offline.listMessages(target, 'session-1').map((message) => message.messageId), ['other-epoch']);
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
  service.retireRetractedMessages(scope, 'new-epoch', 'session-1', ['cancelled']);
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
  for (const durable of [false, true]) {
    const db = await database(t);
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    };
    const record = db.store.enqueue('authority', intent('cancelled'));
    db.store.update({ ...record, state: 'accepted', intent: { ...record.intent, originHostEpoch: 'epoch' } });
    const service = new DesktopSessionLocalService(db.store, { targets: () => [target], changed() {}, onError: assert.fail });
    db.beforeClose.push(() => service.close());
    service.cacheTranscript(target.scope, {
      sessionId: 'session-1', generation: 'generation', hostEpoch: 'epoch', durableThrough: 1,
      durable: [{ sequence: 1, message: { type: 'user', id: 'completed', turnId: 'turn-1', ts: 1, text: 'keep history' } }],
      overlay: [], hasOlder: false, hasNewer: false,
    });
    if (durable) service.retireCancelledMessages(target.scope, 'session-1', ['cancelled']);
    else service.retireRetractedMessages(target.scope, 'epoch', 'session-1', ['cancelled']);
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
  service.retireRetractedMessages(target.scope, 'epoch', 'session-1', ['message-1']);
  ack.resolve(accepted);
  await nextTurn();
  await nextTurn();
  assert.equal(store.get('authority', 'message-1'), undefined);
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
  const draft = service.readFailedMessage(target, 'session-1', source.messageId);
  assert.deepEqual(draft.attachments, [attachment]);
  assert.deepEqual(draft.stagedAttachments, []);
  assert.throws(() => service.readFailedMessage(target, 'other-session', source.messageId), /definitively failed/);
  assert.throws(() => service.readFailedMessage({ ...target, partition: 'other-authority' }, 'session-1', source.messageId), /definitively failed/);
  for (const state of ['saved', 'sending', 'unknown', 'accepted'] as const) {
    store.update({ ...store.get(target.partition, source.messageId)!, state });
    assert.throws(() => service.readFailedMessage(target, 'session-1', source.messageId), /definitively failed/);
  }
});
