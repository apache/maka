import type {
  AgentListResult,
  AgentGraphCoordinator,
  AgentOutputInput,
  AgentOutputResult,
  PrepareChildAgentResumeResult,
  ResumeChildAgentInput,
  RetryChildAgentInput,
  SessionManager,
  SpawnChildAgentInput,
  SpawnChildAgentResult,
  SpawnChildSessionInput,
  SpawnChildSessionResult,
  StopSessionInput,
  MakaTool,
} from '@maka/runtime';
import {
  AgentGraphSupervisorWakeCoordinator,
  SessionActivityRegistry,
  drainGoalTurn,
  renderAgentSwarmSupervisorWake,
  shouldWakeAgentSwarmSupervisor,
} from '@maka/runtime';
import type { AgentGraphSupervisorWakeStore, AgentRunStore, SessionHeader } from '@maka/core';

export interface HeadlessSessionCapabilities {
  spawnChildAgent(sessionId: string, input: SpawnChildAgentInput): Promise<SpawnChildAgentResult>;
  spawnChildSession(
    parentSessionId: string,
    input: SpawnChildSessionInput,
  ): Promise<SpawnChildSessionResult>;
  prepareChildAgentResume(
    sessionId: string,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult>;
  resumeChildAgent(sessionId: string, input: ResumeChildAgentInput): Promise<SpawnChildAgentResult>;
  retryChildAgent(sessionId: string, input: RetryChildAgentInput): Promise<SpawnChildAgentResult>;
  listChildAgents(sessionId: string): Promise<AgentListResult>;
  readChildAgentOutput(sessionId: string, input: AgentOutputInput): Promise<AgentOutputResult>;
  getAgentGraphSupervisorTools(sessionId: string): Promise<readonly MakaTool[]>;
}

export function createHeadlessSessionCapabilityBridge(): {
  capabilities: HeadlessSessionCapabilities;
  bind(
    manager: SessionManager,
    graphCoordinator?: AgentGraphCoordinator,
    graphWakeCoordinator?: AgentGraphSupervisorWakeCoordinator,
  ): void;
  settle(sessionId: string, input?: StopSessionInput): Promise<void>;
} {
  let manager: SessionManager | undefined;
  let graphCoordinator: AgentGraphCoordinator | undefined;
  let graphWakeCoordinator: AgentGraphSupervisorWakeCoordinator | undefined;
  const activeOperations = new Set<Promise<unknown>>();
  const requireManager = (): SessionManager => {
    if (!manager) {
      throw new Error('Headless session capabilities are unavailable during backend registration');
    }
    return manager;
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    void operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation),
    );
    return operation;
  };
  return {
    capabilities: {
      spawnChildAgent: async (sessionId, input) =>
        await track(requireManager().spawnChildAgent(sessionId, input)),
      spawnChildSession: async (parentSessionId, input) =>
        await track(requireManager().spawnChildSession(parentSessionId, input)),
      prepareChildAgentResume: async (sessionId, sourceRunId) =>
        await requireManager().prepareChildAgentResume(sessionId, sourceRunId),
      resumeChildAgent: async (sessionId, input) =>
        await track(requireManager().resumeChildAgent(sessionId, input)),
      retryChildAgent: async (sessionId, input) =>
        await track(requireManager().retryChildAgent(sessionId, input)),
      listChildAgents: async (sessionId) => await requireManager().listChildAgents(sessionId),
      readChildAgentOutput: async (sessionId, input) =>
        await requireManager().readChildAgentOutput(sessionId, input),
      getAgentGraphSupervisorTools: async (sessionId) => {
        if (!graphCoordinator) {
          throw new Error('Headless agent graph coordinator is unavailable');
        }
        return graphCoordinator.toolsForSession(sessionId);
      },
    },
    bind(nextManager, nextGraphCoordinator, nextGraphWakeCoordinator) {
      if (manager) {
        throw new Error('Headless session capabilities are already bound');
      }
      manager = nextManager;
      graphCoordinator = nextGraphCoordinator;
      graphWakeCoordinator = nextGraphWakeCoordinator;
    },
    async settle(sessionId, input) {
      const operations = [...activeOperations];
      if (!input?.source && graphCoordinator) {
        if (!graphWakeCoordinator) {
          await graphCoordinator.waitForIdle(sessionId);
        } else {
          for (let cycle = 0; cycle < 64; cycle += 1) {
            await graphCoordinator.waitForIdle(sessionId);
            await graphWakeCoordinator.waitForIdle();
            await graphCoordinator.waitForIdle(sessionId);
            await graphWakeCoordinator.waitForIdle();
            const snapshot = await graphCoordinator.getSnapshot(sessionId);
            if (snapshot.scheduleRevision === 0 || snapshot.closed) break;
            if (cycle === 63) {
              throw new Error(
                `Headless agent graph ${snapshot.graphId} did not finish after 64 supervisor checkpoints`,
              );
            }
          }
        }
      }
      let graphStopError: unknown;
      if (graphCoordinator) {
        try {
          await graphCoordinator.stop(sessionId);
        } catch (error) {
          graphStopError = error;
        }
      }
      let firstStopError: unknown;
      try {
        await requireManager().stopSession(sessionId, input);
      } catch (error) {
        firstStopError = error;
      }
      if (firstStopError !== undefined) {
        try {
          await requireManager().stopSession(sessionId, input);
        } catch {
          throw firstStopError;
        }
      }
      const results = await Promise.allSettled(operations);
      const error = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )?.reason;
      if (graphStopError !== undefined) throw graphStopError;
      if (error !== undefined) throw error;
    },
  };
}

export function createHeadlessAgentGraphWakeCoordinator(input: {
  manager: SessionManager;
  graphCoordinator: AgentGraphCoordinator;
  activityRegistry: SessionActivityRegistry;
  wakeStore: AgentGraphSupervisorWakeStore;
  runStore: Pick<AgentRunStore, 'listSessionRuns'>;
  sessionStore: { readHeader(sessionId: string): Promise<SessionHeader> };
  newId(): string;
}): AgentGraphSupervisorWakeCoordinator {
  return new AgentGraphSupervisorWakeCoordinator({
    activityRegistry: input.activityRegistry,
    wakeStore: input.wakeStore,
    readSnapshot: (rootSessionId) => input.graphCoordinator.getSnapshot(rootSessionId),
    startTurn: async (sessionId, message, activity, abortSignal, isCurrent) => {
      if (!(await isCurrent())) {
        return {
          kind: 'superseded',
          turnId: message.turnId,
          reason: 'Agent graph supervisor checkpoint was superseded before execution.',
        };
      }
      let stopPromise: Promise<void> | undefined;
      const stop = () => {
        stopPromise ??= input.manager.stopSession(sessionId, { source: 'graph_supervisor' });
      };
      abortSignal.addEventListener('abort', stop, { once: true });
      if (abortSignal.aborted) stop();
      try {
        return await drainGoalTurn({
          events: input.manager.sendMessage(sessionId, message),
          turnId: message.turnId,
          activity,
        });
      } finally {
        abortSignal.removeEventListener('abort', stop);
        await stopPromise;
      }
    },
    inspectAttempt: async (rootSessionId, attemptId, turnId) => {
      const runs = (await input.runStore.listSessionRuns(rootSessionId)).filter(
        (run) => run.agentGraphWakeAttemptId === attemptId && run.turnId === turnId,
      );
      if (runs.length > 1) {
        throw new Error(`Agent graph supervisor wake attempt ${attemptId} has multiple AgentRuns`);
      }
      return runs[0]?.status ?? 'missing';
    },
    isSessionDeliverable: async (sessionId) => {
      const header = await input.sessionStore.readHeader(sessionId);
      return !header.isArchived && header.status !== 'archived';
    },
    shouldWake: shouldWakeAgentSwarmSupervisor,
    renderWake: renderAgentSwarmSupervisorWake,
    newId: input.newId,
  });
}
