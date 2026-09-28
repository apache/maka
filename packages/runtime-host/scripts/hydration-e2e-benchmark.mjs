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

// End-to-end hydration measurement for the #4677 budget item:
// "long Session @30ms RTT: open to visible tail p95 <= 800ms".
//
// Faithful path: a real execution composition (FakeBackend), turns seeded
// through `turn.start`, then per round the client RPCs
// `subscription.open` (tail bootstrap) and `session.transcript.page`
// with REAL injected round-trip latency: every handler call is one wire
// round trip modeled as a 15ms request flight + measured server CPU +
// 15ms response flight. The tail is decoded with the production
// ClientSessionSubscription decode path.
//
// Usage (from packages/runtime-host, after a workspace build):
//   node scripts/hydration-e2e-benchmark.mjs
//   TURNS=1000 ROUNDS=10 RTT_MS=30 node scripts/hydration-e2e-benchmark.mjs

import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { SessionManager } from '@maka/runtime/session-manager';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { ClientSessionSubscription } from '../dist/client/session-subscription.js';
import { createExecutionRuntimeHostComposition } from '../dist/server/execution-composition.js';

const RTT_MS = Number(process.env.RTT_MS ?? 30);
const ROUNDS = Number(process.env.ROUNDS ?? 10);
const TURNS = Number(process.env.TURNS ?? 1000);
const TURN_TEXT_BYTES = Number(process.env.TURN_TEXT_BYTES ?? 40);
const TAIL_VISIBLE_BUDGET_MS = 800;

const HOST_EPOCH = 'hydration-benchmark';
const CONNECTION_ID = 'hydration-benchmark-client';
const operationContext = {
  hostEpoch: HOST_EPOCH,
  connectionId: CONNECTION_ID,
  principal: 'local_os_user',
  principalKind: 'local_owner',
  acquireResidency: () => ({ release() {} }),
};
const flightMs = RTT_MS / 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Every wire RPC is one round trip: request flight, server work, response flight.
const wire = async (serverWork) => {
  await sleep(flightMs);
  const result = await serverWork();
  await sleep(flightMs);
  return result;
};

const root = await mkdtemp(join(tmpdir(), 'maka-hydration-benchmark-'));
const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
if (!owner) throw new Error(`Could not acquire hydration storage root: ${root}`);

// Capture the composition's SessionManager (same trick as startup-profile.mjs).
let manager;
const originalRecover = SessionManager.prototype.recoverInterruptedSessionsStrict;
SessionManager.prototype.recoverInterruptedSessionsStrict = async function (stores) {
  manager = this;
  return originalRecover.call(this, stores);
};
const composition = await createExecutionRuntimeHostComposition(
  {
    owner,
    hostEpoch: HOST_EPOCH,
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => undefined,
    requestDrain: () => undefined,
  },
  {},
  { primaryBackendFactory: (context) => new FakeBackend(context) },
);
await composition.recover();
SessionManager.prototype.recoverInterruptedSessionsStrict = originalRecover;
if (!manager) throw new Error('Composition did not construct a SessionManager');
// Attach the benchmark's client connection to continuity, like a real
// transport accept does (frames are dropped; this harness reads via RPCs).
const connection = composition.continuity.attachConnection(CONNECTION_ID, {
  send: async () => {},
});
await configureDefaultModel(composition.handlers);
const call = async (operation, input) => {
  const outcome = await composition.handlers[operation](input, operationContext);
  if (!outcome.ok) throw new Error(`${operation} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
};

try {
  const created = await call('session.create', {
    sessionId: randomUUID(),
    workspace: { kind: 'host_path', path: root },
    name: `hydration-${TURNS}turns`,
    modelTarget: { kind: 'default' },
  });
  const sessionId = created.id;
  const seedStart = performance.now();
  for (let turn = 0; turn < TURNS; turn += 1) {
    const turnId = `turn-${turn}`;
    const started = await call('turn.start', {
      sessionId,
      turnId,
      content: { text: `hydration turn ${turn} ${'x'.repeat(TURN_TEXT_BYTES)}` },
    });
    await waitForCompletedTurn(sessionId, turnId);
    if (turn % 50 === 0 || turn === TURNS - 1) {
      process.stdout.write(
        `seeded ${turn + 1}/${TURNS} turns (${((performance.now() - seedStart) / 1000).toFixed(0)}s)\n`,
      );
    }
  }
  const seedSeconds = (performance.now() - seedStart) / 1000;

  const samples = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    samples.push(await openAndMeasure(sessionId));
  }
  report({ TURNS, TURN_TEXT_BYTES, RTT_MS, seedSeconds, samples });
} finally {
  await composition.close?.();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

// One round = one client opening the session over an RTT_MS wire.

async function waitForCompletedTurn(sessionId, turnId) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const messages = await manager.getMessages(sessionId);
    const state = messages.findLast(
      (message) => message.type === 'turn_state' && message.turnId === turnId,
    );
    if (state?.status === 'completed') return;
    if (state?.status === 'failed' || state?.status === 'aborted') {
      throw new Error(`Hydration turn ${turnId} ended as ${state.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for hydration turn ${turnId}`);
}

async function openAndMeasure(sessionId) {
  const openStart = performance.now();
  const open = await wire(() =>
    call('subscription.open', {
      sessionId,
      transcript: { kind: 'tail', maxBytes: 16 * 1024 },
    }),
  );
  if (!open.transcript) throw new Error('subscription.open returned no transcript bootstrap');
  const bootstrap = open.transcript;
  let wireBytes = bootstrap.durable.rawBytes;
  let pageRequests = 0;

  const subscription = new ClientSessionSubscription(
    open,
    async () => call('subscription.close', { subscriptionId: open.subscriptionId }),
    async (request) => {
      pageRequests += 1;
      const page = await wire(() =>
        call('session.transcript.page', { subscriptionId: open.subscriptionId, ...request }),
      );
      wireBytes += page.rawBytes;
      return page;
    },
  );

  // Visible tail: production decode path over the bootstrap page.
  const tail = await subscription.decodeTranscriptPage(bootstrap.durable, (value) => value);
  const openToTailMs = performance.now() - openStart;

  // Full hydration: page in the entire transcript through cursors.
  const materialized = await subscription.loadTranscript((value) => value);
  const fullHydrationMs = performance.now() - openStart;
  await subscription.close();

  return {
    openToTailMs,
    fullHydrationMs,
    pageRequests,
    tailMessages: tail.messages.length,
    materializedMessages: materialized.length,
    tailKiB: bootstrap.durable.rawBytes / 1024,
    wireMiB: wireBytes / (1024 * 1024),
  };
}

function report({ TURNS, TURN_TEXT_BYTES, RTT_MS, seedSeconds, samples }) {
  const pick = (key) => samples.map((sample) => sample[key]);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const openToTail = stats(pick('openToTailMs'));
  const fullHydration = stats(pick('fullHydrationMs'));
  console.log(
    `\nfixture: ${TURNS} turns (~${TURN_TEXT_BYTES}B user text/turn), ` +
      `seed ${seedSeconds.toFixed(0)}s, ${ROUNDS} rounds @ ${RTT_MS}ms RTT`,
  );
  console.table([
    {
      metric: 'openToTail (budget 800ms)',
      medianMs: openToTail.medianMs.toFixed(1),
      p95Ms: openToTail.p95Ms.toFixed(1),
      maxMs: openToTail.maxMs.toFixed(1),
      verdict: openToTail.p95Ms <= TAIL_VISIBLE_BUDGET_MS ? 'PASS' : 'FAIL',
    },
    {
      metric: 'fullHydration (no budget)',
      medianMs: fullHydration.medianMs.toFixed(1),
      p95Ms: fullHydration.p95Ms.toFixed(1),
      maxMs: fullHydration.maxMs.toFixed(1),
      verdict: '-',
    },
  ]);
  console.log(
    `tail: ${mean(pick('tailKiB')).toFixed(2)} KiB / ${Math.round(mean(pick('tailMessages')))} msgs, ` +
      `pages(older): median ${[...pick('pageRequests')].sort((a, b) => a - b)[Math.floor(ROUNDS / 2)]}, ` +
      `total wire: ${mean(pick('wireMiB')).toFixed(2)} MiB, ` +
      `materialized: ${samples[0].materializedMessages} msgs`,
  );
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[p95Index],
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
  };
}

async function configureDefaultModel(handlers) {
  const callModel = async (operation, input) => {
    const outcome = await handlers[operation](input, operationContext);
    if (!outcome.ok) throw new Error(`${operation} failed: ${JSON.stringify(outcome.error)}`);
    return outcome.result;
  };
  const catalog = await callModel('connection.catalog.query', { kind: 'start' });
  const created = await callModel('connection.catalog.create', {
    expectedCatalogRevision: catalog.revision,
    connection: {
      slug: 'hydration-benchmark',
      name: 'Hydration benchmark',
      providerType: 'custom',
      defaultApiProtocol: 'openai-chat',
      baseUrl: 'https://hydration-benchmark.invalid/v1',
      enabled: true,
      enabledModelIds: ['hydration-test-model'],
    },
  });
  if (created.kind !== 'committed') throw new Error('Benchmark connection must commit');
  await callModel('credential.vault.set', {
    locator: {
      scope: 'connection',
      connectionId: created.connection.connectionId,
      kind: 'api_key',
    },
    expected: null,
    secret: 'hydration-benchmark-key',
  });
  await callModel('connection.catalog.set-default-target', {
    expectedCatalogRevision: created.catalogRevision,
    target: { connectionId: created.connection.connectionId, modelId: 'hydration-test-model' },
  });
}
