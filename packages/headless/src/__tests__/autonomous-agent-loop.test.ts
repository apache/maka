import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  BackendRegistry,
  FakeBackend,
  SessionManager,
  type SessionStore,
  type AgentBackend,
} from '@maka/runtime';
import type { BackendKind, SessionEvent, SessionHeader } from '@maka/core';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { Config, Task } from '../contracts.js';
import type { HeadlessBackendContext } from '../isolation.js';
import { runAutonomousTask } from '../autonomous-agent-loop.js';
import { countRuntimeSteps } from '../cell-output.js';

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class RequiresBypassBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'error',
      id: 'requires-bypass-error',
      turnId: input.turnId,
      ts,
      recoverable: false,
      reason: 'requires_bypass',
      message: 'This operation requires the session to use Bypass.',
    };
    yield {
      type: 'complete',
      id: 'requires-bypass-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'error',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerRequiresBypassBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new RequiresBypassBackend(ctx.sessionId));
};

class RuntimeContextCapturingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly runtimeContextCounts: number[],
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.runtimeContextCounts.push(input.runtimeContext?.length ?? 0);
    const ts = Date.now();
    yield {
      type: 'complete',
      id: `context-complete-${this.runtimeContextCounts.length}`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerRuntimeContextCapturingBackend =
  (runtimeContextCounts: number[]) =>
  (registry: BackendRegistry): void => {
    registry.register(
      'fake',
      (ctx) => new RuntimeContextCapturingBackend(ctx.sessionId, runtimeContextCounts),
    );
  };

class PromptCapturingProgressBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly progress: HeadlessBackendContext['heavyTaskProgress'],
    private readonly evidence: HeadlessBackendContext['heavyTaskEvidence'],
    private readonly prompts: string[],
    private readonly runtimeContextCounts?: number[],
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.prompts.push(input.text);
    this.runtimeContextCounts?.push(input.runtimeContext?.length ?? 0);
    if (this.prompts.length === 1 && this.progress) {
      const toolCtx = {
        sessionId: this.sessionId,
        turnId: input.turnId,
        cwd: '/workspace',
        toolCallId: 'progress-tool-call',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      };
      await this.progress.recordInventory(
        {
          summary: 'Inspected public task files.',
          items: [{ path: 'README.md', kind: 'file', status: 'observed' }],
        },
        toolCtx,
      );
      await this.progress.recordTodos(
        {
          items: [
            { id: 'fix', content: 'Patch implementation', status: 'in_progress', priority: 'high' },
          ],
        },
        toolCtx,
      );
      await this.evidence?.recordToolEvidence(
        {
          name: 'Bash',
          input: { command: 'npm test', cwd: '/workspace', timeoutMs: 120_000 },
          result: {
            exitCode: 1,
            stdout: `public failure summary\n${'x'.repeat(5_000)}`,
            stderr: 'short stderr\n',
          },
        },
        toolCtx,
      );
    }
    const ts = Date.now();
    yield {
      type: 'complete',
      id: `progress-complete-${this.prompts.length}`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerPromptCapturingProgressBackend =
  (prompts: string[], runtimeContextCounts?: number[]) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    registry.register(
      'fake',
      (ctx) =>
        new PromptCapturingProgressBackend(
          ctx.sessionId,
          context.heavyTaskProgress,
          context.heavyTaskEvidence,
          prompts,
          runtimeContextCounts,
        ),
    );
  };

async function withDirs<T>(
  fn: (fixtureDir: string, storageRoot: string) => Promise<T>,
): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-autonomous-loop-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-autonomous-loop-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

describe('runAutonomousTask', () => {
  test('uses RuntimeRunner path without SessionManager.sendMessage', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const original = SessionManager.prototype.sendMessage;
      SessionManager.prototype.sendMessage = async function* () {
        throw new Error('autonomous loop must not use interactive sendMessage');
      } as typeof original;
      try {
        const task: Task = {
          id: 'no-send-message',
          instruction: 'do the thing',
          workspaceDir: fixtureDir,
          verification: { command: 'test -f marker.txt', protectedPaths: [] },
        };

        const result = await runAutonomousTask(fakeConfig, task, {
          storageRoot,
          registerBackends: registerFakeBackend,
          budget: { maxAttempts: 2 },
          newId: idFactory(),
        });

        assert.equal(result.attempts.length, 1);
        assert.equal(result.resultRecord.passed, true);
        assert.equal(result.projection.status, 'completed');
      } finally {
        SessionManager.prototype.sendMessage = original;
      }
    });
  });

  test('runs one passing attempt and records stop decision', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'pass-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.resultRecord.passed, true);
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.projection.decisions[0]?.decision, 'stop');
      assert.equal(result.projection.decisions[0]?.reason, 'authoritative verification passed');
      assert.equal(
        result.projection.feedback.some((entry) => entry.source === 'verifier'),
        true,
      );
      assert.deepEqual(
        result.projection.events
          .filter((event) => event.type.startsWith('task_run_'))
          .map((event) => event.type),
        [
          'task_run_created',
          'task_run_queued',
          'task_run_started',
          'task_run_verifying',
          'task_run_completed',
        ],
      );
    });
  });

  test('continues after verifier failure until maxAttempts records budget terminal', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'verify-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 2 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 2);
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
      assert.deepEqual(
        result.projection.decisions.map((decision) => decision.decision),
        ['continue', 'stop'],
      );
      assert.equal(result.projection.error?.class, 'budget_exhausted');
      assert.equal(
        result.projection.events.filter((event) => event.type === 'task_run_budget_exhausted')
          .length,
        1,
      );
    });
  });

  test('can replay prior attempt runtime events into the next autonomous attempt', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const runtimeContextCounts: number[] = [];
      const task: Task = {
        id: 'replay-prior-runtime-context',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerRuntimeContextCapturingBackend(runtimeContextCounts),
        replayPriorAttemptRuntimeContext: true,
        budget: { maxAttempts: 2 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 2);
      assert.equal(runtimeContextCounts[0], 0);
      assert.ok(
        (runtimeContextCounts[1] ?? 0) > 0,
        'expected second attempt to receive prior runtime events',
      );
    });
  });

  test('replays every invocation from a heavy-task attempt and counts only runtime steps', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const prompts: string[] = [];
      const runtimeContextCounts: number[] = [];
      const task: Task = {
        id: 'replay-heavy-attempt-trajectory',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask({ ...fakeConfig, heavyTaskMode: true }, task, {
        storageRoot,
        registerBackends: registerPromptCapturingProgressBackend(prompts, runtimeContextCounts),
        replayPriorAttemptRuntimeContext: true,
        budget: { maxAttempts: 2 },
        newId: idFactory(),
      });

      const firstAttempt = result.attempts[0]!;
      assert.equal(firstAttempt.invocations.length, 2);
      const firstTrajectory = firstAttempt.invocations.flatMap((invocation) => invocation.events);
      assert.equal(runtimeContextCounts[2], firstTrajectory.length);
      assert.equal(firstAttempt.resultRecord.steps, countRuntimeSteps(firstTrajectory));
    });
  });

  test('heavy-task continuation prompt includes compact progress from replay', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'README.md'), 'public notes\n', 'utf8');
      const prompts: string[] = [];
      const task: Task = {
        id: 'heavy-progress-retry',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask({ ...fakeConfig, heavyTaskMode: true }, task, {
        storageRoot,
        registerBackends: registerPromptCapturingProgressBackend(prompts),
        budget: { maxAttempts: 2 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 2);
      assert.equal(result.projection.latestHeavyTaskInventory?.items[0]?.path, 'README.md');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[0]?.id, 'fix');
      assert.match(
        prompts[1] ?? '',
        /Your previous completion is not accepted for heavy-task finalization yet/,
      );
      assert.match(prompts[1] ?? '', /missing accepted public self-check evidence/);

      const continuationPrompt = prompts.find((prompt) =>
        prompt.includes('Heavy-task progress state from prior task-run events'),
      );
      assert.ok(
        continuationPrompt,
        'expected autonomous retry prompt to include replayed heavy-task progress',
      );
      assert.match(continuationPrompt, /Inventory summary: Inspected public task files/);
      assert.match(continuationPrompt, /Active todo: fix/);
      assert.match(
        continuationPrompt,
        /Heavy-task compact evidence from prior public tool\/check\/artifact observations/,
      );
      assert.match(continuationPrompt, /tool:Bash exit=1/);
      assert.match(continuationPrompt, /truncated=true/);
      assert.doesNotMatch(continuationPrompt, new RegExp(`x{${3_000}}`));
      assert.equal((continuationPrompt.match(/Heavy-task progress state/g) ?? []).length, 1);
      assert.equal((continuationPrompt.match(/Heavy-task compact evidence/g) ?? []).length, 1);
    });
  });

  test('self-check pass-like language is non-authoritative when verifier fails', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'self-check-does-not-score',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 1 },
        selfCheck: {
          observe: () => ({
            summary: 'self-check passed: looks solved',
            details: { passed: true },
          }),
        },
        newId: idFactory(),
      });

      assert.equal(result.projection.selfChecks[0]?.summary, 'self-check passed: looks solved');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.projection.result?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
      assert.notEqual(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.projection.status, 'budget_exhausted');
    });
  });

  test('maxRuntimeSteps fails closed after an over-cap attempt', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'runtime-step-cap',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3, maxRuntimeSteps: 1 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.decisions[0]?.reason, 'runtime step cap reached');
      assert.equal(result.projection.error?.class, 'budget_exhausted');
    });
  });

  test('maxRuntimeSteps can park for budget extension in desktop mode', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'runtime-step-cap-park',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3, maxRuntimeSteps: 1 },
        interventionPolicy: { mode: 'park', allowBudgetExtensionRequests: true },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.projection.status, 'needs_approval');
      assert.equal(result.projection.parked?.reason, 'budget_extension');
      assert.equal(result.projection.inboxItems[0]?.kind, 'budget_extension');
      assert.equal(
        result.projection.events.some((event) => event.type === 'task_run_budget_exhausted'),
        false,
      );
    });
  });

  test('a benchmark deadline cannot park for budget extension', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'benchmark-deadline-park',
        instruction: 'must not start',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 2 },
        interventionPolicy: { mode: 'park', allowBudgetExtensionRequests: true },
        deadlineAtMs: Date.now() - 1,
        newId: idFactory(),
      });

      assert.equal(result.attempts.at(-1)?.settledByDeadline, true);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.events.at(-1)?.type, 'task_run_budget_exhausted');
      assert.equal(result.projection.parked, undefined);
    });
  });

  test('maxWallTimeMs admits the first attempt but prevents another one', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'wall-cap',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };
      let t = 0;

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3, maxWallTimeMs: 1 },
        now: () => {
          t += 10;
          return t;
        },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.decisions[0]?.reason, 'wall time cap reached');
      assert.equal(result.projection.error?.class, 'budget_exhausted');
    });
  });

  test('requires_bypass fails closed without an autonomous retry', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'policy-denied',
        instruction: 'run a dangerous command',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerRequiresBypassBackend,
        budget: { maxAttempts: 3 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.projection.status, 'policy_denied');
      assert.equal(result.projection.decisions[0]?.decision, 'stop');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'policy_denied');
    });
  });
});
