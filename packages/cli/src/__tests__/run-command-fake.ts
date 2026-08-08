import type { SessionEvent } from '@maka/core/events';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import type { SessionSummary } from '@maka/core/session';
import type { InvocationResult } from '@maka/runtime';
import type { MakaRunAdapter } from '../run-command-core.js';
import type { MakaRunContext, MakaRunContextInput, MakaRunRuntime } from '../run-command.js';
import {
  invocationHasSandboxBoundaryFailure,
  invocationRecoveredSandboxBoundaryFailure,
} from '../sandbox-boundary-failure.js';
import type { ReadySessionTarget } from '../connection-target.js';

export interface RunCommandFakeOptions {
  scenario?: string;
  sessions?: SessionSummary[];
  expectNoCreate?: boolean;
  expectPermissionMode?: string;
  expectNoSend?: boolean;
  expectSessionId?: string;
  boundaryKind?: string;
  expectBoundaryKind?: string;
  expectGraph?: boolean;
  graphBoundaryFailure?: boolean;
  expectMaxSteps?: number;
  expectContextCwd?: string;
  expectContextConnection?: string;
  expectContextModel?: string;
  expectCwdOverride?: string;
  onReady?: () => void;
}

export function createRunCommandFake(options: RunCommandFakeOptions = {}): MakaRunAdapter {
  const scenario = options.scenario ?? 'completed';
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

  async function notify(result: InvocationResult): Promise<void> {
    await observer?.({
      outcomeId: result.invocationId,
      status: result.status === 'completed' ? 'completed' : 'failed',
      ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
      ...(result.failure ? { failure: result.failure } : {}),
      sandboxBoundary: invocationRecoveredSandboxBoundaryFailure(result)
        ? 'recovered'
        : invocationHasSandboxBoundaryFailure(result)
          ? 'unresolved'
          : 'none',
    });
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

  function functionResponseEvent(
    toolUseId: string,
    isError: boolean,
    result: unknown,
  ): InvocationResult['events'][number] {
    return {
      id: `event-${toolUseId}`,
      invocationId: 'invocation-fixture',
      runId: 'run-fixture',
      sessionId: summary.id,
      turnId: 'turn-fixture',
      ts: 1,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: toolUseId,
        name: 'Bash',
        result,
        isError,
      },
    };
  }

  const runtime: MakaRunRuntime = {
    async createSession(input) {
      if (options.expectNoCreate) throw new Error('unexpected createSession call');
      if (options.expectPermissionMode && input.permissionMode !== options.expectPermissionMode) {
        throw new Error(`unexpected permissionMode ${input.permissionMode}`);
      }
      return summary;
    },
    async readExecutionBoundary() {
      const kind = options.boundaryKind ?? 'managed';
      return kind === 'managed'
        ? {
            kind,
            profile: createWorkspaceWritePermissionProfile(),
            revision: 0,
          }
        : { kind: kind as 'bypass' | 'external', revision: 0 };
    },
    async setExecutionBoundaryKind(_sessionId, kind) {
      if (options.expectBoundaryKind && kind !== options.expectBoundaryKind) {
        throw new Error(`unexpected boundary kind ${kind}`);
      }
    },
    async *sendMessage(sessionId, input): AsyncIterable<SessionEvent> {
      if (options.expectNoSend) throw new Error('unexpected sendMessage call');
      if (options.expectSessionId && sessionId !== options.expectSessionId) {
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
      if (options.expectGraph) {
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
        await notify({
          ...completedResult('recovered safely'),
          events: [
            functionResponseEvent('tool-boundary', true, {
              sandboxFailure: { reason: 'sandbox_boundary_required' },
            }),
            functionResponseEvent('tool-safe', false, 'completed within the current boundary'),
          ],
        });
        return;
      }
      if (scenario === 'slow') {
        options.onReady?.();
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
      const output =
        options.expectMaxSteps === undefined
          ? `prompt=${input.text}`
          : `maxSteps=${options.expectMaxSteps};prompt=${input.text}`;
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
    if (options.expectMaxSteps !== undefined && input.maxSteps !== options.expectMaxSteps) {
      throw new Error(`unexpected maxSteps ${String(input.maxSteps)}`);
    }
    if (options.expectContextCwd && input.cwd !== options.expectContextCwd) {
      throw new Error(`unexpected context cwd ${input.cwd}`);
    }
    if (
      options.expectContextConnection &&
      input.requestedConnectionSlug !== options.expectContextConnection
    ) {
      throw new Error(`unexpected context connection ${String(input.requestedConnectionSlug)}`);
    }
    if (options.expectContextModel && input.requestedModel !== options.expectContextModel) {
      throw new Error(`unexpected context model ${String(input.requestedModel)}`);
    }
    if (options.expectCwdOverride) {
      const actual = JSON.stringify(input.sessionCwdOverride);
      if (actual !== options.expectCwdOverride) {
        throw new Error(`unexpected sessionCwdOverride ${actual}`);
      }
    }
    observer = input.runOutcomeObserver;
    if (options.expectGraph || scenario === 'graph-runtime-error' || scenario === 'graph-wait') {
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
              // Reaching here is the bug this scenario guards against; the
              // thrown message surfaces on the captured stderr channel.
              throw new Error('graph-wait-called: unexpected graph wait after failed invocation');
            }
            if (scenario === 'graph-wait') {
              options.onReady?.();
              const keepAlive = setInterval(() => {}, 1_000);
              await new Promise<void>((resolve) => {
                releaseGraphWait = resolve;
              });
              clearInterval(keepAlive);
              return;
            }
            if (options.graphBoundaryFailure) {
              await notify({
                ...completedResult('child could not complete'),
                invocationId: 'invocation-child',
                runId: 'run-child',
                sessionId: 'session-child',
                events: [
                  {
                    id: 'event-child-tool',
                    invocationId: 'invocation-child',
                    runId: 'run-child',
                    sessionId: 'session-child',
                    turnId: 'turn-child',
                    ts: 1,
                    partial: false,
                    role: 'tool',
                    author: 'tool',
                    content: {
                      kind: 'function_response',
                      id: 'tool-child',
                      name: 'Write',
                      isError: true,
                      result: {
                        kind: 'text',
                        text: 'boundary required',
                        sandboxFailure: { reason: 'sandbox_boundary_required' },
                      },
                    },
                  },
                ],
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
    return options.sessions ?? [];
  }

  return { createContext, listSessions };
}
