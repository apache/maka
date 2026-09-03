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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  createRuntimeHostPeerClient,
  RuntimeHostPeerReachabilityUnavailableError,
} from '../client/peer-client.js';
import { PEER_REACHABILITY_MAX_CLOCK_SKEW_MS } from '../peer-reachability/index.js';
import {
  ensureRuntimeHostPeerIdentity,
  normalizePeerError,
  readRuntimeHostPeerAuthentication,
  readRuntimeHostPeerAuthenticationResult,
  RuntimeHostPeerError,
  startRuntimeHostPeerEndpoint,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';

test('preserves transit route failures from the native boundary', () => {
  const error = normalizePeerError(new Error('transit_unavailable: no approved route'));
  assert.equal(error.code, 'transit_unavailable');
  assert.equal(error.message, 'no approved route');
});

test('shares one peer endpoint, serializes same-peer connects, and cancels independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-peer-abort-'));
  const nativePath = join(directory, 'peer.cjs');
  try {
    await writeFile(
      nativePath,
      `let finishAccept;
let finishMeshAccept;
let finishConnectivity;
let connectivity = { generation: 0, connectedPeerIds: [] };
const pending = new Map();
const stats = { starts: 0, closes: 0, requests: [], updates: [], cancellations: [] };
let missFirstCancellation = true;
const stream = { read: async () => null, write: async () => {}, close: async () => {}, abort: () => {} };
module.exports = {
  stats,
  resolveConnect: (requestId) => {
    pending.get(requestId)?.resolve(stream);
    pending.delete(requestId);
  },
  establishPeer: (peerId) => {
    connectivity = { generation: connectivity.generation + 1, connectedPeerIds: [peerId] };
    finishConnectivity?.(connectivity);
    finishConnectivity = undefined;
  },
  failEndpoint: () => { finishAccept?.(null); finishMeshAccept?.(null); },
  ensurePeerIdentity: async () => 'client',
  signPeerIdentity: async () => ({ publicKey: Buffer.from('public'), signature: Buffer.from('signature') }),
  verifyPeerIdentity: () => true,
  startPeerEndpoint: () => {
    stats.starts += 1;
    return {
      peerId: 'client',
      reachabilitySnapshot: { generation: 0, listenAddresses: [], activeCoordinationRelays: [] },
      get connectivitySnapshot() { return connectivity; },
      transitSnapshot: { allowedPeerCount: 0, activeReservationCount: 0, activeCircuitCount: 0, maxReservationCount: 32, maxCircuitCount: 8, maxCircuitsPerPeer: 2, maxCircuitDurationSeconds: 7_200, maxCircuitBytes: 256 * 1024 * 1024 },
      watchReachability: async () => ({ generation: 0, listenAddresses: [], activeCoordinationRelays: [] }),
      watchConnectivity: async (afterGeneration) => connectivity.generation === afterGeneration
        ? new Promise((resolve) => { finishConnectivity = resolve; })
        : connectivity,
      connect: ({ requestId, peerId, routeHints, coordinationRelays, transitRelayPeerIds }) => {
        stats.requests.push({ requestId, peerId, routeHints, coordinationRelays, transitRelayPeerIds });
        if (peerId === 'unreachable') return Promise.reject(Object.assign(new Error('transit_unavailable: no approved route'), { code: 'GenericFailure' }));
        if (peerId === 'ready' || peerId === 'fallback' || peerId === 'observed') return Promise.resolve(stream);
        return new Promise((resolve, reject) => pending.set(requestId, { peerId, resolve, reject }));
      },
      connectMeshControl: ({ requestId, peerId, routeHints, coordinationRelays, transitRelayPeerIds }) => {
        stats.requests.push({ requestId, peerId, routeHints, coordinationRelays, transitRelayPeerIds });
        if (peerId === 'ready' || peerId === 'self-contained') return Promise.resolve(stream);
        return new Promise((resolve, reject) => pending.set(requestId, { peerId, resolve, reject }));
      },
      configureTransit: async () => {},
      updateConnect: async (options) => {
        stats.updates.push(options);
        const request = pending.get(options.requestId);
        if (request?.peerId === 'self-contained') {
          request.resolve(stream);
          pending.delete(options.requestId);
        }
        return Boolean(request);
      },
      cancelConnect: async (requestId) => {
        stats.cancellations.push(requestId);
        if (missFirstCancellation) {
          missFirstCancellation = false;
          return false;
        }
        pending.get(requestId)?.reject(new Error('peer_connect_cancelled: cancelled'));
        pending.delete(requestId);
        return true;
      },
      accept: () => new Promise((resolve) => { finishAccept = resolve; }),
      acceptMeshControl: () => new Promise((resolve) => { finishMeshAccept = resolve; }),
      close: async () => { stats.closes += 1; finishAccept?.(null); finishMeshAccept?.(null); finishConnectivity?.(connectivity); },
    };
  },
};
`,
    );
    let routesPrepared = false;
    let selfContainedRoutesPrepared = false;
    let recoveryExhausted = false;
    const preparedPeerIds: string[] = [];
    const client = createRuntimeHostPeerClient({
      nativePath,
      keyPath: join(directory, 'peer.key'),
    });
    const detachRouteResolver = client.attachRouteResolver({
      prepareRoutes: async (peerId) => {
        preparedPeerIds.push(peerId);
        if (peerId === 'exhausted') {
          recoveryExhausted = true;
          return;
        }
        routesPrepared = true;
        if (peerId === 'fallback') throw new Error('Mesh refresh failed');
        if (peerId === 'self-contained') {
          await new Promise((resolve) => setImmediate(resolve));
          selfContainedRoutesPrepared = true;
        }
      },
      resolveRoutes: (peerId) =>
        peerId === 'exhausted'
          ? {
              state: recoveryExhausted ? 'exhausted' : 'recovering',
              routeHints: [],
              coordinationRelays: [],
              transitRelayPeerIds: [],
            }
          : peerId !== 'observed' &&
              (peerId === 'self-contained' ? selfContainedRoutesPrepared : routesPrepared)
            ? {
                state: 'available',
                routeHints: ['/memory/discovered'],
                coordinationRelays: ['/memory/relay'],
                transitRelayPeerIds: ['transit-peer'],
              }
            : {
                state: 'recovering',
                routeHints: [],
                coordinationRelays: [],
                transitRelayPeerIds: [],
              },
      subscribeRoutes: () => () => undefined,
    });
    const native = await import(nativePath);
    const phases: string[] = [];
    const abort = new AbortController();
    const pending = client.connect(peerConnectInput('pending'), abort.signal, (phase) => {
      phases.push(phase);
    });
    await waitForRequestCount(native.default.stats, 1);
    assert.equal(routesPrepared, true);
    assert.deepEqual(phases, ['discovering', 'connecting']);
    abort.abort();
    await assert.rejects(pending, /aborted/u);

    const application = client.connect(peerConnectInput('shared'));
    await waitForRequestCount(native.default.stats, 2);
    const queuedAbort = new AbortController();
    const cancelled = client.connectMeshControl(peerConnectInput('shared'), queuedAbort.signal);
    queuedAbort.abort();
    await assert.rejects(cancelled, /aborted/u);
    const control = client.connectMeshControl(peerConnectInput('shared'));
    await waitForImmediate();
    assert.equal(native.default.stats.requests.length, 2);
    native.default.resolveConnect(2);
    await application;
    await waitForRequestCount(native.default.stats, 3);
    assert.equal(native.default.stats.requests.length, 3);
    native.default.resolveConnect(3);
    await control;

    const preparedBeforeReopen = preparedPeerIds.length;
    const reopenPhases: string[] = [];
    await client.connect(
      { ...peerConnectInput('ready'), refreshRoutes: false },
      undefined,
      (phase) => reopenPhases.push(phase),
    );
    assert.equal(preparedPeerIds.length, preparedBeforeReopen);
    assert.deepEqual(reopenPhases, ['connecting']);
    await client.connect(peerConnectInput('fallback'));
    await assert.rejects(client.connect(peerConnectInput('unreachable')), (failure: unknown) => {
      return failure instanceof RuntimeHostPeerError && failure.code === 'transit_unavailable';
    });
    const selfContained = client.connect({
      ...peerConnectInput('self-contained'),
      coordinationRelays: ['/memory/explicit-relay'],
    });
    await selfContained;
    assert.equal(preparedPeerIds.includes('self-contained'), true);
    client.observeAuthenticatedReachability({
      expectedPeerId: 'observed',
      value: signedReachability('observed', ['/memory/fresh'], ['/memory/fresh-relay']),
    });
    await client.connect({
      ...peerConnectInput('observed'),
      routeHints: ['/memory/stale'],
      coordinationRelays: ['/memory/stale-relay'],
    });
    assert.equal(native.default.stats.starts, 1);
    assert.equal(native.default.stats.closes, 0);
    assert.equal(native.default.stats.requests.length, 8);
    assert.equal(
      native.default.stats.requests.filter(
        ({ peerId }: { peerId: string }) => peerId === 'self-contained',
      ).length,
      1,
    );
    assert.deepEqual(native.default.stats.requests[0], {
      requestId: 1,
      peerId: 'pending',
      routeHints: ['/memory/1'],
      coordinationRelays: [],
      transitRelayPeerIds: [],
    });
    assert.deepEqual(native.default.stats.updates[0], {
      requestId: 1,
      routeHints: ['/memory/discovered', '/memory/1'],
      coordinationRelays: ['/memory/relay'],
      transitRelayPeerIds: ['transit-peer'],
    });
    assert.deepEqual(native.default.stats.requests.at(-1), {
      requestId: 8,
      peerId: 'observed',
      routeHints: ['/memory/fresh', '/memory/stale'],
      coordinationRelays: ['/memory/fresh-relay', '/memory/stale-relay'],
      transitRelayPeerIds: [],
    });
    for (let index = 0; index < 160; index += 1) {
      const peerId = `remembered-${index}`;
      client.observeAuthenticatedReachability({
        expectedPeerId: peerId,
        value: signedReachability(peerId, [`/memory/${peerId}`], []),
      });
    }
    await client.connect({
      ...peerConnectInput('observed'),
      routeHints: ['/memory/stale'],
      coordinationRelays: ['/memory/stale-relay'],
      refreshRoutes: false,
    });
    assert.deepEqual(native.default.stats.requests.at(-1), {
      requestId: 9,
      peerId: 'observed',
      routeHints: ['/memory/stale'],
      coordinationRelays: ['/memory/stale-relay'],
      transitRelayPeerIds: [],
    });
    assert.deepEqual(native.default.stats.cancellations, [1, 1]);

    const rolledBackIssuedAt = Date.now() + PEER_REACHABILITY_MAX_CLOCK_SKEW_MS + 1;
    client.observeAuthenticatedReachability({
      expectedPeerId: 'ready',
      value: signedReachability('ready', ['/memory/before-clock-reset'], [], rolledBackIssuedAt),
      allowHistorical: true,
    });
    await client.connect({
      ...peerConnectInput('ready'),
      routeHints: [],
      refreshRoutes: false,
    });
    const historicalRequest = native.default.stats.requests.at(-1) as {
      readonly peerId: string;
      readonly routeHints: readonly string[];
    };
    assert.equal(historicalRequest.peerId, 'ready');
    assert.equal(historicalRequest.routeHints.includes('/memory/before-clock-reset'), true);

    await assert.rejects(
      client.connect({
        ...peerConnectInput('exhausted'),
        routeHints: [],
      }),
      (error: unknown) =>
        error instanceof RuntimeHostPeerReachabilityUnavailableError &&
        error.code === 'peer_reachability_needs_repair',
    );

    detachRouteResolver();
    const requestCount = native.default.stats.requests.length;
    await assert.rejects(
      client.connect({
        ...peerConnectInput('needs-repair'),
        routeHints: [],
        refreshRoutes: false,
      }),
      (error: unknown) => error instanceof RuntimeHostPeerReachabilityUnavailableError,
    );
    assert.equal(native.default.stats.requests.length, requestCount);

    let connectivityWakeups = 0;
    const unsubscribeConnectivity = client.subscribeRoutes('restored', () => {
      connectivityWakeups += 1;
    });
    native.default.establishPeer('restored');
    await waitForImmediate();
    assert.equal(connectivityWakeups, 1);
    unsubscribeConnectivity();

    native.default.failEndpoint();
    await waitForImmediate();
    await assert.rejects(
      client.connect(peerConnectInput('ready')),
      /cannot recover until this Client restarts/u,
    );
    assert.equal(native.default.stats.starts, 1);

    await client.close();
    assert.equal(native.default.stats.closes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an incomplete endpoint API and loads a compatible relative native module', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-peer-native-'));
  try {
    const incompletePath = join(directory, 'incomplete.cjs');
    await writeFile(
      incompletePath,
      'module.exports = { ensurePeerIdentity: async () => "peer", signPeerIdentity: async () => ({ publicKey: Buffer.from("public"), signature: Buffer.from("signature") }), verifyPeerIdentity: () => true, startPeerEndpoint: () => ({ peerId: "peer", listenAddresses: [] }) };\n',
    );
    assert.throws(
      () =>
        startRuntimeHostPeerEndpoint({
          nativePath: relative(process.cwd(), incompletePath),
          keyPath: 'unused',
        }),
      (error: unknown) =>
        error instanceof RuntimeHostPeerError && error.code === 'peer_native_unavailable',
    );

    const modulePath = join(directory, 'peer.cjs');
    await writeFile(
      modulePath,
      `const stream = { read: async () => null, write: async () => {}, close: async () => {}, abort: () => {} };
const starts = [];
module.exports = {
  starts,
  ensurePeerIdentity: async () => 'peer',
  signPeerIdentity: async () => ({ publicKey: Buffer.from('public'), signature: Buffer.from('signature') }),
  verifyPeerIdentity: () => true,
  startPeerEndpoint: (options) => {
    starts.push(options);
    return ({
	    peerId: 'peer',
	    reachabilitySnapshot: { generation: 0, listenAddresses: [], activeCoordinationRelays: [] },
	    connectivitySnapshot: { generation: 0, connectedPeerIds: [] },
    transitSnapshot: { allowedPeerCount: 0, activeReservationCount: 0, activeCircuitCount: 0, maxReservationCount: 32, maxCircuitCount: 8, maxCircuitsPerPeer: 2, maxCircuitDurationSeconds: 7_200, maxCircuitBytes: 256 * 1024 * 1024 },
	    watchReachability: async () => ({ generation: 0, listenAddresses: [], activeCoordinationRelays: [] }),
	    watchConnectivity: async () => ({ generation: 0, connectedPeerIds: [] }),
    connect: async () => stream,
    connectMeshControl: async () => stream,
    configureTransit: async () => {},
    updateConnect: async () => true,
    cancelConnect: async () => true,
    accept: async () => null,
    acceptMeshControl: async () => null,
    close: async () => {},
  });
  },
};
`,
    );
    const endpoint = startRuntimeHostPeerEndpoint({
      nativePath: relative(process.cwd(), modulePath),
      keyPath: 'unused',
      webRtcStunUrls: [],
    });
    assert.equal(endpoint.peerId, 'peer');
    const native = await import(modulePath);
    assert.deepEqual(native.default.starts, [{ keyPath: 'unused', webRtcStunUrls: [] }]);
    assert.equal(
      await ensureRuntimeHostPeerIdentity({
        nativePath: modulePath,
        keyPath: 'unused',
      }),
      'peer',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounds and separates the peer credential preface from Runtime Host frames', async () => {
  const frame = Buffer.from('{"kind":"hello"}\n');
  const authenticated = await readRuntimeHostPeerAuthentication(
    streamWith(Buffer.concat([Buffer.from('{"v":1,"credential":"token"}\n'), frame])),
  );
  assert.equal(authenticated.credential, 'token');
  assert.deepEqual(authenticated.remainder, frame);

  await assert.rejects(
    readRuntimeHostPeerAuthentication(
      streamWith(Buffer.concat([Buffer.alloc(12 * 1024 + 1), Buffer.from('\n')])),
    ),
    (error: unknown) =>
      error instanceof RuntimeHostPeerError && /preface is too large/u.test(error.message),
  );

  const result = await readRuntimeHostPeerAuthenticationResult(
    streamWith(Buffer.concat([Buffer.from('{"v":1,"accepted":true}\n'), frame])),
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.remainder, frame);
});

async function waitForRequestCount(
  stats: { readonly requests: readonly unknown[] },
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10 && stats.requests.length < expected; attempt += 1) {
    await waitForImmediate();
  }
  assert.equal(stats.requests.length, expected);
}

function streamWith(chunk: Buffer): RuntimeHostPeerNativeStream {
  let pending: Buffer | null = chunk;
  return {
    peerId: 'remote-peer',
    read: async () => {
      const value = pending;
      pending = null;
      return value;
    },
    write: async () => undefined,
    close: async () => undefined,
    abort: () => undefined,
  };
}

function signedReachability(
  peerId: string,
  directRoutes: readonly string[],
  coordinationRoutes: readonly string[],
  issuedAt = Date.now(),
) {
  return {
    lease: {
      version: 1 as const,
      peerId,
      revision: 1,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      directRoutes,
      coordinationRoutes,
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from('signature').toString('base64url'),
  };
}

function peerConnectInput(peerId: string) {
  return {
    peerId,
    routeHints: ['/memory/1'],
    coordinationRelays: [],
    directDeadlineMs: 1_000,
  } as const;
}
