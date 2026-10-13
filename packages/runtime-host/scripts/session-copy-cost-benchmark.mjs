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

import { performance } from 'node:perf_hooks';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { SessionManager } from '@maka/runtime/session-manager';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createExecutionRuntimeHostComposition } from '../dist/server/execution-composition.js';

const HISTORY_SIZES = [4, 16, 64, 128];
const COPY_SAMPLE_COUNT = 5;
const COPY_RETRY_ATTEMPTS = 20;
const COPY_RETRY_DELAY_MS = 25;
const CONNECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationContext = {
  hostEpoch: 'session-copy-cost-benchmark',
  connectionId: 'benchmark-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

const results = [];
for (const historySize of HISTORY_SIZES) {
  results.push(await runFixture(historySize));
}
console.table(results);

async function runFixture(historySize) {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-copy-benchmark-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error(`Could not acquire benchmark storage root: ${root}`);

  let composition;
  let manager;
  const originalRecover = SessionManager.prototype.recoverInterruptedSessionsStrict;
  SessionManager.prototype.recoverInterruptedSessionsStrict = async function (stores) {
    manager = this;
    return originalRecover.call(this, stores);
  };
  try {
    composition = await createExecutionRuntimeHostComposition(
      {
        owner,
        hostEpoch: operationContext.hostEpoch,
        acquireResidency: () => ({ release() {} }),
        retainUntilProcessExit: () => undefined,
        requestDrain: () => undefined,
      },
      {},
      {
        primaryBackendFactory: (context) => new FakeBackend(context),
      },
    );
    await composition.recover();

    if (!manager) throw new Error('Execution composition did not construct a SessionManager');
    const source = await manager.createSession({
      cwd: root,
      llmConnectionId: CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'bypass',
      name: `copy-cost-${historySize}`,
    });
    let sourceTurnId;
    for (let index = 0; index < historySize; index += 1) {
      sourceTurnId = `turn-${index}`;
      const started = await composition.handlers['turn.start'](
        {
          sessionId: source.id,
          turnId: sourceTurnId,
          content: { text: `benchmark turn ${index} ${'x'.repeat(256)}` },
        },
        operationContext,
      );
      if (!started.ok) throw new Error(`Turn ${index} failed to start: ${started.reason}`);
      await waitForCompletedTurn(manager, source.id, sourceTurnId);
    }

    const sourceSummary = (await manager.listSessions()).find((item) => item.id === source.id);
    if (!sourceSummary || !sourceTurnId) throw new Error('Benchmark source did not settle');

    await copySession({ composition, manager, sourceSessionId: source.id, sourceTurnId });
    const beforeBytes = await directoryBytes(root);
    const copyDurations = [];
    let targetSessionId;
    for (let sample = 0; sample < COPY_SAMPLE_COUNT; sample += 1) {
      targetSessionId = randomUUID();
      const startedAt = performance.now();
      await copySession({
        composition,
        manager,
        sourceSessionId: source.id,
        sourceTurnId,
        targetSessionId,
      });
      copyDurations.push(performance.now() - startedAt);
    }
    const afterBytes = await directoryBytes(root);
    const sourceMessages = await manager.getMessages(source.id);
    const childMessages = await manager.getMessages(targetSessionId);
    const sourceInvocations = await manager.listInvocations(source.id);
    const childInvocations = await manager.listInvocations(targetSessionId);

    return {
      historySize,
      copyMsMedian: median(copyDurations).toFixed(1),
      addedMiB: ((afterBytes - beforeBytes) / COPY_SAMPLE_COUNT / (1024 * 1024)).toFixed(3),
      sourceMessages: sourceMessages.length,
      childMessages: childMessages.length,
      sourceRuns: sourceInvocations.length,
      childRuns: childInvocations.length,
      amplification: (childMessages.length / Math.max(1, sourceMessages.length)).toFixed(2),
    };
  } finally {
    SessionManager.prototype.recoverInterruptedSessionsStrict = originalRecover;
    composition?.beginDrain();
    await composition?.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function copySession({
  composition,
  manager,
  sourceSessionId,
  sourceTurnId,
  targetSessionId = randomUUID(),
}) {
  let lastOutcome;
  for (let attempt = 0; attempt < COPY_RETRY_ATTEMPTS; attempt += 1) {
    const sourceRecord = await manager.deps.store.readHeaderRecordSnapshot(sourceSessionId);
    const copied = await composition.handlers['session.branch.create'](
      {
        sourceSessionId,
        targetSessionId,
        sourceTurnId,
        expectedSourceRevision: sourceRecord.revision,
      },
      operationContext,
    );
    if (copied.ok && copied.result.kind === 'committed') return copied.result;

    lastOutcome = copied;
    const retryable =
      (copied.ok && copied.result.kind === 'source_revision_conflict') ||
      (!copied.ok && copied.error.code === 'session_busy');
    if (!retryable) break;
    await sleep(COPY_RETRY_DELAY_MS);
  }
  throw new Error(`Session copy failed after retries: ${JSON.stringify(lastOutcome)}`);
}

async function waitForCompletedTurn(manager, sessionId, turnId) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const messages = await manager.getMessages(sessionId);
    const state = messages.findLast(
      (message) => message.type === 'turn_state' && message.turnId === turnId,
    );
    if (state?.status === 'completed') return;
    if (state?.status === 'failed' || state?.status === 'aborted') {
      throw new Error(`Benchmark turn ${turnId} ended as ${state.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for benchmark turn ${turnId}`);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function directoryBytes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (entry.name === '.maka-storage-root.json') continue;
    const path = join(root, entry.name);
    const info = await stat(path);
    total += info.isDirectory() ? await directoryBytes(path) : info.size;
  }
  return total;
}
