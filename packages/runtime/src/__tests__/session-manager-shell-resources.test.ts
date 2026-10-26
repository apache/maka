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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ShellRunRecord } from '@maka/core/shell-run';
import type { SessionHeaderPatch } from '@maka/core/session';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { ShellRunProcessManager } from '../shell-run-manager.js';
import { shellRunContent, shellRunUpdate } from '../shell-run-tool-result.js';
import { seedInvocation } from './invocation-fixture.js';

test('root resource reads preserve own states without reading transcript history', async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const records = ['starting', 'running', 'completed', 'cancelled'].map((status, index) =>
    record(session.id, `own-${index}`, {
      status: status as ShellRunRecord['status'],
      ...(status === 'completed' ? { completedAt: 2, exitCode: 0 } : {}),
      ...(status === 'cancelled' ? { completedAt: 2, exitCode: 130 } : {}),
    }),
  );
  records[0]!.visibility = 'user';
  for (const item of records) await f.shellStore.createShellRun(item);
  const noHistory = t.mock.method(f.manager, 'getMessages', async () => {
    throw new Error('Resource query must not read transcript history');
  });

  assert.deepEqual(await f.manager.listShellRunUpdates(session.id), records.map(shellRunUpdate));
  for (const item of records) {
    assert.deepEqual(
      await f.manager.getShellRunUpdate(session.id, shellRunContent(item).ref),
      shellRunUpdate(item),
    );
  }
  assert.equal(
    await f.manager.getShellRunUpdate(
      session.id,
      shellRunContent(record(session.id, 'missing')).ref,
    ),
    null,
  );
  assert.deepEqual(await f.manager.listShellRunUpdates((await f.session()).id), []);
  assert.equal(noHistory.mock.callCount(), 0);
});

test('a failed lineage read is not an empty resource answer, while own lookup stays independent', async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const own = record(session.id, 'own');
  await f.shellStore.createShellRun(own);
  const manager = new SessionManager({
    ...f.options,
    store: {
      ...f.stores.sessionStore,
      readHeader: async () => {
        throw new Error('header unavailable');
      },
    },
  });
  assert.deepEqual(
    await manager.getShellRunUpdate(session.id, shellRunContent(own).ref),
    shellRunUpdate(own),
  );
  await assert.rejects(manager.listShellRunUpdates(session.id), /header unavailable/);
  await assert.rejects(
    manager.getShellRunUpdate(session.id, shellRunContent(record(session.id, 'missing')).ref),
    /header unavailable/,
  );
});

test('root resources do not declare staged transcript history ready', async (t) => {
  const f = await fixture(t);
  const session = await f.session({ transcriptLedgerVersion: 0 });
  const own = record(session.id, 'staged-own');
  await f.shellStore.createShellRun(own);
  const noHistory = t.mock.method(f.manager, 'getMessages', async () => {
    throw new Error('Resource query must not read transcript history');
  });
  assert.deepEqual(await f.manager.listShellRunUpdates(session.id), [shellRunUpdate(own)]);
  assert.equal(
    await f.manager.getShellRunUpdate(
      session.id,
      shellRunContent(record(session.id, 'missing')).ref,
    ),
    null,
  );
  assert.equal(noHistory.mock.callCount(), 0);
  assert.equal((await f.stores.sessionStore.readHeader(session.id)).transcriptLedgerVersion, 0);
  await assert.rejects(
    f.manager.ensureTranscriptLedgerForRead(session.id),
    /Imported Session history is still being prepared/,
  );
});

for (const lineage of ['parentSessionId', 'revisionParentSessionId'] as const) {
  test(`${lineage} resources retain ancestor ownership, own priority and copied-history scope`, async (t) => {
    const f = await fixture(t);
    const ancestor = await f.session();
    const parent = await f.session({ parentSessionId: ancestor.id });
    const decoy = await f.session();
    const child = await f.session({
      parentSessionId: lineage === 'parentSessionId' ? parent.id : decoy.id,
      ...(lineage === 'revisionParentSessionId'
        ? {
            revisionParentSessionId: parent.id,
            revisionRootSessionId: ancestor.id,
            revisionOfTurnId: 'history-turn',
            revisionIndex: 2,
            revisionState: 'committed' as const,
          }
        : {}),
    });
    const inherited = record(ancestor.id, 'inherited');
    const shadowed = record(ancestor.id, 'shadowed');
    const outsideCopy = record(ancestor.id, 'outside-copy');
    for (const item of [inherited, shadowed, outsideCopy]) await f.shellStore.createShellRun(item);
    const own = record(child.id, 'own', { sourceToolCallId: shadowed.sourceToolCallId });
    await f.shellStore.createShellRun(own);
    await f.history(child.id, [inherited, shadowed]);
    // The inherited snapshot says running, while its real owner has since finished.
    await f.shellStore.updateShellRun(ancestor.id, inherited.shellRunId, {
      status: 'completed',
      exitCode: 0,
      completedAt: 2,
      updatedAt: 2,
    });
    const expected = {
      sessionId: child.id,
      ownership: { kind: 'source_owned', sourceSessionId: parent.id, ownerSessionId: ancestor.id },
      sourceTurnId: 'history-turn',
      sourceToolCallId: inherited.sourceToolCallId,
      result: await f.shellRuns.inspectResource(ancestor.id, shellRunContent(inherited).ref),
    };
    assert.deepEqual(await f.manager.listShellRunUpdates(child.id), [
      shellRunUpdate(own),
      expected,
    ]);
    assert.deepEqual(
      await f.manager.getShellRunUpdate(child.id, shellRunContent(inherited).ref),
      expected,
    );
    assert.equal(
      await f.manager.getShellRunUpdate(child.id, shellRunContent(outsideCopy).ref),
      null,
    );
  });
}

test('missing inherited owners and cyclic ancestry preserve source-unavailable snapshots', async (t) => {
  const f = await fixture(t);
  const parent = await f.session();
  const child = await f.session({ parentSessionId: parent.id });
  await f.stores.sessionStore.updateHeader(parent.id, { parentSessionId: child.id });
  const missing = record(parent.id, 'gone');
  await f.history(child.id, [missing]);
  const expected = {
    sessionId: child.id,
    ownership: { kind: 'source_unavailable', sourceSessionId: parent.id },
    sourceTurnId: 'history-turn',
    sourceToolCallId: missing.sourceToolCallId,
    result: shellRunContent(missing),
  };
  assert.deepEqual(await f.manager.listShellRunUpdates(child.id), [expected]);
  assert.deepEqual(await f.manager.getShellRunUpdate(child.id, expected.result.ref), expected);
});

test('inherited discovery excludes non-Bash and terminal snapshots', async (t) => {
  const f = await fixture(t);
  const parent = await f.session();
  const child = await f.session({ parentSessionId: parent.id });
  const terminal = record(parent.id, 'terminal', {
    status: 'completed',
    completedAt: 2,
    exitCode: 0,
  });
  const otherTool = record(parent.id, 'other-tool');
  await f.history(child.id, [terminal, otherTool], ['Bash', 'Other']);
  assert.deepEqual(await f.manager.listShellRunUpdates(child.id), []);
  for (const item of [terminal, otherTool]) {
    assert.equal(await f.manager.getShellRunUpdate(child.id, shellRunContent(item).ref), null);
  }
});

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'maka-shell-resource-read-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const shellStore = await openInteractiveShellRunStoreForWrite(owner.lease);
  const shellRuns = new ShellRunProcessManager({
    store: shellStore,
    newId: randomUUID,
    now: Date.now,
  });
  t.after(async () => {
    await shellRuns.terminateAll();
    shellStore.close();
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  });
  const options = {
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    shellRuns,
    backends: new BackendRegistry(),
    newId: randomUUID,
    now: Date.now,
  };
  const manager = new SessionManager(options);
  return {
    stores,
    shellStore,
    shellRuns,
    manager,
    options,
    session: async (patch: SessionHeaderPatch = {}) => {
      const session = await stores.sessionStore.create({
        cwd: base,
        llmConnectionId: 'fake-connection',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      return stores.sessionStore.updateHeader(session.id, { transcriptLedgerVersion: 1, ...patch });
    },
    history: async (sessionId: string, records: ShellRunRecord[], names: string[] = []) => {
      const identity = await seedInvocation(stores.runtimeEventStore, {
        sessionId,
        runId: 'history-run',
        turnId: 'history-turn',
        openedAt: 1,
      });
      let sequence = 1;
      const append = (patch: Partial<RuntimeEvent>) =>
        stores.runtimeEventStore.appendRuntimeEvent(sessionId, identity.runId, {
          ...identity,
          id: `event-${++sequence}`,
          ts: sequence,
          partial: false,
          role: 'system',
          author: 'system',
          ...patch,
        });
      for (const [index, item] of records.entries()) {
        const name = names[index] ?? 'Bash';
        await append({
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: item.sourceToolCallId, name, args: {} },
        });
        await append({
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: item.sourceToolCallId,
            name,
            result: shellRunContent(item),
          },
        });
      }
      await append({ status: 'completed', actions: { endInvocation: true } });
    },
  };
}

function record(
  sessionId: string,
  shellRunId: string,
  patch: Partial<ShellRunRecord> = {},
): ShellRunRecord {
  return {
    sessionId,
    shellRunId,
    sourceTurnId: 'resource-turn',
    sourceToolCallId: `call-${shellRunId}`,
    cwd: '/tmp',
    command: 'fixture',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
    ...patch,
  };
}
