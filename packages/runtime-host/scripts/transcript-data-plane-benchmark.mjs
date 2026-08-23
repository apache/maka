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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '@maka/storage';
import { ClientSessionSubscription } from '../dist/client/session-subscription.js';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '../dist/protocol/index.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
} from '../dist/server/session-transcript-pager.js';

const BOOTSTRAP_BYTES = 16 * 1024;
const RTT_MS = Number.parseInt(process.env.MAKA_TRANSCRIPT_BENCHMARK_RTT_MS ?? '20', 10);
const cases = [
  { name: '5k-small-messages', messages: 5_000, textBytes: 96 },
  { name: '15MiB-single-message', messages: 1, textBytes: 15 * 1024 * 1024 },
  { name: '17MiB-transcript', totalBytes: 17 * 1024 * 1024, textBytes: 4 * 1024 },
  { name: '64MiB-transcript', totalBytes: 64 * 1024 * 1024, textBytes: 4 * 1024 },
];

const results = [];
for (const fixture of cases) results.push(await runFixture(fixture));
console.table(results);

async function runFixture(fixture) {
  const messages = buildMessages(fixture);
  const root = await mkdtemp(join(tmpdir(), 'maka-transcript-benchmark-'));
  const store = createSessionStore(root);
  const setupAt = performance.now();
  const session = await store.create({
    cwd: root,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: fixture.name,
    labels: [],
  });
  await store.appendMessages(session.id, messages);
  const setupMs = performance.now() - setupAt;
  const reader = sqliteReader(store);
  try {
    const openedAt = performance.now();
    const throughSequence = await reader.readDurableHighWater(session.id);
    const { bootstrap, state } = await createSessionTranscriptBootstrap({
      reader,
      sessionId: session.id,
      subscriptionId: `benchmark-${fixture.name}`,
      throughSequence,
      rootTurn: null,
      activeAssistantStreams: [],
      maxBytes: BOOTSTRAP_BYTES,
    });
    const bootstrapCpuMs = performance.now() - openedAt;
    let pageRequests = 0;
    let transferredRawBytes = bootstrap.durable.rawBytes + bootstrap.overlay.rawBytes;
    const subscription = new ClientSessionSubscription(
      {
        hostEpoch: 'benchmark-host',
        subscriptionId: state.subscriptionId,
        nextSequence: 1,
        activeAssistantStreams: [],
        transcript: bootstrap,
        snapshot: {
          schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
          session: {
            sessionId: state.sessionId,
            metadataRevision: 1,
            status: 'active',
            createdAt: 1,
            lastUsedAt: 1,
            isArchived: false,
          },
          projectionRevision: 1,
          rootTurn: null,
          goal: null,
          queue: {
            hostEpoch: 'benchmark-host',
            queueRevision: 0,
            steering: [],
            followup: [],
          },
          interactions: { pending: [] },
        },
      },
      async () => undefined,
      async (request) => {
        pageRequests += 1;
        const page = await readSessionTranscriptPage({ reader, state, request });
        transferredRawBytes += page.rawBytes;
        return page;
      },
    );
    const materializeAt = performance.now();
    const materialized = await subscription.loadTranscript((value) => value);
    const materializeCpuMs = performance.now() - materializeAt;
    if (materialized.length !== messages.length) {
      throw new Error(
        `${fixture.name} materialized ${materialized.length}/${messages.length} messages`,
      );
    }
    const wireRequests = 1 + pageRequests;
    return {
      fixture: fixture.name,
      messages: messages.length,
      rawMiB: decimalMiB(transferredRawBytes),
      bootstrapKiB: decimalKiB(bootstrap.durable.rawBytes + bootstrap.overlay.rawBytes),
      wireRequests,
      pageRequests,
      setupMs: setupMs.toFixed(1),
      bootstrapCpuMs: bootstrapCpuMs.toFixed(1),
      materializeCpuMs: materializeCpuMs.toFixed(1),
      modeledRttFloorMs: wireRequests * RTT_MS,
    };
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

function buildMessages(fixture) {
  const messages = [];
  let encodedBytes = 0;
  const targetCount = fixture.messages ?? Number.POSITIVE_INFINITY;
  while (
    messages.length < targetCount &&
    (fixture.totalBytes === undefined || encodedBytes < fixture.totalBytes)
  ) {
    const index = messages.length;
    const message = {
      type: 'user',
      id: `message-${index}`,
      turnId: `turn-${index}`,
      ts: index + 1,
      text: 'x'.repeat(fixture.textBytes),
    };
    messages.push(message);
    encodedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
  }
  return messages;
}

function sqliteReader(store) {
  return {
    readDurableHighWater: (sessionId) => store.readTranscriptHighWaterSnapshot(sessionId),
    readDurablePage: (sessionId, request) => store.readTranscriptPageSnapshot(sessionId, request),
    readDurableMessagesById: (sessionId, messageIds, throughSequence) =>
      store.readTranscriptMessagesSnapshot(sessionId, messageIds, throughSequence),
    readActiveOverlay: async () => [],
  };
}

function decimalMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function decimalKiB(bytes) {
  return (bytes / 1024).toFixed(2);
}
