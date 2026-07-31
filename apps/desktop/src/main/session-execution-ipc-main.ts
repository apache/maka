import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { SessionEvent } from '@maka/core';
import type { SessionManager } from '@maka/runtime';
import { normalizeRegenerateTurnInput } from './permission-response-guard.js';

export interface SessionExecutionIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  runtime: Pick<
    SessionManager,
    | 'approvePlan'
    | 'compactSession'
    | 'planLatestAuthoritativeSafeBoundaryContinuation'
    | 'regenerateTurn'
    | 'resumePlanExecution'
    | 'resumeSafeBoundaryContinuation'
    | 'sendMessage'
  >;
  ensureSessionCanSend: (sessionId: string) => Promise<void>;
  ensureSessionWorkspaceAvailable: (sessionId: string) => Promise<void>;
  streamEvents: (
    sessionId: string,
    iterator: AsyncIterable<SessionEvent>,
    options: {
      turnId: string;
      goalBoundary: 'external' | 'none';
    },
  ) => Promise<{ turnId: string; ok: boolean; error?: string }>;
  emitModeChanged: (sessionId: string) => void;
  newId?: () => string;
}

export function registerSessionExecutionIpc(deps: SessionExecutionIpcDeps): void {
  const newId = deps.newId ?? randomUUID;
  deps.ipcMain.handle('sessions:compact', async (_event, sessionId: string) => {
    await deps.ensureSessionCanSend(sessionId);
    const turnId = newId();
    void deps.streamEvents(sessionId, deps.runtime.compactSession(sessionId, { turnId }), {
      turnId,
      goalBoundary: 'none',
    });
  });
  deps.ipcMain.handle('sessions:resumeLatest', async (_event, sessionId: string) => {
    await deps.ensureSessionCanSend(sessionId);
    const plan =
      await deps.runtime.planLatestAuthoritativeSafeBoundaryContinuation(sessionId);
    if (!plan.continuation) {
      return {
        disposition: 'park' as const,
        rejectionReasons: plan.rejectionReasons,
        diagnostics: plan.diagnostics,
      };
    }
    const iterator = deps.runtime.resumeSafeBoundaryContinuation(plan.continuation);
    void deps.streamEvents(sessionId, iterator, {
      turnId: plan.continuation.turnId,
      goalBoundary: 'none',
    });
    return {
      disposition: 'started' as const,
      runId: plan.continuation.runId,
      turnId: plan.continuation.turnId,
    };
  });
  deps.ipcMain.handle(
    'sessions:regenerateTurn',
    async (_event, sessionId: string, input: unknown) => {
      await deps.ensureSessionCanSend(sessionId);
      const normalized = normalizeRegenerateTurnInput(input);
      const turnId = normalized.turnId ?? newId();
      void deps.streamEvents(
        sessionId,
        deps.runtime.regenerateTurn(sessionId, { ...normalized, turnId }),
        {
          turnId,
          goalBoundary: 'external',
        },
      );
    },
  );
  deps.ipcMain.handle(
    'plan-mode:approve',
    async (_event, sessionId: string, input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid plan approval');
      const proposalId = (input as { proposalId?: unknown }).proposalId;
      const expectedRevision = (input as { expectedRevision?: unknown }).expectedRevision;
      const expectedStoreVersion = (input as { expectedStoreVersion?: unknown })
        .expectedStoreVersion;
      if (
        typeof proposalId !== 'string' ||
        !proposalId ||
        typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        (expectedStoreVersion !== undefined &&
          (typeof expectedStoreVersion !== 'number' ||
            !Number.isSafeInteger(expectedStoreVersion)))
      ) {
        throw new Error('Invalid plan approval');
      }
      await deps.ensureSessionCanSend(sessionId);
      await deps.ensureSessionWorkspaceAvailable(sessionId);
      const result = await deps.runtime.approvePlan({
        sessionId,
        proposalId,
        expectedRevision,
        ...(expectedStoreVersion !== undefined ? { expectedStoreVersion } : {}),
      });
      if (result.event.type !== 'plan_approved') {
        throw new Error('Plan approval did not create an execution');
      }
      const turnId = newId();
      const iterator = deps.runtime.sendMessage(sessionId, {
        turnId,
        text: `Execute the approved plan ${result.event.execution.planId}.`,
      });
      void deps.streamEvents(sessionId, iterator, {
        turnId,
        goalBoundary: 'external',
      });
      deps.emitModeChanged(sessionId);
      return {
        state: result.state,
        turnId,
        executionId: result.event.execution.executionId,
      };
    },
  );
  deps.ipcMain.handle(
    'plan-mode:resume',
    async (_event, sessionId: string, executionId: unknown) => {
      if (typeof executionId !== 'string' || !executionId) {
        throw new Error('Invalid execution id');
      }
      await deps.ensureSessionCanSend(sessionId);
      await deps.ensureSessionWorkspaceAvailable(sessionId);
      const result = await deps.runtime.resumePlanExecution(sessionId, executionId);
      const turnId = newId();
      const iterator = deps.runtime.sendMessage(sessionId, {
        turnId,
        text: `Resume the approved plan execution ${executionId}.`,
      });
      void deps.streamEvents(sessionId, iterator, {
        turnId,
        goalBoundary: 'external',
      });
      deps.emitModeChanged(sessionId);
      return { state: result.state, turnId, executionId };
    },
  );
}
