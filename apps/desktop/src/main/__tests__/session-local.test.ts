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
  assert.equal((await stat(db.path)).mode & 0o777, 0o600);
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
    /附件总量超出大小限制/,
  );
  assert.equal(resizeCalls, 0);
  assert.equal(store.get('authority', 'too-large'), undefined);
  for (const item of largePicked) assert.ok(approvals.peekApproval(7, item.approvalId));
});
