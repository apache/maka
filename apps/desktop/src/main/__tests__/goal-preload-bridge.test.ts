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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { GoalEventWaitCancelInput, GoalEventWaitCancelResult, GoalProjection } from '@maka/runtime-host/protocol';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import {
  invokeProjectedSessionRuntimeHost,
} from '../../preload/projected-session-runtime-host.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import {
  registerRuntimeHostSessionDomainsIpc,
  type RuntimeHostSessionDomainsIpcDeps,
} from '../runtime-host-session-domains-ipc-main.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { TerminalCloseIntents } from '../terminal-close-intents.js';

test('Goal arm preload routing preserves target scope and projects every outcome', async () => {
  const scope = { hostId: 'host-1', targetEpoch: 'epoch-2' };
  const desktopSessionId = desktopSessionKey({
    hostId: scope.hostId,
    sessionId: 'session-1',
  });
  const request = { condition: 'Finish', maxIterations: 20, tokenBudget: 1_000 };
  const scenarios = [
    {
      wire: {
        kind: 'armed',
        goal: { id: 'goal-1', sessionId: 'session-1' },
      },
      projected: {
        kind: 'armed',
        goal: { id: 'goal-1', sessionId: desktopSessionId },
      },
    },
    {
      wire: {
        kind: 'reconciled',
        currentGoal: { id: 'goal-2', sessionId: 'session-1' },
        matchesRequestedState: true,
      },
      projected: {
        kind: 'reconciled',
        currentGoal: { id: 'goal-2', sessionId: desktopSessionId },
        matchesRequestedState: true,
      },
    },
    {
      wire: { kind: 'reconciliation_unavailable' },
      projected: { kind: 'reconciliation_unavailable' },
    },
  ] as const;

  for (const scenario of scenarios) {
    const invocations: unknown[] = [];
    const result = await invokeProjectedSessionRuntimeHost(
      async (sessionId) => {
        assert.equal(sessionId, desktopSessionId);
        return { scope, sessionId: 'session-1' };
      },
      async (channel, targetScope, rawSessionId, ...args) => {
        invocations.push({ channel, targetScope, rawSessionId, args });
        return scenario.wire;
      },
      'goal:arm',
      desktopSessionId,
      request,
    );

    assert.deepEqual(invocations, [
      {
        channel: 'goal:arm',
        targetScope: scope,
        rawSessionId: 'session-1',
        args: [request],
      },
    ]);
    assert.deepEqual(result, scenario.projected);
  }
});

test('Goal wait cancellation resolves Desktop identity once and projects every result', async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  for (const profileKind of ['local', 'remote'] as const) {
    for (const outcome of ['cancelled', 'already_cancelled', 'conflict', 'already_admitted'] as const) {
      await t.test(`${profileKind} owner: ${outcome}`, async () => {
        const host = {
          hostId: `${profileKind}-host`, targetEpoch: `${profileKind}-epoch`,
          profileId: profileKind, profileName: profileKind, profileKind,
          profileAccess: 'owner', readiness: 'ready',
        };
        const scope = { hostId: host.hostId, targetEpoch: host.targetEpoch };
        const desktopSessionId = desktopSessionKey({ hostId: host.hostId, sessionId: 'session-1' });
        const goal: GoalProjection = {
          goalId: 'goal-1', sessionId: 'session-1', revision: 3,
          condition: 'Inspect the background tests', status: 'active', setAt: 1,
          iterations: 1, maxIterations: 20, consecutiveNoProgress: 0, blockCap: 8,
          tokenBudget: null, tokensSpent: 100, lastReason: null, achievedAt: null, pausedAt: null,
          eventWait: {
            waitId: 'wait-1', controlGeneration: 5, waitRevision: 2,
            resource: { providerId: 'shell_run', resourceType: 'background_task', resourceId: 'maka://runtime/background-tasks/task-1' },
            reason: 'Inspect the test result', deadlineAt: 60_000, phase: 'observing',
            observation: { state: 'pending', lastObservedAt: 1, reasonCode: null }, outcome: null,
          },
        };
        const cancelled = outcome === 'cancelled' || outcome === 'already_cancelled';
        const response: GoalEventWaitCancelResult = {
          sessionId: 'session-1', outcome,
          goal: {
            ...goal, revision: 4,
            status: cancelled ? 'paused' : 'active',
            pausedAt: cancelled ? 2 : null,
            eventWait: outcome === 'conflict'
              ? { ...goal.eventWait!, waitId: 'wait-new', controlGeneration: 6 }
              : null,
          },
        };
        const handlers = new Map<string, IpcHandler>();
        const cancellations: GoalEventWaitCancelInput[] = [];
        const ipcCancellations: unknown[] = [];
        const pauses: string[] = [];
        let queries = 0;
        const domains = registerRuntimeHostSessionDomainsIpc({
          client: {
            queryGoal: async (sessionId: string) => {
              assert.equal(sessionId, 'session-1');
              queries++;
              return { sessionId, goal };
            },
            cancelGoalEventWait: async (input: GoalEventWaitCancelInput) => {
              cancellations.push(input);
              return response;
            },
            controlGoalWithRetry: async (sessionId: string, action: string) => {
              assert.equal(action, 'pause');
              pauses.push(sessionId);
            },
          } as RuntimeHostSessionDomainsIpcDeps['client'],
          terminalCloses: new TerminalCloseIntents(),
          sessionObserver: { async observe() {}, async unobserve() {} },
          emitModeChanged() {},
        }, {
          handle(channel, handler) { handlers.set(channel, handler); },
        });
        const ipcRenderer = {
          on() {}, off() {}, send() {},
          async invoke(channel: string, ...vmArgs: unknown[]) {
            if (channel === 'app:bootstrapReady' || channel === 'runtime-host:awaitReady') return { ready: true };
            if (channel === 'runtime-host:identities') return [
              ...(profileKind === 'remote' ? [{
                ...host, hostId: 'local-host', targetEpoch: 'local-epoch', epoch: 'local-epoch',
                profileId: 'local', profileKind: 'local', isDefault: true,
              }] : []),
              { ...host, epoch: host.targetEpoch, isDefault: profileKind === 'local' },
            ];
            // Electron IPC clones arguments out of the preload's realm.
            const [targetScope, rawSessionId, ...args] = structuredClone(vmArgs);
            assert.deepEqual(targetScope, scope);
            assert.equal(rawSessionId, 'session-1');
            if (channel === 'goal:cancel-event-wait') ipcCancellations.push(args[0]);
            const handler = handlers.get(channel);
            assert.ok(handler, `Unexpected channel: ${channel}`);
            return handler({} as never, rawSessionId, ...args);
          },
        };
        let bridge: MakaBridge | undefined;
        const require = createRequire(import.meta.url);
        runInNewContext(bundle.outputFiles[0]!.text, {
          require: (id: string) => id === 'electron' ? {
            ipcRenderer,
            contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) {
              if (name === 'maka') bridge = value;
            } },
          } : require(id),
          process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
          crypto: globalThis.crypto,
        });
        assert.ok(bridge);
        try {
          const displayed = await bridge.goal.get(desktopSessionId);
          assert.equal(displayed?.sessionId, desktopSessionId);
          assert.ok(displayed?.eventWait);
          const target = Object.freeze({
            sessionId: displayed.sessionId, goalId: displayed.id,
            controlGeneration: displayed.eventWait.controlGeneration,
            waitId: displayed.eventWait.waitId, expectedGoalRevision: displayed.revision,
          });
          const result = await bridge.goal.cancelEventWait(target);
          const expectedTarget = { ...target, sessionId: 'session-1' };
          assert.deepEqual(ipcCancellations, [expectedTarget]);
          assert.deepEqual(cancellations, [expectedTarget]);
          assert.equal(target.sessionId, desktopSessionId, 'do not mutate the displayed target');
          assert.equal(queries, 1, 'do not query a newer wait to retarget cancellation');
          assert.deepEqual(structuredClone(result), {
            ...response, sessionId: desktopSessionId,
            goal: { ...response.goal, sessionId: desktopSessionId },
          });
          await bridge.goal.pause(desktopSessionId);
          assert.deepEqual(pauses, ['session-1']);
        } finally {
          await domains.close();
        }
      });
    }
  }
});
