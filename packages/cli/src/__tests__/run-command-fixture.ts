import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import type { InvocationResult } from '@maka/runtime';
import { runMakaTextCli, type MakaRunContext, type MakaRunRuntime } from '../run-command.js';
import type { CreateMakaCliRuntimeContextInput } from '../runtime-bootstrap.js';
import type { ReadySessionTarget } from '../connection-target.js';

const scenario = process.env.MAKA_RUN_FIXTURE_SCENARIO ?? 'completed';
let observer: CreateMakaCliRuntimeContextInput['runtimeInvocationObserver'];
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
} as ReadySessionTarget;

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
    return summary;
  },
  async *sendMessage(sessionId, input): AsyncIterable<SessionEvent> {
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
    if (scenario === 'permission') {
      yield {
        type: 'permission_request',
        kind: 'tool_permission',
        id: 'event-permission',
        turnId: input.turnId,
        ts: 1,
        requestId: 'permission-1',
        toolUseId: 'tool-1',
        toolName: 'WebSearch',
        category: 'web_read',
        reason: 'network',
        args: { query: 'example' },
        rememberForTurnAllowed: true,
      };
      if (!permissionDenied) throw new Error('permission prompt was not denied');
      await notify(failedResult('permission_denied', 'permission request permission-1 was denied'));
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
  async respondToPermission(_sessionId, response) {
    permissionDenied =
      response.decision === 'deny' &&
      (response.requestId === 'permission-1' || response.requestId === 'boundary-1');
  },
  async stopSession() {
    releaseStop?.();
  },
};

async function createContext(input: CreateMakaCliRuntimeContextInput): Promise<MakaRunContext> {
  if (scenario === 'config-error') throw new Error('unknown connection fixture-missing');
  if (
    process.env.MAKA_RUN_EXPECT_MAX_STEPS &&
    input.maxSteps !== Number(process.env.MAKA_RUN_EXPECT_MAX_STEPS)
  ) {
    throw new Error(`unexpected maxSteps ${String(input.maxSteps)}`);
  }
  if (process.env.MAKA_RUN_EXPECT_PERMISSION_RULES) {
    const actual = JSON.stringify(input.permissionRules ?? []);
    if (actual !== process.env.MAKA_RUN_EXPECT_PERMISSION_RULES) {
      throw new Error(`unexpected permissionRules ${actual}`);
    }
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
  observer = input.runtimeInvocationObserver;
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

function completedResult(finalOutput: string): InvocationResult {
  return {
    invocationId: 'invocation-fixture',
    runId: 'run-fixture',
    sessionId: summary.id,
    turnId: 'turn-fixture',
    status: 'completed',
    finalOutput,
    events: [],
    startedAt: 1,
    finishedAt: 2,
  };
}

function failedResult(failureClass: string, message: string): InvocationResult {
  return {
    invocationId: 'invocation-fixture',
    runId: 'run-fixture',
    sessionId: summary.id,
    turnId: 'turn-fixture',
    status: 'failed',
    events: [],
    failure: { class: failureClass, message },
    startedAt: 1,
    finishedAt: 2,
  };
}

async function notify(result: InvocationResult): Promise<void> {
  await observer?.(result);
}

runMakaTextCli(process.argv.slice(2), { createContext, listSessions }).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
