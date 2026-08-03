import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import {
  createConnectionStore,
  createFileCredentialStore,
  createSessionStore,
  createSqliteShellRunStore,
} from '@maka/storage';
import {
  BackendRegistry,
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  AGENT_SWARM_TOOL_NAME,
  AGENT_TOOL_GROUP_ID,
  GOAL_CLEAR_TOOL_NAME,
  GOAL_PAUSE_TOOL_NAME,
  GOAL_RESUME_TOOL_NAME,
  GOAL_SET_TOOL_NAME,
  GOAL_STATUS_TOOL_NAME,
  IMPLEMENTATION_AGENT_ID,
  UPDATE_AGENT_GRAPH_TOOL_NAME,
  VIEW_AGENT_GRAPH_TOOL_NAME,
  YIELD_AGENT_GRAPH_TOOL_NAME,
  type AiSdkBackendInput,
  type MakaTool,
  type SessionStore,
  type ShellRunUpdate,
} from '@maka/runtime';
import {
  createMakaCliRuntimeContext,
  getOrCreateCliClaudeDeviceId,
  isMakaClaudeSubscriptionCloakEnabled,
  resolveCliStreamConnectTimeoutMs,
} from '../runtime-bootstrap.js';

function modelCallAttemptFixture(): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'history_compact',
    providerId: 'ollama',
    modelId: 'llama3.2',
    startedAt: 1,
    completedAt: 2,
    latencyMs: 1,
    status: 'completed',
    usageBasis: 'missing',
    costBasis: 'unpriced',
  };
}

describe('Maka CLI runtime bootstrap', () => {
  test('parses the CLI stream connect timeout override', () => {
    assert.equal(resolveCliStreamConnectTimeoutMs({}), undefined);
    assert.equal(
      resolveCliStreamConnectTimeoutMs({ MAKA_STREAM_CONNECT_TIMEOUT_MS: '120000' }),
      120_000,
    );
    assert.throws(
      () => resolveCliStreamConnectTimeoutMs({ MAKA_STREAM_CONNECT_TIMEOUT_MS: '0' }),
      /positive integer/,
    );
    assert.throws(
      () => resolveCliStreamConnectTimeoutMs({ MAKA_STREAM_CONNECT_TIMEOUT_MS: 'later' }),
      /positive integer/,
    );
  });

  test('forwards generated title notifications to the TUI host', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const onSessionTitleChanged = (_sessionId: string): void => {};

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
        onSessionTitleChanged,
      });
      try {
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        assert.equal(runtimeDeps.onSessionTitleChanged, onSessionTitleChanged);
      } finally {
        await context.close();
      }
    });
  });

  test('routes activation resume lifecycle diagnostics to stderr', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'activation',
        workspaceRoot,
        cwd: workspaceRoot,
      });
      const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
      const info: unknown[] = [];
      const error: unknown[] = [];
      const originalInfo = console.info;
      const originalError = console.error;
      console.info = (...args: unknown[]) => info.push(args);
      console.error = (...args: unknown[]) => error.push(args);
      try {
        runtimeDeps.onContinuationLifecycleEvent?.({ type: 'plan_approved' });
        assert.equal(info.length, 0);
        assert.equal(error.length, 1);
      } finally {
        console.info = originalInfo;
        console.error = originalError;
        await context.close();
      }
    });
  });

  test('loads the default connection and can create an ai-sdk session', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
      });
      const session = await context.runtime.createSession({
        cwd: context.cwd,
        backend: 'ai-sdk',
        llmConnectionSlug: context.target.connection.slug,
        model: context.target.model,
        permissionMode: 'bypass',
        name: 'hello',
      });

      assert.equal(context.target.connection.slug, 'local');
      assert.equal(context.target.model, 'llama3.2');
      assert.equal(session.backend, 'ai-sdk');
      assert.equal(session.llmConnectionSlug, 'local');
      assert.equal(session.permissionMode, 'bypass');
    });
  });

  test('treats child tools and prompt from BackendFactoryContext as hard boundaries', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
      });
      try {
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'explore',
          name: 'scoped-child',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const scopedTool: MakaTool = {
          name: 'ReadOnlyProbe',
          description: 'Read-only test probe',
          parameters: {},
          impl: () => 'ok',
        };
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
          tools: [scopedTool],
          systemPrompt: 'Durable child prompt.',
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.deepEqual(
          backendInput.tools.map((tool) => tool.name),
          ['ReadOnlyProbe'],
        );
        assert.equal(backendInput.systemPrompt, 'Durable child prompt.');
        assert.deepEqual(backendInput.toolAvailability, {
          economy: !process.env.MAKA_DISABLE_DEFERRED_TOOLS,
          groups: [],
        });
        assert.equal(backendInput.spawnChildAgent, undefined);
        assert.equal(backendInput.spawnChildSession, undefined);
      } finally {
        await context.close();
      }
    });
  });

  test('forwards the canonical metering sink from the backend context', async () => {
    // The CLI factory used to wire capture and attempt diagnostics but not the
    // canonical sink, so `/compact` and ordinary sends produced no
    // `ModelCallAttempt` at all — the kernel offered one and nothing took it.
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
      });
      try {
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'explore',
          name: 'metering-sink',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const recorded: ModelCallAttempt[] = [];
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
          recordModelCallAttempt: (attempt: ModelCallAttempt) => {
            recorded.push(attempt);
            return Promise.resolve();
          },
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(
          typeof backendInput.recordModelCallAttempt,
          'function',
          'the composition must pass the sink the kernel offers',
        );
        await backendInput.recordModelCallAttempt?.(modelCallAttemptFixture());
        assert.equal(recorded.length, 1, 'and it must reach the context, not a local stub');
        assert.equal(recorded[0]?.callKind, 'history_compact');
      } finally {
        await context.close();
      }
    });
  });

  test('uses an explicit connection and forwards one-shot limits and invocation results', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'default-local',
        name: 'Default local',
        providerType: 'ollama',
        defaultModel: 'default-model',
      });
      await connectionStore.create({
        slug: 'selected-local',
        name: 'Selected local',
        providerType: 'ollama',
        defaultModel: 'selected-model',
      });
      await connectionStore.update('selected-local', {
        // Requested model must be user-enabled; discovered catalog alone is not enough.
        enabledModelIds: ['selected-model', 'requested-model'],
        models: [
          { id: 'selected-model' },
          { id: 'requested-model', capabilities: { vision: true } },
        ],
      });
      const observed: unknown[] = [];
      const observer = (result: unknown): void => {
        observed.push(result);
      };
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
        requestedConnectionSlug: 'selected-local',
        requestedModel: 'requested-model',
        maxSteps: 3,
        runtimeInvocationObserver: observer,
      });
      try {
        assert.equal(context.target.connection.slug, 'selected-local');
        assert.equal(context.target.model, 'requested-model');
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'explore',
          name: 'one-shot',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.maxSteps, 3);
        assert.equal(backendInput.supportsVision, true);
        assert.equal(typeof backendInput.readAttachmentBytes, 'function');
        assert.equal(runtimeDeps.runtimeInvocationObserver, observer);
        assert.deepEqual(observed, []);
      } finally {
        await context.close();
      }
    });
  });

  test('uses a canonical cwd for one resumed backend without rewriting its stored header', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local',
        providerType: 'ollama',
        defaultModel: 'model-1',
      });
      const sessionStore = createSessionStore(workspaceRoot);
      const stored = await sessionStore.create({
        cwd: '/stored-link',
        backend: 'ai-sdk',
        llmConnectionSlug: 'local',
        model: 'model-1',
        permissionMode: 'explore',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/canonical-repo',
        requestedConnectionSlug: 'local',
        requestedModel: 'model-1',
        sessionCwdOverride: { sessionId: stored.id, cwd: '/canonical-repo' },
      });
      try {
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(stored.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: stored.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.header.cwd, '/canonical-repo');
        assert.equal((await sessionStore.readHeader(stored.id)).cwd, '/stored-link');
      } finally {
        await context.close();
      }
    });
  });

  test('registers Edit in the TUI runtime toolset', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
      });

      const edit = context.tools.find((tool) => tool.name === 'Edit');
      assert.ok(
        edit,
        'Edit must be registered (regression: it was once filtered out of the TUI runtime)',
      );
    });
  });

  test('registers interactive-only tools exclusively on the TUI surface', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const tui = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
        surface: 'tui',
      });
      const run = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
        surface: 'run',
      });
      try {
        const tool = tui.tools.find((candidate) => candidate.name === 'AskUserQuestion');
        assert.ok(tool);
        assert.equal(
          run.tools.some((candidate) => candidate.name === 'AskUserQuestion'),
          false,
        );
        const goalToolNames = [
          GOAL_SET_TOOL_NAME,
          GOAL_CLEAR_TOOL_NAME,
          GOAL_STATUS_TOOL_NAME,
          GOAL_PAUSE_TOOL_NAME,
          GOAL_RESUME_TOOL_NAME,
        ];
        assert.deepEqual(
          goalToolNames.filter((name) => tui.tools.some((candidate) => candidate.name === name)),
          goalToolNames,
        );
        assert.equal(
          run.tools.some((candidate) => goalToolNames.includes(candidate.name)),
          false,
        );
        const agentToolNames = [
          AGENT_SPAWN_TOOL_NAME,
          AGENT_LIST_TOOL_NAME,
          AGENT_OUTPUT_TOOL_NAME,
        ];
        assert.deepEqual(
          agentToolNames.filter((name) => tui.tools.some((candidate) => candidate.name === name)),
          agentToolNames,
        );
        assert.equal(
          run.tools.some((candidate) => agentToolNames.includes(candidate.name)),
          false,
        );
      } finally {
        await tui.close();
        await run.close();
      }
    });
  });

  test('composes Graph controls and worktree execution for non-interactive Graph runs', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
        surface: 'run',
        enableAgentGraph: true,
      });
      try {
        assert.ok(context.agentGraph);
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        assert.ok(runtimeDeps.worktreeChildExecutor);
        assert.ok(runtimeDeps.childTools?.length);

        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'execute',
          name: 'cli-graph',
        });
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;
        const names = backendInput.tools.map((tool) => tool.name);

        assert.ok(names.includes('view_agent_graph'));
        assert.ok(names.includes('update_agent_graph'));
        assert.ok(names.includes(AGENT_OUTPUT_TOOL_NAME));
        assert.ok(backendInput.runtimeCommitSink);
      } finally {
        await context.close();
      }
    });
  });

  test('wires TUI subagent capabilities and a profile-filtered child tool surface', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
      });
      try {
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(typeof backendInput.spawnChildAgent, 'function');
        assert.equal(typeof backendInput.spawnChildSession, 'function');
        assert.equal(typeof backendInput.retryChildAgent, 'function');
        assert.equal(typeof backendInput.listChildAgents, 'function');
        assert.equal(typeof backendInput.readChildAgentOutput, 'function');
        assert.deepEqual(backendInput.toolAvailability, {
          economy: !process.env.MAKA_DISABLE_DEFERRED_TOOLS,
          groups: [
            {
              id: AGENT_TOOL_GROUP_ID,
              label: 'Agent',
              description: 'Spawn, fan out, and inspect foreground child agents.',
              toolNames: [
                AGENT_SPAWN_TOOL_NAME,
                AGENT_SWARM_TOOL_NAME,
                AGENT_LIST_TOOL_NAME,
                AGENT_OUTPUT_TOOL_NAME,
                VIEW_AGENT_GRAPH_TOOL_NAME,
                UPDATE_AGENT_GRAPH_TOOL_NAME,
                YIELD_AGENT_GRAPH_TOOL_NAME,
              ],
            },
          ],
        });
        assert.deepEqual(
          runtimeDeps.childTools?.map((tool) => tool.name),
          ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
        );
        assert.equal(
          runtimeDeps.childTools?.some((tool) =>
            [AGENT_SPAWN_TOOL_NAME, AGENT_SWARM_TOOL_NAME].includes(tool.name),
          ),
          false,
        );
        const childAgents = (await backendInput.listChildAgents?.()) as {
          definitions: Array<{
            id: string;
            availability: { status: string; reason?: string };
          }>;
        };
        assert.deepEqual(
          childAgents.definitions.find((definition) => definition.id === IMPLEMENTATION_AGENT_ID)
            ?.availability,
          { status: 'available' },
        );
        assert.equal(context.skills.host.toolNames.has(AGENT_SPAWN_TOOL_NAME), true);
        assert.equal(context.skills.host.toolNames.has(AGENT_SWARM_TOOL_NAME), true);
      } finally {
        await context.close();
      }
    });
  });

  test('registers Skill and bounded SkillSearch tools on the CLI host', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: '/repo',
      });
      try {
        const skill = context.tools.find((tool) => tool.name === 'Skill');
        assert.ok(skill, 'Skill tool must be registered on the CLI host');
        const skillSearch = context.tools.find((tool) => tool.name === 'SkillSearch');
        assert.ok(skillSearch, 'SkillSearch tool must be registered on the CLI host');
      } finally {
        await context.close();
      }
    });
  });

  test('enables background ShellRuns for the TUI runtime and cleans them up on close', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: workspaceRoot,
      });
      try {
        const names = context.tools.map((tool) => tool.name);
        assert.ok(names.includes('StopBackgroundTask'));

        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const read = context.tools.find((tool) => tool.name === 'Read');
        assert.ok(read);
        const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('start'); setTimeout(() => {}, 5000)"`;
        const result = (await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: 'session-1',
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        )) as {
          kind: string;
          ref?: string;
          status?: string;
          output?: { mode: string; stdout?: string };
        };

        assert.equal(result.kind, 'shell_run');
        assert.equal(result.status, 'running');
        assert.equal(result.output, undefined);
        assert.ok(result.ref);
        if (!result.ref) throw new Error('expected background task resource ref');
        const detail = await waitFor(async () => {
          const snapshot = (await read.impl(
            { ref: result.ref },
            {
              sessionId: 'session-1',
              runId: 'run-1',
              turnId: 'turn-1',
              cwd: workspaceRoot,
              toolCallId: 'tool-2',
              abortSignal: new AbortController().signal,
              emitOutput: () => {},
            },
          )) as {
            kind?: string;
            status?: string;
            output?: { mode: string; stdout?: string };
          };
          return snapshot.output?.stdout === 'start' ? snapshot : undefined;
        });
        assert.equal(detail.kind, 'shell_run');
        assert.equal(detail.status, 'running');
        assert.equal(detail.output?.mode, 'pipes');
        assert.equal(detail.output?.stdout, 'start');

        await context.close();
        const shellRuns = createSqliteShellRunStore(workspaceRoot);
        await shellRuns.ready();
        const record = await shellRuns.readShellRun('session-1', backgroundTaskId(result.ref));
        shellRuns.close();
        assert.equal(record.status, 'cancelled');
        assert.equal(record.exitCode, 130);
      } finally {
        await context.close();
      }
    });
  });

  test('publishes background ShellRun completion without a model resource read', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: workspaceRoot,
      });
      const updates: ShellRunUpdate[] = [];
      const unsubscribe = context.subscribeShellRunUpdates((update) => updates.push(update));
      try {
        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('start'); setTimeout(() => process.stdout.write('done'), 500)"`;
        const result = (await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: 'session-1',
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        )) as { kind?: string; status?: string };
        assert.equal(result.kind, 'shell_run');
        assert.equal(result.status, 'running');

        const terminal = await waitFor(() =>
          updates.find((update) => update.result.status === 'completed'),
        );
        assert.equal(terminal.sourceToolCallId, 'tool-1');
        assert.equal(
          terminal.result.output?.mode === 'pipes' ? terminal.result.output.stdout : '',
          'startdone',
        );
      } finally {
        unsubscribe();
        await context.close();
      }
    });
  });

  test('exposes canonical ShellRun updates through the runtime context', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: workspaceRoot,
      });
      try {
        const parent = await context.runtime.createSession({
          cwd: workspaceRoot,
          backend: 'ai-sdk',
          llmConnectionSlug: 'local',
          model: 'llama3.2',
          permissionMode: 'bypass',
          name: 'parent',
        });
        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;
        const started = (await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: parent.id,
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        )) as { kind?: string; ref?: string; status?: string };
        assert.equal(started.status, 'running');
        assert.ok(started.ref);

        const updates = await context.listShellRunUpdates(parent.id);
        const update = updates.find((candidate) => candidate.result.ref === started.ref);
        assert.deepEqual(update?.ownership, { kind: 'local' });
        assert.equal(update?.result.status, 'running');
      } finally {
        await context.close();
      }
    });
  });

  test('hydrates terminal ShellRun state without marking it observed by the agent', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        cwd: workspaceRoot,
      });
      try {
        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 500)"`;
        const started = (await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: 'session-1',
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        )) as { ref?: string; status?: string };
        assert.equal(started.status, 'running');
        assert.ok(started.ref);

        const hydrated = await waitFor(async () => {
          const updates = await context.listShellRunUpdates('session-1');
          const snapshot = updates.find((candidate) => candidate.result.ref === started.ref);
          return snapshot?.result.status === 'completed' ? snapshot : undefined;
        });
        assert.equal(hydrated.result.status, 'completed');
        const shellRuns = createSqliteShellRunStore(workspaceRoot);
        await shellRuns.ready();
        const stored = await shellRuns.readShellRun('session-1', backgroundTaskId(started.ref));
        shellRuns.close();
        assert.equal(stored.observedAt, undefined);
      } finally {
        await context.close();
      }
    });
  });

  test('passes the default context budget policy to ai-sdk backends', async () => {
    await withCleanContextBudgetEnv(async () => {
      await withWorkspace(async (workspaceRoot) => {
        const connectionStore = createConnectionStore(workspaceRoot);
        await connectionStore.create({
          slug: 'local',
          name: 'Local Ollama',
          providerType: 'ollama',
          defaultModel: 'llama3.2',
        });

        const context = await createMakaCliRuntimeContext({
          surface: 'tui',
          workspaceRoot,
          cwd: '/repo',
        });
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
          name: 'budgeted',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.contextBudget?.name, 'cli-default-history-budget');
        assert.equal(backendInput.contextBudget?.maxHistoryEstimatedTokens, 32_000);
        assert.equal(backendInput.contextBudget?.activeToolResultPrune?.enabled, true);
        // In-turn semantic compaction (the #986 experiment) is off by default in
        // the runtime, so the CLI inherits it absent without a local strip.
        // History/turn compaction stays.
        assert.equal(backendInput.contextBudget?.semanticCompact, undefined);
        assert.equal(backendInput.contextBudget?.historyCompact?.enabled, true);
        assert.equal(backendInput.contextBudget?.historyCompact?.mode, 'read_write');
        assert.equal(backendInput.contextBudget?.historyCompact?.highWaterRatio, 1);
        assert.equal(backendInput.contextBudget?.historyCompact?.tailEstimatedTokens, 16_384);
        assert.equal(backendInput.contextBudget?.historyCompact?.minRecentTurns, 3);
      });
    });
  });

  test('honors an explicit MAKA_CONTEXT_SEMANTIC_COMPACT opt-in', async () => {
    await withCleanContextBudgetEnv(async () => {
      process.env.MAKA_CONTEXT_SEMANTIC_COMPACT = 'on';
      try {
        await withWorkspace(async (workspaceRoot) => {
          const connectionStore = createConnectionStore(workspaceRoot);
          await connectionStore.create({
            slug: 'local',
            name: 'Local Ollama',
            providerType: 'ollama',
            defaultModel: 'llama3.2',
          });

          const context = await createMakaCliRuntimeContext({
            surface: 'tui',
            workspaceRoot,
            cwd: '/repo',
          });
          const session = await context.runtime.createSession({
            cwd: context.cwd,
            backend: 'ai-sdk',
            llmConnectionSlug: context.target.connection.slug,
            model: context.target.model,
            permissionMode: 'bypass',
            name: 'semantic-opt-in',
          });
          const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
          const header = await runtimeDeps.store.readHeader(session.id);
          const backend = await runtimeDeps.backends.build('ai-sdk', {
            sessionId: session.id,
            workspaceRoot,
            header,
            store: runtimeDeps.store,
          });
          const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

          // Semantic compaction is off by default, but an explicit env opt-in
          // must reach the backend so the path stays exercisable.
          assert.equal(backendInput.contextBudget?.semanticCompact?.enabled, true);
        });
      } finally {
        delete process.env.MAKA_CONTEXT_SEMANTIC_COMPACT;
      }
    });
  });

  test('keeps ordinary send policy read-write for providers without a context-window budget', async () => {
    await withCleanContextBudgetEnv(async () => {
      process.env.MAKA_CONTEXT_HISTORY_COMPACT = 'on';
      await withWorkspace(async (workspaceRoot) => {
        const connectionStore = createConnectionStore(workspaceRoot);
        await connectionStore.create({
          slug: 'deepseek',
          name: 'DeepSeek',
          providerType: 'deepseek',
          defaultModel: 'custom-deepseek-model',
        });
        const credentialStore = createFileCredentialStore(workspaceRoot);
        await credentialStore.setSecret('deepseek', 'api_key', 'test-key');

        const context = await createMakaCliRuntimeContext({
          surface: 'tui',
          workspaceRoot,
          cwd: '/repo',
        });
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
          name: 'budgeted',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.contextBudget?.maxHistoryEstimatedTokens, undefined);
        assert.equal(backendInput.contextBudget?.historyCompact?.mode, 'read_write');
        assert.equal(backendInput.contextBudget?.historyCompact?.highWaterRatio, 1);
        assert.equal(backendInput.contextBudget?.historyCompact?.tailEstimatedTokens, 16_384);
      });
    });
  });

  test('keeps Claude subscription cloaking enabled unless the emergency opt-out is set', () => {
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({}), true);
    assert.equal(
      isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '1' }),
      true,
    );
    assert.equal(
      isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '0' }),
      false,
    );
  });

  test('persists a random Claude device id instead of deriving it from the workspace path', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const pathHash = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
      const first = await getOrCreateCliClaudeDeviceId(workspaceRoot, {
        newId: () => '1'.repeat(64),
      });
      const second = await getOrCreateCliClaudeDeviceId(workspaceRoot, {
        newId: () => '2'.repeat(64),
      });

      assert.equal(first, '1'.repeat(64));
      assert.equal(second, first);
      assert.notEqual(first, pathHash);
    });
  });

  test('isolates portable state from injected config roots', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const stateRoot = join(workspaceRoot, 'state');
      const configRoot = join(workspaceRoot, 'config');
      await Promise.all([mkdir(stateRoot), mkdir(configRoot)]);

      const connectionStore = createConnectionStore(configRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const credentialStore = createFileCredentialStore(configRoot);
      await credentialStore.setSecret('local', 'api_key', 'config-secret-canary');

      const context = await createMakaCliRuntimeContext({
        surface: 'run',
        workspaceRoot,
        stateRoot,
        configRoot,
        cwd: '/repo',
      });
      try {
        assert.equal(context.workspaceRoot, workspaceRoot);
        assert.equal(context.stateRoot, stateRoot);
        assert.equal(context.configRoot, configRoot);

        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
          name: 'isolated',
        });

        await access(join(stateRoot, 'runtime.sqlite'));
        await assert.rejects(access(join(configRoot, 'runtime.sqlite')));
        await access(join(configRoot, 'llm-connections.json'));
        await access(join(configRoot, 'credentials.json'));
        await assert.rejects(access(join(stateRoot, 'credentials.json')));

        await getOrCreateCliClaudeDeviceId(configRoot, { newId: () => '3'.repeat(64) });
        await access(join(configRoot, '.maka_cli_claude_device_id'));
        await assert.rejects(access(join(stateRoot, '.maka_cli_claude_device_id')));
      } finally {
        await context.close();
      }
    });
  });

  test('routes skill tools, search, and the model catalog through the config root', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const stateRoot = join(workspaceRoot, 'state');
      const configRoot = join(workspaceRoot, 'config');
      const skillRoot = join(configRoot, 'skills', 'config-only');
      await Promise.all([mkdir(stateRoot), mkdir(skillRoot, { recursive: true })]);
      await writeFile(
        join(skillRoot, 'SKILL.md'),
        [
          '---',
          'name: Config Only',
          'description: Skill injected only through the host config root.',
          '---',
          '# Config Only',
          'Follow the config-root instructions.',
        ].join('\n'),
      );
      const connectionStore = createConnectionStore(configRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        surface: 'tui',
        workspaceRoot,
        stateRoot,
        configRoot,
        cwd: '/repo',
      });
      try {
        const toolContext = {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd: '/repo',
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        };
        const skill = context.tools.find((tool) => tool.name === 'Skill');
        assert.ok(skill);
        const loaded = (await skill.impl({ name: 'Config Only' }, toolContext)) as {
          ok: boolean;
        };
        assert.equal(loaded.ok, true);

        const skillSearch = context.tools.find((tool) => tool.name === 'SkillSearch');
        assert.ok(skillSearch);
        const searched = (await skillSearch.impl(
          { query: 'host config root', limit: 3 },
          toolContext,
        )) as { matches: Array<{ name: string }> };
        assert.equal(
          searched.matches.some((match) => match.name === 'Config Only'),
          true,
        );

        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
          name: 'config-root-skill',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot: stateRoot,
          header,
          store: runtimeDeps.store,
        });
        const systemPrompt = (backend as unknown as { input: AiSdkBackendInput }).input
          .systemPrompt;
        assert.equal(typeof systemPrompt, 'function');
        const rendered =
          typeof systemPrompt === 'function'
            ? await systemPrompt({
                sessionId: session.id,
                turnId: 'bootstrap-test-turn',
                cwd: context.cwd,
                workspaceRoot: stateRoot,
              })
            : systemPrompt;
        assert.match(rendered ?? '', /Config Only/);
      } finally {
        await context.close();
      }
    });
  });

  test('defaults both new roots to the legacy workspaceRoot', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'run',
        workspaceRoot,
        cwd: '/repo',
      });
      try {
        assert.equal(context.stateRoot, workspaceRoot);
        assert.equal(context.configRoot, workspaceRoot);
      } finally {
        await context.close();
      }
    });
  });
});

interface RuntimeWithPrivateDeps {
  deps: {
    backends: BackendRegistry;
    store: SessionStore;
    runtimeInvocationObserver?: (result: unknown) => void | Promise<void>;
    onSessionTitleChanged?: (sessionId: string) => void;
    childTools?: readonly MakaTool[];
    worktreeChildExecutor?: unknown;
    onContinuationLifecycleEvent?: (event: unknown) => void;
  };
}

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-cli-runtime-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for ShellRun state');
}

function backgroundTaskId(ref: string): string {
  const id = new URL(ref).pathname.split('/').pop();
  if (!id) throw new Error(`Invalid background task ref: ${ref}`);
  return decodeURIComponent(id);
}

async function withCleanContextBudgetEnv(fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env).filter((key) => key.startsWith('MAKA_CONTEXT_'))) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
