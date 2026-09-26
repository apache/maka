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
import type { SessionCreateInput, TurnMessageSubmitInput, TurnMessageSubmitResult } from '@maka/runtime-host/protocol';
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
import { parseDesktopSlashCommand } from '../../renderer/desktop-slash-command.js';
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
    { executorId: 'codex.app-server' },
  )) as DesktopSessionSummaryInput;
  assert.equal(summary.backend, 'plugin-executor');
  assert.equal(summary.executorId, 'codex.app-server');
  assert.equal(summary.llmConnectionId, undefined);
  assert.equal(summary.llmConnectionSlug, 'executor:codex.app-server');
  assert.equal(summary.model, 'codex.app-server');
  assert.equal(store.creation(target.partition, summary.id)?.executorId, 'codex.app-server');
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
