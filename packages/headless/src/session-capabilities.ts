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
  bind(manager: SessionManager, graphCoordinator?: AgentGraphCoordinator): void;
  settle(sessionId: string, input?: StopSessionInput): Promise<void>;
} {
  let manager: SessionManager | undefined;
  let graphCoordinator: AgentGraphCoordinator | undefined;
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
    bind(nextManager, nextGraphCoordinator) {
      if (manager) {
        throw new Error('Headless session capabilities are already bound');
      }
      manager = nextManager;
      graphCoordinator = nextGraphCoordinator;
    },
    async settle(sessionId, input) {
      const operations = [...activeOperations];
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
