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

import { deferred, type Deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import type { ComputerHistorySummaryInput } from '@maka/core/computer-history';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { readHostRegistration } from '../control/registration.js';
import {
  connectRuntimeHost,
  RuntimeHostRequestInterruptedError,
  type RuntimeHostConnection,
} from '../client/index.js';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS,
  RUNTIME_HOST_PROTOCOL_VERSION,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type ClientFrame,
  type EncodedProtocolMessage,
  type HostFrame,
  type ResponseFrame,
  type TurnSnapshot,
} from '../protocol/index.js';
import { RuntimeHostKernel, type RuntimeHostComposition } from '../server/index.js';
import { LOCAL_OWNER_CONNECTION_AUTHORITY } from '../server/connection-authority.js';
import type {
  ClientCapabilityConnectionIdentity,
  ClientCapabilityService,
} from '../server/client-capability-service.js';
import { RuntimeHostConnectionSession } from '../server/connection-session.js';
import type { SessionContinuityService } from '../server/session-continuity-service.js';
import {
  createUnavailableHostCoreOperationHandlers,
  createUnavailableDomainOperationHandlers,
  type OperationHandlerMap,
} from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import {
  BoundedSerialOutboundWriter,
  RuntimeHostOutboundQueueError,
} from '../server/serial-outbound-writer.js';
import { FramedTransport } from '../transport/framed-transport.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

function acceptedConnection(connectionId: string) {
  return {
    hostEpoch: 'host-epoch',
    connectionId,
    clientInstanceId: 'test-client',
    authority: LOCAL_OWNER_CONNECTION_AUTHORITY,
  };
}

type TurnQueryHandler = RuntimeHostComposition['handlers']['turn.query'];

const HISTORY_INPUT: ComputerHistorySummaryInput = {
  level: '10min',
  start: '2026-09-13T00:00:00.000Z',
  end: '2026-09-13T00:10:00.000Z',
  evidence: [{ id: 'event', text: 'Edited project documentation.' }],
};
const HISTORY_RESULT = {
  title: 'Documentation',
  description: 'Edited docs.',
  body: 'Observed edits.',
};

test('an aborted queued summary never dispatches after saturation clears', async (t) => {
  const saturated = deferred();
  const release = deferred();
  let queries = 0;
  let summaries = 0;
  await withRuntimeHost(
    async (input) => {
      if (++queries === RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 1) saturated.resolve();
      await release.promise;
      return { ok: true, result: runningSnapshot(input.sessionId, input.turnId) };
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const blockers = Array.from(
        { length: RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 1 },
        (_, i) => client.request('turn.query', { sessionId: 'session', turnId: `block-${i}` }),
      );
      try {
        await withTimeout(saturated.promise, 1_000, 'client queue did not saturate');
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const abort = new AbortController();
        const summary = client.request(
          'computer-history.summarize',
          HISTORY_INPUT,
          75_000,
          abort.signal,
        );
        const rejected = assert.rejects(summary, { name: 'AbortError' });
        abort.abort();
        await rejected;
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
        t.mock.timers.tick(10_001);
        assert.equal(summaries, 0);
        t.mock.timers.reset();
        release.resolve();
        await Promise.all(blockers);
        // A subsequent request proves the queue drained without reviving cancelled evidence.
        await client.request('turn.query', { sessionId: 'session', turnId: 'barrier' });
        assert.equal(summaries, 0);
        assert.deepEqual(
          await client.request('computer-history.summarize', HISTORY_INPUT),
          HISTORY_RESULT,
        );
        assert.equal(summaries, 1);
      } finally {
        t.mock.timers.reset();
        release.resolve();
        await Promise.allSettled(blockers);
      }
    },
    {
      'computer-history.summarize': async () => {
        summaries++;
        return { ok: true, result: HISTORY_RESULT };
      },
    },
  );
});

test('a dispatched summary cancels past saturated domain work and waits for terminal response', async () => {
  const entered = deferred();
  const cancelled = deferred();
  const finish = deferred();
  const saturated = deferred();
  const release = deferred();
  let queries = 0;
  await withRuntimeHost(
    async (input) => {
      if (++queries === RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 2) saturated.resolve();
      await release.promise;
      return { ok: true, result: runningSnapshot(input.sessionId, input.turnId) };
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const abort = new AbortController();
      let settled = false;
      const summary = client
        .request('computer-history.summarize', HISTORY_INPUT, 75_000, abort.signal)
        .finally(() => {
          settled = true;
        });
      const rejected = assert.rejects(summary, { name: 'AbortError' });
      const blockers: Promise<unknown>[] = [];
      try {
        await withTimeout(entered.promise, 1_000, 'summary did not enter');
        for (let i = 0; i < RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 2; i++) {
          blockers.push(
            client.request('turn.query', { sessionId: 'session', turnId: `block-${i}` }),
          );
        }
        await withTimeout(saturated.promise, 1_000, 'client queue did not saturate');
        abort.abort();
        await withTimeout(cancelled.promise, 1_000, 'cancellation was trapped behind domain work');
        assert.equal(settled, false);
        finish.resolve();
        await rejected;
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
        // Cancel does not close the shared connection or disrupt unrelated work.
        release.resolve();
        await Promise.all(blockers);
        assert.equal((await client.status()).state, 'ready');
      } finally {
        finish.resolve();
        release.resolve();
        await Promise.allSettled([rejected, ...blockers]);
      }
    },
    {
      'computer-history.summarize': async (_input, context) => {
        assert.ok(context.requestAbortSignal);
        context.requestAbortSignal.addEventListener('abort', () => cancelled.resolve(), {
          once: true,
        });
        entered.resolve();
        await finish.promise;
        return { ok: true, result: HISTORY_RESULT };
      },
    },
  );
});

test('summary request cancellation rejects unsupported signals and cleans up success and disconnect', async () => {
  const entered = deferred();
  const disconnected = deferred();
  const finish = deferred();
  let summaries = 0;
  await withRuntimeHost(
    async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    async ({ connectClient }) => {
      const client = await connectClient();
      await assert.rejects(
        client.request('computer-history.summarize', HISTORY_INPUT, 75_000, AbortSignal.abort()),
        { name: 'AbortError' },
      );
      await assert.rejects(
        client.request(
          'turn.query',
          { sessionId: 'session', turnId: 'unsupported' },
          undefined,
          new AbortController().signal,
        ),
        /does not support request cancellation/,
      );
      assert.equal(summaries, 0);
      const completed = new AbortController();
      await client.request(
        'computer-history.summarize',
        HISTORY_INPUT,
        undefined,
        completed.signal,
      );
      assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
      completed.abort();
      const abort = new AbortController();
      const summary = client.request(
        'computer-history.summarize',
        HISTORY_INPUT,
        75_000,
        abort.signal,
      );
      const rejected = assert.rejects(
        summary,
        (error: unknown) =>
          error instanceof RuntimeHostRequestInterruptedError && error.reason === 'connection_lost',
      );
      try {
        await withTimeout(entered.promise, 1_000, 'second summary did not enter');
        await client.close();
        await rejected;
        await withTimeout(disconnected.promise, 1_000, 'disconnect did not reach summary');
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
      } finally {
        finish.resolve();
        await rejected;
      }
    },
    {
      'computer-history.summarize': async (_input, context) => {
        if (++summaries === 1) return { ok: true, result: HISTORY_RESULT };
        context.inputClosedSignal!.addEventListener('abort', () => disconnected.resolve(), {
          once: true,
        });
        entered.resolve();
        await finish.promise;
        return { ok: true, result: HISTORY_RESULT };
      },
    },
  );
});

test('summary timeout cancels Host work and retires its eventual response without closing the client', async (t) => {
  const entered = deferred();
  const cancelled = deferred();
  const finish = deferred();
  await withRuntimeHost(
    async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    async ({ connectClient }) => {
      const client = await connectClient();
      const abort = new AbortController();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const summary = client.request(
        'computer-history.summarize',
        HISTORY_INPUT,
        75_000,
        abort.signal,
      );
      const rejected = assert.rejects(
        summary,
        (error: unknown) =>
          error instanceof RuntimeHostRequestInterruptedError &&
          error.dispatch === 'dispatched' &&
          error.reason === 'timeout',
      );
      try {
        await entered.promise;
        t.mock.timers.tick(75_000);
        await rejected;
        t.mock.timers.reset();
        await withTimeout(cancelled.promise, 1_000, 'timeout did not cancel provider work');
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
        finish.resolve();
        await client.request('turn.query', { sessionId: 'session', turnId: 'after-timeout' });
        assert.equal((await client.status()).state, 'ready');
      } finally {
        t.mock.timers.reset();
        finish.resolve();
        await rejected;
      }
    },
    {
      'computer-history.summarize': async (_input, context) => {
        context.requestAbortSignal!.addEventListener('abort', () => cancelled.resolve(), {
          once: true,
        });
        entered.resolve();
        await finish.promise;
        return { ok: true, result: HISTORY_RESULT };
      },
    },
  );
});

for (const callerCancels of [false, true]) {
  test(`summary has a 190-second terminal bound when Host ignores ${callerCancels ? 'caller cancellation' : 'the deadline'}`, {
    timeout: 10_000,
  }, async (t) => {
    const entered = deferred();
    const cancelled = deferred();
    const finish = deferred();
    const saturated = deferred();
    const release = deferred();
    let queries = 0;
    let queuedEntered = false;
    let hostSignal: AbortSignal | undefined;
    await withRuntimeHost(
      async (input) => {
        if (input.turnId === 'queued') {
          queuedEntered = true;
        } else {
          if (++queries === RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 2) saturated.resolve();
          await release.promise;
        }
        return { ok: true, result: runningSnapshot(input.sessionId, input.turnId) };
      },
      async ({ connectClient }) => {
        const client = await connectClient();
        const abort = new AbortController();
        const blockers: Promise<unknown>[] = [];
        let queued: Promise<unknown> | undefined;
        let settlements = 0;
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const summary = client
          .request('computer-history.summarize', HISTORY_INPUT, 190_000, abort.signal)
          .finally(() => {
            settlements++;
          });
        const rejected = assert.rejects(
          summary,
          (error: unknown) =>
            error instanceof RuntimeHostRequestInterruptedError &&
            error.dispatch === 'dispatched' &&
            error.reason === 'timeout',
        );
        try {
          await entered.promise;
          t.mock.timers.tick(125_000);
          await Promise.resolve();
          assert.equal(settlements, 0);
          assert.equal(hostSignal?.aborted, false);
          if (callerCancels) {
            abort.abort();
            await cancelled.promise;
            assert.equal(settlements, 0);
          }
          t.mock.timers.tick(64_999);
          await Promise.resolve();
          assert.equal(settlements, 0);
          t.mock.timers.tick(1);
          await rejected;
          t.mock.timers.reset();
          await withTimeout(cancelled.promise, 1_000, 'deadline did not cancel Host work');
          assert.equal(settlements, 1);
          assert.equal(getEventListeners(abort.signal, 'abort').length, 0);

          for (let i = 0; i < RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 2; i++) {
            blockers.push(
              client.request('turn.query', { sessionId: 'session', turnId: `block-${i}` }),
            );
          }
          await withTimeout(saturated.promise, 1_000, 'domain requests did not saturate');
          queued = client.request('turn.query', { sessionId: 'session', turnId: 'queued' });
          // Status bypasses domain slots and proves that the connection is still usable.
          assert.equal((await client.status()).state, 'ready');
          assert.equal(queuedEntered, false, 'retirement must retain the unacknowledged slot');
          finish.resolve();
          await withTimeout(queued, 1_000, 'late summary response did not release its slot');
          assert.equal(queuedEntered, true);
          assert.equal(settlements, 1);
          release.resolve();
          await Promise.all(blockers);
          assert.equal((await client.status()).state, 'ready');
        } finally {
          t.mock.timers.reset();
          finish.resolve();
          release.resolve();
          abort.abort();
          await Promise.allSettled([rejected, ...blockers, ...(queued ? [queued] : [])]);
        }
      },
      {
        'computer-history.summarize': async (_input, context) => {
          hostSignal = context.requestAbortSignal;
          assert.ok(hostSignal);
          hostSignal.addEventListener('abort', () => cancelled.resolve(), { once: true });
          entered.resolve();
          await finish.promise;
          return { ok: true, result: HISTORY_RESULT };
        },
      },
    );
  });
}

test('only Computer History requests may exceed the 120-second timeout cap', async () => {
  await withRuntimeHost(
    async (input) => ({ ok: true, result: runningSnapshot(input.sessionId, input.turnId) }),
    async ({ connectClient }) => {
      const client = await connectClient();
      for (const timeout of [0, -1, 190_001, 190_000.5, NaN, Infinity]) {
        assert.throws(
          () => client.request('computer-history.summarize', HISTORY_INPUT, timeout),
          RangeError,
        );
      }
      assert.throws(
        () => client.request('turn.query', { sessionId: 'session', turnId: 'invalid' }, 120_001),
        RangeError,
      );
      await assert.rejects(client.status(120_001), RangeError);
      assert.equal(
        (await client.request('turn.query', { sessionId: 'session', turnId: 'valid' }, 120_000))
          .status,
        'running',
      );
      assert.deepEqual(
        await client.request('computer-history.summarize', HISTORY_INPUT, 190_000),
        HISTORY_RESULT,
      );
    },
    { 'computer-history.summarize': async () => ({ ok: true, result: HISTORY_RESULT }) },
  );
  for (const option of ['connectTimeoutMs', 'handshakeTimeoutMs', 'livenessIntervalMs'] as const) {
    await assert.rejects(
      connectRuntimeHost({
        rootPath: '/unused-invalid-timeout',
        protocol: CURRENT_PROTOCOL,
        [option]: 120_001,
      }),
      RangeError,
    );
  }
});

test('late cancellation of more than 256 completed requests cannot exhaust admission cancellation', async () => {
  const pair = await openTransportPair();
  const admissionEntered = deferred();
  const admit = deferred();
  let generations = 0;
  let noncancellableCalls = 0;
  let leases = 0;
  const handlers: OperationHandlerMap = {
    'host.status': async () => ({
      ok: true,
      result: {
        hostEpoch: 'host-epoch',
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
        connections: 1,
        activeOperations: 1,
        activeResidencies: 0,
      },
    }),
    ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
    ...createUnavailableHostCoreOperationHandlers(),
    ...createHandlers(async (input, context) => {
      assert.equal(context.requestAbortSignal, undefined);
      noncancellableCalls++;
      return { ok: true, result: runningSnapshot(input.sessionId, input.turnId) };
    }),
    'computer-history.summarize': async () => {
      generations++;
      return { ok: true, result: HISTORY_RESULT };
    },
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection('cancellable-admission'),
    resolveHandlers: () => handlers,
    resolveContinuity: () => undefined,
    beginOperation: async (frame) => {
      if (frame.requestId === 'pending' || frame.requestId === 'ordinary') {
        admissionEntered.resolve();
        await admit.promise;
      }
      leases++;
      return {
        acquireResidency: () => ({ release() {} }),
        seal() {},
        finish() {
          leases--;
        },
      };
    },
    onTeardown() {},
  });
  const run = session.run();
  try {
    for (let i = 0; i < 300; i++) {
      const requestId = `completed-${i}`;
      await writeProtocolFrame(pair.clientTransport, {
        requestId,
        operation: 'computer-history.summarize',
        input: HISTORY_INPUT,
      });
      const response = decodeHostFrame(await pair.clientTransport.read(1_000));
      assert.ok('ok' in response && response.ok);
      await writeProtocolFrame(pair.clientTransport, { kind: 'request.cancel', requestId });
    }
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'pending',
      operation: 'computer-history.summarize',
      input: HISTORY_INPUT,
    });
    await admissionEntered.promise;
    await writeProtocolFrame(pair.clientTransport, {
      kind: 'request.cancel',
      requestId: 'pending',
    });
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'ordinary',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'ordinary' },
    });
    await writeProtocolFrame(pair.clientTransport, {
      kind: 'request.cancel',
      requestId: 'ordinary',
    });
    // This reply proves both control frames were consumed while admission is held.
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'barrier',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'barrier' },
    });
    const barrier = decodeHostFrame(await pair.clientTransport.read(1_000));
    assert.ok('requestId' in barrier && barrier.requestId === 'barrier');
    admit.resolve();
    const replies = [
      decodeHostFrame(await pair.clientTransport.read(1_000)),
      decodeHostFrame(await pair.clientTransport.read(1_000)),
    ];
    const cancelled = replies.find(
      (reply) => 'requestId' in reply && reply.requestId === 'pending',
    );
    assert.ok(cancelled && 'ok' in cancelled && !cancelled.ok);
    assert.equal(cancelled.error.code, 'operation_unavailable');
    const ordinary = replies.find(
      (reply) => 'requestId' in reply && reply.requestId === 'ordinary',
    );
    assert.ok(ordinary && 'ok' in ordinary && ordinary.ok);
    assert.equal(generations, 300);
    assert.equal(noncancellableCalls, 2);
    // Unmatched IDs create no state and cannot cancel future work.
    await writeProtocolFrame(pair.clientTransport, { kind: 'request.cancel', requestId: 'future' });
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'future',
      operation: 'computer-history.summarize',
      input: HISTORY_INPUT,
    });
    const subsequent = decodeHostFrame(await pair.clientTransport.read(1_000));
    assert.ok('ok' in subsequent && subsequent.ok);
    assert.equal(generations, 301);
  } finally {
    admit.resolve();
    pair.clientTransport.abort();
    await Promise.all([run, pair.close()]);
  }
  assert.equal(leases, 0);
});

test('request cancellation cannot target the same wire ID on another connection', async () => {
  const entered = deferred();
  const finish = deferred();
  let signal: AbortSignal | undefined;
  await withRuntimeHost(
    async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    async ({ endpoint }) => {
      const owner = await openAcceptedTransport(endpoint, 'summary-owner');
      const other = await openAcceptedTransport(endpoint, 'other-client');
      try {
        await writeProtocolFrame(owner, {
          requestId: 'same-wire-id',
          operation: 'computer-history.summarize',
          input: HISTORY_INPUT,
        });
        await withTimeout(entered.promise, 1_000, 'summary did not enter');
        await writeProtocolFrame(other, { kind: 'request.cancel', requestId: 'same-wire-id' });
        await writeProtocolFrame(other, {
          requestId: 'barrier',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'barrier' },
        });
        await other.read(1_000);
        assert.ok(signal);
        assert.equal(signal.aborted, false);
        finish.resolve();
        const response = decodeHostFrame(await owner.read(1_000));
        assert.ok('ok' in response && response.ok);
      } finally {
        finish.resolve();
        owner.abort();
        other.abort();
        await Promise.all([owner.closed, other.closed]);
      }
    },
    {
      'computer-history.summarize': async (_input, context) => {
        signal = context.requestAbortSignal;
        entered.resolve();
        await finish.promise;
        return { ok: true, result: HISTORY_RESULT };
      },
    },
  );
});

test('concurrent responses remain framed and correlated in reverse completion order', async () => {
  const requestCount = 16;
  const entered = Array.from({ length: requestCount }, () => deferred());
  const release = Array.from({ length: requestCount }, () => deferred());
  await withRuntimeHost(
    async (input) => {
      const index = Number(input.turnId.slice('turn-'.length));
      entered[index]?.resolve();
      await release[index]?.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const requests = Array.from({ length: requestCount }, (_, index) =>
        client.request('turn.query', { sessionId: 'session', turnId: `turn-${index}` }, 5_000),
      );
      try {
        await withTimeout(
          Promise.all(entered.map((item) => item.promise)),
          1_000,
          'concurrent handlers were not all admitted',
        );

        for (let index = requestCount - 1; index >= 0; index -= 1) {
          release[index]?.resolve();
          const result = await requests[index];
          assert.equal(result?.turnId, `turn-${index}`);
          assert.equal(result?.runId, `run-turn-${index}`);
        }
        const results = await Promise.all(requests);
        assert.deepEqual(
          results.map((result) => result.turnId),
          Array.from({ length: requestCount }, (_, index) => `turn-${index}`),
        );
      } finally {
        for (const gate of release) gate.resolve();
        await Promise.allSettled(requests);
      }
    },
  );
});

test('transcript pages are serialized per connection before their responses are retained', async () => {
  const pair = await openTransportPair();
  const entered = Array.from({ length: 3 }, () => deferred());
  const release = Array.from({ length: 3 }, () => deferred());
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const handlers: OperationHandlerMap = {
    'host.status': async () => ({
      ok: true,
      result: {
        hostEpoch: 'host-epoch',
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
        connections: 1,
        activeOperations: 1,
        activeResidencies: 0,
      },
    }),
    ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
    ...createUnavailableHostCoreOperationHandlers(),
    ...createHandlers(async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    })),
    'session.transcript.page': async (input) => {
      const index = calls;
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered[index]?.resolve();
      await release[index]?.promise;
      active -= 1;
      return {
        ok: true,
        result: {
          kind: 'page',
          sessionId: 'session-1',
          source: input.source,
          direction: input.direction,
          throughSequence: input.throughSequence,
          rawBytes: 0,
          fragments: [],
          rangeBoundarySequence: null,
          protectedTurnSequence: null,
          nextCursor: null,
        },
      };
    },
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection('serialized-transcript-pages'),
    resolveHandlers: () => handlers,
    resolveContinuity: () => undefined,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown() {},
  });
  const run = session.run();
  try {
    for (let index = 0; index < 3; index += 1) {
      await writeProtocolFrame(pair.clientTransport, {
        requestId: `transcript-page-${index}`,
        operation: 'session.transcript.page',
        input: {
          subscriptionId: 'subscription-1',
          source: 'durable',
          direction: 'older',
          throughSequence: null,
          cursor: null,
          anchorSequence: null,
          maxBytes: 512 * 1024,
        },
      });
    }
    await withTimeout(entered[0]!.promise, 1_000, 'first transcript page was not admitted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);

    for (let index = 0; index < 3; index += 1) {
      release[index]!.resolve();
      const response = decodeHostFrame(await pair.clientTransport.read(1_000));
      assert.equal('kind' in response, false);
      if (!('kind' in response)) assert.equal(response.requestId, `transcript-page-${index}`);
      if (index < 2) {
        await withTimeout(
          entered[index + 1]!.promise,
          1_000,
          `transcript page ${index + 1} was not admitted`,
        );
      }
    }
    assert.equal(maxActive, 1);
  } finally {
    for (const gate of release) gate.resolve();
    pair.clientTransport.abort();
    await Promise.allSettled([run, pair.close()]);
  }
});

test('the Client leaves Host acknowledgement headroom while backpressuring a request burst', async () => {
  const requestCount = 96;
  const firstWaveEntered = deferred();
  const acknowledgementHeadroomCrossed = deferred();
  const releaseFirstWave = deferred();
  const clientRequestLimit = RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS - 1;
  let entered = 0;
  let active = 0;
  let maxActive = 0;

  await withRuntimeHost(
    async (input) => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (entered === clientRequestLimit) firstWaveEntered.resolve();
      if (entered > clientRequestLimit) acknowledgementHeadroomCrossed.resolve();
      await releaseFirstWave.promise;
      active -= 1;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const requests = Array.from({ length: requestCount }, (_, index) =>
        client.request('turn.query', { sessionId: 'session', turnId: `burst-${index}` }, 5_000),
      );
      try {
        await withTimeout(firstWaveEntered.promise, 1_000, 'first request wave was not admitted');
        assert.equal(
          await Promise.race([
            acknowledgementHeadroomCrossed.promise.then(() => true),
            delay(50, false),
          ]),
          false,
        );
        assert.equal(maxActive, clientRequestLimit);
        releaseFirstWave.resolve();
        const results = await Promise.all(requests);
        assert.equal(results.length, requestCount);
        assert.equal((await client.status(1_000)).state, 'ready');
      } finally {
        releaseFirstWave.resolve();
        await Promise.allSettled(requests);
      }
    },
  );
});

test('serial outbound writer flushes accepted frames in FIFO order over a real socket', async () => {
  const pair = await openTransportPair();
  let failureCalls = 0;
  const writer = new BoundedSerialOutboundWriter(pair.clientTransport, () => {
    failureCalls += 1;
  });
  try {
    const frames = ['first', 'second', 'third'].map(statusResponse);
    const receipts = frames.map((frame) => writer.enqueue(frame));
    await Promise.all(receipts.map((receipt) => receipt.flushed));
    for (const expected of frames) {
      const received = decodeHostFrame(await pair.serverTransport.read(1_000));
      assert.equal('kind' in received, false);
      if (!('kind' in received)) assert.equal(received.requestId, expected.requestId);
    }
    assert.equal(failureCalls, 0);

    writer.close();
    assert.throws(() => writer.enqueue(statusResponse('after-close')), /writer is closed/);
  } finally {
    writer.close();
    await pair.close();
  }
});

test('outbound scheduling prioritizes controls, makes fair data progress, and fences closure', async () => {
  const blocked = deferred<void>();
  const writes: HostFrame[] = [];
  const transport: RuntimeHostMessageTransport = {
    closed: Promise.resolve(),
    read: async () => {
      throw new Error('unexpected read');
    },
    async write(message) {
      writes.push(decodeHostFrame(JSON.parse(message.toString('utf8'))));
      if (writes.length === 1) await blocked.promise;
    },
    closeAfterFlush() {},
    abort() {},
  };
  const writer = new BoundedSerialOutboundWriter(transport, () => assert.fail('writer failed'));
  const pty = (ptySequence: number): HostFrame => ({
    kind: 'subscription.runtime_resource_pty_data',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    ref: 'maka://runtime/background-tasks/shell-1',
    ptySequence,
    data: 'bytes',
  });
  const receipts = [writer.enqueue(pty(1)), writer.enqueue(pty(2))];
  for (let index = 0; index < 20; index += 1)
    receipts.push(writer.enqueue(statusResponse(`control-${index}`)));
  receipts.push(
    writer.enqueue({
      kind: 'subscription.closed',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      reason: 'session_removed',
    }),
  );
  receipts.push(writer.enqueue(statusResponse('after-fence')));
  blocked.resolve();
  await Promise.all(receipts.map((receipt) => receipt.flushed));
  assert.equal('operation' in writes[1]! && writes[1].requestId, 'control-0');
  const ptyIndex = writes.findIndex(
    (frame) =>
      'kind' in frame &&
      frame.kind === 'subscription.runtime_resource_pty_data' &&
      frame.ptySequence === 2,
  );
  assert.ok(ptyIndex > 1 && ptyIndex <= 9, 'PTY must neither block controls nor starve');
  const closed = writes.at(-2)!;
  const last = writes.at(-1)!;
  assert.equal('kind' in closed && closed.kind, 'subscription.closed');
  assert.equal('operation' in last && last.requestId, 'after-fence');
  writer.close();
});

test('serial outbound writer fails once when its real transport is closed', async () => {
  const pair = await openTransportPair();
  let failureCalls = 0;
  let reportedFailure: Error | undefined;
  const writer = new BoundedSerialOutboundWriter(pair.clientTransport, (error) => {
    failureCalls += 1;
    reportedFailure = error;
  });
  try {
    pair.clientTransport.abort();
    await pair.clientTransport.closed;
    const receipt = writer.enqueue(statusResponse('closed-transport'));
    await assert.rejects(receipt.flushed);
    assert.equal(failureCalls, 1);
    assert.ok(reportedFailure);
    assert.match(reportedFailure.message, /closed|write/i);
    assert.throws(() => writer.enqueue(statusResponse('after-failure')), /writer is closed/);
    assert.equal(failureCalls, 1);
  } finally {
    writer.close();
    await pair.close();
  }
});

test('serial outbound writer reports its 2 MiB byte bound before its frame bound', async () => {
  const pair = await openTransportPair();
  let failureCalls = 0;
  const writer = new BoundedSerialOutboundWriter(pair.clientTransport, () => {
    failureCalls += 1;
  });
  const settlements: Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: Error }>[] = [];
  let overload: unknown;
  let acceptedFrames = 0;
  try {
    for (let index = 0; index < 64; index += 1) {
      try {
        const receipt = writer.enqueue(largeFailureResponse(`byte-bound-${index}`));
        acceptedFrames += 1;
        settlements.push(
          receipt.flushed.then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error: asError(error) }),
          ),
        );
      } catch (error) {
        overload = error;
        break;
      }
    }

    assert.ok(overload instanceof RuntimeHostOutboundQueueError);
    assert.equal(overload.code, 'byte_limit');
    assert.ok(acceptedFrames < 64, 'frame bound fired before the 2 MiB byte bound');
    assert.equal(failureCalls, 1);
    const results = await Promise.all(settlements);
    assert.equal(results.length, acceptedFrames);
    assert.equal(
      results.every((result) => result.status === 'rejected' && result.error === overload),
      true,
    );
  } finally {
    writer.close();
    await pair.close();
  }
});

test('flushes concurrent subscription opens before activating their live frame streams', async () => {
  const releaseWrites = deferred();
  const requestsEntered = deferred();
  const allWrites = deferred();
  const inbound = Array.from({ length: 16 }, (_, index) => ({
    requestId: `open-${index}`,
    operation: 'subscription.open',
    input: { sessionId: `session-${index}`, transcript: { kind: 'none' } },
  }));
  const written: EncodedProtocolMessage[] = [];
  let aborted = false;
  let resolveClosed!: () => void;
  let rejectRead: ((error: Error) => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const transport: RuntimeHostMessageTransport = {
    closed,
    read: async () => {
      const frame = inbound.shift();
      if (frame) return frame;
      return new Promise<never>((_resolve, reject) => {
        rejectRead = reject;
      });
    },
    write: async (message) => {
      await releaseWrites.promise;
      written.push(message);
      if (written.length === 32) allWrites.resolve();
    },
    closeAfterFlush: () => {
      resolveClosed();
    },
    abort: (error) => {
      if (aborted) return;
      aborted = true;
      rejectRead?.(error ?? new Error('in-memory transport aborted'));
      resolveClosed();
    },
  };
  let openCalls = 0;
  let sink: Parameters<SessionContinuityService['attachConnection']>[1] | undefined;
  const largeSnapshot = (sessionId: string) => {
    const snapshot = canonicalProjection(sessionId);
    return {
      ...snapshot,
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      projectionRevision: 1,
      queue: {
        ...snapshot.queue,
        followup: Array.from({ length: 2 }, (_, index) => ({
          entryId: `entry-${sessionId}-${index}`,
          messageId: `message-${sessionId}-${index}`,
          content: { text: 'q'.repeat(25 * 1024), quotes: [] },
          placement: 'next_turn' as const,
          state: 'queued' as const,
        })),
      },
    };
  };
  const continuity: SessionContinuityService = {
    handlers: {
      'subscription.pty_interest.set': async (input) => ({
        ok: true,
        result: { subscriptionId: input.subscriptionId },
      }),
      'subscription.open': async (input) => {
        openCalls += 1;
        if (openCalls === 16) requestsEntered.resolve();
        return {
          ok: true,
          result: {
            hostEpoch: 'host-epoch',
            subscriptionId: `subscription-${input.sessionId}`,
            nextSequence: 1,
            snapshot: largeSnapshot(input.sessionId),
            activeAssistantStreams: Array.from({ length: 180 }, (_, index) => ({
              kind: 'text' as const,
              turnId: `turn-${input.sessionId}`,
              messageId: `stream-${input.sessionId}-${index}`,
            })),
            transcript: transcriptBootstrapFor(input.sessionId),
          },
        };
      },
      'subscription.close': async (input) => ({
        ok: true,
        result: { subscriptionId: input.subscriptionId },
      }),
      'session.transcript.overlay.release': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'not used' },
      }),
      'session.transcript.page': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'not used' },
      }),
    },
    attachConnection: (_connectionId, attachedSink) => {
      sink = attachedSink;
      return {
        activate: (subscriptionId) => {
          const sessionId = subscriptionId.slice('subscription-'.length);
          void sink
            ?.send({
              kind: 'subscription.session_projection',
              hostEpoch: 'host-epoch',
              subscriptionId,
              sequence: 1,
              snapshot: largeSnapshot(sessionId),
            })
            .catch(() => undefined);
        },
        abort() {},
        close() {},
      };
    },
  };
  const handlers: OperationHandlerMap = {
    'host.status': async () => ({
      ok: true,
      result: {
        hostEpoch: 'host-epoch',
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
        connections: 1,
        activeOperations: 0,
        activeResidencies: 0,
      },
    }),
    ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
    ...createUnavailableHostCoreOperationHandlers(),
    ...createHandlers(async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    })),
    ...continuity.handlers,
  };
  const session = new RuntimeHostConnectionSession({
    transport,
    connection: acceptedConnection('concurrent-subscription-opens'),
    resolveHandlers: () => handlers,
    resolveContinuity: () => continuity,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown() {},
  });
  const run = session.run();
  try {
    await withTimeout(requestsEntered.promise, 1_000, 'subscription opens were not dispatched');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborted, false);

    releaseWrites.resolve();
    await withTimeout(allWrites.promise, 2_000, 'subscription frames were not flushed');
    const frames = written.map((message) =>
      decodeHostFrame(JSON.parse(message.toString('utf8')) as unknown),
    );
    const openResponseBytes = written.reduce(
      (total, message, index) =>
        !('kind' in frames[index]!) && frames[index]!.operation === 'subscription.open'
          ? total + message.byteLength
          : total,
      0,
    );
    assert.ok(openResponseBytes < 2 * 1024 * 1024);
    assert.ok(written.reduce((total, message) => total + message.byteLength, 0) > 2 * 1024 * 1024);
    assert.equal(
      frames.filter((frame) => !('kind' in frame) && frame.operation === 'subscription.open')
        .length,
      16,
    );
    assert.equal(
      frames.filter((frame) => 'kind' in frame && frame.kind === 'subscription.session_projection')
        .length,
      16,
    );
    assert.equal(aborted, false);
  } finally {
    releaseWrites.resolve();
    transport.abort();
    await run;
  }
});

test('clean read EOF drains an already dispatched response before closing', async () => {
  const fixture = await openHalfClosedDispatchedSession('half-close');
  try {
    fixture.releaseHandler.resolve();
    const response = decodeHostFrame(await fixture.pair.clientTransport.read(1_000));
    if ('kind' in response || response.operation !== 'turn.query') {
      assert.fail('Expected the dispatched turn.query response');
    }
    assert.equal(response.ok, true);
    await withTimeout(fixture.run, 1_000, 'connection did not close after draining its response');
    assert.equal(fixture.teardownCalls(), 1);
    assert.deepEqual(fixture.diagnostics, []);
  } finally {
    await fixture.close();
  }
});

test('a fatal transport close during clean EOF drain tears down exactly once', async () => {
  const fixture = await openHalfClosedDispatchedSession('fatal-close-after-eof');
  try {
    fixture.pair.serverTransport.abort(new Error('forced transport failure'));
    await withTimeout(
      fixture.teardownObserved.promise,
      1_000,
      'fatal transport close did not interrupt EOF drain',
    );
    assert.equal(fixture.teardownCalls(), 1);

    fixture.releaseHandler.resolve();
    await withTimeout(fixture.run, 1_000, 'connection did not settle after its handler completed');
    assert.equal(fixture.teardownCalls(), 1);
  } finally {
    await fixture.close();
  }
});

test('records an unexpected accepted-connection failure before teardown', async () => {
  const pair = await openTransportPair();
  const teardownObserved = deferred();
  const logs: string[] = [];
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection('failed-admission'),
    resolveHandlers: () => ({
      'host.status': async () => ({
        ok: true,
        result: {
          hostEpoch: 'host-epoch',
          compositionId: 'maka.interactive',
          compositionRevision: '1',
          state: 'ready',
          connections: 1,
          activeOperations: 0,
          activeResidencies: 0,
        },
      }),
      ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
      ...createUnavailableHostCoreOperationHandlers(),
      ...createUnavailableDomainOperationHandlers(),
    }),
    resolveContinuity: () => undefined,
    beginOperation: async () => {
      throw new Error('api_key=sk-connection-secret123');
    },
    onDiagnostic: (diagnostic) => logs.push(diagnostic),
    onTeardown: () => teardownObserved.resolve(),
  });
  const run = session.run();
  try {
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'failed-admission-request',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    await withTimeout(teardownObserved.promise, 1_000, 'connection did not tear down');
    await withTimeout(run, 1_000, 'connection did not settle');
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /connection session failed/);
    assert.match(logs[0] ?? '', /\[redacted\]/i);
    assert.doesNotMatch(logs[0] ?? '', /sk-connection-secret123/);
  } finally {
    pair.clientTransport.abort();
    await Promise.allSettled([run, pair.close()]);
  }
});

test('a connection accepted before composition exists resolves ready handlers without reconnecting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-pre-ready-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const factoryEntered = deferred();
  const releaseFactory = deferred();
  const hostTask = RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    composition: defineInteractiveRuntimeHostComposition(async () => {
      factoryEntered.resolve();
      await releaseFactory.promise;
      return {
        handlers: createHandlers(async (input) => ({
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        })),
        beginDrain() {},
        async recover() {},
        async close() {},
      };
    }),
  });
  let transport: FramedTransport | undefined;
  let host: RuntimeHostKernel | undefined;
  try {
    await withTimeout(factoryEntered.promise, 1_000, 'Runtime Host did not enter composition');
    const registration = await readHostRegistration(owner.controlDirectory);
    assert.ok(registration);
    assert.equal(registration.state, 'recovering');
    transport = await openAcceptedTransport(registration.endpoint, 'pre-ready-client');

    await writeProtocolFrame(transport, {
      requestId: 'before-ready',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    const beforeReady = decodeHostFrame(await transport.read(1_000));
    if ('kind' in beforeReady) assert.fail('Expected an operation response');
    if (beforeReady.ok) assert.fail('Pre-ready request unexpectedly succeeded');
    assert.equal(beforeReady.error.code, 'host_not_ready');

    releaseFactory.resolve();
    host = await withTimeout(hostTask, 1_000, 'Runtime Host did not become ready');
    await writeProtocolFrame(transport, {
      requestId: 'after-ready',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    const afterReady = decodeHostFrame(await transport.read(1_000));
    if ('kind' in afterReady || afterReady.operation !== 'turn.query') {
      assert.fail('Expected a turn.query response');
    }
    if (!afterReady.ok) assert.fail(afterReady.error.message);
    assert.equal(afterReady.result.runId, 'run-turn');
  } finally {
    releaseFactory.resolve();
    transport?.abort();
    host ??= await hostTask.catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

for (const closure of ['reset', 'eof'] as const) {
  test(`connection ${closure} during operation admission preserves closure evidence`, async () => {
    const pair = await openTransportPair();
    const admissionEntered = deferred();
    const releaseAdmission = deferred();
    const teardownObserved = deferred();
    let handlerCalls = 0;
    let finishCalls = 0;
    const handlers: OperationHandlerMap = {
      'host.status': async () => ({
        ok: true,
        result: {
          hostEpoch: 'host-epoch',
          compositionId: 'maka.interactive',
          compositionRevision: '1',
          state: 'ready',
          connections: 1,
          activeOperations: 1,
          activeResidencies: 0,
        },
      }),
      ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
      ...createUnavailableHostCoreOperationHandlers(),
      ...createHandlers(async (input, context) => {
        handlerCalls += 1;
        assert.equal(context.inputClosedSignal?.aborted, true);
        return {
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        };
      }),
    };
    const session = new RuntimeHostConnectionSession({
      transport: pair.serverTransport,
      connection: acceptedConnection('pending-admission'),
      resolveHandlers: () => handlers,
      resolveContinuity: () => undefined,
      beginOperation: async () => {
        admissionEntered.resolve();
        await releaseAdmission.promise;
        return {
          acquireResidency: () => ({ release() {} }),
          seal() {},
          finish() {
            finishCalls += 1;
          },
        };
      },
      onTeardown: () => teardownObserved.resolve(),
    });
    const run = session.run();
    try {
      await writeProtocolFrame(pair.clientTransport, {
        requestId: 'pending-request',
        operation: 'turn.query',
        input: { sessionId: 'session', turnId: 'turn' },
      });
      await withTimeout(admissionEntered.promise, 1_000, 'operation did not enter admission');
      if (closure === 'reset') {
        pair.clientTransport.socket.resetAndDestroy();
        await withTimeout(
          teardownObserved.promise,
          1_000,
          'connection did not tear down while admission was pending',
        );
      } else {
        const readEnded = onceSocketEnd(pair.serverTransport.socket);
        pair.clientTransport.socket.end();
        await withTimeout(readEnded, 1_000, 'Host did not observe EOF during admission');
      }
      releaseAdmission.resolve();
      if (closure === 'eof') {
        const response = decodeHostFrame(await pair.clientTransport.read(1_000));
        assert.ok(!('kind' in response) && response.ok);
      }
      await withTimeout(run, 1_000, 'connection did not settle after admission completed');
      assert.equal(handlerCalls, closure === 'reset' ? 0 : 1);
      assert.equal(finishCalls, 1);
    } finally {
      releaseAdmission.resolve();
      pair.clientTransport.abort();
      await Promise.allSettled([run, pair.close()]);
    }
  });
}

test('a ready composition attaches the authenticated Client identity once', async () => {
  const pair = await openTransportPair();
  const attached: ClientCapabilityConnectionIdentity[] = [];
  let serviceAvailable = false;
  let closeCalls = 0;
  const closeStarted = deferred();
  const releaseClose = deferred();
  const service: ClientCapabilityService = {
    attachConnection(identity) {
      attached.push(identity);
      return {
        accept() {},
        async close() {
          closeCalls += 1;
          closeStarted.resolve();
          await releaseClose.promise;
        },
      };
    },
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection('stable-provider-connection'),
    resolveHandlers: () => ({
      'host.status': async () => ({
        ok: true,
        result: {
          hostEpoch: 'host-epoch',
          compositionId: 'maka.interactive',
          compositionRevision: '1',
          state: 'ready',
          connections: 1,
          activeOperations: 1,
          activeResidencies: 0,
        },
      }),
      ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
      ...createUnavailableHostCoreOperationHandlers(),
      ...createUnavailableDomainOperationHandlers(),
    }),
    resolveContinuity: () => undefined,
    resolveClientCapabilities: () => (serviceAvailable ? service : undefined),
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown() {},
  });
  const run = session.run();
  let runSettled = false;
  void run.then(() => {
    runSettled = true;
  });
  try {
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'before-composition',
      operation: 'host.status',
      input: {},
    });
    await pair.clientTransport.read(1_000);
    assert.deepEqual(attached, []);

    serviceAvailable = true;
    for (const requestId of ['after-composition', 'still-attached']) {
      await writeProtocolFrame(pair.clientTransport, {
        requestId,
        operation: 'host.status',
        input: {},
      });
      await pair.clientTransport.read(1_000);
    }
    assert.deepEqual(attached, [
      {
        connectionId: 'stable-provider-connection',
        principalId: 'local_os_user',
        clientInstanceId: 'test-client',
        principalKind: 'local_owner',
      },
    ]);
  } finally {
    pair.clientTransport.abort();
    await closeStarted.promise;
    await Promise.resolve();
    assert.equal(runSettled, false);
    releaseClose.resolve();
    await Promise.allSettled([run, pair.close()]);
  }
  assert.equal(runSettled, true);
  assert.equal(closeCalls, 1);
});

test('an admitted operation settles without connection or residency leakage after disconnect', async () => {
  const handlerEntered = deferred();
  const releaseHandler = deferred();
  const handlerSettled = deferred();
  await withRuntimeHost(
    async (input, context) => {
      const residency = context.acquireResidency();
      handlerEntered.resolve();
      try {
        await releaseHandler.promise;
        return {
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        };
      } finally {
        residency.release();
        handlerSettled.resolve();
      }
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const requestFailure = client
        .request('turn.query', { sessionId: 'session', turnId: 'disconnect' }, 5_000)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        await withTimeout(handlerEntered.promise, 1_000, 'handler was not admitted');
        await client.close();
        releaseHandler.resolve();
        await withTimeout(handlerSettled.promise, 1_000, 'handler did not settle after disconnect');
        assert.ok((await requestFailure) instanceof Error);

        const observer = await connectClient();
        const status = await waitForStatus(
          observer,
          (value) =>
            value.connections === 1 &&
            value.activeOperations === 1 &&
            value.activeResidencies === 0,
        );
        assert.equal(status.connections, 1);
        assert.equal(status.activeOperations, 1);
        assert.equal(status.activeResidencies, 0);
      } finally {
        releaseHandler.resolve();
        await client.close().catch(() => undefined);
        await Promise.allSettled([requestFailure]);
      }
    },
  );
});

test('an admitted command reports an unknown outcome when its connection closes', async () => {
  const commandEntered = deferred();
  const releaseCommand = deferred();
  await withRuntimeHost(
    async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    async ({ connectClient }) => {
      const client = await connectClient();
      const command = client.request('turn.start', {
        sessionId: 'session',
        turnId: 'interrupted-command',
        content: { text: 'start' },
      });
      try {
        await withTimeout(commandEntered.promise, 1_000, 'command was not admitted');
        await client.close();
        await assert.rejects(
          command,
          (error: unknown) =>
            error instanceof RuntimeHostRequestInterruptedError &&
            error.mode === 'command' &&
            error.dispatch === 'dispatched' &&
            error.reason === 'connection_lost' &&
            !error.retryable,
        );
      } finally {
        releaseCommand.resolve();
        await Promise.allSettled([command]);
      }
    },
    {
      'turn.start': async (input) => {
        commandEntered.resolve();
        await releaseCommand.promise;
        return {
          ok: true,
          result: {
            kind: 'started',
            turn: runningSnapshot(input.sessionId, input.turnId),
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          },
        };
      },
    },
  );
});

test('a duplicate active request id tears down only the offending connection', async () => {
  const handlerEntered = deferred();
  const releaseHandler = deferred();
  let handlerCalls = 0;
  await withRuntimeHost(
    async (input) => {
      handlerCalls += 1;
      handlerEntered.resolve();
      await releaseHandler.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient, endpoint }) => {
      const transport = await openAcceptedTransport(endpoint, 'duplicate-request-client');
      try {
        await writeProtocolFrame(transport, {
          requestId: 'duplicate-request',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'first' },
        });
        await withTimeout(handlerEntered.promise, 1_000, 'first request was not admitted');
        await writeProtocolFrame(transport, {
          requestId: 'duplicate-request',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'second' },
        });
        await withTimeout(
          transport.closed,
          1_000,
          'duplicate request id did not close its connection',
        );
        assert.equal(handlerCalls, 1);
      } finally {
        releaseHandler.resolve();
        transport.abort();
      }

      const observer = await connectClient();
      const status = await waitForStatus(
        observer,
        (value) =>
          value.connections === 1 && value.activeOperations === 1 && value.activeResidencies === 0,
      );
      assert.equal(status.state, 'ready');
    },
  );
});

test('reserves liveness status at the domain request limit and rejects another domain request', async () => {
  const releaseHandlers = deferred();
  await withRuntimeHost(
    async (input) => {
      await releaseHandlers.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient, endpoint }) => {
      const transport = await openAcceptedTransport(endpoint, 'overflowing-client');
      const observer = await connectClient();
      try {
        const requests = Array.from({ length: 64 }, (_, index) =>
          JSON.stringify({
            requestId: `overflow-${index}`,
            operation: 'turn.query',
            input: { sessionId: 'session', turnId: `turn-${index}` },
          }),
        ).join('\n');
        transport.socket.write(`${requests}\n`);
        await waitForStatus(
          observer,
          (value) =>
            value.connections === 2 &&
            value.activeOperations === 65 &&
            value.activeResidencies === 0,
        );
        await writeProtocolFrame(transport, {
          requestId: 'overflow-status',
          operation: 'host.status',
          input: {},
        });
        const statusResponse = decodeHostFrame(await transport.read(1_000));
        assert.equal('kind' in statusResponse, false);
        if (!('kind' in statusResponse)) {
          assert.equal(statusResponse.requestId, 'overflow-status');
          assert.equal(statusResponse.operation, 'host.status');
          assert.equal(statusResponse.ok, true);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        await writeProtocolFrame(transport, {
          requestId: 'overflow-64',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'turn-64' },
        });
        await withTimeout(
          transport.closed,
          1_000,
          'in-flight overflow did not close its connection',
        );
      } finally {
        releaseHandlers.resolve();
        transport.abort();
      }
      const status = await waitForStatus(
        observer,
        (value) =>
          value.connections === 1 && value.activeOperations === 1 && value.activeResidencies === 0,
      );
      assert.equal(status.state, 'ready');
    },
  );
});

test('an in-flight status does not consume the final domain request slot', async () => {
  const pair = await openTransportPair();
  const domainEntered = Array.from({ length: 64 }, () => deferred());
  const releaseDomains = deferred();
  const statusEntered = deferred();
  const releaseStatus = deferred();
  const handlers: OperationHandlerMap = {
    'host.status': async () => {
      statusEntered.resolve();
      await releaseStatus.promise;
      return {
        ok: true,
        result: {
          hostEpoch: 'host-epoch',
          compositionId: 'maka.interactive',
          compositionRevision: '1',
          state: 'ready',
          connections: 1,
          activeOperations: 65,
          activeResidencies: 0,
        },
      };
    },
    ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
    ...createUnavailableHostCoreOperationHandlers(),
    ...createHandlers(async (input) => {
      const index = Number(input.turnId.slice('turn-'.length));
      domainEntered[index]?.resolve();
      await releaseDomains.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    }),
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection('status-before-final-domain-client'),
    resolveHandlers: () => handlers,
    resolveContinuity: () => undefined,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown() {},
  });
  const run = session.run();
  try {
    const initialDomains = Array.from({ length: 63 }, (_, index) => ({
      requestId: `status-first-${index}`,
      operation: 'turn.query' as const,
      input: { sessionId: 'session', turnId: `turn-${index}` },
    }));
    pair.clientTransport.socket.write(
      `${initialDomains.map((request) => JSON.stringify(request)).join('\n')}\n`,
    );
    await withTimeout(
      Promise.all(domainEntered.slice(0, 63).map((entry) => entry.promise)),
      1_000,
      'initial domain handlers were not admitted',
    );
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'status-first-probe',
      operation: 'host.status',
      input: {},
    });
    await withTimeout(statusEntered.promise, 1_000, 'status handler was not admitted');
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'status-first-63',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn-63' },
    });
    await withTimeout(domainEntered[63]?.promise, 1_000, 'final domain handler was not admitted');

    releaseStatus.resolve();
    const response = decodeHostFrame(await pair.clientTransport.read(1_000));
    assert.equal('kind' in response, false);
    if (!('kind' in response)) {
      assert.equal(response.requestId, 'status-first-probe');
      assert.equal(response.operation, 'host.status');
      assert.equal(response.ok, true);
    }
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'status-first-overflow',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn-64' },
    });
    await withTimeout(
      pair.clientTransport.closed,
      1_000,
      'in-flight overflow did not close its connection',
    );
  } finally {
    releaseStatus.resolve();
    releaseDomains.resolve();
    pair.clientTransport.abort();
    await Promise.allSettled([run, pair.close()]);
  }
});

test('evicting one slow subscription keeps sibling subscriptions and requests usable', async () => {
  const pair = await openTransportPair();
  const coordinator = new SessionContinuityCoordinator(
    'host-epoch',
    async (sessionId) => canonicalProjection(sessionId),
    new SessionAdmissionGate(),
  );
  const handlers: OperationHandlerMap = {
    'host.status': async () => ({
      ok: true,
      result: {
        hostEpoch: 'host-epoch',
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
        connections: 1,
        activeOperations: 1,
        activeResidencies: 0,
      },
    }),
    ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
    ...createUnavailableHostCoreOperationHandlers(),
    ...createHandlers(async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    })),
    ...coordinator.handlers,
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection('shared-subscription-connection'),
    resolveHandlers: () => handlers,
    resolveContinuity: () => coordinator,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown() {},
  });
  const run = session.run();
  const slow = await openSubscription(pair.clientTransport, 'slow-session', 'open-slow');
  const sibling = await openSubscription(pair.clientTransport, 'sibling-session', 'open-sibling');
  const originalWrite = pair.serverTransport.write.bind(pair.serverTransport);
  const writeBlocked = deferred();
  const releaseWrite = deferred();
  pair.serverTransport.write = async (message) => {
    writeBlocked.resolve();
    await releaseWrite.promise;
    return originalWrite(message);
  };

  try {
    // Alternate message streams so the queued deltas cannot coalesce: this
    // exercises eviction for a genuinely undrainable backlog.
    for (let index = 1; index <= 32; index += 1) {
      await coordinator.acceptRuntimeEvent(
        'slow-session',
        'run-slow-session',
        connectionTextEvent('slow-session', index, `message-slow-${index % 2}`),
      );
    }
    await withTimeout(writeBlocked.promise, 1_000, 'slow subscription never blocked in-flight');
    releaseWrite.resolve();

    await coordinator.acceptRuntimeEvent(
      'sibling-session',
      'run-sibling-session',
      connectionTextEvent('sibling-session', 1),
    );
    await writeProtocolFrame(pair.clientTransport, {
      requestId: 'status-after-eviction',
      operation: 'host.status',
      input: {},
    });

    const observed: HostFrame[] = [];
    while (
      !observed.some(
        (frame) =>
          'kind' in frame &&
          frame.kind === 'subscription.closed' &&
          frame.subscriptionId === slow.subscriptionId,
      ) ||
      !observed.some(
        (frame) =>
          'kind' in frame &&
          frame.kind === 'subscription.session_delta' &&
          frame.subscriptionId === sibling.subscriptionId,
      ) ||
      !observed.some((frame) => !('kind' in frame) && frame.requestId === 'status-after-eviction')
    ) {
      observed.push(decodeHostFrame(await pair.clientTransport.read(1_000)));
    }

    const slowClosed = observed.find(
      (frame) =>
        'kind' in frame &&
        frame.kind === 'subscription.closed' &&
        frame.subscriptionId === slow.subscriptionId,
    );
    assert.ok(slowClosed && 'kind' in slowClosed);
    if (slowClosed && 'kind' in slowClosed && slowClosed.kind === 'subscription.closed') {
      assert.equal(slowClosed.reason, 'slow_consumer');
      assert.equal(slowClosed.sequence, 2);
    }
    assert.equal(pair.serverTransport.socket.destroyed, false);
  } finally {
    releaseWrite.resolve();
    pair.serverTransport.write = originalWrite;
    pair.clientTransport.abort();
    await Promise.allSettled([run, pair.close()]);
    coordinator.close();
  }
});

interface RuntimeHostTestFixture {
  connectClient(): Promise<RuntimeHostConnection>;
  endpoint: string;
}

async function withRuntimeHost(
  queryTurn: TurnQueryHandler,
  run: (fixture: RuntimeHostTestFixture) => Promise<void>,
  handlerOverrides: Partial<RuntimeHostComposition['handlers']> = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-continuity-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const connections = new Set<RuntimeHostConnection>();
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    composition: defineInteractiveRuntimeHostComposition(async () => ({
      handlers: { ...createHandlers(queryTurn), ...handlerOverrides },
      beginDrain() {},
      async recover() {},
      async close() {},
    })),
  });
  try {
    await run({
      endpoint: host.endpoint,
      connectClient: async () => {
        const result = await connectRuntimeHost({
          rootPath: root,
          protocol: CURRENT_PROTOCOL,
        });
        assert.equal(result.kind, 'connected');
        connections.add(result.connection);
        return result.connection;
      },
    });
  } finally {
    await Promise.allSettled([...connections].map((connection) => connection.close()));
    await host.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
}

async function openAcceptedTransport(
  endpoint: string,
  clientInstanceId: string,
): Promise<FramedTransport> {
  const socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const transport = new FramedTransport(socket);
  await writeProtocolFrame(transport, {
    kind: 'hello',
    clientInstanceId,
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: 'maka.interactive',
  });
  const handshake = decodeHostFrame(await transport.read(1_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  return transport;
}

interface TransportPair {
  clientTransport: FramedTransport;
  serverTransport: FramedTransport;
  close(): Promise<void>;
}

interface HalfClosedDispatchedSession {
  pair: TransportPair;
  diagnostics: string[];
  releaseHandler: Deferred;
  teardownObserved: Deferred;
  run: Promise<void>;
  teardownCalls(): number;
  close(): Promise<void>;
}

async function openTransportPair(): Promise<TransportPair> {
  const listener = createServer({ allowHalfOpen: true });
  const accepted = new Promise<Socket>((resolve) => listener.once('connection', resolve));
  await listenServer(listener);
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const clientSocket = connect(address.port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    clientSocket.once('connect', resolve);
    clientSocket.once('error', reject);
  });
  const serverSocket = await accepted;
  const clientTransport = new FramedTransport(clientSocket);
  const serverTransport = new FramedTransport(serverSocket);
  return {
    clientTransport,
    serverTransport,
    close: async () => {
      clientTransport.abort();
      serverTransport.abort();
      await Promise.all([clientTransport.closed, serverTransport.closed]);
      await closeServer(listener);
    },
  };
}

async function openHalfClosedDispatchedSession(
  turnId: string,
): Promise<HalfClosedDispatchedSession> {
  const pair = await openTransportPair();
  const handlerEntered = deferred();
  const releaseHandler = deferred();
  const teardownObserved = deferred();
  const diagnostics: string[] = [];
  let teardownCalls = 0;
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: acceptedConnection(`${turnId}-client`),
    resolveHandlers: () => ({
      'host.status': async () => ({
        ok: true,
        result: {
          hostEpoch: 'host-epoch',
          compositionId: 'maka.interactive',
          compositionRevision: '1',
          state: 'ready',
          connections: 1,
          activeOperations: 1,
          activeResidencies: 0,
        },
      }),
      ...UNUSED_HOST_DIAGNOSTICS_HANDLER,
      ...createUnavailableHostCoreOperationHandlers(),
      ...createHandlers(async (input) => {
        handlerEntered.resolve();
        await releaseHandler.promise;
        return {
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        };
      }),
    }),
    resolveContinuity: () => undefined,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onTeardown: () => {
      teardownCalls += 1;
      teardownObserved.resolve();
    },
  });
  const run = session.run();
  try {
    await writeProtocolFrame(pair.clientTransport, {
      requestId: `${turnId}-request`,
      operation: 'turn.query',
      input: { sessionId: 'session', turnId },
    });
    await withTimeout(handlerEntered.promise, 1_000, 'handler was not dispatched');
    const readEnded = onceSocketEnd(pair.serverTransport.socket);
    pair.clientTransport.socket.end();
    await withTimeout(readEnded, 1_000, 'Host did not observe Client read EOF');
    return {
      pair,
      diagnostics,
      releaseHandler,
      teardownObserved,
      run,
      teardownCalls: () => teardownCalls,
      close: async () => {
        releaseHandler.resolve();
        pair.clientTransport.abort();
        await Promise.allSettled([run, pair.close()]);
      },
    };
  } catch (error) {
    releaseHandler.resolve();
    pair.clientTransport.abort();
    await Promise.allSettled([run, pair.close()]);
    throw error;
  }
}

function onceSocketEnd(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('end', resolve));
}

function listenServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createHandlers(queryTurn: TurnQueryHandler): RuntimeHostComposition['handlers'] {
  const unavailable: Awaited<ReturnType<OperationHandlerMap['turn.message.submit']>> = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  };
  const subscriptionUnavailable = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  } as const;
  const sessionTodoUnavailable: Awaited<ReturnType<OperationHandlerMap['session.todo.query']>> = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  };
  const interactionUnavailable = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  } as const;
  return {
    ...createUnavailableDomainOperationHandlers(),
    'turn.start': async (input) => ({
      ok: true,
      result: {
        kind: 'started',
        turn: runningSnapshot(input.sessionId, input.turnId),
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      },
    }),
    'turn.query': queryTurn,
    'turn.stop': async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    'turn.message.submit': async () => unavailable,
    'queue.retract': async () => unavailable,
    'turn.interrupt': async () => unavailable,
    'interaction.query': async () => interactionUnavailable,
    'interaction.answer': async () => interactionUnavailable,
    'subscription.open': async () => subscriptionUnavailable,
    'subscription.close': async () => subscriptionUnavailable,
    'session.todo.query': async () => sessionTodoUnavailable,
  };
}

function statusResponse(requestId: string): ResponseFrame {
  return {
    requestId,
    operation: 'host.status',
    ok: true,
    result: {
      hostEpoch: 'host-epoch',
      compositionId: 'maka.interactive',
      compositionRevision: '1',
      state: 'ready',
      connections: 1,
      activeOperations: 0,
      activeResidencies: 0,
    },
  };
}

const UNUSED_HOST_DIAGNOSTICS_HANDLER: Pick<
  OperationHandlerMap,
  'host.diagnostics.query' | 'host.resources.query' | 'host.upgrade.prepare'
> = {
  'host.diagnostics.query': async () => ({
    ok: false,
    error: { code: 'internal_failure', message: 'not used' },
  }),
  'host.upgrade.prepare': async () => ({
    ok: false,
    error: { code: 'internal_failure', message: 'not used' },
  }),
  'host.resources.query': async () => ({
    ok: false,
    error: { code: 'internal_failure', message: 'not used' },
  }),
};

function largeFailureResponse(requestId: string): ResponseFrame {
  return {
    requestId,
    operation: 'host.status',
    ok: false,
    error: {
      code: 'internal_failure',
      message: 'x'.repeat(48 * 1024),
    },
  };
}

function runningSnapshot(sessionId: string, turnId: string): TurnSnapshot {
  return {
    sessionId,
    turnId,
    runId: `run-${turnId}`,
    status: 'running',
  };
}

async function openSubscription(transport: FramedTransport, sessionId: string, requestId: string) {
  await writeProtocolFrame(transport, {
    requestId,
    operation: 'subscription.open',
    input: { sessionId, transcript: { kind: 'none' } },
  });
  const response = decodeHostFrame(await transport.read(1_000));
  if ('kind' in response || response.operation !== 'subscription.open' || !response.ok) {
    throw new Error(`Unable to open ${sessionId} subscription`);
  }
  return response.result;
}

function writeProtocolFrame(
  transport: FramedTransport,
  frame: ClientFrame | HostFrame,
): Promise<void> {
  return transport.write(encodeProtocolMessage(frame));
}

function canonicalProjection(sessionId: string): CanonicalSessionProjection {
  return {
    session: {
      sessionId,
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      isArchived: false,
    },
    rootTurn: {
      sessionId,
      turnId: `turn-${sessionId}`,
      runId: `run-${sessionId}`,
      status: 'running',
    },
    goal: null,
    queue: {
      hostEpoch: 'host-epoch',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}

function transcriptBootstrapFor(sessionId: string) {
  const contents = Buffer.from('t'.repeat(16 * 1024));
  return {
    throughSequence: 0,
    overlayMessageCount: 0,
    durable: {
      kind: 'page' as const,
      sessionId,
      source: 'durable' as const,
      direction: 'older' as const,
      throughSequence: 0,
      rawBytes: contents.byteLength,
      fragments: [
        {
          kind: 'durable' as const,
          sequence: 0,
          byteOffset: 0,
          totalBytes: contents.byteLength,
          payloadDigest: null,
          data: contents.toString('base64'),
        },
      ],
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
      nextCursor: null,
    },
    overlay: {
      kind: 'page' as const,
      sessionId,
      source: 'overlay' as const,
      direction: 'older' as const,
      throughSequence: 0,
      rawBytes: 0,
      fragments: [],
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
      nextCursor: null,
    },
  };
}

function connectionTextEvent(sessionId: string, index: number, messageId?: string) {
  return {
    type: 'text_delta' as const,
    id: `event-${sessionId}-${index}`,
    turnId: `turn-${sessionId}`,
    ts: index,
    messageId: messageId ?? `message-${sessionId}`,
    text: `chunk-${index}`,
  };
}

async function waitForStatus(
  connection: RuntimeHostConnection,
  predicate: (status: Awaited<ReturnType<RuntimeHostConnection['status']>>) => boolean,
): Promise<Awaited<ReturnType<RuntimeHostConnection['status']>>> {
  const deadline = Date.now() + 1_000;
  let status = await connection.status(1_000);
  while (!predicate(status) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    status = await connection.status(1_000);
  }
  assert.equal(predicate(status), true, 'Host operation counters did not settle');
  return status;
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
