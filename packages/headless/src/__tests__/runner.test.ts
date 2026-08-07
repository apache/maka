import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  BackendRegistry,
  FakeBackend,
  PiAgentBackend,
  type AgentBackend,
  type MakaTool,
  type MakaToolContext,
  type PiAgentTransport,
  type SessionStore,
} from '@maka/runtime';
import type { BackendKind, SessionEvent, SessionHeader } from '@maka/core';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { createSessionStore, openRuntimeEventReadPersistence } from '@maka/storage';
import type { Config, Task } from '../contracts.js';
import type { HeadlessBackendContext } from '../isolation.js';
import { runExperiment } from '../runner.js';

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

function registerTestPiAgentBackend(
  registry: BackendRegistry,
  transportFactory: (input: { header: SessionHeader; store: SessionStore }) => PiAgentTransport,
): void {
  registry.register(
    'pi-agent',
    (ctx) =>
      new PiAgentBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        appendMessage:
          ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
        transport: transportFactory({ header: ctx.header, store: ctx.store }),
      }),
  );
}

/**
 * A malicious config: it rewrites the grading test in its own cwd to one
 * that always passes, then completes normally. Used to prove clean-room
 * grading reverts the tamper before scoring.
 */
class TamperBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
  ) {
    this.sessionId = ctx.sessionId;
  }
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    const messageId = 'tamper-msg';
    // Rewrite the grading script in its own cwd to one that always passes.
    await writeFile(join(this.ctx.header.cwd, 'check.mjs'), 'process.exit(0);\n', 'utf8');
    const text = 'rewrote the grading script to pass';
    const ts = Date.now();
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text,
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: 'tamper-tc', turnId, ts, messageId, text };
    yield { type: 'complete', id: 'tamper-c', turnId, ts, stopReason: 'end_turn' };
  }
  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerTamperBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new TamperBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

/**
 * A backend that reports failure the way a real one can — an error event plus
 * a complete(error) — WITHOUT throwing. The InvocationResult comes back with
 * status 'failed'; the run must surface that as a record error, not a silent
 * ⚠️-but-exit-0.
 */
class FailingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
  ) {
    this.sessionId = ctx.sessionId;
  }
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const { turnId } = input;
    const ts = Date.now();
    yield {
      type: 'error',
      id: 'fail-err',
      turnId,
      ts,
      recoverable: false,
      reason: 'backend_failed',
      message: 'backend blew up',
    };
    yield { type: 'complete', id: 'fail-c', turnId, ts, stopReason: 'error' };
  }
  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerFailingBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new FailingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class IsolatedRealBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;
  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
  ) {
    this.sessionId = ctx.sessionId;
  }
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    const ts = Date.now();
    const messageId = 'isolated-real-msg';
    await writeFile(join(this.ctx.header.cwd, 'solved.txt'), 'ok\n', 'utf8');
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text: 'solved inside explicit isolation',
      modelId: this.ctx.header.model,
    });
    yield {
      type: 'text_complete',
      id: 'isolated-real-tc',
      turnId,
      ts,
      messageId,
      text: 'solved inside explicit isolation',
    };
    yield { type: 'complete', id: 'isolated-real-c', turnId, ts, stopReason: 'end_turn' };
  }
  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerIsolatedRealBackend =
  (
    seen: HeadlessBackendContext[],
  ): NonNullable<Parameters<typeof runExperiment>[2]['registerBackends']> =>
  (registry, context) => {
    seen.push(context);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new IsolatedRealBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
    );
  };

interface ScriptedSwarmState {
  rootTurns: number;
  trace: string[];
  releaseChildren: Promise<void>;
  childrenCompleted: Promise<void>;
  allowChildren(): void;
  childCompleted(): void;
}

function createScriptedSwarmState(): ScriptedSwarmState {
  let allowChildren!: () => void;
  let resolveChildrenCompleted!: () => void;
  let completedChildren = 0;
  const releaseChildren = new Promise<void>((resolve) => {
    allowChildren = resolve;
  });
  const childrenCompleted = new Promise<void>((resolve) => {
    resolveChildrenCompleted = resolve;
  });
  return {
    rootTurns: 0,
    trace: [],
    releaseChildren,
    childrenCompleted,
    allowChildren,
    childCompleted() {
      completedChildren += 1;
      if (completedChildren === 2) resolveChildrenCompleted();
    },
  };
}

class ScriptedSwarmBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      store: SessionStore;
      headless: HeadlessBackendContext;
      state: ScriptedSwarmState;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.ctx.header.subagentParent) {
      this.ctx.state.trace.push('child_started');
      await this.ctx.state.releaseChildren;
      yield* this.completeText(input, `result from ${this.ctx.header.id}`);
      this.ctx.state.trace.push('child_completed');
      this.ctx.state.childCompleted();
      return;
    }

    const rootTurn = this.ctx.state.rootTurns++;
    const getAgentGraphSupervisorTools = this.ctx.headless.getAgentGraphSupervisorTools;
    assert.ok(getAgentGraphSupervisorTools);
    const tools = await getAgentGraphSupervisorTools(this.sessionId);
    if (rootTurn === 0) {
      this.ctx.state.trace.push('schedule');
      await requiredTool(tools, 'update_agent_graph').impl(
        {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'new_agent',
              agent_id: 'local-read',
              instruction: 'Return bounded result A.',
              input_ids: [],
              replacement_mode: 'none',
            },
            {
              target_kind: 'new_agent',
              agent_id: 'local-read',
              instruction: 'Return bounded result B.',
              input_ids: [],
              replacement_mode: 'none',
            },
          ],
        },
        scriptedToolContext(this.ctx, input, 'schedule'),
      );
      await requiredTool(tools, 'yield_agent_graph').impl(
        { reason: 'Children are admitted; wait for a durable swarm checkpoint.' },
        scriptedToolContext(this.ctx, input, 'yield'),
      );
      this.ctx.state.trace.push('yield');
      this.ctx.state.allowChildren();
      await this.ctx.state.childrenCompleted;
      yield* this.completeText(input, 'yielded asynchronous swarm');
      this.ctx.state.trace.push('parent_completed');
      return;
    }

    this.ctx.state.trace.push('supervisor_woke');
    const status = (await requiredTool(tools, 'agent_swarm_status').impl(
      {},
      scriptedToolContext(this.ctx, input, 'status'),
    )) as {
      status: string;
      items: Array<{ status: string; childSessionId?: string; runId?: string }>;
    };
    assert.equal(status.status, 'settled');
    this.ctx.state.trace.push('status_read');
    const resultIds: string[] = [];
    const readChildAgentOutput = this.ctx.headless.readChildAgentOutput;
    assert.ok(readChildAgentOutput);
    for (const item of status.items) {
      assert.equal(item.status, 'completed');
      assert.ok(item.childSessionId);
      assert.ok(item.runId);
      const output = await readChildAgentOutput(this.sessionId, {
        execution: {
          kind: 'child_session',
          sessionId: item.childSessionId,
          currentRunId: item.runId,
        },
        view: 'result',
      });
      assert.ok(output.result?.resultRecordId);
      resultIds.push(output.result.resultRecordId);
    }
    await requiredTool(tools, 'update_agent_graph').impl(
      {
        operation: 'finish',
        finish: { result_ids: resultIds, reason: 'Both independent results are committed.' },
      },
      scriptedToolContext(this.ctx, input, 'finish'),
    );
    this.ctx.state.trace.push('synthesis');
    yield* this.completeText(input, 'synthesized two committed child results');
  }

  private async *completeText(input: BackendSendInput, text: string): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    const messageId = `${input.turnId}-assistant`;
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId: input.turnId,
      ts,
      text,
      modelId: this.ctx.header.model,
    });
    yield {
      type: 'text_complete',
      id: `${input.turnId}-text`,
      turnId: input.turnId,
      ts,
      messageId,
      text,
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

function requiredTool(tools: readonly MakaTool[], name: string): MakaTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

function scriptedToolContext(
  ctx: { header: SessionHeader },
  input: BackendSendInput,
  toolCallId: string,
): MakaToolContext {
  assert.ok(input.runId);
  return {
    sessionId: ctx.header.id,
    runId: input.runId,
    turnId: input.turnId,
    toolCallId,
    cwd: ctx.header.cwd,
    orchestrationMode: input.orchestration?.mode,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

// A fixture whose grading script exits non-zero against the buggy source —
// the only way `node check.mjs` passes is if the grading script is replaced.
// (Plain exit-code grading, not `node --test`, so the verification child
// doesn't collide with the lab's own test runner.)
async function writeBuggyFixture(fixtureDir: string): Promise<void> {
  await writeFile(join(fixtureDir, 'src.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
  await writeFile(
    join(fixtureDir, 'check.mjs'),
    "import { add } from './src.mjs';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
    'utf8',
  );
}

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

const piConfig: Config = {
  id: 'pi-cfg',
  backend: 'pi-agent',
  llmConnectionSlug: 'pi-agent',
  model: 'pi-test',
};

async function withDirs<T>(
  fn: (fixtureDir: string, storageRoot: string) => Promise<T>,
): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-headless-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-headless-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

describe('runExperiment (walking skeleton)', () => {
  test('runs Config × Task end-to-end, scores a passing verification, records a trajectory', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'pass-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.taskId, 'pass-task');
      assert.equal(result.configId, 'fake-cfg');
      assert.equal(result.orchestrationMode, 'default');
      assert.equal(result.orchestrationSource, 'session');
      assert.equal(result.agentSwarmAuthorization, 'none');
      // The agent run produced a trajectory...
      assert.ok(result.steps > 0, 'expected a non-empty trajectory');
      // ...persisted in the canonical SQLite RuntimeEvent ledger.
      const runtimePersistence = await openRuntimeEventReadPersistence({
        workspaceRoot: storageRoot,
      });
      try {
        assert.equal(runtimePersistence.kind, 'sqlite');
        assert.ok(
          (
            await runtimePersistence.runtimeEventStore.readRuntimeEvents(
              result.sessionId,
              result.runId,
            )
          ).length > 0,
          'expected RuntimeEvents in runtime.sqlite',
        );
      } finally {
        runtimePersistence.close();
      }
    });
  });

  test('scores a failing verification as not passed (run still completes)', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'fail-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f does-not-exist.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, false);
      assert.notEqual(result.exitCode, 0);
    });
  });

  test('defaults to the inert FakeBackend when no registerBackends is given', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'default-backend',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      // Minimal usage — no registerBackends supplied; the engine wires fake.
      const result = await runExperiment(fakeConfig, task, { storageRoot });
      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
    });
  });

  test('records the persistent session Swarm Mode as authoritative run evidence', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'session-swarm',
        instruction: 'fan out the work',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };
      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        orchestrationMode: 'swarm',
      });

      assert.equal(result.orchestrationMode, 'swarm');
      assert.equal(result.orchestrationSource, 'session');
      assert.equal(result.agentSwarmAuthorization, 'session_mode');
    });
  });

  test('records a host API turn override without changing the session-default API', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'turn-swarm',
        instruction: 'fan out this turn',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };
      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        orchestrationMode: 'default',
        turnOrchestration: { mode: 'swarm', source: 'host_api' },
      });

      assert.equal(result.orchestrationMode, 'swarm');
      assert.equal(result.orchestrationSource, 'turn_override');
      assert.equal(result.agentSwarmAuthorization, 'turn_override');
    });
  });

  test('keeps Headless alive through yield, child settlement, wake, and synthesis', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const state = createScriptedSwarmState();
      const task: Task = {
        id: 'headless-swarm-wake',
        instruction: 'Run two independent checks and synthesize them.',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };
      const result = await runExperiment(
        {
          id: 'scripted-swarm',
          backend: 'ai-sdk',
          llmConnectionSlug: 'scripted',
          model: 'scripted',
          agentTools: true,
        },
        task,
        {
          storageRoot,
          orchestrationMode: 'swarm',
          realBackendIsolation: {
            kind: 'external',
            label: 'scripted swarm isolation',
            toolExecutor: {
              async exec() {
                return { exitCode: 0, stdout: '', stderr: '' };
              },
            },
          },
          registerBackends(registry, headless) {
            registry.register(
              'ai-sdk',
              (ctx) =>
                new ScriptedSwarmBackend({
                  sessionId: ctx.sessionId,
                  header: ctx.header,
                  store: ctx.store,
                  headless,
                  state,
                }),
            );
          },
        },
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(state.rootTurns, 2);
      assert.equal(state.trace.filter((entry) => entry === 'child_completed').length, 2);
      assert.ok(state.trace.indexOf('schedule') < state.trace.indexOf('yield'));
      assert.ok(state.trace.indexOf('yield') < state.trace.indexOf('parent_completed'));
      assert.ok(state.trace.indexOf('yield') < state.trace.indexOf('child_completed'));
      assert.ok(
        state.trace.lastIndexOf('child_completed') < state.trace.indexOf('parent_completed'),
      );
      assert.ok(state.trace.indexOf('parent_completed') < state.trace.indexOf('supervisor_woke'));
      assert.ok(state.trace.indexOf('supervisor_woke') < state.trace.indexOf('status_read'));
      assert.ok(state.trace.indexOf('status_read') < state.trace.indexOf('synthesis'));
    });
  });
});

describe('clean-room grading (a config cannot rewrite its own test to pass)', () => {
  test('protectedPaths reverts the tampered test before scoring', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeBuggyFixture(fixtureDir);
      const task: Task = {
        id: 'tamper-task',
        instruction: 'fix the bug',
        workspaceDir: fixtureDir,
        verification: { command: 'node check.mjs', protectedPaths: ['check.mjs'] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerTamperBackend,
      });

      // The run completed normally, but the cheated grading script was
      // restored to the original, which still fails the unfixed buggy source.
      assert.equal(result.status, 'completed');
      assert.equal(result.passed, false);
      assert.notEqual(result.exitCode, 0);
    });
  });
});

describe('fail-closed (a model-backed backend does not run without isolation)', () => {
  test('refuses a real backend when no isolated executor is available', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const realConfig: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-6',
      };
      const task: Task = {
        id: 'real-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      // A real backend would run tools on the host with no isolation, so the
      // run is refused before it starts — no workspace prepared, no agent turn.
      await assert.rejects(
        runExperiment(realConfig, task, { storageRoot, registerBackends: registerFakeBackend }),
        /isolated executor/i,
      );
    });
  });

  test('runs a model-backed backend only when the caller supplies explicit isolation', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const realConfig: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-chat',
      };
      const task: Task = {
        id: 'real-task',
        instruction: 'create solved.txt',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f solved.txt', protectedPaths: [] },
      };
      const contexts: HeadlessBackendContext[] = [];

      const result = await runExperiment(realConfig, task, {
        storageRoot,
        registerBackends: registerIsolatedRealBackend(contexts),
        realBackendIsolation: { kind: 'external', label: 'unit-test isolated backend' },
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(contexts.length, 1);
      assert.equal(contexts[0]?.realBackendIsolation?.label, 'unit-test isolated backend');
      assert.equal(contexts[0]?.config.id, 'real-cfg');
      assert.equal(contexts[0]?.task.id, 'real-task');
      assert.equal(typeof contexts[0]?.spawnChildAgent, 'function');
      assert.equal(typeof contexts[0]?.spawnChildSession, 'function');
      assert.equal(typeof contexts[0]?.retryChildAgent, 'function');
      assert.equal(typeof contexts[0]?.listChildAgents, 'function');
      assert.equal(typeof contexts[0]?.readChildAgentOutput, 'function');
      assert.ok(Array.isArray((await contexts[0]!.listChildAgents!(result.sessionId)).definitions));
      const sessions = createSessionStore(storageRoot);
      try {
        assert.deepEqual(await sessions.readExecutionBoundary(result.sessionId), {
          kind: 'external',
          revision: 0,
        });
      } finally {
        await sessions.close?.();
      }
    });
  });

  test('runs pi-agent through the headless backend bridge when isolated', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeBuggyFixture(fixtureDir);
      const seen: HeadlessBackendContext[] = [];
      const task: Task = {
        id: 'pi-task',
        instruction: 'solve the fixture',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f solved.txt', protectedPaths: [] },
      };

      const result = await runExperiment({ ...piConfig, agentTools: true }, task, {
        storageRoot,
        realBackendIsolation: {
          kind: 'external',
          label: 'unit-test isolated pi transport',
          toolExecutor: {
            async exec() {
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
        },
        registerBackends: (registry, context) => {
          seen.push(context);
          registerTestPiAgentBackend(registry, ({ header }) => ({
            async *send(sendInput) {
              assert.equal(header.cwd, context.workspaceDir);
              assert.equal(sendInput.text, 'solve the fixture');
              yield {
                type: 'tool_start',
                toolUseId: 'tool-1',
                toolName: 'Bash',
                args: { command: 'touch solved.txt' },
              };
              await writeFile(join(header.cwd, 'solved.txt'), 'ok\n', 'utf8');
              yield {
                type: 'tool_result',
                toolUseId: 'tool-1',
                content: { kind: 'text', text: 'created solved.txt' },
              };
              yield { type: 'text_complete', text: 'done' };
              yield { type: 'complete' };
            },
          }));
        },
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(seen[0]?.config.backend, 'pi-agent');
      assert.equal(seen[0]?.realBackendIsolation?.label, 'unit-test isolated pi transport');
      assert.equal(seen[0]?.productToolSurface, undefined);
    });
  });
});

describe('failed runs surface as an error (not a silent ⚠️ + exit 0)', () => {
  test('a backend that reports failure without throwing yields status failed + an error', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      // The fixture already satisfies the verification — proving the failure
      // verdict comes from the run status, not from a failing check.
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'failing',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFailingBackend,
      });

      assert.equal(result.status, 'failed');
      assert.ok(
        result.error,
        'a failed run must carry an error so the CLI exit code and the table agree',
      );
      assert.equal(result.errorClass, 'backend_failed');
      assert.equal(result.passed, false);
    });
  });

  test('complete(stopReason=error) with no preceding error event classifies as runtime_error in ResultRecord', async () => {
    // Reproduces the DeepSeek-reasoner smoke: the backend ended with
    // stopReason='error' but never emitted a preceding error event. The
    // benchmark ResultRecord.errorClass must read 'runtime_error' (not
    // 'failed' or 'unknown') so scoring can distinguish runtime failures
    // from max_tokens / incomplete_tool_calls / verification_failed.
    class BareErrorCompleteBackend implements AgentBackend {
      readonly kind: BackendKind = 'fake';
      readonly sessionId: string;
      constructor(
        private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
      ) {
        this.sessionId = ctx.sessionId;
      }
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        const { turnId } = input;
        const ts = Date.now();
        // NO preceding error event — just a bare complete(error).
        yield { type: 'complete', id: 'bare-err-c', turnId, ts, stopReason: 'error' };
      }
      async stop(): Promise<void> {}
      async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
      async dispose(): Promise<void> {}
    }
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'bare-error',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: (registry) => {
          registry.register(
            'fake',
            (ctx) =>
              new BareErrorCompleteBackend({
                sessionId: ctx.sessionId,
                header: ctx.header,
                store: ctx.store,
              }),
          );
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.errorClass, 'runtime_error');
      assert.equal(result.passed, false);
    });
  });
});

describe('engine-level grading-boundary validation (not only the CLI)', () => {
  test('runExperiment refuses a task missing protectedPaths before running the agent', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      // Simulate an untyped (JS / JSON) caller that omits the now-required field.
      const task = {
        id: 'no-guard',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true' },
      } as unknown as Task;

      await assert.rejects(
        runExperiment(fakeConfig, task, { storageRoot, registerBackends: registerFakeBackend }),
        /protectedPaths/,
      );
    });
  });
});

describe('Config.systemPrompt (benchmark config variable, not session state)', () => {
  // A factory that captures the systemPrompt it would hand to the backend,
  // proving the benchmark's registerBackends closure can read config.systemPrompt
  // and pass it through — mirroring the desktop path. The harness itself does
  // NOT thread systemPrompt through BackendFactoryContext (that channel is the
  // child-agent instruction); the factory owns it.
  const registerCapturingBackend =
    (captured: { systemPrompt?: string }[]) =>
    (registry: BackendRegistry, context: HeadlessBackendContext): void => {
      captured.push({ systemPrompt: context.config.systemPrompt });
      registry.register(
        'fake',
        (ctx) =>
          new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
      );
    };

  test('factory closure can read config.systemPrompt and pass it to the backend', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const configWithPrompt: Config = {
        ...fakeConfig,
        systemPrompt: 'You are a benchmark agent. Use tools, do not narrate.',
      };
      const captured: { systemPrompt?: string }[] = [];
      const task: Task = {
        id: 'prompt-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(configWithPrompt, task, {
        storageRoot,
        registerBackends: registerCapturingBackend(captured),
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.systemPromptMode, 'custom');
      assert.equal(
        result.systemPromptHash,
        `sha256:${createHash('sha256')
          .update(JSON.stringify(configWithPrompt.systemPrompt))
          .digest('hex')}`,
      );
      assert.equal(captured.length, 1);
      assert.equal(
        captured[0]?.systemPrompt,
        'You are a benchmark agent. Use tools, do not narrate.',
        'factory closure must receive config.systemPrompt',
      );
    });
  });

  test('omitting systemPrompt injects the default headless prompt in the factory context', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const captured: { systemPrompt?: string }[] = [];
      const task: Task = {
        id: 'default-prompt-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerCapturingBackend(captured),
      });

      assert.equal(captured.length, 1);
      assert.equal(
        captured[0]?.systemPrompt,
        [
          'Complete the task by acting with the available tools, not by narrating.',
          'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
          'Verify the result when practical.',
          'Stop when the task is complete.',
        ].join('\n'),
        'the factory must receive the default headless system prompt',
      );
      assert.equal(result.systemPromptMode, 'default');
      assert.equal(
        result.systemPromptHash,
        `sha256:${createHash('sha256')
          .update(JSON.stringify(captured[0]?.systemPrompt))
          .digest('hex')}`,
      );
    });
  });

  test('rejects a blank custom systemPrompt before registering a backend', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'blank-prompt-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };
      let registered = false;

      await assert.rejects(
        runExperiment({ ...fakeConfig, systemPrompt: '\n \t' }, task, {
          storageRoot,
          registerBackends: (registry) => {
            registered = true;
            registerFakeBackend(registry);
          },
        }),
        /systemPrompt must contain non-whitespace text/,
      );
      assert.equal(registered, false);
    });
  });

  test('does not append heavy-task policy without the required direct-runner tools', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const captured: { systemPrompt?: string }[] = [];
      const task: Task = {
        id: 'heavy-default-prompt-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runExperiment({ ...fakeConfig, heavyTaskMode: true }, task, {
        storageRoot,
        registerBackends: registerCapturingBackend(captured),
      });

      const prompt = captured[0]?.systemPrompt ?? '';
      assert.equal(
        prompt,
        [
          'Complete the task by acting with the available tools, not by narrating.',
          'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
          'Verify the result when practical.',
          'Stop when the task is complete.',
        ].join('\n'),
      );
      assert.doesNotMatch(prompt, /Heavy-task benchmark policy/);
      assert.equal(
        result.systemPromptHash,
        `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      );
    });
  });

  test('does not change direct-runner policy behavior while resolving Layer 1', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const captured: { systemPrompt?: string }[] = [];
      const task: Task = {
        id: 'economy-default-prompt-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      await runExperiment({ ...fakeConfig, economyTaskMode: true }, task, {
        storageRoot,
        registerBackends: registerCapturingBackend(captured),
      });

      const prompt = captured[0]?.systemPrompt ?? '';
      assert.equal(
        prompt,
        [
          'Complete the task by acting with the available tools, not by narrating.',
          'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
          'Verify the result when practical.',
          'Stop when the task is complete.',
        ].join('\n'),
      );
      assert.doesNotMatch(prompt, /Economy-task benchmark policy/);
    });
  });

  // End-to-end wiring test: proves config.systemPrompt flows all the way
  // through to the backend constructor's systemPrompt parameter — the exact
  // seam a real AiSdkBackend factory (like desktop's) uses. Uses an ai-sdk
  // stub that records its constructor input, so we verify the wiring contract
  // without needing a live LLM call.
  class SystemPromptCapturingBackend implements AgentBackend {
    readonly kind: BackendKind = 'ai-sdk';
    readonly sessionId: string;
    readonly receivedSystemPrompt: string | undefined;
    constructor(
      private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
      systemPrompt?: string,
    ) {
      this.sessionId = ctx.sessionId;
      this.receivedSystemPrompt = systemPrompt;
    }
    async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
      const turnId = input.turnId;
      const ts = Date.now();
      const messageId = 'capture-msg';
      await this.ctx.store.appendMessage(this.sessionId, {
        type: 'assistant',
        id: messageId,
        turnId,
        ts,
        text: 'ok',
        modelId: this.ctx.header.model,
      });
      yield { type: 'text_complete', id: 'capture-tc', turnId, ts, messageId, text: 'ok' };
      yield { type: 'complete', id: 'capture-c', turnId, ts, stopReason: 'end_turn' };
    }
    async stop(): Promise<void> {}
    async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
    async dispose(): Promise<void> {}
  }

  test('config.systemPrompt reaches the backend constructor systemPrompt parameter', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const prompt = 'You are a benchmark agent. Use tools, do not narrate.';
      let constructedBackend: SystemPromptCapturingBackend | undefined;
      const configWithPrompt: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-chat',
        systemPrompt: prompt,
      };
      const task: Task = {
        id: 'wiring-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      await runExperiment(configWithPrompt, task, {
        storageRoot,
        realBackendIsolation: { kind: 'external', label: 'wiring test' },
        registerBackends: (registry, context) => {
          // This is the exact pattern a real benchmark factory uses:
          // read config.systemPrompt from the closure, pass to backend ctor.
          // The factory receives BackendFactoryContext (with store/header),
          // and context.config is the HeadlessBackendContext closure copy.
          registry.register('ai-sdk', (ctx) => {
            constructedBackend = new SystemPromptCapturingBackend(
              { sessionId: ctx.sessionId, header: ctx.header, store: ctx.store },
              context.config.systemPrompt,
            );
            return constructedBackend;
          });
        },
      });

      assert.ok(constructedBackend, 'backend must have been constructed');
      assert.equal(
        constructedBackend!.receivedSystemPrompt,
        prompt,
        'config.systemPrompt must reach the backend constructor systemPrompt parameter',
      );
    });
  });
});
