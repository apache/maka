import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { LOCAL_RUNTIME_HOST_PROFILE, type RuntimeHostConnection } from '@maka/runtime-host/client';
import type {
  InteractionPendingSnapshot,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import { resolveRuntimeHostCliTarget } from '../runtime-host-cli-context.js';
import { createRuntimeHostRunContext, runRuntimeHostTextCli } from '../runtime-host-run-command.js';
import type { RuntimeHostMakaSessionDriver } from '../runtime-host-session-driver.js';
import type { MakaRunContextInput, MakaRunOutcome } from '../run-command-core.js';

describe('Runtime Host maka run adapter', () => {
  test('stops before context creation when CLI preflight finds a confirmed blocker', async () => {
    const stderr: string[] = [];
    let contextCreations = 0;
    const blockedCatalog = connectionCatalog();
    blockedCatalog.connections[0]!.enabled = false;

    const exitCode = await runRuntimeHostTextCli(
      ['answer once'],
      {
        workspaceRoot: () => '/runtime-host-data',
        processCwd: () => process.cwd(),
        stdinIsTTY: () => true,
        readStdin: async () => '',
        writeStdout: () => {},
        writeStderr: (text) => stderr.push(text),
        onSigint: () => () => {},
        newId: () => 'turn-blocked',
      },
      {
        connect: async () => ({
          connection: {} as RuntimeHostConnection,
          catalog: blockedCatalog,
          profile: LOCAL_RUNTIME_HOST_PROFILE,
          close: async () => {},
        }),
        createContext: (_connection, _catalog, input) => {
          contextCreations += 1;
          return publicCommandContext(input);
        },
      },
      { clientDataRoot: '/client-data', cliCommand: 'npm run cli:dev --' },
    );

    assert.equal(exitCode, 2);
    assert.equal(contextCreations, 0);
    assert.match(stderr.join(''), /model_connection_disabled/);
    assert.match(stderr.join(''), /repair connection "openai-main" in `npm run cli:dev --`/);
  });

  test('routes both launch roots through the selected Host profile and canonical Project', async () => {
    let selectedWorkspaceRoot: string | undefined;
    let selectedClientDataRoot: string | undefined;
    let selectedProfile: string | undefined;
    let contextInput: MakaRunContextInput | undefined;
    const connection = remoteReadinessConnection();
    const exitCode = await runRuntimeHostTextCli(
      ['answer once', '--host', 'office', '--project', 'project-old'],
      {
        workspaceRoot: () => '/runtime-host-data',
        processCwd: () => process.cwd(),
        stdinIsTTY: () => true,
        readStdin: async () => '',
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => () => {},
        newId: () => 'turn-remote',
      },
      {
        connect: async (rootPath, profileId, clientDataRoot) => {
          selectedWorkspaceRoot = rootPath;
          selectedClientDataRoot = clientDataRoot;
          selectedProfile = profileId;
          return {
            connection,
            catalog: connectionCatalog(),
            profile: {
              id: 'office',
              name: 'Office',
              kind: 'remote',
              transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
              rootId: 'a'.repeat(64),
            },
            close: async () => {},
          };
        },
        createContext: (_connection, _catalog, input) => {
          contextInput = input;
          return publicCommandContext(input);
        },
      },
      { clientDataRoot: '/client-data', cliCommand: 'npm run cli:dev --' },
    );

    assert.equal(exitCode, 0);
    assert.equal(selectedWorkspaceRoot, '/runtime-host-data');
    assert.equal(selectedClientDataRoot, '/client-data');
    assert.equal(selectedProfile, 'office');
    assert.equal(contextInput?.projectId, 'project-1');
  });

  test('continues the Host-owned cwd Session without creating another identity', async () => {
    const cwd = process.cwd();
    let creates = 0;
    let contextInput: MakaRunContextInput | undefined;
    const connection = {
      request: async (operation: string) => {
        if (operation !== 'session.catalog.query') {
          throw new Error(`Unexpected operation: ${operation}`);
        }
        return {
          kind: 'page',
          revision: 1,
          nextCursor: null,
          sessions: [
            {
              ...sessionProjection('session-existing'),
              workspace: {
                target: { kind: 'host_path', path: cwd },
                hostCwd: cwd,
              },
              lastUsedAt: 10,
              lastMessageAt: 10,
            },
          ],
        };
      },
    } as unknown as RuntimeHostConnection;
    const exitCode = await runRuntimeHostTextCli(
      ['continue once', '--continue'],
      {
        workspaceRoot: () => '/runtime-host-data',
        processCwd: () => cwd,
        stdinIsTTY: () => true,
        readStdin: async () => '',
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => () => {},
        newId: () => 'turn-continue',
      },
      {
        connect: async () => ({
          connection,
          catalog: connectionCatalog(),
          profile: LOCAL_RUNTIME_HOST_PROFILE,
          close: async () => {},
        }),
        createContext: (_connection, _catalog, input) => {
          contextInput = input;
          return publicCommandContext(input, () => {
            creates += 1;
          });
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(creates, 0);
    assert.equal(contextInput?.sessionCwdOverride?.sessionId, 'session-existing');
  });

  test('fails the public command explicitly when an ordinary Host Turn requests permission', async () => {
    const stderr: string[] = [];
    const fixture = runFixture({
      pendingInteractions: [pendingPermission('turn-1')],
      pendingAfterTurnStarts: true,
    });

    const exitCode = await runRuntimeHostTextCli(
      ['run a protected tool'],
      {
        workspaceRoot: () => '/runtime-host-data',
        processCwd: () => process.cwd(),
        stdinIsTTY: () => true,
        readStdin: async () => '',
        writeStdout: () => {},
        writeStderr: (text) => stderr.push(text),
        onSigint: () => () => {},
        newId: () => 'turn-1',
      },
      {
        connect: async () => ({
          connection: {} as RuntimeHostConnection,
          catalog: connectionCatalog(),
          profile: LOCAL_RUNTIME_HOST_PROFILE,
          close: async () => {},
        }),
        createContext: () => fixture.context,
      },
    );

    assert.equal(exitCode, 1);
    assert.match(stderr.join(''), /interactive permission requests are unavailable/);
    assert.deepEqual(fixture.exactTurnStops, [
      { sessionId: 'session-created', turnId: 'turn-1', runId: 'run-1' },
    ]);
  });

  test('returns exit code 1 when an ordinary Host Turn fails', async () => {
    const fixture = runFixture({ turnEvents: failedEvents('turn-1', 'provider_failure') });
    const exitCode = await runFixtureCommand(fixture, ['fail once']);

    assert.equal(exitCode, 1);
  });

  test('returns exit code 0 when the final Graph Turn completes', async () => {
    const stdout: string[] = [];
    const fixture = runFixture({ graph: true });
    const exitCode = await runFixtureCommand(fixture, ['delegate once', '--graph'], (text) =>
      stdout.push(text),
    );

    assert.equal(exitCode, 0);
    assert.equal(stdout.join(''), 'Final graph answer\n');
  });

  test('returns exit code 1 when the final Graph Turn fails', async () => {
    const fixture = runFixture({
      graph: true,
      finalMessages: failedGraphMessages('provider_failure'),
    });
    const exitCode = await runFixtureCommand(fixture, ['delegate once', '--graph']);

    assert.equal(exitCode, 1);
  });

  test('waits for Host-started graph supervisor Turns before returning', async () => {
    const observed: MakaRunOutcome[] = [];
    const fixture = runFixture({ observed, graph: true, graphProjectionRace: true });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    await collect(
      fixture.context.runtime.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'delegate',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      }),
    );
    await fixture.context.agentGraph?.waitForCompletion(session.id);

    assert.equal(observed.length, 2);
    assert.equal(observed.at(-1)?.outcomeId, 'turn-2');
    assert.equal(observed.at(-1)?.finalOutput, 'Final graph answer');
  });

  test('uses the durable Graph supervisor outcome independently of live projection', async () => {
    const observed: MakaRunOutcome[] = [];
    const fixture = runFixture({ observed, graph: true });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    await collect(
      fixture.context.runtime.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'delegate',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      }),
    );

    await fixture.context.agentGraph?.waitForCompletion(session.id);

    assert.equal(observed.at(-1)?.outcomeId, 'turn-2');
    assert.equal(observed.at(-1)?.finalOutput, 'Final graph answer');
  });

  test('reports a recovered sandbox boundary from live and durable Turns', async () => {
    const live = await observeFixtureOutcome({ turnEvents: recoveredSandboxEvents('turn-1') });
    const durable = await observeFixtureOutcome({
      graph: true,
      finalMessages: recoveredSandboxMessages(),
    });

    assert.equal(live.sandboxBoundary, 'recovered');
    assert.equal(durable.sandboxBoundary, 'recovered');
  });

  test('classifies live and durable Turn cancellations as aborted', async () => {
    const live = await observeFixtureOutcome({ turnEvents: abortedEvents('turn-1') });
    const durable = await observeFixtureOutcome({
      graph: true,
      finalMessages: abortedGraphMessages(),
    });

    assert.equal(live.failure?.class, 'aborted');
    assert.equal(durable.failure?.class, 'aborted');
  });

  test('classifies a live step limit like a durable failed Turn', async () => {
    const live = await observeFixtureOutcome({ turnEvents: stepLimitedEvents('turn-1') });
    const durable = await observeFixtureOutcome({
      graph: true,
      finalMessages: failedGraphMessages('tool_step_cap_reached'),
    });

    assert.equal(live.status, 'failed');
    assert.equal(live.failure?.class, 'tool_step_cap_reached');
    assert.equal(durable.status, 'failed');
    assert.equal(durable.failure?.class, 'tool_step_cap_reached');
  });

  test('classifies a user-stop complete event as aborted', async () => {
    const outcome = await observeFixtureOutcome({ turnEvents: userStoppedEvents('turn-1') });

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.failure?.class, 'aborted');
  });

  test('keeps a live Turn failed when complete follows its error', async () => {
    const outcome = await observeFixtureOutcome({
      turnEvents: failedThenCompleteEvents('turn-1'),
    });

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.failure?.class, 'provider_failure');
  });

  test('waits for the exact final Graph wake after an earlier wake already settled', async () => {
    const observed: MakaRunOutcome[] = [];
    const fixture = runFixture({ observed, graph: true, graphMultiWakeRace: true });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    await collect(
      fixture.context.runtime.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'delegate twice',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      }),
    );

    await fixture.context.agentGraph?.waitForCompletion(session.id);

    assert.equal(observed.at(-1)?.outcomeId, 'turn-3');
    assert.equal(observed.at(-1)?.finalOutput, 'Final wake answer');
  });

  test('releases a pending Graph durable-terminal wait when the context closes', async () => {
    const finalRead = deferred<void>();
    const fixture = runFixture({
      graph: true,
      graphProjectionNeverCompletes: true,
      onFinalGraphRead: () => finalRead.resolve(),
    });
    const context = fixture.context;
    const session = await context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    await collect(
      context.runtime.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'delegate',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      }),
    );
    const waiting = context.agentGraph?.waitForCompletion(session.id);
    assert.ok(waiting);
    await finalRead.promise;
    await new Promise((resolve) => setImmediate(resolve));

    await context.close();

    await assert.rejects(waiting, new Error('Runtime Host run context closed'));
  });

  test('does not reuse a historical Graph outcome when this execution has no successor', async () => {
    const observed: MakaRunOutcome[] = [];
    const historical = graphMessages();
    const fixture = runFixture({
      observed,
      graph: true,
      initialMessages: historical,
      finalMessages: historical,
    });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    await collect(
      fixture.context.runtime.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'finish without another wake',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      }),
    );

    await fixture.context.agentGraph?.waitForCompletion(session.id);

    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.finalOutput, 'Host answer');
  });

  test('applies the requested step cap through the Host turn', async () => {
    const fixture = runFixture({ maxSteps: 3 });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    await collect(
      fixture.context.runtime.sendMessage(session.id, {
        turnId: 'turn-with-step-cap',
        text: 'answer within the cap',
      }),
    );

    assert.deepEqual(fixture.preparedMaxSteps, [3]);
  });

  test('never selects a discovered model that the Host has not enabled', () => {
    const catalog = {
      revision: 1,
      defaultTarget: null,
      connections: [
        {
          connectionId: 'connection-1',
          revision: 1,
          slug: 'openai-main',
          name: 'OpenAI',
          providerType: 'openai' as const,
          enabled: true,
          enabledModelIds: ['gpt-5'],
          models: [{ id: 'gpt-5' }, { id: 'gpt-6-preview' }],
        },
      ],
    };

    assert.equal(
      resolveRuntimeHostCliTarget(catalog, { connectionSlug: 'openai-main' }).model,
      'gpt-5',
    );
    assert.throws(
      () =>
        resolveRuntimeHostCliTarget(catalog, {
          connectionSlug: 'openai-main',
          model: 'gpt-6-preview',
        }),
      new Error('Runtime Host model is unavailable for openai-main: gpt-6-preview'),
    );
  });

  test('stops both the active Host Turn and its Graph on cancellation', async () => {
    const fixture = runFixture({ graph: true });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    await fixture.context.runtime.stopSession(session.id);

    assert.equal(fixture.turnStops, 1);
    assert.deepEqual(fixture.graphStops, [session.id]);
  });

  test('stops a Turn that starts after cancellation was requested', async () => {
    const prepareGate = deferred<void>();
    const prepareStarted = deferred<void>();
    const fixture = runFixture({
      graph: true,
      prepareGate: prepareGate.promise,
      onPrepareStarted: () => prepareStarted.resolve(),
    });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    const sending = collect(
      fixture.context.runtime.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'answer once',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      }),
    );
    await prepareStarted.promise;

    await fixture.context.runtime.stopSession(session.id);
    prepareGate.resolve();
    await sending;

    assert.deepEqual(fixture.exactTurnStops, [
      { sessionId: session.id, turnId: 'turn-1', runId: 'run-1' },
    ]);
    assert.deepEqual(fixture.graphStops, [session.id, session.id]);
  });

  test('fails and stops instead of waiting for an interactive question', async () => {
    const fixture = runFixture({
      turnEvents: questionEvents('turn-1'),
      pendingInteractions: [pendingQuestion('turn-1')],
      pendingAfterTurnStarts: true,
    });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    await assert.rejects(
      collect(
        fixture.context.runtime.sendMessage(session.id, {
          turnId: 'turn-1',
          text: 'ask me something',
        }),
      ),
      new Error('interactive user questions are unavailable in non-interactive mode'),
    );
    assert.deepEqual(fixture.exactTurnStops, [
      { sessionId: session.id, turnId: 'turn-1', runId: 'run-1' },
    ]);
  });

  test('stops Graph Mode when a successor waits for an interactive question', async () => {
    const fixture = runFixture({
      graph: true,
      pendingInteractions: [pendingQuestion('turn-2')],
    });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    const graph = fixture.context.agentGraph;
    assert.ok(graph);
    await assert.rejects(
      graph.waitForCompletion(session.id),
      new Error('interactive user questions are unavailable in non-interactive mode'),
    );
    assert.deepEqual(fixture.graphStops, [session.id]);
  });

  test('preserves the interaction error when Graph stop races an in-flight query', async () => {
    const queryStarted = deferred<void>();
    const queryGate = deferred<void>();
    const graphStopped = deferred<void>();
    const fixture = runFixture({
      graph: true,
      graphQueryGate: queryGate.promise,
      graphQueryStatus: 'stopped',
      onGraphQueryStarted: () => queryStarted.resolve(),
      onGraphStop: () => graphStopped.resolve(),
    });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });
    const waiting = fixture.context.agentGraph?.waitForCompletion(session.id);
    assert.ok(waiting);
    await queryStarted.promise;

    fixture.publishPendingInteraction(pendingQuestion('turn-2'));
    await graphStopped.promise;
    queryGate.resolve();

    await assert.rejects(
      waiting,
      new Error('interactive user questions are unavailable in non-interactive mode'),
    );
  });

  test('denies a Graph successor sandbox expansion in non-interactive mode', async () => {
    const fixture = runFixture({
      graph: true,
      pendingInteractions: [
        {
          schemaVersion: 1,
          sessionId: 'session-created',
          turnId: 'turn-2',
          runId: 'run-2',
          interactionId: 'boundary-1',
          revision: 1,
          status: 'pending',
          outcome: null,
          request: {
            kind: 'sandbox_boundary',
            justification: 'Needs broader access',
            expansion: {
              filesystem: {
                entries: [{ path: '/outside', access: 'read', scope: 'subtree' }],
              },
            },
          },
        },
      ],
    });
    const session = await fixture.context.runtime.createSession({
      cwd: '/workspace',
      llmConnectionSlug: 'openai-main',
      model: 'gpt-5',
      permissionMode: 'ask',
    });

    await fixture.context.agentGraph?.waitForCompletion(session.id);

    assert.deepEqual(fixture.sandboxResponses, [{ requestId: 'boundary-1', decision: 'deny' }]);
  });
});

function publicCommandContext(input: MakaRunContextInput, onCreate: () => void = () => {}) {
  return {
    runtime: {
      createSession: async () => {
        onCreate();
        return sessionSummary('session-public');
      },
      readExecutionBoundary: async () => ({
        kind: 'managed' as const,
        access: 'writable' as const,
        revision: 0,
      }),
      sendMessage: async function* (_sessionId: string, message: { turnId: string }) {
        yield* eventsFor(message.turnId, 'Host answer');
        await input.runOutcomeObserver?.({
          outcomeId: 'run-public',
          status: 'completed',
          finalOutput: 'Host answer',
          sandboxBoundary: 'none',
        });
      },
      respondToSandboxBoundary: async () => {},
      stopSession: async () => {},
      setExecutionBoundaryKind: async () => {},
    },
    target: { connection: { slug: 'openai-main' }, model: 'gpt-5' },
    close: async () => {},
  };
}

function runFixture(input: {
  observed?: MakaRunOutcome[];
  graph?: boolean;
  maxSteps?: number;
  prepareGate?: Promise<void>;
  onPrepareStarted?: () => void;
  turnEvents?: AsyncIterable<SessionEvent>;
  pendingInteractions?: InteractionPendingSnapshot[];
  pendingAfterTurnStarts?: boolean;
  graphProjectionRace?: boolean;
  graphMultiWakeRace?: boolean;
  graphProjectionNeverCompletes?: boolean;
  onFinalGraphRead?: () => void;
  sessionCwdOverride?: { sessionId: string; cwd: string };
  switchSummaryCwd?: string;
  graphQueryGate?: Promise<void>;
  graphQueryStatus?: 'completed' | 'stopped';
  onGraphQueryStarted?: () => void;
  onGraphStop?: () => void;
  initialMessages?: StoredMessage[];
  finalMessages?: StoredMessage[];
}) {
  const switches: string[] = [];
  const moves: string[] = [];
  const graphStops: string[] = [];
  const exactTurnStops: { sessionId: string; turnId: string; runId: string }[] = [];
  const sandboxResponses: { requestId: string; decision: 'deny' }[] = [];
  let turnStops = 0;
  const pendingInteractionListeners = new Set<(pending: InteractionPendingSnapshot) => void>();
  const transcriptListeners = new Set<
    (sessionId: string, turnId: string, messages: StoredMessage[]) => void
  >();
  let messageReads = 0;
  const preparedMaxSteps: Array<number | undefined> = [];
  const driver = {
    createSession: async () => sessionSummary('session-created'),
    readMessages: async () => {
      messageReads += 1;
      if (messageReads === 1) {
        if (input.graphMultiWakeRace) {
          queueMicrotask(() => {
            for (const listener of transcriptListeners) {
              listener('session-created', 'turn-2', structuredClone(graphMessages()));
            }
          });
        }
        return structuredClone(input.initialMessages ?? []);
      }
      if (input.graphMultiWakeRace) {
        queueMicrotask(() => {
          const terminal = multiWakeGraphMessages(true);
          for (const listener of transcriptListeners) {
            listener('session-created', 'turn-3', structuredClone(terminal));
          }
        });
        return multiWakeGraphMessages(false);
      }
      if (input.graphProjectionNeverCompletes) {
        input.onFinalGraphRead?.();
        return graphMessages(false);
      }
      const messages = input.finalMessages ?? graphMessages();
      if (input.graphProjectionRace) {
        queueMicrotask(() => {
          for (const listener of transcriptListeners) {
            listener('session-created', 'turn-2', structuredClone(messages));
          }
        });
        return graphMessages(false);
      }
      return structuredClone(messages);
    },
    listPendingInteractions: () => input.pendingInteractions ?? [],
    subscribePendingInteractions: (listener: (pending: InteractionPendingSnapshot) => void) => {
      pendingInteractionListeners.add(listener);
      if (!input.pendingAfterTurnStarts) {
        for (const pending of input.pendingInteractions ?? []) {
          queueMicrotask(() => listener(structuredClone(pending)));
        }
      }
      return () => pendingInteractionListeners.delete(listener);
    },
    switchSession: async (sessionId: string) => {
      switches.push(sessionId);
      return {
        summary: { ...sessionSummary(sessionId), cwd: input.switchSummaryCwd ?? '/workspace' },
        messages: [],
      };
    },
    moveSession: async (cwd: string) => {
      moves.push(cwd);
      return {
        previousCwd: input.switchSummaryCwd ?? '/workspace',
        cwd,
        changed: true,
        oldCwdDirty: false,
      };
    },
    preparePrompt: async (
      _prompt: string,
      options: { turnId?: string; maxSteps?: number } = {},
    ) => {
      preparedMaxSteps.push(options.maxSteps);
      input.onPrepareStarted?.();
      await input.prepareGate;
      const events = input.turnEvents ?? eventsFor(options.turnId ?? 'turn-1', 'Host answer');
      return {
        sessionId: switches.at(-1) ?? 'session-created',
        turnId: options.turnId ?? 'turn-1',
        runId: 'run-1',
        events: input.pendingAfterTurnStarts
          ? eventsAfterPendingNotification(
              events,
              pendingInteractionListeners,
              input.pendingInteractions ?? [],
            )
          : events,
      };
    },
    respondToSandboxBoundary: async (response: { requestId: string; decision: 'deny' }) => {
      sandboxResponses.push(response);
    },
    setPermissionMode: async () => {},
    stop: async () => {
      turnStops += 1;
    },
    subscribeStartedTurns: () => () => {},
    subscribeTranscriptReplacements: (
      listener: (sessionId: string, turnId: string, messages: StoredMessage[]) => void,
    ) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
  } as unknown as RuntimeHostMakaSessionDriver;
  const connection = {
    hostEpoch: 'host-1',
    request: async (operation: string, requestInput: Record<string, unknown>) => {
      if (operation === 'session.execution_boundary.query') {
        return { kind: 'managed', access: 'writable', revision: 0 };
      }
      if (operation === 'agent.graph.query') {
        input.onGraphQueryStarted?.();
        await input.graphQueryGate;
        return { status: input.graphQueryStatus ?? 'completed' };
      }
      if (operation === 'agent.graph.stop') {
        graphStops.push(String(requestInput.rootSessionId));
        input.onGraphStop?.();
        return { rootSessionId: requestInput.rootSessionId, graphId: 'graph-1' };
      }
      if (operation === 'turn.stop') {
        exactTurnStops.push({
          sessionId: String(requestInput.sessionId),
          turnId: String(requestInput.turnId),
          runId: String(requestInput.runId),
        });
        return { kind: 'stopped' };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
  } as unknown as RuntimeHostConnection;
  const createContext = (contextInput: MakaRunContextInput) =>
    createRuntimeHostRunContext(connection, connectionCatalog(), contextInput, {
      createDriver: () => driver,
    });
  let create = () =>
    createContext({
      workspaceRoot: '/data',
      cwd: '/workspace',
      ...(input.graph ? { enableAgentGraph: true } : {}),
      ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
      ...(input.sessionCwdOverride ? { sessionCwdOverride: input.sessionCwdOverride } : {}),
      ...(input.observed
        ? {
            runOutcomeObserver: (result: MakaRunOutcome) => {
              input.observed?.push(result);
            },
          }
        : {}),
    });
  return {
    get context() {
      const context = create();
      create = () => context;
      return context;
    },
    switches,
    moves,
    graphStops,
    exactTurnStops,
    preparedMaxSteps,
    sandboxResponses,
    createContext,
    publishPendingInteraction(pending: InteractionPendingSnapshot) {
      for (const listener of pendingInteractionListeners) listener(structuredClone(pending));
    },
    get turnStops() {
      return turnStops;
    },
  };
}

async function observeFixtureOutcome(
  input: Parameters<typeof runFixture>[0],
): Promise<MakaRunOutcome> {
  const observed: MakaRunOutcome[] = [];
  const fixture = runFixture({ ...input, observed });
  const session = await fixture.context.runtime.createSession({
    cwd: '/workspace',
    llmConnectionSlug: 'openai-main',
    model: 'gpt-5',
    permissionMode: 'ask',
  });
  await collect(
    fixture.context.runtime.sendMessage(session.id, {
      turnId: 'turn-1',
      text: 'observe outcome',
      ...(input.graph
        ? { turnOrchestration: { mode: 'graph' as const, source: 'host_api' as const } }
        : {}),
    }),
  );
  if (input.graph) await fixture.context.agentGraph?.waitForCompletion(session.id);
  const outcome = observed.at(-1);
  assert.ok(outcome);
  return outcome;
}

function runFixtureCommand(
  fixture: ReturnType<typeof runFixture>,
  argv: readonly string[],
  writeStdout: (text: string) => void = () => {},
): Promise<number> {
  return runRuntimeHostTextCli(
    argv,
    { ...publicCommandEnvironment(), writeStdout },
    {
      connect: async () => ({
        connection: readinessConnection(),
        catalog: connectionCatalog(),
        profile: LOCAL_RUNTIME_HOST_PROFILE,
        close: async () => {},
      }),
      createContext: (_connection, _catalog, input) => fixture.createContext(input),
    },
  );
}

function publicCommandEnvironment() {
  return {
    workspaceRoot: () => '/runtime-host-data',
    processCwd: () => process.cwd(),
    stdinIsTTY: () => true,
    readStdin: async () => '',
    writeStdout: () => {},
    writeStderr: () => {},
    onSigint: () => () => {},
    newId: () => 'turn-1',
  };
}

function connectionCatalog() {
  return {
    revision: 1,
    defaultTarget: { connectionId: 'connection-1', modelId: 'gpt-5' },
    connections: [
      {
        connectionId: 'connection-1',
        revision: 1,
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai' as const,
        enabled: true,
        enabledModelIds: ['gpt-5'],
        models: [{ id: 'gpt-5' }],
      },
    ],
  };
}

function readinessConnection(): RuntimeHostConnection {
  return {
    request: async (operation: string) => {
      if (operation !== 'credential.vault.query') {
        throw new Error(`Unexpected readiness operation: ${operation}`);
      }
      return {
        kind: 'status',
        status: {
          locator: { scope: 'connection', connectionId: 'connection-1', kind: 'api_key' },
          configured: true,
          credentialId: 'credential-1',
          revision: 1,
          updatedAt: 1,
        },
      };
    },
  } as unknown as RuntimeHostConnection;
}

function remoteReadinessConnection(): RuntimeHostConnection {
  return {
    request: async (operation: string) => {
      if (operation === 'session.catalog.query') {
        return {
          kind: 'page',
          revision: 1,
          nextCursor: null,
          sessions: [sessionProjection('session-existing')],
        };
      }
      if (operation === 'project.catalog.query') {
        return {
          kind: 'page',
          view: 'summary',
          revision: `sha256:${'1'.repeat(64)}`,
          projectCount: 1,
          items: [
            {
              kind: 'project',
              projectIndex: 0,
              id: 'project-1',
              name: 'Project',
              aliasCount: 1,
              locationCount: 1,
              preferredLocationIndex: 0,
              archivedAt: null,
              available: true,
            },
            {
              kind: 'alias',
              projectIndex: 0,
              itemIndex: 0,
              alias: 'project-old',
            },
          ],
          nextCursor: null,
        };
      }
      if (operation === 'credential.vault.query') {
        return {
          kind: 'status',
          status: {
            locator: { scope: 'connection', connectionId: 'connection-1', kind: 'api_key' },
            configured: true,
            credentialId: 'credential-1',
            revision: 1,
            updatedAt: 1,
          },
        };
      }
      throw new Error(`Unexpected readiness operation: ${operation}`);
    },
  } as unknown as RuntimeHostConnection;
}

async function* questionEvents(turnId: string): AsyncIterable<SessionEvent> {
  yield {
    type: 'user_question_request',
    id: `${turnId}-question`,
    turnId,
    ts: 1,
    requestId: 'question-1',
    toolUseId: 'tool-1',
    questions: [
      {
        question: 'Choose one',
        options: [{ label: 'One' }, { label: 'Two' }],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function pendingQuestion(turnId: string): InteractionPendingSnapshot {
  return {
    schemaVersion: 1,
    interactionId: 'interaction-1',
    sessionId: 'session-created',
    turnId,
    runId: turnId === 'turn-1' ? 'run-1' : 'run-2',
    revision: 1,
    status: 'pending',
    outcome: null,
    request: {
      kind: 'question',
      toolUseId: 'tool-question',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    },
  };
}

function pendingPermission(turnId: string): InteractionPendingSnapshot {
  return {
    schemaVersion: 1,
    interactionId: 'permission-1',
    sessionId: 'session-created',
    turnId,
    runId: 'run-1',
    revision: 1,
    status: 'pending',
    outcome: null,
    request: {
      kind: 'permission',
      toolUseId: 'tool-permission',
      prompt: {
        kind: 'tool_permission',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        review: { kind: 'command', command: 'echo protected', cwd: '/workspace' },
        rememberForTurnAllowed: true,
      },
    },
  };
}

function graphMessages(includeTerminal = true): StoredMessage[] {
  const messages: StoredMessage[] = [
    {
      type: 'user',
      id: 'user-turn-2',
      turnId: 'turn-2',
      ts: 3,
      text: 'Graph wake',
      origin: {
        kind: 'agent_graph',
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
      },
    },
    {
      type: 'assistant',
      id: 'assistant-turn-2',
      turnId: 'turn-2',
      ts: 4,
      text: 'Final graph answer',
      modelId: 'gpt-5',
    },
  ];
  if (includeTerminal) {
    messages.push({
      type: 'turn_state',
      id: 'state-turn-2',
      turnId: 'turn-2',
      ts: 5,
      status: 'completed',
      partialOutputRetained: false,
    });
  }
  return messages;
}

function recoveredSandboxMessages(): StoredMessage[] {
  return [
    ...graphMessages(false),
    sandboxFailureToolResult('turn-2', 5),
    successfulToolResult('turn-2', 6),
    {
      type: 'turn_state',
      id: 'state-turn-2',
      turnId: 'turn-2',
      ts: 7,
      status: 'completed',
      partialOutputRetained: true,
    },
  ];
}

function abortedGraphMessages(): StoredMessage[] {
  return [
    ...graphMessages(false),
    {
      type: 'turn_state',
      id: 'state-turn-2',
      turnId: 'turn-2',
      ts: 5,
      status: 'aborted',
      abortSource: 'user_interrupt',
      partialOutputRetained: true,
    },
  ];
}

function failedGraphMessages(errorClass: string): StoredMessage[] {
  return [
    ...graphMessages(false),
    {
      type: 'turn_state',
      id: 'state-turn-2',
      turnId: 'turn-2',
      ts: 5,
      status: 'failed',
      errorClass,
      partialOutputRetained: true,
    },
  ];
}

function multiWakeGraphMessages(includeFinalTerminal: boolean): StoredMessage[] {
  const messages = [
    ...graphMessages(),
    {
      type: 'user' as const,
      id: 'user-turn-3',
      turnId: 'turn-3',
      ts: 6,
      text: 'Final Graph wake',
      origin: {
        kind: 'agent_graph' as const,
        graphId: 'graph-1',
        wakeId: 'wake-2',
        attemptId: 'attempt-2',
      },
    },
    {
      type: 'assistant' as const,
      id: 'assistant-turn-3',
      turnId: 'turn-3',
      ts: 7,
      text: 'Final wake answer',
      modelId: 'gpt-5',
    },
  ];
  if (includeFinalTerminal) {
    messages.push({
      type: 'turn_state',
      id: 'state-turn-3',
      turnId: 'turn-3',
      ts: 8,
      status: 'completed',
      partialOutputRetained: false,
    });
  }
  return messages;
}

async function* eventsFor(turnId: string, text: string): AsyncIterable<SessionEvent> {
  yield {
    type: 'text_complete',
    id: `${turnId}-text`,
    turnId,
    messageId: `${turnId}-message`,
    ts: 1,
    text,
  };
  yield { type: 'complete', id: `${turnId}-complete`, turnId, ts: 2, stopReason: 'end_turn' };
}

async function* recoveredSandboxEvents(turnId: string): AsyncIterable<SessionEvent> {
  yield sandboxFailureToolResult(turnId, 1);
  yield successfulToolResult(turnId, 2);
  yield* eventsFor(turnId, 'Recovered answer');
}

async function* abortedEvents(turnId: string): AsyncIterable<SessionEvent> {
  yield {
    type: 'abort',
    id: `${turnId}-abort`,
    turnId,
    ts: 1,
    reason: 'user_stop',
  };
}

async function* stepLimitedEvents(turnId: string): AsyncIterable<SessionEvent> {
  yield {
    type: 'text_complete',
    id: `${turnId}-text`,
    turnId,
    messageId: `${turnId}-message`,
    ts: 1,
    text: 'Partial answer',
  };
  yield {
    type: 'complete',
    id: `${turnId}-complete`,
    turnId,
    ts: 2,
    stopReason: 'step_limit',
  };
}

async function* userStoppedEvents(turnId: string): AsyncIterable<SessionEvent> {
  yield {
    type: 'complete',
    id: `${turnId}-complete`,
    turnId,
    ts: 1,
    stopReason: 'user_stop',
  };
}

async function* failedEvents(turnId: string, reason: string): AsyncIterable<SessionEvent> {
  yield {
    type: 'error',
    id: `${turnId}-error`,
    turnId,
    ts: 1,
    recoverable: false,
    reason,
    message: 'Turn failed',
  };
}

async function* failedThenCompleteEvents(turnId: string): AsyncIterable<SessionEvent> {
  yield* failedEvents(turnId, 'provider_failure');
  yield {
    type: 'complete',
    id: `${turnId}-complete`,
    turnId,
    ts: 2,
    stopReason: 'end_turn',
  };
}

type SharedToolResult = Extract<SessionEvent, { type: 'tool_result' }> &
  Extract<StoredMessage, { type: 'tool_result' }>;

function sandboxFailureToolResult(turnId: string, ts: number): SharedToolResult {
  return {
    type: 'tool_result',
    id: `${turnId}-sandbox-failure`,
    turnId,
    ts,
    toolUseId: 'tool-1',
    isError: true,
    content: sandboxFailureContent(),
  };
}

function successfulToolResult(turnId: string, ts: number): SharedToolResult {
  return {
    type: 'tool_result',
    id: `${turnId}-tool-success`,
    turnId,
    ts,
    toolUseId: 'tool-2',
    isError: false,
    content: { kind: 'text', text: 'ok' },
  };
}

function sandboxFailureContent() {
  return {
    kind: 'text' as const,
    text: 'Write requires an approved sandbox boundary expansion.',
    sandboxFailure: {
      reason: 'sandbox_boundary_required' as const,
      requiredExpansion: {
        filesystem: {
          entries: [{ path: '/outside', access: 'write' as const, scope: 'subtree' as const }],
        },
      },
    },
  };
}

async function* eventsAfterPendingNotification(
  events: AsyncIterable<SessionEvent>,
  listeners: ReadonlySet<(pending: InteractionPendingSnapshot) => void>,
  pending: readonly InteractionPendingSnapshot[],
): AsyncIterable<SessionEvent> {
  let notified = false;
  for await (const event of events) {
    if (!notified) {
      notified = true;
      for (const interaction of pending) {
        for (const listener of listeners) listener(structuredClone(interaction));
      }
    }
    yield event;
  }
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function sessionProjection(id: string): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Run once',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function sessionSummary(id: string): SessionSummary {
  return {
    id,
    cwd: '/workspace',
    name: 'Run once',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
