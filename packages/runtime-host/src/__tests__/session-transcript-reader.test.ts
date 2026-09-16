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
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type StoredMessage,
} from '@maka/core/session';
import { projectRuntimeEventsToStoredMessages } from '@maka/runtime/runtime-event-read-model';
import { encodeDurableToolResultOutput } from '@maka/runtime/durable-tool-result-projection';
import { shapeTerminalResult } from '@maka/runtime/shell-tools';
import { createLedgerArchiveResourceReader } from '@maka/runtime/ledger-tool-result-archive-reader';
import { readToolResultArchiveResource } from '@maka/runtime/tool-result-archive-resource';
import { readPageSchema } from '@maka/runtime/read-page';
import { openToolResultArchiveEvidenceReader } from '@maka/storage/tool-result-archive-evidence';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import type { SessionTurnContribution } from '@maka/storage/execution-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  createSessionTranscriptReader,
  TRANSCRIPT_TURN_MAX_BYTES,
} from '../server/session-transcript-reader.js';

for (const coordination of [false, true])
  test(`pages ${coordination ? 'WorkHub' : 'ordinary'} running Turn rows as their events commit`, async () => {
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
      let largeBash: ReturnType<typeof shapeTerminalResult> | undefined;
      const resultCount = coordination ? 9 : 2;
      {
        const stream = `${(coordination ? 'x' : '\u0001').repeat(127)}\n`.repeat(8_191);
        largeBash = shapeTerminalResult({
          cwd: capability.canonicalPath,
          command: 'synthetic bounded output',
          result: {
            stdout: `FRONT\n${stream}TAIL`,
            stderr: `ERROR_FRONT\n${stream}ERROR_TAIL`,
            exitCode: 7,
          },
        });
        const modelProjection = encodeDurableToolResultOutput(
          { type: 'json', value: largeBash as never },
          session.id,
        );
        assert.equal(modelProjection.kind, 'json');
        for (let index = 0; index < resultCount; index++) {
          const toolCallId = `large-bash-${index}`;
          await stores.runtimeEventStore.appendRuntimeEvent(
            session.id,
            'run-1',
            runtimeEvent(session.id, {
              id: `${toolCallId}-call`,
              ts: 11 + index * 2,
              role: 'model',
              author: 'agent',
              content: {
                kind: 'function_call',
                id: toolCallId,
                name: 'Bash',
                args: { command: 'synthetic bounded output' },
              },
              refs: { toolCallId },
            }),
          );
          const resultEvent = runtimeEvent(session.id, {
            id: `${toolCallId}-result`,
            ts: 12 + index * 2,
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: toolCallId,
              name: 'Bash',
              result: largeBash,
              modelProjection,
            },
            refs: { toolCallId },
          });
          const resultEventBytes = Buffer.byteLength(JSON.stringify(resultEvent), 'utf8');
          assert.ok(resultEventBytes > (coordination ? 3 : 23) * 1024 * 1024);
          await stores.runtimeEventStore.appendRuntimeEvent(session.id, 'run-1', resultEvent);
        }
      }

      const read = createSessionTranscriptReader({
        stores,
        canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
      });
      const messages: StoredMessage[] = [];
      for (let position: number | null = 0; position !== null; ) {
        const running: Awaited<ReturnType<typeof read.readDurableRecords>> =
          await read.readDurableRecords(session.id, {
            direction: 'newer',
            position,
            maxStoredBytes: TRANSCRIPT_TURN_MAX_BYTES,
            maxMessages: 64,
          });
        messages.push(
          ...running.records
            .map(({ message }) => message)
            .filter((message) => message.turnId === 'turn-1'),
        );
        position = running.nextPosition;
      }

      assert.deepEqual(
        messages.slice(0, 2).map((message) => ({ type: message.type, id: message.id })),
        [
          { type: 'user', id: 'user-1' },
          { type: 'assistant', id: 'assistant-3' },
        ],
      );
      assert.equal(messages.length, 2 + resultCount * 2);
      const completedAssistant = messages[1];
      assert.equal(completedAssistant?.type, 'assistant');
      if (completedAssistant?.type === 'assistant')
        assert.equal(completedAssistant.text, 'final text');
      if (largeBash) assertLargeBashResult(messages, largeBash);
      const evidence = await openToolResultArchiveEvidenceReader(owner.lease);
      try {
        const reader = {
          readArchivedToolResultResource: createLedgerArchiveResourceReader(evidence),
        };
        const page = readPageSchema.parse(
          await readToolResultArchiveResource(reader, session.id, {
            path: 'maka://runtime/tool-results/large-bash-0-result',
            limit: 1,
          }),
        );
        assert.equal(page.content, 'FRONT');
        assert.equal(page.totalLines, 16_386);
        const tail = readPageSchema.parse(
          await readToolResultArchiveResource(reader, session.id, {
            path: 'maka://runtime/tool-results/large-bash-0-result',
            offset: page.totalLines - 1,
          }),
        );
        assert.equal(tail.content, 'ERROR_TAIL');
        assert.equal(tail.next, null);
      } finally {
        evidence.close();
      }

      const durable = await read.readDurablePage(session.id, {
        direction: 'newer',
        maxBytes: 1024,
        maxMessages: 3,
      });
      assert.equal(durable.throughSequence, await read.readDurableHighWater(session.id));
      assert.ok(durable.throughSequence !== null);
      assert.deepEqual(
        durable.fragments.map((fragment) => {
          const message = JSON.parse(fragment.data.toString('utf8')) as StoredMessage;
          return { type: message.type, id: message.id };
        }),
        [
          { type: 'user', id: 'user-0' },
          { type: 'turn_state', id: 'terminal-0' },
          { type: 'user', id: 'user-1' },
        ],
      );
      if (largeBash) {
        await stores.runtimeEventStore.appendRuntimeEvent(
          session.id,
          'run-1',
          runtimeEvent(session.id, {
            id: 'terminal-1',
            ts: 13 + resultCount * 2,
            ...(coordination ? { status: 'failed' as const } : {}),
            actions: {
              endInvocation: true,
              ...(!coordination
                ? {
                    handoffPause: {
                      protocol: 'runtime_handoff_pause_v1' as const,
                      handoffId: 'large-output-handoff',
                      remainingSteps: null,
                      hostEpoch: 'old-host',
                      rootRunId: 'run-1',
                      successorRunId: 'run-2',
                      successorInvocationId: 'run-2',
                      claimId: 'large-output-claim',
                    },
                  }
                : {}),
            },
          }),
        );
        const recovered = await read.readDurableRecords(session.id, {
          direction: 'older',
          maxStoredBytes: TRANSCRIPT_TURN_MAX_BYTES,
          maxMessages: 32,
        });
        assertLargeBashResult(
          recovered.records.map(({ message }) => message),
          largeBash,
        );
      }
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

/** Every row a reader may serve, as `[sequence, message id]`, in `newer` order. */
type ExpectedRows = ReadonlyArray<readonly [number, string]>;

/**
 * Both directions serve exactly `expected`, monotone in sequence, whether the
 * walk takes one row at a time or the whole transcript at once.
 *
 * Paging is not compared against a sweep: both run the same walk, so a walk
 * that drops a Turn drops it from both and the comparison still passes.
 */
async function assertTranscriptRows(
  read: ReturnType<typeof createSessionTranscriptReader>,
  sessionId: string,
  throughSequence: number,
  expected: ExpectedRows,
): Promise<void> {
  for (const direction of ['older', 'newer'] as const) {
    const wanted = direction === 'older' ? [...expected].reverse() : expected;
    for (const maxMessages of [expected.length, 1]) {
      const rows: Array<readonly [number, string]> = [];
      let position: number | undefined;
      for (let page = 0; page <= expected.length; page++) {
        const result = await read.readDurableRecords(sessionId, {
          direction,
          throughSequence,
          ...(position === undefined ? {} : { position }),
          maxMessages,
          maxStoredBytes: 1 << 20,
        });
        rows.push(
          ...result.records.map(({ sequence, message }) => [sequence, message.id] as const),
        );
        if (result.nextPosition === null) break;
        position = result.nextPosition;
      }
      assert.deepEqual(rows, wanted, `${direction} in pages of ${maxMessages}`);
      for (let index = 1; index < rows.length; index++) {
        const step = rows[index]![0] - rows[index - 1]![0];
        assert.ok(direction === 'older' ? step < 0 : step > 0, `${direction} is monotone`);
      }
    }
  }
}

test('serves every row of a Turn nested inside another', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-nested-paging-'));
  await withNestedTranscript(base, async (read, sessionId) => {
    // outer opens first and ends last; inner opens and ends inside it, so the
    // two Turns share a stretch of the Session's ordinals.
    //
    //   outer: [1 ....................... 10]   rows 2, 9, 10
    //   inner:      [3 ............. 8]         rows 4, 5, 6, 7, 8
    await seed(read.stores, sessionId, 'outer');
    await read.text('outer', 'outer-before');
    await seed(read.stores, sessionId, 'inner');
    for (let index = 0; index < 4; index++) await read.text('inner', `inner-${index}`);
    await read.end('inner', 'inner-end');
    await read.text('outer', 'outer-after');
    await read.end('outer', 'outer-end');

    const throughSequence = (await read.readDurableHighWater(sessionId))!;
    assert.equal(throughSequence, 10 * 8 + 7);
    await assertTranscriptRows(read, sessionId, throughSequence, [
      [2 * 8, 'outer-before'],
      [4 * 8, 'inner-0'],
      [5 * 8, 'inner-1'],
      [6 * 8, 'inner-2'],
      [7 * 8, 'inner-3'],
      [8 * 8, 'inner-end'],
      [9 * 8, 'outer-after'],
      [10 * 8, 'outer-end'],
    ]);
  });
});

test('serves a running Turn that encloses two separated Turns', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-sibling-paging-'));
  await withNestedTranscript(base, async (read, sessionId) => {
    // Two siblings that do not touch each other, both inside one Turn. Meeting
    // a Turn that does not overlap the one in hand proves nothing about the
    // rest, so a walk that probes only its own edges loses whichever side it
    // steps over.
    //
    //   outer: [1 .............................. 11]  rows 2, 6, 10, 11
    //   first:      [3 .. 5]                          rows 4, 5
    //   second:                 [7 .. 9]              rows 8, 9
    await seed(read.stores, sessionId, 'outer');
    await read.text('outer', 'outer-a');
    await seed(read.stores, sessionId, 'first');
    await read.text('first', 'first-a');
    await read.end('first', 'first-end');
    await read.text('outer', 'outer-b');
    await seed(read.stores, sessionId, 'second');
    await read.text('second', 'second-a');
    await read.end('second', 'second-end');
    await read.text('outer', 'outer-c');
    await read.end('outer', 'outer-end');

    // A watermark inside the outer Turn: it is still running as of this read,
    // so it has no ending to be reached through.
    const throughSequence = 10 * 8 + 7;
    assert.equal(await read.readDurableHighWater(sessionId), 11 * 8 + 7);
    await assertTranscriptRows(read, sessionId, throughSequence, [
      [2 * 8, 'outer-a'],
      [4 * 8, 'first-a'],
      [5 * 8, 'first-end'],
      [6 * 8, 'outer-b'],
      [8 * 8, 'second-a'],
      [9 * 8, 'second-end'],
      [10 * 8, 'outer-c'],
    ]);
  });
});

const seed = (
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>,
  sessionId: string,
  runId: string,
) =>
  seedInvocation(stores.runtimeEventStore, {
    sessionId,
    runId,
    turnId: `turn-${runId}`,
    openedAt: 0,
  });

/** A reader over an empty Session, with the appenders these fixtures build from. */
async function withNestedTranscript(
  base: string,
  body: (
    read: ReturnType<typeof createSessionTranscriptReader> & {
      stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
      text(runId: string, id: string): Promise<unknown>;
      end(runId: string, id: string): Promise<unknown>;
    },
    sessionId: string,
  ) => Promise<void>,
): Promise<void> {
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
    let ts = 0;
    const append = (runId: string, id: string, overrides: Partial<RuntimeEvent>) =>
      stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        runId,
        runtimeEvent(session.id, {
          id,
          invocationId: runId,
          runId,
          turnId: `turn-${runId}`,
          ts: ++ts,
          ...overrides,
        }),
      );
    await body(
      {
        ...createSessionTranscriptReader({
          stores,
          canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
        }),
        stores,
        text: (runId, id) =>
          append(runId, id, {
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: id },
            refs: { storedMessageId: id },
          }),
        end: (runId, id) =>
          append(runId, id, { status: 'completed', actions: { endInvocation: true } }),
      },
      session.id,
    );
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

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

function assertLargeBashResult(
  messages: readonly StoredMessage[],
  expected: ReturnType<typeof shapeTerminalResult>,
): void {
  const result = messages.find(
    (message) => message.type === 'tool_result' && message.toolUseId === 'large-bash-0',
  );
  assert.ok(result?.type === 'tool_result');
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < TRANSCRIPT_TURN_MAX_BYTES);
  assert.ok(result.content.kind === 'terminal');
  assert.equal(result.content.status, 'failed');
  assert.equal(result.content.exitCode, 7);
  assert.ok(result.content.output.mode === 'pipes');
  assert.ok(expected.output.mode === 'pipes');
  assert.ok(result.content.output.stdout.length < expected.output.stdout.length);
  assert.ok(result.content.output.stderr.length < expected.output.stderr.length);
  assert.match(result.content.output.stdout, /TAIL/);
  assert.match(result.content.output.stderr, /ERROR_TAIL/);
  assert.match(result.content.output.stdout, /maka:\/\/runtime\/tool-results\/large-bash-0-result/);
  assert.equal(result.content.output.stdoutTruncated, true);
  assert.equal(result.content.output.stderrTruncated, true);
}
