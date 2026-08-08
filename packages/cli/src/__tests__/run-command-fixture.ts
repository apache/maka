import type { SessionEvent } from '@maka/core/events';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import type { SessionSummary } from '@maka/core/session';
import {
  runMakaTextCliCore,
  type MakaRunContext,
  type MakaRunContextInput,
  type MakaRunOutcome,
  type MakaRunRuntime,
} from '../run-command-core.js';

const scenario = process.env.MAKA_RUN_FIXTURE_SCENARIO ?? 'completed';
let observer: MakaRunContextInput['runOutcomeObserver'];
let permissionDenied = false;
let releaseStop: (() => void) | undefined;
let releaseGraphWait: (() => void) | undefined;
let graphActivityReleased = false;

const target = {
  connection: {
    slug: 'fixture',
    name: 'Fixture',
    providerType: 'ollama',
    enabled: true,
    defaultModel: 'fixture-model',
  },
  apiKey: '',
  model: 'fixture-model',
};

const summary = {
  id: 'session-fixture',
  cwd: process.cwd(),
  name: 'fixture',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: 'fixture',
  connectionLocked: false,
  model: 'fixture-model',
  permissionMode: 'explore',
} satisfies SessionSummary;

const runtime: MakaRunRuntime = {
  async createSession(input) {
    if (process.env.MAKA_RUN_EXPECT_NO_CREATE === '1') {
      throw new Error('unexpected createSession call');
    }
    if (
      process.env.MAKA_RUN_EXPECT_PERMISSION_MODE &&
      input.permissionMode !== process.env.MAKA_RUN_EXPECT_PERMISSION_MODE
    ) {
      throw new Error(`unexpected permissionMode ${input.permissionMode}`);
    }
    if (
      process.env.MAKA_RUN_EXPECT_SESSION_NAME &&
      input.name !== process.env.MAKA_RUN_EXPECT_SESSION_NAME
    ) {
      throw new Error(`unexpected Session name ${JSON.stringify(input.name)}`);
    }
    return summary;
  },
  async readExecutionBoundary() {
    const kind = process.env.MAKA_RUN_BOUNDARY_KIND ?? 'managed';
    return kind === 'managed'
      ? {
          kind,
          profile: createWorkspaceWritePermissionProfile(),
          revision: 0,
        }
      : { kind: kind as 'bypass' | 'external', revision: 0 };
  },
  async setExecutionBoundaryKind(_sessionId, kind) {
    if (
      process.env.MAKA_RUN_EXPECT_BOUNDARY_KIND &&
      kind !== process.env.MAKA_RUN_EXPECT_BOUNDARY_KIND
    ) {
      throw new Error(`unexpected boundary kind ${kind}`);
    }
  },
  async *sendMessage(sessionId, input): AsyncIterable<SessionEvent> {
    if (process.env.MAKA_RUN_EXPECT_NO_SEND === '1') {
      throw new Error('unexpected sendMessage call');
    }
    if (
      process.env.MAKA_RUN_EXPECT_SESSION_ID &&
      sessionId !== process.env.MAKA_RUN_EXPECT_SESSION_ID
    ) {
      throw new Error(`unexpected sessionId ${sessionId}`);
    }
    if (scenario === 'runtime-error') throw new Error('provider failed after startup');
    if (scenario === 'graph-runtime-error') {
      if (input.turnOrchestration?.mode !== 'graph') {
        throw new Error('expected graph orchestration');
      }
      await notify(failedResult('provider_unavailable', 'provider failed before graph creation'));
      return;
    }
    if (scenario === 'graph-wait') {
      if (input.turnOrchestration?.mode !== 'graph') {
        throw new Error('expected graph orchestration');
      }
      await notify(completedResult('initial graph supervisor output'));
      return;
    }
    if (process.env.MAKA_RUN_EXPECT_GRAPH === '1') {
      if (
        input.turnOrchestration?.mode !== 'graph' ||
        input.turnOrchestration.source !== 'host_api'
      ) {
        throw new Error(
          `unexpected graph orchestration ${JSON.stringify(input.turnOrchestration)}`,
        );
      }
      await notify(completedResult('initial graph supervisor output'));
      return;
    }
    if (scenario === 'sandbox-boundary') {
      yield {
        type: 'sandbox_boundary_request',
        id: 'event-boundary',
        turnId: input.turnId,
        ts: 1,
        requestId: 'boundary-1',
        toolUseId: 'tool-boundary',
        justification: 'Read an external file.',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
      };
      if (!permissionDenied) throw new Error('sandbox boundary request was not denied');
      return;
    }
    if (scenario === 'sandbox-boundary-tool-result') {
      yield {
        type: 'tool_result',
        id: 'event-boundary-result',
        turnId: input.turnId,
        ts: 1,
        toolUseId: 'tool-boundary',
        isError: true,
        content: {
          kind: 'text',
          text: 'Bash requires an approved session sandbox boundary expansion.',
          sandboxFailure: {
            reason: 'sandbox_boundary_required',
            requiredExpansion: { network: { enabled: true } },
          },
        },
      } as unknown as SessionEvent;
      await notify(completedResult('should not be emitted'));
      return;
    }
    if (scenario === 'sandbox-boundary-recovered') {
      yield {
        type: 'tool_result',
        id: 'event-boundary-result',
        turnId: input.turnId,
        ts: 1,
        toolUseId: 'tool-boundary',
        isError: true,
        content: {
          kind: 'text',
          text: 'Bash requires an approved session sandbox boundary expansion.',
          sandboxFailure: {
            reason: 'sandbox_boundary_required',
            requiredExpansion: { network: { enabled: true } },
          },
        },
      } as unknown as SessionEvent;
      yield {
        type: 'tool_result',
        id: 'event-safe-result',
        turnId: input.turnId,
        ts: 2,
        toolUseId: 'tool-safe',
        isError: false,
        content: { kind: 'text', text: 'completed within the current boundary' },
      };
      await notify({ ...completedResult('recovered safely'), sandboxBoundary: 'recovered' });
      return;
    }
    if (scenario === 'slow') {
      process.stderr.write('fixture-ready\n');
      const keepAlive = setInterval(() => {}, 1_000);
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      clearInterval(keepAlive);
      await notify(failedResult('aborted', 'fixture stopped'));
      return;
    }
    if (scenario === 'missing-output') {
      await notify(
        failedResult('missing_final_output', 'completed invocation produced no final output'),
      );
      return;
    }
    if (scenario === 'step-limit') {
      await notify(
        failedResult('step_limit', 'explicit tool-step limit reached; send continue to resume'),
      );
      return;
    }
    const maxSteps = process.env.MAKA_RUN_EXPECT_MAX_STEPS;
    const output = maxSteps ? `maxSteps=${maxSteps};prompt=${input.text}` : `prompt=${input.text}`;
    await notify(completedResult(output));
  },
  async respondToSandboxBoundary(_sessionId, response) {
    permissionDenied = response.decision === 'deny' && response.requestId === 'boundary-1';
  },
  async stopSession() {
    releaseStop?.();
  },
};

async function createContext(input: MakaRunContextInput): Promise<MakaRunContext> {
  if (scenario === 'config-error') throw new Error('unknown connection fixture-missing');
  if (
    process.env.MAKA_RUN_EXPECT_MAX_STEPS &&
    input.maxSteps !== Number(process.env.MAKA_RUN_EXPECT_MAX_STEPS)
  ) {
    throw new Error(`unexpected maxSteps ${String(input.maxSteps)}`);
  }
  if (
    process.env.MAKA_RUN_EXPECT_CONTEXT_CWD &&
    input.cwd !== process.env.MAKA_RUN_EXPECT_CONTEXT_CWD
  ) {
    throw new Error(`unexpected context cwd ${input.cwd}`);
  }
  if (
    process.env.MAKA_RUN_EXPECT_CONTEXT_CONNECTION &&
    input.requestedConnectionSlug !== process.env.MAKA_RUN_EXPECT_CONTEXT_CONNECTION
  ) {
    throw new Error(`unexpected context connection ${String(input.requestedConnectionSlug)}`);
  }
  if (
    process.env.MAKA_RUN_EXPECT_CONTEXT_MODEL &&
    input.requestedModel !== process.env.MAKA_RUN_EXPECT_CONTEXT_MODEL
  ) {
    throw new Error(`unexpected context model ${String(input.requestedModel)}`);
  }
  if (process.env.MAKA_RUN_EXPECT_CWD_OVERRIDE) {
    const actual = JSON.stringify(input.sessionCwdOverride);
    if (actual !== process.env.MAKA_RUN_EXPECT_CWD_OVERRIDE) {
      throw new Error(`unexpected sessionCwdOverride ${actual}`);
    }
  }
  observer = input.runOutcomeObserver;
  if (
    process.env.MAKA_RUN_EXPECT_GRAPH === '1' ||
    scenario === 'graph-runtime-error' ||
    scenario === 'graph-wait'
  ) {
    if (!input.enableAgentGraph) throw new Error('Graph host was not enabled');
    return {
      runtime,
      target,
      agentGraph: {
        reserveActivity: () => ({
          release: () => {
            graphActivityReleased = true;
          },
        }),
        waitForCompletion: async () => {
          if (!graphActivityReleased) throw new Error('Graph activity was not released');
          if (scenario === 'graph-runtime-error') {
            process.stderr.write('graph-wait-called\n');
            throw new Error('unexpected graph wait after failed invocation');
          }
          if (scenario === 'graph-wait') {
            process.stderr.write('fixture-ready\n');
            const keepAlive = setInterval(() => {}, 1_000);
            await new Promise<void>((resolve) => {
              releaseGraphWait = resolve;
            });
            clearInterval(keepAlive);
            return;
          }
          if (process.env.MAKA_RUN_GRAPH_BOUNDARY_FAILURE === '1') {
            await notify({
              ...completedResult('child could not complete'),
              outcomeId: 'run-child',
              sandboxBoundary: 'unresolved',
            });
          }
          await notify(completedResult('graph completed'));
        },
      },
      close: async () => {
        releaseGraphWait?.();
      },
    };
  }
  return { runtime, target, close: async () => {} };
}

async function listSessions(): Promise<SessionSummary[]> {
  return JSON.parse(process.env.MAKA_RUN_FIXTURE_SESSIONS ?? '[]') as SessionSummary[];
}

function completedResult(finalOutput: string): MakaRunOutcome {
  return {
    outcomeId: 'run-fixture',
    status: 'completed',
    finalOutput,
    sandboxBoundary: 'none',
  };
}

function failedResult(failureClass: string, message: string): MakaRunOutcome {
  return {
    outcomeId: 'run-fixture',
    status: 'failed',
    failure: { class: failureClass, message },
    sandboxBoundary: 'none',
  };
}

async function notify(result: MakaRunOutcome): Promise<void> {
  await observer?.(result);
}

runMakaTextCliCore(process.argv.slice(2), { createContext, listSessions }).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
