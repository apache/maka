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
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withTimeout } from '@maka/core/test-only/async-primitives';
import type { AttachmentRef } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { PendingMessageAdmission } from '@maka/storage/execution-stores';
import {
  openStorageWriterComposition,
  type StorageWriterComposition,
} from '@maka/storage/storage-writer-composition';
import {
  resolveStorageRoot,
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import type {
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidatesResult,
} from '../protocol/index.js';
import { connectClient, waitForTerminalTurn } from './fixtures/execution-host-suite.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

type Notice =
  | { type: 'ready'; hostEpoch: string }
  | { type: 'assignment_failed' }
  | {
      type: 'assignment_committed';
      assignment: WorkHubDelegationAssignedMessage;
      admission: PendingMessageAdmission;
      targetCreated: boolean;
    }
  | {
      type: 'dispatch';
      sessionId: string;
      turnId: string;
      text: string;
      attachments: AttachmentRef[];
    };

const TIMEOUT = 15_000;
const ATTACHMENT_TEXT = 'Durable requirements: resume exactly this submitted message.';

// This is a real process loss at a precise durable boundary, not a close/reopen
// simulation. A fresh Host acquires a fresh lease and runs production recovery.
for (const disposition of ['create_new', 'delegate_existing'] as const) {
  for (const withAttachment of [false, true]) {
    test(`WorkHub ${disposition} survives commit-before-dispatch process death (attachment=${withAttachment})`, {
      timeout: 60_000,
    }, async () => {
      const base = await mkdtemp(join(tmpdir(), 'maka-workhub-crash-'));
      const root = join(base, 'root');
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const children: HostProcess[] = [];
      const clients: RuntimeHostConnection[] = [];
      try {
        await withStores(capability, configureDefaultTarget);
        const first = new HostProcess(root, capability.rootId, 'crash');
        children.push(first);
        const firstReady = await first.wait('ready');
        const client = await connectClient(root);
        clients.push(client);
        await client.request('workhub.coordination.resolve', {});
        const action: WorkHubCoordinationActInput = {
          actionId: 'durable-delegation',
          userText:
            disposition === 'create_new'
              ? 'Create a new task to review the durable requirements'
              : 'Review the durable requirements',
          proposal: { disposition: 'create_new', title: 'Requirements' },
          create: { workspace: { kind: 'host_path', path: root } },
        };
        if (disposition === 'delegate_existing') {
          await client.request('session.create', {
            sessionId: 'existing-target',
            name: 'Requirements',
            workspace: { kind: 'host_path', path: root },
            modelTarget: { kind: 'default' },
          });
          const candidates = await client.request('workhub.coordination.candidates', {});
          const target = candidates.candidates.find((c) => c.sessionId === 'existing-target');
          assert.ok(target);
          Object.assign(action, {
            proposal: { disposition, candidateRef: target.candidateRef },
            candidateSetId: candidates.candidateSetId,
            create: undefined,
          });
        }
        if (withAttachment)
          Object.assign(action, { attachments: [await uploadAttachment(client)] });

        // Attach both fulfillment and rejection handlers immediately: the
        // original caller loses its response when we kill the owner.
        const request = client.request('workhub.coordination.act', action).then(() => {
          throw new Error('The trapped assignment unexpectedly returned to its caller');
        });
        const committed = await Promise.race([first.wait('assignment_committed'), request]);
        assert.equal(committed.targetCreated, disposition === 'create_new');
        assert.deepEqual(
          first.notices.filter((n) => n.type === 'dispatch'),
          [],
        );
        await first.stop('SIGKILL');
        await assert.rejects(request);
        const { assignment, admission } = committed;

        // Open brand-new handles after death. These observations prove we hit
        // the intended window, before any Root admission or first dispatch.
        await withStores(capability, async ({ execution: stores }) => {
          assert.deepEqual(
            await stores.sessionStore.readWorkHubAssignment(action.actionId),
            assignment,
          );
          assert.deepEqual(
            await stores.sessionStore.listMessageAdmissions(assignment.targetSessionId),
            [admission],
          );
          assert.equal(
            await stores.agentRunStore.readRootTurnAdmission(
              assignment.targetSessionId,
              assignment.targetTurnId,
            ),
            undefined,
          );
          assert.deepEqual(
            await stores.runtimeEventStore.listSessionInvocations(assignment.targetSessionId),
            [],
          );
        });

        const recovered = new HostProcess(root, capability.rootId, 'recover');
        children.push(recovered);
        const ready = await recovered.wait('ready');
        assert.notEqual(ready.hostEpoch, firstReady.hostEpoch);
        const connection = await connectClient(root);
        clients.push(connection);
        const dispatch = await recovered.wait('dispatch');
        assert.equal(dispatch.sessionId, assignment.targetSessionId);
        assert.equal(dispatch.turnId, assignment.targetTurnId);
        assert.equal(dispatch.text, action.userText);
        const terminal = await waitForTerminalTurn(
          connection,
          assignment.targetSessionId,
          assignment.targetTurnId,
        );
        assert.equal(terminal.status, 'completed');
        if (withAttachment) {
          assert.equal(dispatch.attachments.length, 1);
          const ref = dispatch.attachments[0]!.ref;
          assert.equal(ref.kind, 'session_file');
          if (ref.kind !== 'session_file') throw new Error('Expected target-owned attachment');
          assert.equal(ref.sessionId, assignment.targetSessionId);
          const payload = await connection.request('artifact.query', {
            kind: 'read_text',
            sessionId: ref.sessionId,
            artifactId: ref.relativePath,
          });
          assert.equal(payload.kind, 'text');
          if (payload.kind !== 'text') throw new Error('Expected text attachment');
          assert.deepEqual(payload.preview, { ok: true, text: ATTACHMENT_TEXT });
        }
        const candidates = await connection.request('workhub.coordination.candidates', {});
        assert.equal(
          candidates.candidates.find((c) => c.sessionId === assignment.targetSessionId)
            ?.latestDelegationActionId,
          action.actionId,
        );

        // Recovery and a client retry converge on the SAME durable linkage.
        // No stale candidate reference needs to be re-authorized for replay.
        const replay = await connection.request('workhub.coordination.act', action);
        assert.equal(replay.disposition, disposition);
        assert.ok('targetSessionId' in replay);
        assert.equal(replay.targetSessionId, assignment.targetSessionId);
        assert.ok('targetTurnId' in replay);
        assert.equal(replay.targetTurnId, assignment.targetTurnId);
        assert.deepEqual(await connection.request('workhub.coordination.act', action), replay);
        await assert.rejects(
          connection.request('workhub.coordination.act', {
            ...action,
            userText: 'A different task',
          }),
          (error: unknown) =>
            error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
        );
        await connection.close();
        await recovered.stop();
        assert.equal(recovered.notices.filter((n) => n.type === 'dispatch').length, 1);

        await withStores(capability, async ({ execution: stores }) => {
          const headers = await stores.sessionStore.listHeaders();
          assert.equal(headers.filter((h) => h.role !== 'workhub_coordination').length, 1);
          const messages = await stores.sessionStore.readMessagesSnapshot(
            WORKHUB_COORDINATION_SESSION_ID,
          );
          assert.deepEqual(
            messages.filter(
              (m) => m.type === 'workhub_coordination' && m.kind === 'delegation_assigned',
            ),
            [assignment],
          );
          assert.deepEqual(
            await stores.sessionStore.listMessageAdmissions(assignment.targetSessionId),
            [],
          );
          const rootAdmission = await stores.agentRunStore.readRootTurnAdmission(
            assignment.targetSessionId,
            assignment.targetTurnId,
          );
          assert.ok(rootAdmission);
          assert.equal(rootAdmission.userMessageId, assignment.targetMessageId);
          assert.deepEqual(
            rootAdmission.sourceMessages.map((message) => message.messageId),
            [assignment.targetMessageId],
          );
          assert.deepEqual(rootAdmission.normalizedInput, admission.content);
          const invocations = await stores.runtimeEventStore.listSessionInvocations(
            assignment.targetSessionId,
          );
          assert.equal(invocations.length, 1);
          assert.equal(invocations[0]!.runId, rootAdmission.runId);
          const events = await stores.runtimeEventStore.readImmutableRuntimeEvents(
            assignment.targetSessionId,
            rootAdmission.runId,
          );
          assert.equal(events.filter((e) => e.role === 'user').length, 1);
        });
      } finally {
        for (const client of clients) await client.close().catch(() => undefined);
        for (const child of children) await child.stop('SIGKILL');
        await removePosixEndpointDirectories(capability.rootId);
        await rm(join(resolveRootControlNamespace(), capability.rootId), {
          recursive: true,
          force: true,
        });
        await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), {
          force: true,
        });
        await rm(base, { recursive: true, force: true });
      }
    });
  }
}

for (const failAssignment of [false, true]) {
  test(`WorkHub reuses attachments across delegations and retries (assignment failure=${failAssignment})`, {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-workhub-attachment-retry-'));
    const root = join(base, 'root');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    let host: HostProcess | undefined;
    let client: RuntimeHostConnection | undefined;
    try {
      await withStores(capability, configureDefaultTarget);
      host = new HostProcess(
        root,
        capability.rootId,
        failAssignment ? 'fail-assignment-once' : 'recover',
      );
      await host.wait('ready');
      client = await connectClient(root);
      await client.request('workhub.coordination.resolve', {});
      const sessionId = 'attachment-target';
      await client.request('session.create', {
        sessionId,
        name: 'Requirements',
        workspace: { kind: 'host_path', path: root },
        modelTarget: { kind: 'default' },
      });
      const attachment = await uploadAttachment(client);
      const turnIds: string[] = [];
      for (const actionId of ['first-delegation', 'second-delegation']) {
        const candidates: WorkHubCoordinationCandidatesResult = await client.request(
          'workhub.coordination.candidates',
          {},
        );
        const target = candidates.candidates.find((c) => c.sessionId === sessionId);
        assert.ok(target);
        const action: WorkHubCoordinationActInput = {
          actionId,
          userText: 'Review the durable requirements',
          candidateSetId: candidates.candidateSetId,
          proposal: { disposition: 'delegate_existing', candidateRef: target.candidateRef },
          attachments: [attachment],
        };
        if (failAssignment && actionId === 'first-delegation') {
          await assert.rejects(
            client.request('workhub.coordination.act', action),
            (error: unknown) =>
              error instanceof RuntimeHostOperationError && error.code === 'persistence_failed',
          );
          await host.wait('assignment_failed');
          assert.equal(host.notices.filter((n) => n.type === 'dispatch').length, 0);
        }
        const assigned: WorkHubCoordinationActResult = await client.request(
          'workhub.coordination.act',
          action,
        );
        assert.ok(assigned.disposition === 'delegate_existing');
        assert.equal(assigned.targetSessionId, sessionId);
        turnIds.push(assigned.targetTurnId);
        assert.equal(
          (await waitForTerminalTurn(client, sessionId, assigned.targetTurnId)).status,
          'completed',
        );
        assert.deepEqual(await client.request('workhub.coordination.act', action), assigned);
      }
      assert.notEqual(turnIds[0], turnIds[1]);
      await client.close();
      await host.stop();
      const dispatched = host.notices.filter((n) => n.type === 'dispatch');
      assert.equal(dispatched.length, 2);
      assert.deepEqual(
        dispatched.map((n) => n.turnId),
        turnIds,
      );
      assert.deepEqual(dispatched[0]!.attachments, dispatched[1]!.attachments);
      await withStores(capability, async ({ execution, artifacts }) => {
        const records = await artifacts.listPage(sessionId, { offset: 0, limit: 10 });
        assert.equal(records.total, 1);
        assert.deepEqual(dispatched[0]!.attachments, [
          {
            ...attachment,
            ref: { kind: 'session_file', sessionId, relativePath: records.records[0]!.id },
          },
        ]);
        assert.deepEqual(await artifacts.readTextInSession(sessionId, records.records[0]!.id), {
          ok: true,
          text: ATTACHMENT_TEXT,
        });
        assert.equal(
          (await artifacts.listPage(WORKHUB_COORDINATION_SESSION_ID, { offset: 0, limit: 10 }))
            .total,
          1,
        );
        assert.deepEqual(await execution.sessionStore.listMessageAdmissions(sessionId), []);
        const messages = await execution.sessionStore.readMessagesSnapshot(
          WORKHUB_COORDINATION_SESSION_ID,
        );
        const assignments = messages.filter(
          (m) => m.type === 'workhub_coordination' && m.kind === 'delegation_assigned',
        );
        assert.equal(assignments.length, 2);
        assert.equal(
          (await execution.runtimeEventStore.listSessionInvocations(sessionId)).length,
          2,
        );
      });
    } finally {
      await client?.close().catch(() => undefined);
      await host?.stop('SIGKILL');
      await removePosixEndpointDirectories(capability.rootId);
      await rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      });
      await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true });
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('real Host uses the independent Memory provider for messages, history and WorkHub without SQLite execution fallback', {
  timeout: 60_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-memory-host-')),
    root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let host: HostProcess | undefined, client: RuntimeHostConnection | undefined;
  try {
    await withStores(capability, configureDefaultTarget);
    host = new HostProcess(root, capability.rootId, 'memory');
    const ready = await host.wait('ready');
    client = await connectClient(root);
    await client.request('session.create', {
      sessionId: 'memory-task',
      name: 'Memory task',
      workspace: { kind: 'host_path', path: root },
      modelTarget: { kind: 'default' },
    });
    const ordinary = await client.request('turn.message.submit', {
      originHostEpoch: ready.hostEpoch,
      sessionId: 'memory-task',
      messageId: 'ordinary-message',
      content: { text: 'Ordinary message through replacement persistence' },
      placement: 'current_turn',
    });
    assert.equal(ordinary.disposition, 'turn_started');
    if (ordinary.disposition !== 'turn_started') throw new Error('Ordinary Turn did not start');
    assert.equal(
      (await waitForTerminalTurn(client, 'memory-task', ordinary.turnId)).status,
      'completed',
    );
    const subscription = await client.openSessionSubscription(
      { sessionId: 'memory-task', transcript: { kind: 'tail', maxBytes: 16384 } },
      TIMEOUT,
    );
    try {
      const history = subscription.transcriptBootstrap;
      assert.ok(history);
      assert.ok(history.durable.fragments.length > 0);
      assert.match(
        history.durable.fragments
          .map((f) => Buffer.from(f.data, 'base64').toString('utf8'))
          .join(''),
        /Ordinary message through replacement persistence/,
      );
    } finally {
      await subscription.close();
    }
    await client.request('workhub.coordination.resolve', {});
    const candidates = await client.request('workhub.coordination.candidates', {});
    const target = candidates.candidates.find((c) => c.sessionId === 'memory-task');
    assert.ok(target);
    const action: WorkHubCoordinationActInput = {
      actionId: 'memory-delegation',
      userText: 'Continue payment work',
      candidateSetId: candidates.candidateSetId,
      proposal: { disposition: 'delegate_existing', candidateRef: target.candidateRef },
    };
    const assigned = await client.request('workhub.coordination.act', action);
    assert.equal(assigned.disposition, 'delegate_existing');
    if (assigned.disposition !== 'delegate_existing') throw new Error('Delegation not admitted');
    assert.equal(
      (await waitForTerminalTurn(client, assigned.targetSessionId, assigned.targetTurnId)).status,
      'completed',
    );
    assert.deepEqual(await client.request('workhub.coordination.act', action), assigned);
    const create: WorkHubCoordinationActInput = {
      actionId: 'memory-create',
      userText: 'Create a new task to inspect the transaction contract',
      proposal: { disposition: 'create_new', title: 'Transaction contract' },
      create: { workspace: { kind: 'host_path', path: root } },
    };
    const created = await client.request('workhub.coordination.act', create);
    assert.equal(created.disposition, 'create_new');
    if (created.disposition !== 'create_new') throw new Error('New delegation not admitted');
    assert.equal(
      (await waitForTerminalTurn(client, created.targetSessionId, created.targetTurnId)).status,
      'completed',
    );
    assert.deepEqual(await client.request('workhub.coordination.act', create), created);
    await client.close();
    await host.stop();
    assert.equal(host.notices.filter((n) => n.type === 'dispatch').length, 3);
    // The other storage domains still legitimately use Local. Execution facts
    // must not have escaped to it when the trusted composition selected Memory.
    await withStores(capability, async ({ execution }) => {
      assert.deepEqual(await execution.sessionStore.listHeaders(), []);
      assert.deepEqual(await execution.runtimeEventStore.listSessionInvocations('memory-task'), []);
      assert.equal(
        await execution.sessionStore.readWorkHubAssignment('memory-delegation'),
        undefined,
      );
      assert.deepEqual(await execution.sessionStore.listMessageAdmissions('memory-task'), []);
    });
  } finally {
    await client?.close().catch(() => undefined);
    await host?.stop('SIGKILL');
    await removePosixEndpointDirectories(capability.rootId);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(join(resolveRootOwnershipNamespace(), capability.rootId + '.lock'), { force: true });
    await rm(base, { recursive: true, force: true });
  }
});

async function uploadAttachment(client: RuntimeHostConnection): Promise<AttachmentRef> {
  const bytes = Buffer.from(ATTACHMENT_TEXT);
  const sessionId = WORKHUB_COORDINATION_SESSION_ID;
  const uploadId = 'requirements-upload';
  await client.request('artifact.ingest', {
    kind: 'begin',
    sessionId,
    uploadId,
    name: 'requirements.txt',
    mimeType: 'text/plain',
    totalBytes: bytes.length,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  await client.request('artifact.ingest', {
    kind: 'chunk',
    sessionId,
    uploadId,
    offset: 0,
    chunkBase64: bytes.toString('base64'),
  });
  const result = await client.request('artifact.ingest', { kind: 'commit', sessionId, uploadId });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('Attachment was not committed');
  return result.attachment;
}

async function withStores(
  capability: StorageRootCapability<'interactive'>,
  run: (stores: StorageWriterComposition) => Promise<void>,
): Promise<void> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: StorageWriterComposition | undefined;
  try {
    stores = await openStorageWriterComposition(owner.lease);
    await run(stores);
  } finally {
    await stores?.close();
    await owner.close();
  }
}

async function configureDefaultTarget({
  runtimePolicy: policy,
}: StorageWriterComposition): Promise<void> {
  const created = await policy.connectionCatalog.create({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'fake',
      name: 'Fake',
      providerType: 'ollama',
      enabled: true,
      enabledModelIds: ['fake-model'],
    },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') throw new Error('Connection was not committed');
  const connection = created.snapshot.connections[0]!;
  const fetch = await policy.operations.beginModelFetch(connection.connectionId);
  assert.equal(fetch.kind, 'ready');
  if (fetch.kind !== 'ready') throw new Error('Model fetch was not opened');
  const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
    models: [{ id: 'fake-model' }],
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(fetched.kind, 'committed');
  if (fetched.kind !== 'committed') throw new Error('Model catalog was not committed');
  const selected = await policy.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: fetched.snapshot.revision,
    target: { connectionId: connection.connectionId, modelId: 'fake-model' },
  });
  assert.equal(selected.kind, 'committed');
}

class HostProcess {
  readonly child: ChildProcess;
  readonly notices: Notice[] = [];
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly listeners = new Set<() => void>();

  constructor(
    root: string,
    rootId: string,
    mode: 'crash' | 'recover' | 'fail-assignment-once' | 'memory',
  ) {
    this.child = fork(
      new URL('./fixtures/workhub-assignment-crash-host.js', import.meta.url),
      [root, rootId, mode],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.child.on('message', (notice: Notice) => {
      this.notices.push(notice);
      for (const listener of this.listeners) listener();
    });
  }

  async wait<T extends Notice['type']>(type: T): Promise<Extract<Notice, { type: T }>> {
    let check!: () => void;
    const notice = new Promise<Extract<Notice, { type: T }>>((resolve) => {
      check = () => {
        const found = this.notices.find((n): n is Extract<Notice, { type: T }> => n.type === type);
        if (found) resolve(found);
      };
      this.listeners.add(check);
      check();
    });
    try {
      return await withTimeout(
        Promise.race([
          notice,
          this.closed.then((exit) => {
            throw new Error(`Host exited before ${type}: ${JSON.stringify(exit)}`);
          }),
        ]),
        TIMEOUT,
        `Host did not report ${type}`,
      );
    } finally {
      this.listeners.delete(check);
    }
  }

  async stop(signal?: 'SIGKILL'): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (signal) this.child.kill(signal);
      else this.child.send({ type: 'shutdown' });
    }
    const exit = await withTimeout(this.closed, TIMEOUT, 'Host did not exit');
    if (!signal) assert.deepEqual(exit, { code: 0, signal: null });
  }
}
