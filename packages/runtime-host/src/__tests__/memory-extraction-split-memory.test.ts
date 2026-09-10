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
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('long-session extraction stops copying split candidates after the first fit', () => {
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createSqliteRuntimeStore } from ${JSON.stringify(import.meta.resolve('@maka/storage/sqlite-runtime-store'))};
    import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from ${JSON.stringify(import.meta.resolve('@maka/storage/root-authority'))};
    import { openInteractiveLongTermMemoryStoreForWrite } from ${JSON.stringify(import.meta.resolve('@maka/storage/long-term-memory-store'))};
    import { HostMemoryExtractionCoordinator } from ${moduleUrl('../server/memory-extraction-coordinator.js')};
    import { MemoryExtractionSessionLane } from ${moduleUrl('../server/memory-extraction-session-lane.js')};

    const root = await mkdtemp(join(tmpdir(), 'maka-memory-split-'));
    const originalSlice = Array.prototype.slice;
    let runtime, owner, writer, coordinator;
    try {
      runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      writer = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);

      // 200 Turns of short, valid events: the whole request exceeds 40k tokens,
      // while both halves fit. The preferred split is the midpoint Turn boundary.
      const count = 4000;
      for (let index = 0; index < count; index++) {
        const turn = Math.floor(index / 20);
        const user = index % 20 === 0;
        const event = {
          id: 'event-' + index, invocationId: 'invocation-' + turn,
          runId: 'run-' + turn, sessionId: 'session-1', turnId: 'turn-' + turn,
          ts: 1000 + index, partial: false,
          role: user ? 'user' : 'model', author: user ? 'user' : 'agent',
          content: { kind: 'text', text: user ? 'Keep concise.' : 'Acknowledged.' },
        };
        await runtime.appendRuntimeEvent('session-1', event.runId, event);
      }

      const requests = [], commits = [];
      let release;
      const completed = new Promise(resolve => { release = resolve; });
      coordinator = new HostMemoryExtractionCoordinator({
        store: {
          ...writer,
          commitExtraction: async request => {
            commits.push(request);
            return writer.commitExtraction(request);
          },
        },
        policy: { getSnapshot: async () => ({ policy: {
          privacy: { incognitoActive: false }, memory: { enabled: true },
        } }) },
        sessions: { readHeader: async () => ({ isArchived: false }) },
        runtimeEvents: runtime,
        historyCompaction: {
          readLatestCheckpoint: async () => undefined, readCheckpoints: async () => [],
        },
        model: { generate: async request => {
          requests.push(request);
          return { ok: true, text: JSON.stringify({
            status: 'complete', coverageStatus: 'processed', requestedStatus: 'not_applicable',
            requestedItems: [], incidentalItems: [],
          }) };
        } },
        lane: new MemoryExtractionSessionLane(),
        acquireResidency: () => ({ release }), now: () => 2000,
      });

      // Isolate the observer in this child, retain no sliced arrays, and count
      // only copies of the full event-entry range during extraction planning.
      // The eager implementation copies 15,999,999 slots before testing a fit.
      let copiedSlots = 0;
      Array.prototype.slice = function (...args) {
        const result = Reflect.apply(originalSlice, this, args);
        if (this.length === count && this[0]?.event?.id === 'event-0') {
          copiedSlots += result.length;
        }
        return result;
      };
      global.gc();
      coordinator.sourceCapabilities().extract({
        trigger: 'extract', sourceHeader: { model: 'test-model', llmConnectionSlug: 'test' },
        sourceSystemPrompt: 'system', sourceMessages: [], sourceTools: {}, sourceActiveTools: [],
        sourceContextWindowTokens: 40000, sourceMaxOutputTokens: 256,
        sessionId: 'session-1', runId: 'run-199', turnId: 'turn-199',
        workspaceKey: '/workspace/maka', terminalEventId: 'event-3999',
      });
      await completed;
      Array.prototype.slice = originalSlice;

      assert.equal(requests.length, 2, 'both split ranges must reach the model exactly once');
      assert.deepEqual(commits.map(({ expectedCursorOrdinal, nextCursorOrdinal }) =>
        [expectedCursorOrdinal, nextCursorOrdinal]), [[0, 2000], [2000, 4000]]);
      for (let segment = 0; segment < 2; segment++) {
        const request = requests[segment];
        assert.equal(request.stage, 'proposal');
        assert.equal(request.snapshot.sourceMessages.length, 2000);
        const expectedPositions = {};
        const coverage = [];
        for (let offset = 0; offset < 2000; offset++) {
          const index = segment * 2000 + offset;
          const user = index % 20 === 0;
          expectedPositions['event-' + index] = [offset];
          coverage.push([index + 1, 'event-' + index]);
          assert.deepEqual(request.snapshot.sourceMessages[offset], {
            role: user ? 'user' : 'assistant',
            content: [{ type: 'text', text: user ? 'Keep concise.' : 'Acknowledged.' }],
          });
        }
        assert.deepEqual(request.snapshot.sourceEventMessagePositions, expectedPositions);
        assert.equal(commits[segment].coverageHash,
          createHash('sha256').update(JSON.stringify(coverage)).digest('hex'));
        assert.ok(await writer.readExtractionReceipt(commits[segment].operationId));
      }
      assert.equal((await writer.readExtractionCursor('session-1')).processedOrdinal, count);
      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      assert.ok(copiedSlots >= count, 'the workload must exercise range splitting');
      assert.ok(copiedSlots < count * 5,
        'first-fit planning must bound copied event slots; observed ' + copiedSlots);
    } finally {
      Array.prototype.slice = originalSlice;
      await coordinator?.close();
      writer?.close();
      runtime?.close();
      await owner?.close();
      await rm(root, { recursive: true, force: true });
    }
  `,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
