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

// Run after `npm run build`. The "before" path invokes the same complete
// snapshot used by the old Renderer invalidation; the "after" path invokes
// one targeted change. This is a synthetic Host transport, not an Electron UI
// trace. It deliberately does not include the initial bootstrap cost.

import { performance } from 'node:perf_hooks';
import { createOnboardingService } from '../dist/main/onboarding-service.js';
import {
  applyOnboardingSessionUpdate,
  createOnboardingSnapshotPoller,
} from '../dist/renderer/use-onboarding-snapshot.js';
import { readRuntimeHostSessions } from '../../../packages/runtime-host/dist/client/catalog-reader.js';

const counts = [100, 1_000, 5_000];
const latencies = [0, 30];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(fraction * sorted.length) - 1].toFixed(2));
}

async function measure(count, roundTripMs) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`, backend: 'plugin-executor', llmConnectionSlug: '',
    model: '', connectionLocked: false,
  }));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  let requests = [];
  const connection = {
    async request(_operation, input) {
      if (roundTripMs) await delay(roundTripMs);
      const result = input.kind === 'get'
        ? { kind: 'session', session: rowsById.get(input.sessionId) ?? null }
        : (() => {
            const offset = input.kind === 'list_start' ? 0 : Number(input.cursor);
            const next = Math.min(offset + 32, rows.length);
            return {
              kind: 'page', revision: 1, sessions: rows.slice(offset, next),
              nextCursor: next < rows.length ? String(next) : null,
            };
          })();
      requests.push({
        kind: input.kind,
        bytes: Buffer.byteLength(JSON.stringify(result)),
        rows: result.kind === 'page' ? result.sessions.length : Number(result.session !== null),
      });
      return result;
    },
  };
  const service = createOnboardingService({
    listConnections: async () => [],
    getDefaultSlug: async () => null,
    listSessions: () => readRuntimeHostSessions(connection),
    getSession: async (id) => (await connection.request('session.catalog.query', {
      kind: 'get', sessionId: id,
    })).session,
    getMilestones: async () => [{ id: 'initial_onboarding', completedAt: 1 }],
    upsertMilestone: async () => [{ id: 'initial_onboarding', completedAt: 1 }],
    hasCredential: async () => true,
  });
  await service.getSnapshot(); // Both paths start after identical coverage.
  if (process.argv.includes('--burst')) {
    const results = {};
    for (const name of ['before_full_snapshot', 'after_targeted_update']) {
      let ipcBytes = 0;
      const poller = createOnboardingSnapshotPoller({
        getSnapshot: async () => {
          const result = await service.getSnapshot();
          ipcBytes += Buffer.byteLength(JSON.stringify(result));
          return result;
        },
        ...(name === 'after_targeted_update' ? {
          getSessionUpdate: async (id) => {
            const result = await service.getSessionUpdate(id);
            ipcBytes += Buffer.byteLength(JSON.stringify(result));
            return { ...result, sessionId: id };
          },
        } : {}),
      }, { onSnapshot() {}, onSessionUpdate() {}, onError(error) { throw new Error(error); } }, () => 'en');
      await poller.pull();
      const durations = [];
      let listRequests = 0;
      let getRequests = 0;
      let hostBytes = 0;
      let transferredBytes = 0;
      const sampleCount = roundTripMs ? 5 : 10;
      const sessionId = `session-${Math.floor(count / 2)}`;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        requests = [];
        ipcBytes = 0;
        const start = performance.now();
        const first = name === 'after_targeted_update'
          ? poller.pullSession(sessionId)
          : poller.pull();
        for (let event = 0; event < 10; event += 1) {
          if (name === 'after_targeted_update') void poller.pullSession(sessionId);
          else void poller.pull();
        }
        await first;
        durations.push(performance.now() - start);
        listRequests += requests.filter(({ kind }) => kind.startsWith('list_')).length;
        getRequests += requests.filter(({ kind }) => kind === 'get').length;
        hostBytes += requests.reduce((sum, request) => sum + request.bytes, 0);
        transferredBytes += ipcBytes;
      }
      poller.dispose();
      results[name] = {
        medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
        listRequestsPerBurst: listRequests / sampleCount,
        getRequestsPerBurst: getRequests / sampleCount,
        hostBytesPerBurst: Math.round(hostBytes / sampleCount),
        ipcBytesPerBurst: Math.round(transferredBytes / sampleCount),
      };
    }
    return { count, roundTripMs, burstNotifications: 11, ...results };
  }
  const sampleCount = roundTripMs ? 7 : 30;
  const results = {};
  for (const [name, run] of [
    ['before_full_snapshot', () => service.getSnapshot()],
    ['after_targeted_update', () => service.getSessionUpdate(`session-${Math.floor(count / 2)}`)],
  ]) {
    const durations = [];
    let listRequests = 0;
    let getRequests = 0;
    let hostBytes = 0;
    let ipcBytes = 0;
    let materializedRows = 0;
    for (let index = 0; index < sampleCount; index++) {
      requests = [];
      const start = performance.now();
      const response = await run();
      durations.push(performance.now() - start);
      listRequests += requests.filter(({ kind }) => kind.startsWith('list_')).length;
      getRequests += requests.filter(({ kind }) => kind === 'get').length;
      hostBytes += requests.reduce((sum, request) => sum + request.bytes, 0);
      materializedRows += requests.reduce((sum, request) => sum + request.rows, 0);
      ipcBytes += Buffer.byteLength(JSON.stringify(response));
    }
    results[name] = {
      medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
      listRequestsPerChange: listRequests / sampleCount,
      getRequestsPerChange: getRequests / sampleCount,
      hostBytesPerChange: Math.round(hostBytes / sampleCount),
      ipcBytesPerChange: Math.round(ipcBytes / sampleCount),
      materializedRowsPerChange: materializedRows / sampleCount,
    };
  }
  return { count, roundTripMs, sampleCount, ...results };
}

if (process.argv.includes('--renderer-copy')) {
  for (const count of counts) {
    let snapshot = {
      state: { kind: 'needs_connection' }, milestones: [], sessions: [], connections: [],
      defaultSlug: null, chatModelChoices: [],
      sessionSendOutcomes: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`session-${index}`, { kind: 'ready' }]),
      ),
    };
    const durations = [];
    for (let index = 0; index < 230; index += 1) {
      const update = {
        kind: 'delta', sessionId: `session-${Math.floor(count / 2)}`,
        outcome: index % 2 === 0
          ? { kind: 'blocked', reason: 'fake_backend', connectionLocked: false }
          : { kind: 'ready' },
      };
      const start = performance.now();
      snapshot = applyOnboardingSessionUpdate(snapshot, update);
      if (index >= 30) durations.push(performance.now() - start);
    }
    console.log(JSON.stringify({
      kind: 'renderer-record-copy', count,
      medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
    }));
  }
} else {
  for (const count of counts) {
    for (const roundTripMs of latencies) {
      console.log(JSON.stringify(await measure(count, roundTripMs)));
    }
  }
}
