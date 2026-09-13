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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { backfillRuntimeEventsFromStoredMessages } from '../../../../../packages/runtime/dist/runtime-event-backfill.js';
import { createSessionTranscriptReader } from '../../../../../packages/runtime-host/dist/server/session-transcript-reader.js';
import { isRuntimeSystemNoteKind, type StoredMessage } from '@maka/core/session';

const FIXTURE_EPOCH = Date.UTC(2026, 0, 2, 3, 4, 5);

/**
 * The real SQLite ledger and Host reader used by the navigation regressions.
 * Legacy-shaped input keeps the payload fixture legible, but every page is
 * projected by the production RuntimeEvent reader. Running Turns live only in
 * the active overlay; their rows acquire sparse durable sequences on ending.
 */
export async function openTranscriptNavigationLedger(messages: readonly StoredMessage[]) {
  const base = await mkdtemp(join(tmpdir(), 'maka-transcript-navigation-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const runtimeEventStore = stores.runtimeEventStore;
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fixture', model: 'fixture-model', permissionMode: 'ask',
    });
    const sessionId = session.id;
    const byTurn = new Map<string, Array<{ index: number; message: StoredMessage }>>();
    messages.forEach((message, index) => {
      assert.ok(message.turnId);
      const records = byTurn.get(message.turnId) ?? [];
      records.push({ index, message: { ...message, ts: FIXTURE_EPOCH + index } });
      byTurn.set(message.turnId, records);
    });
    const pending: Array<{ index: number; event: RuntimeEvent }> = [];
    for (const [turnId, records] of byTurn) {
      const runId = `run-${turnId}`;
      let eventIndex = 0;
      const converted = backfillRuntimeEventsFromStoredMessages({
        run: { sessionId, runId, invocationId: runId, turnId },
        // Session-resume notes belong to Session metadata in main; only an
        // invocation-owned note can enter its RuntimeEvent transcript.
        messages: records.map(({ message }) => message).filter((message) =>
          message.type !== 'system_note' || isRuntimeSystemNoteKind(message.kind)),
        outcome: { status: 'completed', ts: FIXTURE_EPOCH + records.at(-1)!.index },
        modelHistory: 'full', now: () => FIXTURE_EPOCH,
        newId: () => `${runId}-event-${eventIndex++}`,
      });
      assert.deepEqual(converted.diagnostics, [], 'the fixture must retain every source payload');
      for (const event of converted.events) {
        const index = event.actions?.endInvocation ? records.at(-1)!.index
          : records.find(({ message }) => message.id === event.refs?.storedMessageId)?.index;
        assert.notEqual(index, undefined);
        pending.push({ index: index!, event });
      }
    }
    pending.sort((left, right) => left.index - right.index);
    const opened = new Set<string>();
    let appendedThrough = -1;
    const reader = createSessionTranscriptReader({
      stores, canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    return {
      sessionId, reader,
      async appendThrough(messageId: string) {
        const index = messages.findIndex((message) => message.id === messageId);
        assert.ok(index >= 0, `Unknown transcript fixture checkpoint: ${messageId}`);
        assert.ok(index >= appendedThrough, 'fixture writes advance monotonically');
        for (const pendingEvent of pending) {
          if (pendingEvent.index <= appendedThrough || pendingEvent.index > index) continue;
          const { event } = pendingEvent;
          if (!opened.has(event.turnId)) {
            await seedInvocation(runtimeEventStore, {
              sessionId, turnId: event.turnId, runId: event.runId, openedAt: event.ts - 0.5,
            });
            opened.add(event.turnId);
          }
          await runtimeEventStore.appendRuntimeEvent(sessionId, event.runId, event);
        }
        appendedThrough = index;
        return reader.readDurableHighWater(sessionId);
      },
      async appendPartialAssistant(turnId: string, messageId: string, text: string) {
        const runId = `run-${turnId}`;
        assert.ok(opened.has(turnId));
        await runtimeEventStore.appendRuntimeEvent(sessionId, runId, {
          id: `partial-${messageId}`, sessionId, runId, invocationId: runId, turnId,
          ts: FIXTURE_EPOCH + appendedThrough + 0.5,
          partial: true, role: 'model', author: 'agent',
          content: { kind: 'text', text }, refs: { providerEventId: messageId },
        });
      },
      async durableRecords() {
        const result = await reader.readDurableRecords(sessionId, {
          direction: 'newer', maxMessages: 1_000, maxStoredBytes: 16 * 1024 * 1024,
        });
        assert.equal(result.nextPosition, null, 'the assertion sweep must include every durable row');
        return result.records;
      },
      async close() {
        await stores!.sessionStore.close?.();
        await owner.close();
        await rm(base, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stores?.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}
