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

import { randomUUID } from 'node:crypto';
import type { AgentGraphClientChangedEvent } from '@maka/runtime/stream-graph-coordinator';
import type {
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import type { GoalState } from '@maka/runtime/goal-state';
import type { ShellRunPtyDataEvent } from '@maka/runtime/shell-run-contract';
import type {
  GoalProjection,
  SessionDomainChange,
} from '@maka/runtime-host/protocol';
import type { AgentGraphEpochDirectory } from '@maka/runtime-host/client';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { RuntimeHostSessionObserver } from './runtime-host-session-observer.js';
import { GOAL_ARM_REQUEST_KEYS } from '../shared/goal-arm.js';
import { projectHostedDeepResearch } from './deep-research-desktop-projection.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import {
  registerRuntimeHostShellRunsIpc,
  type RuntimeHostShellRunsClient,
} from './runtime-host-shell-runs-ipc-main.js';

type RuntimeHostSessionDomainClient = RuntimeHostShellRunsClient &
  Pick<
    DesktopRuntimeHostClient,
    | 'armGoal'
    | 'clearGoal'
  | 'controlGoalWithRetry'
  | 'controlPlan'
  | 'getRuntimeResource'
  | 'getPlanState'
  | 'listRuntimeResources'
  | 'listAgentGraphEpochs'
  | 'listCurrentAgentGraphEpochs'
  | 'listTasks'
  | 'queryAgentGraph'
  | 'queryAgentGraphOperator'
  | 'queryDeepResearch'
  | 'queryGoal'
  | 'startPlanTurn'
    | 'stopAgentGraph'
  >;

export interface RuntimeHostSessionDomainsIpcDeps {
  client: RuntimeHostSessionDomainClient;
  emitModeChanged(sessionId: string): void;
  sessionObserver: Pick<RuntimeHostSessionObserver, 'observe' | 'unobserve'>;
  sendToRenderer?(channel: string, payload: unknown): void;
  now?: () => number;
  newId?: () => string;
  onError?: (error: unknown) => void;
}

export interface RuntimeHostSessionDomainsIpcHandle {
  sessionDomainChanged(change: SessionDomainChange): void;
  runtimeResourcePtyData(event: ShellRunPtyDataEvent): void;
  agentGraphChanged(event: AgentGraphClientChangedEvent): void;
  sessionSubscriptionRecovered(sessionId: string): void;
  close(): Promise<void>;
}

/**
 * Adapt Host-owned Session sidecars to the Desktop renderer IPC contract.
 * Runtime Host remains the production authority; this module only projects
 * its events and operations onto the client-owned presentation boundary.
 */
export function registerRuntimeHostSessionDomainsIpc(
  deps: RuntimeHostSessionDomainsIpcDeps,
  ipcMain: ReconnectableReadIpcMain,
): RuntimeHostSessionDomainsIpcHandle {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const shellRuns = registerRuntimeHostShellRunsIpc(
    { client: deps.client, newId, sessionObserver: deps.sessionObserver },
    ipcMain,
  );

  handleReconnectableRead(ipcMain, 'tasks:list', (_event, sessionId: unknown) =>
    deps.client.listTasks(requiredId(sessionId, 'Session')),
  );
  handleReconnectableRead(ipcMain, 'deepResearch:get', async (_event, sessionId: unknown) =>
    projectHostedDeepResearch(
      await deps.client.queryDeepResearch(requiredId(sessionId, 'Session')),
    ),
  );

  handleReconnectableRead(ipcMain, 'goal:get', async (_event, sessionId: unknown) => {
    const result = await deps.client.queryGoal(requiredId(sessionId, 'Session'));
    return result.goal === null ? null : toDesktopGoal(result.goal);
  });
  ipcMain.handle('goal:clear', async (_event, sessionId: unknown) => {
    await deps.client.clearGoal(requiredId(sessionId, 'Session'));
  });
  ipcMain.handle('goal:pause', async (_event, sessionId: unknown) => {
    await deps.client.controlGoalWithRetry(requiredId(sessionId, 'Session'), 'pause');
  });
  ipcMain.handle('goal:resume', async (_event, sessionId: unknown) => {
    await deps.client.controlGoalWithRetry(requiredId(sessionId, 'Session'), 'resume');
  });
  ipcMain.handle('goal:arm', async (_event, sessionId: unknown, input: unknown) => {
    const result = await deps.client.armGoal({
      sessionId: requiredId(sessionId, 'Session'),
      ...requireGoalArmBudgets(input),
    });
    return toDesktopGoal(result.goal);
  });

  handleReconnectableRead(ipcMain, 'plan-mode:getState', (_event, sessionId: unknown) =>
    deps.client.getPlanState(requiredId(sessionId, 'Session')),
  );
  ipcMain.handle(
    'plan-mode:requestRevision',
    async (_event, sessionId: unknown, proposalId: unknown) => {
      const normalizedSessionId = requiredId(sessionId, 'Session');
      await deps.client.controlPlan({
        kind: 'request_revision',
        sessionId: normalizedSessionId,
        proposalId: requiredId(proposalId, 'Plan proposal'),
        operationId: newId(),
      });
      deps.emitModeChanged(normalizedSessionId);
      return deps.client.getPlanState(normalizedSessionId);
    },
  );
  ipcMain.handle(
    'plan-mode:abandon',
    async (_event, sessionId: unknown, proposalId: unknown) => {
      const normalizedSessionId = requiredId(sessionId, 'Session');
      await deps.client.controlPlan({
        kind: 'abandon_proposal',
        sessionId: normalizedSessionId,
        proposalId: requiredId(proposalId, 'Plan proposal'),
        operationId: newId(),
      });
      deps.emitModeChanged(normalizedSessionId);
      return deps.client.getPlanState(normalizedSessionId);
    },
  );
  ipcMain.handle(
    'plan-mode:approve',
    async (_event, sessionId: unknown, value: unknown) => {
      const normalizedSessionId = requiredId(sessionId, 'Session');
      const input = planApprovalInput(value);
      const result = await deps.client.startPlanTurn({
        kind: 'approve_proposal',
        sessionId: normalizedSessionId,
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        expectedStoreVersion: input.expectedStoreVersion,
        turnId: input.turnId,
      });
      if (result.plan.executionId === null) {
        throw new Error('Plan approval did not create an execution');
      }
      deps.emitModeChanged(normalizedSessionId);
      return {
        turnId: input.turnId,
        executionId: result.plan.executionId,
      };
    },
  );
  ipcMain.handle(
    'plan-mode:resume',
    async (_event, sessionId: unknown, executionId: unknown, turnId: unknown) => {
      const normalizedSessionId = requiredId(sessionId, 'Session');
      const normalizedExecutionId = requiredId(executionId, 'Plan execution');
      const normalizedTurnId = requiredId(turnId, 'Turn');
      await deps.client.startPlanTurn({
        kind: 'resume_execution',
        sessionId: normalizedSessionId,
        executionId: normalizedExecutionId,
        turnId: normalizedTurnId,
      });
      deps.emitModeChanged(normalizedSessionId);
      return {
        turnId: normalizedTurnId,
        executionId: normalizedExecutionId,
      };
    },
  );
  ipcMain.handle(
    'plan-mode:abandonExecution',
    async (_event, sessionId: unknown, executionId: unknown) => {
      const normalizedSessionId = requiredId(sessionId, 'Session');
      await deps.client.controlPlan({
        kind: 'cancel_execution',
        sessionId: normalizedSessionId,
        executionId: requiredId(executionId, 'Plan execution'),
        operationId: newId(),
      });
      deps.emitModeChanged(normalizedSessionId);
      return deps.client.getPlanState(normalizedSessionId);
    },
  );
  handleReconnectableRead(
    ipcMain,
    'graphs:getSnapshot',
    async (_event, rootSessionId: unknown, options?: unknown): Promise<AgentGraphClientSnapshot> =>
      mutableGraphSnapshot(
        await deps.client.queryAgentGraph({
          rootSessionId: requiredId(rootSessionId, 'root Session'),
          ...snapshotOptions(options),
        }),
      ),
  );
  handleReconnectableRead(
    ipcMain,
    'graphs:listEpochs',
    async (_event, rootSessionId: unknown): Promise<AgentGraphEpochDirectory> =>
      deps.client.listAgentGraphEpochs(requiredId(rootSessionId, 'root Session')),
  );
  handleReconnectableRead(
    ipcMain,
    'graphs:listCurrentEpochs',
    async (_event, rootSessionId: unknown): Promise<AgentGraphEpochDirectory> => {
      const page = await deps.client.listCurrentAgentGraphEpochs(
        requiredId(rootSessionId, 'root Session'),
      );
      return { epochs: page.epochs, truncated: page.nextBeforeEpoch !== null };
    },
  );
  handleReconnectableRead(
    ipcMain,
    'graphs:inspectOperator',
    async (
      _event,
      rootSessionId: unknown,
      operatorId: unknown,
      graphId?: unknown,
    ): Promise<AgentGraphOperatorInspection> =>
      mutableGraphInspection(
        await deps.client.queryAgentGraphOperator({
          rootSessionId: requiredId(rootSessionId, 'root Session'),
          ...(graphId === undefined
            ? {}
            : { graphId: requiredId(graphId, 'Agent graph') }),
          operatorId: requiredId(operatorId, 'Agent graph operator'),
        }),
      ),
  );
  ipcMain.handle(
    'graphs:stop',
    async (_event, rootSessionId: unknown, expectedGraphId: unknown) => {
    await deps.client.stopAgentGraph({
      rootSessionId: requiredId(rootSessionId, 'root Session'),
      expectedGraphId: requiredId(expectedGraphId, 'Agent graph'),
    });
    },
  );

  const sessionDomainChanged = (change: SessionDomainChange): void => {
    switch (change.domain) {
      case 'task':
        deps.sendToRenderer?.('tasks:changed', {
          sessionId: change.sessionId,
          taskIds: [],
          at: now(),
        });
        break;
      case 'deep_research':
        deps.sendToRenderer?.('deepResearch:changed', {
          sessionId: change.sessionId,
          ts: now(),
        });
        break;
      case 'plan':
        deps.sendToRenderer?.('plan-mode:changed', { sessionId: change.sessionId });
        break;
      case 'usage':
        deps.sendToRenderer?.('usage:changed', { sessionId: change.sessionId });
        break;
      case 'runtime_resource':
        void refreshRuntimeResources(deps, change.sessionId, change.resources);
        break;
    }
  };

  return {
    sessionDomainChanged,
    runtimeResourcePtyData(event) {
      deps.sendToRenderer?.('shell-runs:pty-data', event);
    },
    agentGraphChanged(event) {
      deps.sendToRenderer?.('graphs:changed', event);
    },
    sessionSubscriptionRecovered(sessionId) {
      sessionDomainChanged({ sessionId, domain: 'task' });
      sessionDomainChanged({ sessionId, domain: 'deep_research' });
      sessionDomainChanged({ sessionId, domain: 'plan' });
      sessionDomainChanged({ sessionId, domain: 'usage' });
      deps.sendToRenderer?.('graphs:resync', { rootSessionId: sessionId });
      deps.sendToRenderer?.('shell-runs:resync', { sessionId });
    },
    close: () => shellRuns.close(),
  };
}

async function refreshRuntimeResources(
  deps: RuntimeHostSessionDomainsIpcDeps,
  sessionId: string,
  resources: readonly { ref: string }[],
): Promise<void> {
  for (const resource of resources) {
    try {
      const update = await deps.client.getRuntimeResource(sessionId, resource.ref);
      if (update) deps.sendToRenderer?.('shell-runs:update', update);
    } catch (error) {
      deps.onError?.(error);
    }
  }
}

/**
 * The renderer sends what the user typed; the Host owns every bound. This only
 * gets the frame into the shape the protocol decodes — numbers stay numbers,
 * "not chosen" stays null — so an out-of-range budget is refused once, by the
 * Host, instead of being clamped here into something the user did not ask for.
 * The Session comes from the scoped IPC argument, not from this frame, so a
 * renderer-side Session id can never redirect the operation.
 */
function requireGoalArmBudgets(value: unknown): {
  condition: string;
  maxIterations: number | null;
  tokenBudget: number | null;
} {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Goal arm input must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !GOAL_ARM_REQUEST_KEYS.includes(key as never))) {
    throw new TypeError('Invalid Goal arm input');
  }
  if (typeof record.condition !== 'string' || record.condition.trim().length === 0) {
    throw new TypeError('Goal condition is required');
  }
  return {
    condition: record.condition,
    maxIterations: optionalCount(record.maxIterations, 'Goal maxIterations'),
    tokenBudget: optionalCount(record.tokenBudget, 'Goal tokenBudget'),
  };
}

function optionalCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function toDesktopGoal(goal: GoalProjection): GoalState {
  return {
    id: goal.goalId,
    revision: goal.revision,
    sessionId: goal.sessionId,
    condition: goal.condition,
    status: goal.status,
    setAt: goal.setAt,
    iterations: goal.iterations,
    maxIterations: goal.maxIterations,
    consecutiveNoProgress: goal.consecutiveNoProgress,
    blockCap: goal.blockCap,
    ...(goal.tokenBudget === null ? {} : { tokenBudget: goal.tokenBudget }),
    tokensAtStart: 0,
    tokensNow: goal.tokensSpent,
    tokensBaselinePending: false,
    ...(goal.lastReason === null ? {} : { lastReason: goal.lastReason }),
    ...(goal.achievedAt === null ? {} : { achievedAt: goal.achievedAt }),
    ...(goal.pausedAt === null ? {} : { pausedAt: goal.pausedAt }),
  };
}

function snapshotOptions(
  value: unknown,
): AgentGraphClientSnapshotOptions & { readonly graphId?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid agent graph snapshot options');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'graphId' && key !== 'terminalCursor')) {
    throw new TypeError('Invalid agent graph snapshot options');
  }
  return {
    ...(record.graphId === undefined
      ? {}
      : { graphId: requiredId(record.graphId, 'Agent graph') }),
    ...(record.terminalCursor === undefined
      ? {}
      : {
          terminalCursor: requiredId(
            record.terminalCursor,
            'Agent graph terminal cursor',
            2_048,
          ),
        }),
  };
}

function mutableGraphSnapshot(
  snapshot: Awaited<ReturnType<RuntimeHostSessionDomainClient['queryAgentGraph']>>,
): AgentGraphClientSnapshot {
  return structuredClone(snapshot) as AgentGraphClientSnapshot;
}

function mutableGraphInspection(
  inspection: Awaited<ReturnType<RuntimeHostSessionDomainClient['queryAgentGraphOperator']>>,
): AgentGraphOperatorInspection {
  return structuredClone(inspection) as AgentGraphOperatorInspection;
}

function requiredId(value: unknown, name: string, maxLength = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`Invalid ${name} id`);
  }
  return value;
}

function planApprovalInput(value: unknown): {
  proposalId: string;
  expectedRevision: number;
  expectedStoreVersion: number;
  turnId: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid plan approval');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        key !== 'proposalId'
        && key !== 'expectedRevision'
        && key !== 'expectedStoreVersion'
        && key !== 'turnId',
    ) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    !Number.isSafeInteger(record.expectedStoreVersion)
  ) {
    throw new TypeError('Invalid plan approval');
  }
  return {
    proposalId: requiredId(record.proposalId, 'Plan proposal'),
    expectedRevision: record.expectedRevision as number,
    expectedStoreVersion: record.expectedStoreVersion as number,
    turnId: requiredId(record.turnId, 'Turn'),
  };
}
