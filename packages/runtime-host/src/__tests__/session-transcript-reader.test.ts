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
import test from 'node:test';
import { seedInvocation, testInvocationOpening } from '@maka/runtime/test-only/invocation-fixture';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type StoredMessage,
} from '@maka/core/session';
import { projectRuntimeEventsToStoredMessages } from '@maka/runtime/runtime-event-read-model';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import type { SessionTurnContribution } from '@maka/storage/execution-stores';
import {
  type ExecutionStoresWriter,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';

for (const coordination of [false, true])
  test(`keeps ${coordination ? 'WorkHub' : 'ordinary'} durable history separate from the canonical active overlay`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-session-transcript-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'root'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) assert.fail('expected the interactive root owner');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const input = {
        cwd: capability.canonicalPath,
        llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask' as const,
      };
      const created = coordination
        ? await stores.sessionStore.createStableSession({
            sessionId: WORKHUB_COORDINATION_SESSION_ID,
            requestFingerprint: `sha256:${'1'.repeat(64)}`,
            input: {
              ...input,
              role: WORKHUB_COORDINATION_SESSION_ROLE,
              toolProfile: 'workhub-coordination-v2',
            },
          })
        : undefined;
      assert.notEqual(created?.kind, 'conflict');
      const session =
        created && created.kind !== 'conflict'
          ? created.record.header
          : await stores.sessionStore.create(input);
      // An ended Turn is what the durable half is made of; the running one below
      // belongs to the overlay and must not appear in a durable page.
      await seedInvocation(stores.runtimeEventStore, {
        sessionId: session.id,
        runId: 'run-0',
        turnId: 'turn-0',
        openedAt: 0,
      });
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-0',
        runtimeEvent(session.id, {
          id: 'user-event-0',
          invocationId: 'run-0',
          runId: 'run-0',
          turnId: 'turn-0',
          ts: 0.1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'settled' },
          refs: { storedMessageId: 'user-0' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-0',
        runtimeEvent(session.id, {
          id: 'terminal-0',
          invocationId: 'run-0',
          runId: 'run-0',
          turnId: 'turn-0',
          ts: 0.2,
          role: 'system',
          author: 'system',
          status: 'completed',
        }),
      );
      await seedInvocation(stores.runtimeEventStore, {
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        openedAt: 1,
      });
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'user-event-1',
          ts: 2,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'hello' },
          refs: { storedMessageId: 'user-1' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'thinking-partial-1',
          ts: 3,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'deep ' },
          refs: { providerEventId: 'assistant-1' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'thinking-partial-2',
          ts: 4,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'thought' },
          refs: { providerEventId: 'assistant-1' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'text-partial-1',
          ts: 5,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'still ' },
          refs: { providerEventId: 'assistant-1' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'text-partial-2',
          ts: 6,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'streaming' },
          refs: { providerEventId: 'assistant-1' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'thinking-only-1',
          ts: 7,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'still ' },
          refs: { providerEventId: 'assistant-2' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'superseded-text-partial',
          ts: 9,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'not final' },
          refs: { providerEventId: 'assistant-3' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'complete-text',
          ts: 10,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'final text' },
          refs: { providerEventId: 'assistant-3' },
        }),
      );
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'run-1',
        runtimeEvent(session.id, {
          id: 'thinking-only-2',
          ts: 8,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'reasoning' },
          refs: { providerEventId: 'assistant-2' },
        }),
      );

      const read = createSessionTranscriptReader({
        stores,
        canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
      });
      const messages = await read.readActiveOverlay(session.id, {
        sessionId: session.id,
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
      });

      assert.deepEqual(
        messages.map((message) => ({ type: message.type, id: message.id })),
        [
          { type: 'user', id: 'user-1' },
          { type: 'assistant', id: 'assistant-1' },
          { type: 'assistant', id: 'assistant-2' },
          { type: 'assistant', id: 'assistant-3' },
        ],
      );
      const firstAssistant = messages.at(-3);
      assert.equal(firstAssistant?.type, 'assistant');
      if (firstAssistant?.type === 'assistant') {
        assert.equal(firstAssistant.text, 'still streaming');
        assert.equal(firstAssistant.thinking?.text, 'deep thought');
      }
      const thinkingOnly = messages.at(-2);
      assert.equal(thinkingOnly?.type, 'assistant');
      if (thinkingOnly?.type === 'assistant') {
        assert.equal(thinkingOnly.text, '');
        assert.equal(thinkingOnly.thinking?.text, 'still reasoning');
      }
      const completed = messages.at(-1);
      assert.equal(completed?.type, 'assistant');
      if (completed?.type === 'assistant') assert.equal(completed.text, 'final text');

      const durable = await read.readDurablePage(session.id, {
        direction: 'older',
        maxBytes: 1024,
        maxMessages: 10,
      });
      assert.equal(durable.throughSequence, await read.readDurableHighWater(session.id));
      assert.ok(durable.throughSequence !== null);
      assert.deepEqual(
        durable.fragments.map((fragment) => {
          const message = JSON.parse(fragment.data.toString('utf8')) as StoredMessage;
          return { type: message.type, id: message.id };
        }),
        [
          { type: 'turn_state', id: 'terminal-0' },
          { type: 'user', id: 'user-0' },
        ],
      );
    } finally {
      await owner.close();
      await rm(base, { recursive: true, force: true });
    }
  });

test('pages the ledger without materializing Turns it takes no rows from', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-transcript-seek-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const expected: StoredMessage[] = [];
    for (let turn = 0; turn < 5; turn++) {
      const runId = `run-${turn}`;
      const turnId = `turn-${turn}`;
      await seedInvocation(stores.runtimeEventStore, {
        sessionId: session.id,
        runId,
        turnId,
        openedAt: turn,
      });
      let count = 0;
      const append = (overrides: Partial<RuntimeEvent>) =>
        stores.runtimeEventStore.appendRuntimeEvent(
          session.id,
          runId,
          runtimeEvent(session.id, {
            id: `${runId}-event-${count++}`,
            invocationId: runId,
            runId,
            turnId,
            ...overrides,
          }),
        );
      await append({
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: `prompt ${turn}` },
      });
      if (turn === 4) {
        // More than 5 MiB in a single Turn, outside a tiny head/tail page.
        for (let index = 0; index < 180; index++) {
          await append({
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: 'x'.repeat(32 * 1024) },
          });
        }
        await append({
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: {} },
          refs: { toolCallId: 'tool-1', stepId: 'assistant-final' },
        });
        await append({
          actions: {
            permissionRequest: {
              kind: 'tool_permission',
              requestId: 'request-1',
              toolUseId: 'tool-1',
              toolName: 'Read',
              category: 'read',
              reason: 'custom',
              args: {},
              rememberForTurnAllowed: true,
              hint: 'original permission hint',
            },
          },
        });
        await append({
          actions: {
            permissionDecision: {
              requestId: 'request-1',
              decision: 'allow',
              rememberForTurn: true,
            },
          },
          refs: { toolCallId: 'tool-1' },
        });
        await append({
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-1',
            name: 'Read',
            result: { kind: 'text', text: 'result' },
            isError: true,
          },
        });
        await append({
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'before text' },
          refs: { providerEventId: 'assistant-final' },
        });
        await append({
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'final answer 中文' },
          refs: { storedMessageId: 'assistant-final' },
        });
        await append({
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: ' after text' },
          refs: { providerEventId: 'assistant-final', storedMessageId: 'usage-final' },
          actions: { tokenUsage: { input: 100, output: 25 } },
        });
        await append({ content: { kind: 'system_note', note: 'step_limit' } });
      } else {
        await append({
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: '\u3000\u00a0' },
        });
      }
      await append({
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'tool_step_cap_reached' } },
      });
      const invocation = await stores.runtimeEventStore.readRunInvocation(session.id, runId);
      assert.ok(invocation);
      const projection = projectRuntimeEventsToStoredMessages(
        await stores.runtimeEventStore.readRuntimeEvents(session.id, runId),
        { invocations: [invocation] },
      );
      assert.deepEqual(projection.diagnostics, []);
      expected.push(...projection.messages);
    }
    const read = createSessionTranscriptReader({
      stores,
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    // Measure actual JSON decoded, not only the eventual response size.
    //
    // A read decodes the Turns it takes rows from, and no others. That bound is
    // per Turn rather than per row: a Turn is projected whole because a row's
    // meaning depends on the rest of its Turn. What must still hold is that no
    // read walks the Session — so a page at one end must not touch the 5 MiB
    // Turn at the other, and a Turn index page must cost only its own Turns.
    const SMALL_TURN_BUDGET = 512 * 1024;
    const ONE_BIG_TURN_BUDGET = 8 * 1024 * 1024;
    let decodedBytes = 0;
    const parse = JSON.parse;
    const measured = t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
      decodedBytes += Buffer.byteLength(args[0]);
      return parse(...args);
    });
    const decoding = async <T>(label: string, budget: number, run: () => Promise<T>) => {
      decodedBytes = 0;
      const result = await run();
      assert.ok(decodedBytes < budget, `${label} decoded ${decodedBytes} bytes`);
      return result;
    };
    const through = await read.readDurableHighWater(session.id);
    const tail = await decoding('tail page', ONE_BIG_TURN_BUDGET, () =>
      read.readDurablePage(session.id, { direction: 'older', maxBytes: 1024, maxMessages: 1 }),
    );
    assert.equal(JSON.parse(tail.fragments[0]!.data.toString()).type, 'system_note');
    // The discriminating read: the first Turn is small and sits at the far end
    // of the Session from the 5 MiB one, so serving it may not decode that Turn.
    const head = await decoding('head page', SMALL_TURN_BUDGET, () =>
      read.readDurablePage(session.id, { direction: 'newer', maxBytes: 1024, maxMessages: 1 }),
    );
    assert.equal(JSON.parse(head.fragments[0]!.data.toString()).text, 'prompt 0');
    assert.deepEqual(
      await decoding('lookup miss', ONE_BIG_TURN_BUDGET, () =>
        read.readDurableMessagesById(session.id, {
          throughSequence: through,
          messageIds: ['missing-stream'],
          maxBytes: 1024,
          maxMessages: 1,
        }),
      ),
      [],
    );
    const landmarks = await decoding('landmarks', SMALL_TURN_BUDGET, () =>
      read.readDurableTurnLandmarks(session.id, 3),
    );
    assert.deepEqual(
      landmarks.landmarks.map((item) => item.label),
      ['prompt 0', 'prompt 2', 'prompt 4'],
    );
    const contributions: SessionTurnContribution[] = [];
    let contributionPosition = 0;
    for (;;) {
      const page = await decoding('turn index page', ONE_BIG_TURN_BUDGET, () =>
        read.readDurableTurnContributions(session.id, through, contributionPosition, 2),
      );
      contributions.push(...page.contributions);
      if (page.nextPosition === null) break;
      contributionPosition = page.nextPosition;
    }
    measured.mock.restore();

    const records: Array<{ sequence: number; message: StoredMessage }> = [];
    let position = 0;
    for (;;) {
      const page = await read.readDurableRecords(session.id, {
        direction: 'newer',
        throughSequence: through,
        position,
        maxMessages: 2,
        maxStoredBytes: 128 * 1024,
      });
      records.push(...page.records);
      if (page.nextPosition === null) break;
      position = page.nextPosition;
    }
    assert.deepEqual(
      records.map((record) => record.message),
      expected,
    );
    const folded = new Map<string, SessionTurnContribution>();
    for (const record of records) {
      if (!('turnId' in record.message) || !record.message.turnId) continue;
      const turnId = record.message.turnId;
      folded.set(
        turnId,
        foldTurnContribution(folded.get(turnId), turnId, record.sequence, record.message),
      );
    }
    assert.deepEqual(contributions, [...folded.values()]);
    const assistant = records.find((record) => record.message.id === 'assistant-final');
    assert.ok(assistant);
    assert.deepEqual(
      await read.readDurableMessagesById(session.id, {
        throughSequence: through,
        messageIds: ['assistant-final'],
        maxBytes: 4096,
        maxMessages: 1,
      }),
      [assistant.message],
    );
    // Reassemble the same multibyte message in either direction, inside one row.
    for (const direction of ['older', 'newer'] as const) {
      let byteOffset: number | undefined;
      const chunks: Buffer[] = [];
      for (;;) {
        const page = await read.readDurablePage(session.id, {
          direction,
          throughSequence: through,
          position: assistant.sequence,
          ...(byteOffset === undefined ? {} : { byteOffset }),
          maxBytes: 37,
          maxMessages: 1,
        });
        chunks.push(page.fragments[0]!.data);
        if (page.next?.position !== assistant.sequence) break;
        assert.notEqual(page.next.byteOffset, null);
        byteOffset = page.next.byteOffset!;
      }
      if (direction === 'older') chunks.reverse();
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), assistant.message);
    }
    // A later sealed Turn must not alter a previously issued snapshot.
    await seedInvocation(stores.runtimeEventStore, {
      sessionId: session.id,
      runId: 'later',
      turnId: 'later',
      openedAt: 99,
    });
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      'later',
      runtimeEvent(session.id, {
        id: 'later-terminal',
        invocationId: 'later',
        runId: 'later',
        turnId: 'later',
        status: 'completed',
      }),
    );
    const frozen = await read.readDurablePage(session.id, {
      direction: 'older',
      throughSequence: through,
      maxBytes: 1024,
      maxMessages: 1,
    });
    assert.deepEqual(frozen.fragments, tail.fragments);
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('stops scanning a control-only ledger at the cumulative immutable event limit', async () => {
  const sessionId = 'session-1';
  const events = Array.from({ length: 8_193 }, (_, index) =>
    runtimeEvent(sessionId, {
      id: `artifact-${index}`,
      ts: index + 1,
      role: 'system',
      author: 'system',
      actions: { artifactDelta: { bytes: index } },
    }),
  );
  let scanned = 0;
  const stores = {
    agentRunStore: {},
    runtimeEventStore: {
      readRunInvocation: async () => testInvocation(sessionId),
      readRuntimeEventsBounded: async () => ({ status: 'limit_exceeded' as const }),
      scanRuntimeEvents: async (
        _sessionId: string,
        _runId: string,
        budget: { readonly maxImmutableRecords: number },
        visit: (batch: readonly RuntimeEvent[]) => void,
      ) => {
        for (let offset = 0; offset < events.length; offset += 128) {
          const batch = events.slice(offset, offset + 128);
          if (offset + batch.length > budget.maxImmutableRecords) {
            return { status: 'limit_exceeded' as const };
          }
          scanned += batch.length;
          visit(batch);
        }
        return { status: 'complete' as const };
      },
    },
  } as unknown as ExecutionStoresWriter<'interactive'>;
  const read = createSessionTranscriptReader({
    stores,
    canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
  });

  await assert.rejects(
    read.readActiveOverlay(sessionId, {
      sessionId,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    }),
    /storage scan limit/,
  );
  assert.equal(scanned, 8_192);
});

test('stops an oversized active projection before retaining the full RuntimeEvent ledger', async () => {
  const sessionId = 'session-1';
  const events = Array.from({ length: 8_193 }, (_, index) =>
    runtimeEvent(sessionId, {
      id: `user-${index}`,
      ts: index + 1,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'x' },
      refs: { storedMessageId: `message-${index}` },
    }),
  );
  let visited = 0;
  const stores = {
    agentRunStore: {},
    runtimeEventStore: {
      readRunInvocation: async () => testInvocation(sessionId),
      scanRuntimeEvents: async (
        _sessionId: string,
        _runId: string,
        _budget: unknown,
        visit: (batch: readonly RuntimeEvent[]) => void,
      ) => {
        for (let offset = 0; offset < events.length; offset += 128) {
          visited += Math.min(128, events.length - offset);
          visit(events.slice(offset, offset + 128));
        }
        return { status: 'complete' as const };
      },
    },
  } as unknown as ExecutionStoresWriter<'interactive'>;
  const read = createSessionTranscriptReader({
    stores,
    canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
  });

  await assert.rejects(
    read.readActiveOverlay(sessionId, {
      sessionId,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    }),
    /exceeds its event limit/,
  );
  assert.equal(visited, 8_193);
});

test('pages a nested Turn the same way a single sweep reads it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-nested-paging-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    let counter = 0;
    const append = (runId: string, overrides: Partial<RuntimeEvent>) =>
      stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        runId,
        runtimeEvent(session.id, {
          id: `${runId}-event-${counter++}`,
          invocationId: runId,
          runId,
          turnId: `turn-${runId}`,
          ts: counter,
          ...overrides,
        }),
      );
    const text = (runId: string, body: string) =>
      append(runId, { role: 'model', author: 'agent', content: { kind: 'text', text: body } });

    // `outer` opens first and ends last; `inner` opens and ends inside it, so
    // the two Turns share a stretch of the Session's ordinals.
    await seedInvocation(stores.runtimeEventStore, {
      sessionId: session.id,
      runId: 'outer',
      turnId: 'turn-outer',
      openedAt: 0,
    });
    await text('outer', 'outer before');
    await seedInvocation(stores.runtimeEventStore, {
      sessionId: session.id,
      runId: 'inner',
      turnId: 'turn-inner',
      openedAt: 1,
    });
    for (let index = 0; index < 4; index++) await text('inner', `inner ${index}`);
    await append('inner', { status: 'completed', actions: { endInvocation: true } });
    await text('outer', 'outer after');
    await append('outer', { status: 'completed', actions: { endInvocation: true } });

    const read = createSessionTranscriptReader({
      stores,
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    const throughSequence = await read.readDurableHighWater(session.id);

    for (const direction of ['older', 'newer'] as const) {
      const sweep = await read.readDurablePage(session.id, {
        direction,
        throughSequence,
        maxBytes: 1 << 20,
        maxMessages: 64,
      });
      const swept = sweep.fragments.map((fragment) => fragment.sequence);

      const paged: number[] = [];
      let position: number | undefined;
      for (let page = 0; page < 32; page++) {
        const result = await read.readDurablePage(session.id, {
          direction,
          throughSequence,
          ...(position === undefined ? {} : { position }),
          maxBytes: 1 << 20,
          maxMessages: 1,
        });
        if (result.fragments.length === 0) break;
        paged.push(...result.fragments.map((fragment) => fragment.sequence));
        if (result.next?.position === undefined || result.next.position === null) break;
        position = result.next.position;
      }
      assert.deepEqual(paged, swept, direction);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function runtimeEvent(sessionId: string, overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'run-1',
    sessionId,
    turnId: 'turn-1',
    runId: 'run-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function testInvocation(sessionId: string): RuntimeInvocationRecord {
  return {
    sessionId,
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    openedAt: 1,
    opening: testInvocationOpening(),
  };
}
