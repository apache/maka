import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type {
  AgentGraphClientChangedEvent,
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphOperatorInspection,
  GoalState,
} from '@maka/runtime';
import type { GoalProjection, SessionDomainChange } from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { projectHostedDeepResearch } from './deep-research-desktop-projection.js';

type RuntimeHostSessionDomainClient = Pick<
  DesktopRuntimeHostClient,
  | 'clearGoal'
  | 'controlPlan'
  | 'getRuntimeResource'
  | 'getPlanState'
  | 'listRuntimeResources'
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
  sendToRenderer?(channel: string, payload: unknown): void;
  now?: () => number;
  newId?: () => string;
  onError?: (error: unknown) => void;
}

export interface RuntimeHostSessionDomainsIpcHandle {
  sessionDomainChanged(change: SessionDomainChange): void;
  agentGraphChanged(event: AgentGraphClientChangedEvent): void;
}

/**
 * Adapt Host-owned Session sidecars to the existing Desktop renderer facade.
 *
 * This remains an isolated M4 candidate. Production keeps registering the
 * embedded handlers until M5 switches the complete ownership path at once.
 */
export function registerRuntimeHostSessionDomainsIpc(
  deps: RuntimeHostSessionDomainsIpcDeps,
  ipcMain: Pick<IpcMain, 'handle'>,
): RuntimeHostSessionDomainsIpcHandle {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? Date.now;

  ipcMain.handle('tasks:list', (_event, sessionId: unknown) =>
    deps.client.listTasks(requiredId(sessionId, 'Session')),
  );
  ipcMain.handle('shell-runs:list', (_event, sessionId: unknown) =>
    deps.client.listRuntimeResources(requiredId(sessionId, 'Session')),
  );
  ipcMain.handle('deepResearch:get', async (_event, sessionId: unknown) =>
    projectHostedDeepResearch(
      await deps.client.queryDeepResearch(requiredId(sessionId, 'Session')),
    ),
  );

  ipcMain.handle('goal:get', async (_event, sessionId: unknown) => {
    const result = await deps.client.queryGoal(requiredId(sessionId, 'Session'));
    return result.goal === null ? null : toDesktopGoal(result.goal);
  });
  ipcMain.handle('goal:clear', async (_event, sessionId: unknown) => {
    await deps.client.clearGoal(requiredId(sessionId, 'Session'));
  });

  ipcMain.handle('plan-mode:getState', (_event, sessionId: unknown) =>
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
  ipcMain.handle(
    'graphs:getSnapshot',
    async (_event, rootSessionId: unknown, options?: unknown): Promise<AgentGraphClientSnapshot> =>
      mutableGraphSnapshot(
        await deps.client.queryAgentGraph({
          rootSessionId: requiredId(rootSessionId, 'root Session'),
          ...snapshotOptions(options),
        }),
      ),
  );
  ipcMain.handle(
    'graphs:inspectOperator',
    async (
      _event,
      rootSessionId: unknown,
      operatorId: unknown,
    ): Promise<AgentGraphOperatorInspection> =>
      mutableGraphInspection(
        await deps.client.queryAgentGraphOperator({
          rootSessionId: requiredId(rootSessionId, 'root Session'),
          operatorId: requiredId(operatorId, 'Agent graph operator'),
        }),
      ),
  );
  ipcMain.handle('graphs:stop', async (_event, rootSessionId: unknown) => {
    await deps.client.stopAgentGraph({
      rootSessionId: requiredId(rootSessionId, 'root Session'),
    });
  });

  return {
    sessionDomainChanged(change) {
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
        case 'runtime_resource':
          void refreshRuntimeResources(deps, change.sessionId, change.resources);
          break;
      }
    },
    agentGraphChanged(event) {
      deps.sendToRenderer?.('graphs:changed', event);
    },
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

function snapshotOptions(value: unknown): AgentGraphClientSnapshotOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid agent graph snapshot options');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'terminalCursor')) {
    throw new TypeError('Invalid agent graph snapshot options');
  }
  return record.terminalCursor === undefined
    ? {}
    : { terminalCursor: requiredId(record.terminalCursor, 'Agent graph terminal cursor', 2_048) };
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
