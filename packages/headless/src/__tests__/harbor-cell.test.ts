import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type {
  BackendKind,
  LlmConnection,
  RuntimeEvent,
  SessionEvent,
  SessionHeader,
} from '@maka/core';
import type { BackendSendInput, BackendStopMode } from '@maka/core/backend-types';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { createSessionStore } from '@maka/storage';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import {
  BackendRegistry,
  PiAgentBackend,
  type AgentBackend,
  type AiSdkBackendInput,
  type BackendFactoryContext,
  type InvocationResult,
  type PiAgentTransport,
  type ProviderRequestCaptureRecord,
  type SessionStore,
  type SynthesisCacheWriteInput,
  type ToolResultArchiveReader,
  type ToolResultArchiveRecorder,
} from '@maka/runtime';
import { createReadImageSnapshotter } from '@maka/storage';
import { Agent } from 'undici';
import type { Config } from '../contracts.js';
import { openHeadlessStorageForWrite } from '../headless-storage.js';
import type {
  HeadlessBackendContext,
  IsolatedCommandResult,
  IsolatedToolExecutor,
} from '../isolation.js';
import {
  buildAiSdkCellBackendRegistration,
  buildHarborCellContextBudgetBackendOptions,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellTaskLedgerExperimentPolicy,
  harborCellMaxStepsFromEnv,
  harborCellSoftTimeoutMsFromEnv,
  createHarborCellLocalToolExecutor,
  createHarborHttpToolExecutor,
  HARBOR_CELL_CONTEXT_ENV_KEYS,
  HARBOR_CELL_OUTPUT_FILENAME,
  HARBOR_CELL_RUNTIME_EVENTS_FILENAME,
  HARBOR_CELL_TRAJECTORY_STATE_DIRECTORY,
  HARBOR_CELL_USAGE_CHECKPOINT_FILENAME,
  resolveHarborCellAiSdkEnv,
  runHarborCellFromEnv,
  runHarborCell,
  writeHarborCellArtifacts,
  writeHarborCellExecutionIdentity,
  writeHarborCellUsageCheckpoint,
} from '../harbor-cell.js';
import { resolveHarborRunOptions } from '../harbor-cli.js';
import { createHeadlessSessionCapabilityBridge } from '../session-capabilities.js';
import { DEFAULT_HEADLESS_SYSTEM_PROMPT } from '../system-prompts.js';
import { buildIsolatedBashTool, buildIsolatedHeadlessProductToolSurface } from '../tools.js';

const config: Config = {
  id: 'cell-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
  systemPrompt: 'You are a benchmark cell agent.',
};

const AGENT_RUNTIME_CAPABILITIES = [
  'spawnChildAgent',
  'spawnChildSession',
  'prepareChildAgentResume',
  'resumeChildAgent',
  'retryChildAgent',
  'listChildAgents',
  'readChildAgentOutput',
] as const satisfies readonly (keyof AiSdkBackendInput)[];

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

class CellReportingBackend implements AgentBackend {
  readonly sessionId: string;

  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
    readonly kind: BackendKind = 'fake',
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    await writeFile(join(this.ctx.header.cwd, 'cell-proof.txt'), 'ran in place\n', 'utf8');
    yield {
      type: 'token_usage',
      id: 'cell-usage',
      turnId: input.turnId,
      ts,
      input: 11,
      output: 7,
      total: 18,
      costUsd: 0.0042,
      systemPromptHash: 'sha256:cell-prompt',
    };
    yield {
      type: 'text_complete',
      id: 'cell-text',
      messageId: 'cell-message',
      turnId: input.turnId,
      ts,
      text: 'cell complete',
    };
    yield {
      type: 'complete',
      id: 'cell-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class CellChildAdmissionProbeBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly context: HeadlessBackendContext,
    private readonly observed: { spawned?: boolean; error?: string },
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    assert.ok(this.context.spawnChildSession);
    assert.ok(input.runId);
    try {
      await this.context.spawnChildSession(this.sessionId, {
        spawnedBy: {
          parentRunId: input.runId,
          parentTurnId: input.turnId,
          toolCallId: 'cell-child-admission-probe',
        },
        agentProfile: 'local_read',
        prompt: 'inspect the task workspace',
      });
      this.observed.spawned = true;
    } catch (error) {
      this.observed.spawned = false;
      this.observed.error = error instanceof Error ? error.message : String(error);
    }
    yield {
      type: 'complete',
      id: 'cell-child-admission-probe-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class RunStartOrderingProbeBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly events: string[],
    private readonly delayMs: number,
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.events.push('backend-send');
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    yield {
      type: 'complete',
      id: 'run-start-ordering-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerCellBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) =>
      new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class ThrowingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(private readonly ctx: { sessionId: string }) {
    this.sessionId = ctx.sessionId;
  }

  async *send(_input: BackendSendInput): AsyncIterable<SessionEvent> {
    throw new Error('backend boom');
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerThrowingBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new ThrowingBackend({ sessionId: ctx.sessionId }));
};

class NonCooperativeDeadlineBackend implements AgentBackend {
  readonly sessionId: string;
  readonly stopModes: BackendStopMode[] = [];
  private releaseStop!: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });
  private readonly fallback: NodeJS.Timeout;

  constructor(
    sessionId: string,
    readonly kind: BackendKind = 'fake',
    fallbackAfterMs = 500,
  ) {
    this.sessionId = sessionId;
    this.fallback = setTimeout(() => this.releaseStop(), fallbackAfterMs);
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'token_usage',
      id: 'usage-before-forced-deadline',
      turnId: input.turnId,
      ts,
      input: 13,
      output: 5,
      total: 18,
      costUsd: 0.004,
    };
    await this.stopped;
    yield {
      type: 'abort',
      id: 'forced-deadline-abort',
      turnId: input.turnId,
      ts: Date.now(),
      reason: 'user_stop',
    };
    yield {
      type: 'complete',
      id: 'forced-deadline-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }

  async stop(
    _reason: 'user_stop' | 'redirect',
    mode: BackendStopMode = 'immediate',
  ): Promise<void> {
    this.stopModes.push(mode);
    if (mode !== 'immediate') return;
    clearTimeout(this.fallback);
    this.releaseStop();
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ActiveIsolatedToolDeadlineBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly stopModes: BackendStopMode[] = [];
  private readonly controller = new AbortController();

  constructor(
    readonly sessionId: string,
    private readonly executor: IsolatedToolExecutor,
  ) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'token_usage',
      id: 'usage-before-active-tool-deadline',
      turnId: input.turnId,
      ts,
      input: 13,
      output: 5,
      total: 18,
      costUsd: 0.004,
    };
    const tool = buildIsolatedBashTool(this.executor);
    try {
      await tool.impl(
        { command: 'sleep until cancelled' },
        {
          sessionId: this.sessionId,
          turnId: input.turnId,
          cwd: '/workspace',
          toolCallId: 'active-bash-call',
          abortSignal: this.controller.signal,
          emitOutput: () => {},
        },
      );
    } catch (error) {
      if (!this.controller.signal.aborted) throw error;
    }
    yield {
      type: 'abort',
      id: 'active-tool-deadline-abort',
      turnId: input.turnId,
      ts: Date.now(),
      reason: 'user_stop',
    };
    yield {
      type: 'complete',
      id: 'active-tool-deadline-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }

  async stop(
    _reason: 'user_stop' | 'redirect',
    mode: BackendStopMode = 'immediate',
  ): Promise<void> {
    this.stopModes.push(mode);
    if (mode === 'immediate') this.controller.abort();
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class TerminalClaimBeforeDeadlineBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;
  stopCalls = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'token_usage',
      id: 'usage-before-normal-completion',
      turnId: input.turnId,
      ts: Date.now(),
      input: 2,
      output: 1,
      total: 3,
      costUsd: 0.001,
    };
    yield {
      type: 'complete',
      id: 'completed-before-deadline',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class StepCapThenCompleteBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  readonly prompts: string[] = [];
  readonly cwds: string[] = [];

  constructor(protected readonly ctx: { sessionId: string; header: SessionHeader }) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    if (this.prompts.length === 1) {
      yield {
        type: 'token_usage',
        id: 'usage-step-cap',
        turnId: input.turnId,
        ts,
        input: 10,
        output: 1,
        total: 11,
        costUsd: 0.01,
        rawFinishReason: 'tool-calls',
        runtimeSteps: 50,
      };
      yield {
        type: 'text_complete',
        id: 'text-step-cap',
        messageId: 'step-cap-message',
        turnId: input.turnId,
        ts,
        text: 'continue',
      };
      yield {
        type: 'complete',
        id: 'complete-step-cap',
        turnId: input.turnId,
        ts,
        stopReason: 'end_turn',
      };
      return;
    }
    await writeFile(join(this.ctx.header.cwd, 'continued-proof.txt'), input.text, 'utf8');
    yield {
      type: 'token_usage',
      id: 'usage-done',
      turnId: input.turnId,
      ts,
      input: 3,
      output: 2,
      total: 5,
      costUsd: 0.02,
      rawFinishReason: 'stop',
    };
    yield {
      type: 'text_complete',
      id: 'text-done',
      messageId: 'done-message',
      turnId: input.turnId,
      ts,
      text: 'done',
    };
    yield {
      type: 'complete',
      id: 'complete-done',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class DeadlineStepCapBackend extends StepCapThenCompleteBackend {
  private releaseStop!: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });

  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.prompts.length > 0) {
      yield* super.send(input);
      return;
    }
    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    await this.stopped;
    const ts = Date.now();
    yield {
      type: 'token_usage',
      id: 'usage-deadline-step-cap',
      turnId: input.turnId,
      ts,
      input: 10,
      output: 1,
      total: 11,
      costUsd: 0.01,
      rawFinishReason: 'tool-calls',
      runtimeSteps: 50,
    };
    yield {
      type: 'complete',
      id: 'complete-deadline-step-cap',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  override async stop(): Promise<void> {
    this.releaseStop();
  }
}

function registerStepCapThenCompleteBackend(seen: { backend?: StepCapThenCompleteBackend }) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new StepCapThenCompleteBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
      });
      seen.backend = backend;
      return backend;
    });
  };
}

class UnmeteredStepCapThenCompleteBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.prompts.length > 0) {
      yield* super.send(input);
      return;
    }
    const ts = Date.now();
    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    yield {
      type: 'tool_start',
      id: 'unmetered-tool-step',
      turnId: input.turnId,
      ts,
      toolUseId: 'call-1',
      toolName: 'Read',
      args: { path: 'README.md' },
      stepId: 'step-1',
    };
    yield {
      type: 'complete',
      id: 'unmetered-step-cap',
      turnId: input.turnId,
      ts,
      stopReason: 'step_limit',
    };
  }
}

function registerUnmeteredStepCapThenCompleteBackend(seen: {
  backend?: UnmeteredStepCapThenCompleteBackend;
}) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new UnmeteredStepCapThenCompleteBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
      });
      seen.backend = backend;
      return backend;
    });
  };
}

class StepCapThenThrowBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.prompts.length > 0) {
      this.prompts.push(input.text);
      this.cwds.push(this.ctx.header.cwd);
      throw new Error('continuation turn crashed');
    }
    yield* super.send(input);
  }
}

function registerStepCapThenThrowBackend(seen: { backend?: StepCapThenThrowBackend }) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new StepCapThenThrowBackend({ sessionId: ctx.sessionId, header: ctx.header });
      seen.backend = backend;
      return backend;
    });
  };
}

class NoisyStepCapThenCompleteBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    if (this.prompts.length > 0) {
      yield* super.send(input);
      return;
    }

    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    for (let index = 0; index < 60; index += 1) {
      yield {
        type: 'token_usage',
        id: `noise-${index}`,
        turnId: input.turnId,
        ts,
        input: 0,
        output: 0,
        total: 0,
      };
    }
    yield {
      type: 'token_usage',
      id: 'usage-step-cap-noisy',
      turnId: input.turnId,
      ts,
      input: 10,
      output: 1,
      total: 11,
      costUsd: 0.01,
      rawFinishReason: 'tool-calls',
      runtimeSteps: 50,
    };
    yield {
      type: 'text_complete',
      id: 'text-step-cap-noisy',
      messageId: 'step-cap-noisy-message',
      turnId: input.turnId,
      ts,
      text: 'continue',
    };
    yield {
      type: 'complete',
      id: 'complete-step-cap-noisy',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }
}

function registerNoisyStepCapThenCompleteBackend(seen: {
  backend?: NoisyStepCapThenCompleteBackend;
}) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new NoisyStepCapThenCompleteBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
      });
      seen.backend = backend;
      return backend;
    });
  };
}

class StepCapTwiceThenCompleteBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    if (this.prompts.length <= 2) {
      yield {
        type: 'token_usage',
        id: `usage-step-cap-${this.prompts.length}`,
        turnId: input.turnId,
        ts,
        input: 10,
        output: 1,
        total: 11,
        costUsd: 0.01,
        rawFinishReason: 'tool-calls',
        runtimeSteps: 50,
      };
      yield {
        type: 'text_complete',
        id: `text-step-cap-${this.prompts.length}`,
        messageId: `step-cap-message-${this.prompts.length}`,
        turnId: input.turnId,
        ts,
        text: 'continue',
      };
      yield {
        type: 'complete',
        id: `complete-step-cap-${this.prompts.length}`,
        turnId: input.turnId,
        ts,
        stopReason: 'end_turn',
      };
      return;
    }
    await writeFile(join(this.ctx.header.cwd, 'continued-proof.txt'), input.text, 'utf8');
    yield {
      type: 'token_usage',
      id: 'usage-done',
      turnId: input.turnId,
      ts,
      input: 3,
      output: 2,
      total: 5,
      costUsd: 0.02,
      rawFinishReason: 'stop',
    };
    yield {
      type: 'text_complete',
      id: 'text-done',
      messageId: 'done-message',
      turnId: input.turnId,
      ts,
      text: 'done',
    };
    yield {
      type: 'complete',
      id: 'complete-done',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }
}

function registerStepCapTwiceThenCompleteBackend(seen: {
  backend?: StepCapTwiceThenCompleteBackend;
}) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new StepCapTwiceThenCompleteBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
      });
      seen.backend = backend;
      return backend;
    });
  };
}

describe('runHarborCell', () => {
  test('atomically replaces the cumulative completed-step usage checkpoint', async () => {
    await withDirs(async ({ outputDir }) => {
      const first = {
        inputTokens: 100,
        outputTokens: 5,
        cacheHitInputTokens: 20,
        cacheMissInputTokens: 80,
        cacheMissInputSource: 'explicit' as const,
        cacheWriteInputTokens: 0,
        reasoningTokens: 1,
        totalTokens: 105,
        costUsd: 0.001,
      };
      await writeHarborCellUsageCheckpoint(outputDir, first);
      await writeHarborCellUsageCheckpoint(outputDir, {
        ...first,
        inputTokens: 300,
        outputTokens: 12,
        cacheHitInputTokens: 100,
        cacheMissInputTokens: 200,
        reasoningTokens: 2,
        totalTokens: 312,
        costUsd: 0.003,
      });

      assert.deepEqual(
        JSON.parse(await readFile(join(outputDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME), 'utf8')),
        {
          input: 300,
          output: 12,
          cachedInput: 100,
          cacheHitInput: 100,
          cacheMissInput: 200,
          cacheWriteInput: 0,
          cacheMissInputSource: 'explicit',
          reasoning: 2,
          total: 312,
          costUsd: 0.003,
          pricingSource: 'runtime',
        },
      );
    });
  });

  test('does not turn unknown checkpoint cost into zero', async () => {
    await withDirs(async ({ outputDir }) => {
      await writeHarborCellUsageCheckpoint(outputDir, {
        inputTokens: 100,
        outputTokens: 5,
        cacheHitInputTokens: 20,
        cacheMissInputTokens: 80,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 1,
        totalTokens: 105,
      });

      await assert.rejects(
        readFile(join(outputDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME), 'utf8'),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    });
  });

  test('writes child-inclusive checkpoint usage into the canonical cell output', async () => {
    await withDirs(async ({ outputDir }) => {
      await writeHarborCellUsageCheckpoint(outputDir, {
        inputTokens: 140,
        outputTokens: 20,
        cacheHitInputTokens: 40,
        cacheMissInputTokens: 100,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 5,
        totalTokens: 160,
        costUsd: 0.012,
      });
      const usageEvent: RuntimeEvent = {
        id: 'parent-usage',
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 100,
        partial: false,
        role: 'model',
        author: 'agent',
        actions: {
          tokenUsage: {
            input: 100,
            output: 10,
            cacheHitInput: 30,
            cacheMissInput: 70,
            cacheMissInputSource: 'explicit',
            cacheWriteInput: 0,
            reasoning: 2,
            total: 110,
            runtimeSteps: 1,
            costUsd: 0.006,
          },
        },
      };
      const invocation: InvocationResult = {
        invocationId: 'invocation-1',
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [usageEvent],
        startedAt: 100,
        finishedAt: 200,
      };

      const result = await writeHarborCellArtifacts({ invocation, outputDir });

      assert.deepEqual(result.output.tokenSummary, {
        input: 140,
        output: 20,
        cachedInput: 40,
        cacheHitInput: 40,
        cacheMissInput: 100,
        cacheWriteInput: 0,
        cacheMissInputSource: 'explicit',
        reasoning: 5,
        total: 160,
        costUsd: 0.012,
        pricingSource: 'runtime',
      });
      assert.deepEqual(
        JSON.parse(await readFile(result.outputPath, 'utf8')).tokenSummary,
        result.output.tokenSummary,
      );
    });
  });

  test('publishes image trajectory evidence from a frozen SQLite session export', async () => {
    await withDirs(async ({ outputDir, storageRoot, workspaceDir, artifactStore }) => {
      const sessions = createSessionStore(storageRoot);
      const session = await sessions.create({
        cwd: workspaceDir,
        backend: config.backend,
        llmConnectionSlug: config.llmConnectionSlug,
        model: config.model,
        permissionMode: 'execute',
        name: 'trajectory-session',
      });
      await sessions.close?.();
      await mkdir(join(storageRoot, 'task-runs'));
      await writeFile(join(storageRoot, 'task-runs', 'headless-ledger.jsonl'), 'excluded\n');
      const image = await artifactStore.create({
        id: 'trajectory-image',
        sessionId: session.id,
        turnId: 'turn-1',
        name: 'screen.png',
        kind: 'image',
        content: Buffer.from('\x89PNG\r\n\x1a\nfixture'),
        mimeType: 'image/png',
        source: 'tool_result',
        now: 100,
      });
      const imageEvent: RuntimeEvent = {
        id: 'image-result',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: session.id,
        turnId: 'turn-1',
        ts: 100,
        partial: false,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'read-image',
          name: 'Read',
          result: {
            kind: 'image',
            mimeType: 'image/png',
            ref: { kind: 'session_file', sessionId: session.id, relativePath: image.id },
          },
        },
      };
      const invocation: InvocationResult = {
        invocationId: 'invocation-1',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [imageEvent],
        startedAt: 100,
        finishedAt: 200,
      };

      await writeHarborCellArtifacts({ invocation, outputDir, storageRoot });

      const trajectoryRoot = join(outputDir, HARBOR_CELL_TRAJECTORY_STATE_DIRECTORY);
      await assert.rejects(lstat(join(trajectoryRoot, 'artifacts', 'metadata.jsonl')), {
        code: 'ENOENT',
      });
      await assert.rejects(lstat(join(trajectoryRoot, 'runtime.sqlite-wal')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(trajectoryRoot, 'task-runs')), { code: 'ENOENT' });
      const database = new DatabaseSync(join(trajectoryRoot, 'runtime.sqlite'), {
        readOnly: true,
      });
      try {
        const row = database
          .prepare('SELECT record_json FROM artifact_records WHERE artifact_id = ?')
          .get(image.id) as { record_json?: unknown } | undefined;
        assert.equal(row?.record_json, JSON.stringify(image));
      } finally {
        database.close();
      }
      assert.deepEqual(
        await readFile(join(trajectoryRoot, 'artifacts', image.relativePath)),
        Buffer.from('\x89PNG\r\n\x1a\nfixture'),
      );

      await writeHarborCellArtifacts({
        invocation: { ...invocation, events: [] },
        outputDir,
        storageRoot,
      });
      await assert.rejects(lstat(trajectoryRoot), { code: 'ENOENT' });
    });
  });

  test('a new cell run does not inherit a stale checkpoint from the same output directory', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      await writeHarborCellUsageCheckpoint(outputDir, {
        inputTokens: 500,
        outputTokens: 50,
        cacheHitInputTokens: 200,
        cacheMissInputTokens: 300,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 10,
        totalTokens: 550,
        costUsd: 1,
      });

      const result = await runHarborCell({
        config,
        instruction: 'fail before model usage',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerThrowingBackend,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.tokenSummary, undefined);
      assert.equal(JSON.parse(await readFile(result.outputPath, 'utf8')).tokenSummary, undefined);
    });
  });

  test('runs in the provided workspace and writes the shared cell artifacts', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const result = await runHarborCell({
        config,
        instruction: 'write the answer in-place',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        registerBackends: registerCellBackend,
      });

      assert.equal(await readFile(join(workspaceDir, 'cell-proof.txt'), 'utf8'), 'ran in place\n');
      assert.equal(result.output.status, 'completed');
      assert.equal(result.output.promptHash, 'sha256:cell-prompt');
      assert.equal(
        result.output.runtimeEventsPath,
        join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME),
      );
      assert.ok(result.output.tokenSummary);
      assert.equal(result.output.tokenSummary.costUsd, 0.0042);
      assert.deepEqual(result.output.executionIdentity, {
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        systemPromptMode: 'custom',
        systemPromptHash: `sha256:${createHash('sha256').update(JSON.stringify(config.systemPrompt)).digest('hex')}`,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        agentTools: false,
      });

      const outputJson = JSON.parse(
        await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8'),
      );
      assert.deepEqual(outputJson, result.output);
      const runtimeEvents = await readFile(
        join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME),
        'utf8',
      );
      assert.match(runtimeEvents, /"id":"cell-usage"/);
      assert.match(runtimeEvents, /"systemPromptHash":"sha256:cell-prompt"/);
      const sessions = createSessionStore(storageRoot);
      try {
        assert.deepEqual(await sessions.readExecutionBoundary(result.invocation.sessionId), {
          kind: 'external',
          revision: 0,
        });
      } finally {
        await sessions.close?.();
      }
    });
  });

  test('does not provision child tools when Agent tools are disabled by default', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const observed: { spawned?: boolean; error?: string } = {};
      const result = await runHarborCell({
        config: { ...config, backend: 'ai-sdk' },
        instruction: 'probe child admission',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register(
            'ai-sdk',
            (ctx) => new CellChildAdmissionProbeBackend(ctx.sessionId, context, observed),
          );
        },
        realBackendIsolation: {
          kind: 'external',
          label: 'unit isolated executor',
          toolExecutor: {
            async exec() {
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
        },
      });

      assert.equal(observed.spawned, false);
      assert.match(observed.error ?? '', /missing tools/i);
      assert.deepEqual(result.output.executionIdentity?.productToolSurface, {
        policy: { economy: true, disabledSurfaceIds: ['agent'] },
        productToolNames: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
      });
    });
  });

  test('fires onRunStarted after run.begin and before provider execution', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const events: string[] = [];
      await runHarborCell({
        config,
        instruction: 'measure run start ordering',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        onRunStarted: () => {
          events.push('run-started');
        },
        registerBackends: (registry) => {
          registry.register(
            'fake',
            (ctx) => new RunStartOrderingProbeBackend(ctx.sessionId, events, 50),
          );
        },
      });

      assert.deepEqual(events.slice(0, 2), ['run-started', 'backend-send']);
    });
  });

  test('rejects resume input that disagrees with the stored execution config', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const first = await runHarborCell({
        config,
        instruction: 'create resumable session',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
      });

      await assert.rejects(
        runHarborCell({
          config: { ...config, model: 'different-model' },
          instruction: 'resume with conflicting config',
          cwd: workspaceDir,
          outputDir: join(outputDir, 'resume'),
          storageRoot,
          resumeSessionId: first.invocation.sessionId,
        }),
        /resume session model.*different-model.*fake-model/i,
      );
    });
  });

  test('rejects resuming a session that is not externally isolated', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const sessions = createSessionStore(storageRoot);
      const managed = await sessions.create({
        cwd: workspaceDir,
        backend: config.backend,
        llmConnectionSlug: config.llmConnectionSlug,
        model: config.model,
        permissionMode: 'execute',
        name: 'managed-session',
      });
      await sessions.close?.();

      await assert.rejects(
        runHarborCell({
          config,
          instruction: 'resume without external isolation',
          cwd: workspaceDir,
          outputDir,
          storageRoot,
          resumeSessionId: managed.id,
        }),
        /external execution boundary/i,
      );
    });
  });

  test('force-stops a non-cooperative active step and writes final usage before the hard deadline', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let backend: NonCooperativeDeadlineBackend | undefined;
      const result = await withTimeout(
        runHarborCell({
          config,
          instruction: 'keep working until force-stopped',
          cwd: workspaceDir,
          outputDir,
          storageRoot,
          registerBackends: (registry) => {
            registry.register('fake', (ctx) => {
              backend = new NonCooperativeDeadlineBackend(ctx.sessionId, 'fake', 5_000);
              return backend;
            });
          },
          settleAfterMs: 1_000,
        }),
        3_000,
        'Harbor cell did not force-stop before the hard deadline',
      );

      assert.equal(result.settledByDeadline, true);
      assert.deepEqual(backend?.stopModes, ['immediate']);
      assert.equal(result.output.tokenSummary?.total, 18);
      assert.deepEqual(
        JSON.parse(await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8')),
        result.output,
      );
    });
  });

  test('force-stops an active isolated tool and writes final artifacts before the hard deadline', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let backend: ActiveIsolatedToolDeadlineBackend | undefined;
      let releaseFallback!: () => void;
      const fallback = new Promise<IsolatedCommandResult>((resolve) => {
        releaseFallback = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
      });
      // The deadline is a wall-clock timer started when the cell is set up, so
      // it races the cell's own storage/session/first-send cost before the turn
      // ever reaches the tool. Lose that race and the run is still cancelled by
      // `benchmark.deadline` while the backend is never stopped — the empty
      // `stopModes` seen in CI. Budget the setup generously and name the race,
      // so a future loss reports itself instead of a bare deepEqual mismatch.
      const settleAfterMs = 3_000;
      const startedAt = Date.now();
      let toolActiveAfterMs: number | undefined;
      const fallbackTimer = setTimeout(releaseFallback, settleAfterMs + 5_000);
      const executor: IsolatedToolExecutor = {
        exec: async (_input, control) => {
          toolActiveAfterMs ??= Date.now() - startedAt;
          const signal = control?.abortSignal;
          if (!signal) return await fallback;
          return await new Promise<IsolatedCommandResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      };
      const result = await withTimeout(
        runHarborCell({
          config: { ...config, backend: 'ai-sdk' },
          instruction: 'run a tool until force-stopped',
          cwd: workspaceDir,
          outputDir,
          storageRoot,
          settleAfterMs,
          realBackendIsolation: {
            kind: 'external',
            label: 'cancellable test executor',
            toolExecutor: executor,
          },
          registerBackends: (registry, context) => {
            if (!context.toolExecutor) throw new Error('missing isolated tool executor');
            registry.register('ai-sdk', (ctx) => {
              backend = new ActiveIsolatedToolDeadlineBackend(ctx.sessionId, context.toolExecutor!);
              return backend;
            });
          },
        }),
        settleAfterMs + 10_000,
        'Harbor cell did not cancel its active isolated tool',
      );
      clearTimeout(fallbackTimer);

      assert.ok(
        toolActiveAfterMs !== undefined && toolActiveAfterMs < settleAfterMs,
        toolActiveAfterMs === undefined
          ? `the isolated tool must be active when the deadline fires, but it never started within the ${settleAfterMs}ms budget`
          : `the isolated tool must be active when the deadline fires, but it started ${toolActiveAfterMs}ms in, past the ${settleAfterMs}ms budget`,
      );
      assert.equal(result.settledByDeadline, true);
      assert.deepEqual(backend?.stopModes, ['immediate']);
      assert.equal(result.output.tokenSummary?.total, 18);
      assert.deepEqual(result.output.deadlineSettlement, {
        source: 'benchmark.deadline',
        mode: 'immediate',
      });
    });
  });

  test('does not report deadline settlement after normal completion already claimed the terminal state', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let backend: TerminalClaimBeforeDeadlineBackend | undefined;
      const result = await runHarborCell({
        config,
        instruction: 'finish before the deadline',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        settleAfterMs: 1_000,
        registerBackends: (registry) => {
          registry.register('fake', (ctx) => {
            backend = new TerminalClaimBeforeDeadlineBackend(ctx.sessionId);
            return backend;
          });
        },
      });

      assert.equal(result.settledByDeadline, false);
      assert.equal(backend?.stopCalls, 0);
    });
  });

  test('does not start a continuation turn after the settlement deadline latches', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let backend: DeadlineStepCapBackend | undefined;
      const result = await withTimeout(
        runHarborCell({
          config,
          instruction: 'stop at the deadline',
          cwd: workspaceDir,
          outputDir,
          storageRoot,
          settleAfterMs: 1_000,
          continuationPolicy: {
            enabled: true,
            maxTurns: 2,
            maxTotalRuntimeSteps: 100,
            prompt: 'continue after the deadline',
          },
          registerBackends: (registry) => {
            registry.register('fake', (ctx) => {
              backend = new DeadlineStepCapBackend({
                sessionId: ctx.sessionId,
                header: ctx.header,
              });
              return backend;
            });
          },
        }),
        5_000,
        'Harbor cell did not settle its capped turn',
      );

      assert.equal(result.settledByDeadline, true);
      assert.deepEqual(backend?.prompts, ['stop at the deadline']);
    });
  });

  test('writes execution identity before the first model call', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let observedIdentity: unknown;
      class IdentityObservingBackend implements AgentBackend {
        readonly kind: BackendKind = 'fake';
        readonly sessionId: string;

        constructor(sessionId: string) {
          this.sessionId = sessionId;
        }

        async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          observedIdentity = JSON.parse(
            await readFile(join(outputDir, 'maka-cell-execution-identity.json'), 'utf8'),
          );
          yield {
            type: 'complete',
            id: 'identity-observed',
            turnId: input.turnId,
            ts: Date.now(),
            stopReason: 'end_turn',
          };
        }

        async stop(): Promise<void> {}
        async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
        async dispose(): Promise<void> {}
      }

      await runHarborCell({
        config,
        instruction: 'observe identity',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        registerBackends: (registry) => {
          registry.register('fake', (ctx) => new IdentityObservingBackend(ctx.sessionId));
        },
      });

      assert.deepEqual(observedIdentity, {
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        systemPromptMode: 'custom',
        systemPromptHash: `sha256:${createHash('sha256').update(JSON.stringify(config.systemPrompt)).digest('hex')}`,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        agentTools: false,
      });
    });
  });

  test('continues after a tool-call step cap without verifier feedback', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 150,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(seen.backend?.cwds, [workspaceDir, workspaceDir]);
      assert.equal(
        await readFile(join(workspaceDir, 'continued-proof.txt'), 'utf8'),
        'Continue neutrally from current workspace.',
      );
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 51,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 1 },
        ],
      });
      assert.ok(result.output.tokenSummary);
      assert.equal(result.output.tokenSummary.input, 13);
      assert.equal(result.output.tokenSummary.costUsd, 0.03);
      const runtimeEvents = await readFile(
        join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME),
        'utf8',
      );
      assert.match(runtimeEvents, /usage-step-cap/);
      assert.match(runtimeEvents, /usage-done/);
      assert.doesNotMatch(
        seen.backend?.prompts[1] ?? '',
        /verifier|verification|failed|taxonomy|retry/i,
      );
    });
  });

  test('fails the cell when a continuation turn throws after a step cap', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenThrowBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapThenThrowBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 150,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'Error');
      assert.match(result.invocation.failure?.message ?? '', /continuation turn crashed/);
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 50,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'failed', stepCapHit: false, runtimeSteps: 0 },
        ],
      });
    });
  });

  test('stops continuation when the total runtime step budget is exhausted', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 3,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'tool_step_cap_reached');
      assert.deepEqual(seen.backend?.prompts, ['solve the benchmark task']);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 3,
        turnsUsed: 1,
        continuedTurns: 0,
        stepCapHits: 1,
        capExhausted: true,
        totalRuntimeSteps: 50,
        turns: [{ turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 }],
      });
    });
  });

  test('stops continuation at the step budget when the capped turn has no usage', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: UnmeteredStepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerUnmeteredStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 1,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'tool_step_cap_reached');
      assert.deepEqual(seen.backend?.prompts, ['solve the benchmark task']);
      assert.equal(result.output.continuationSummary?.totalRuntimeSteps, 1);
      assert.equal('tokenSummary' in result.output, false);
    });
  });

  test('does not spend continuation step budget from diagnostic event count', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: NoisyStepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerNoisyStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 51,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 51,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 51,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 1 },
        ],
      });
    });
  });

  test('records per-turn step-cap hits across continuation turns', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapTwiceThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapTwiceThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 150,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(
        result.output.continuationSummary?.turns.map((turn) => turn.stepCapHit),
        [true, true, false],
      );
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 3,
        continuedTurns: 2,
        stepCapHits: 2,
        capExhausted: false,
        totalRuntimeSteps: 101,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 2, status: 'completed', stepCapHit: false, runtimeSteps: 1 },
        ],
      });
    });
  });

  test('env entrypoint wires continuation policy from env', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenCompleteBackend } = {};
      const result = await runHarborCellFromEnv(
        {
          MAKA_BACKEND: 'fake',
          MAKA_INSTRUCTION: 'solve the benchmark task',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
          MAKA_HARBOR_CONTINUATION: 'on',
          MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
          MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '3',
          MAKA_HARBOR_CONTINUATION_PROMPT: 'Continue neutrally from current workspace.',
        },
        {
          registerBackends: registerStepCapThenCompleteBackend(seen),
        },
      );

      assert.equal(result.output.status, 'failed');
      assert.deepEqual(seen.backend?.prompts, ['solve the benchmark task']);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 3,
        turnsUsed: 1,
        continuedTurns: 0,
        stepCapHits: 1,
        capExhausted: true,
        totalRuntimeSteps: 50,
        turns: [{ turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 }],
      });
    });
  });

  test('writes a failed cell artifact when the backend stream throws', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const result = await runHarborCell({
        config,
        instruction: 'trigger backend failure',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerThrowingBackend,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'Error');
      assert.match(
        await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8'),
        /"status": "failed"/,
      );
    });
  });

  test('env entrypoint maps provider/model env for the real backend path', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];
      const registerAiSdkBackend = (
        registry: BackendRegistry,
        context: HeadlessBackendContext,
      ): void => {
        seenContexts.push(context);
        registry.register(
          'ai-sdk',
          (ctx) =>
            new CellReportingBackend(
              { sessionId: ctx.sessionId, header: ctx.header, store: ctx.store },
              'ai-sdk',
            ),
        );
      };

      const result = await runHarborCellFromEnv(
        {
          MAKA_INSTRUCTION: 'solve from real-provider env',
          MAKA_MODEL: 'openai/gpt-4o-mini',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
          MAKA_SYSTEM_PROMPT: 'Use the benchmark prompt.',
        },
        {
          registerBackends: registerAiSdkBackend,
        },
      );

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts.length, 1);
      assert.equal(seenContexts[0].config.backend, 'ai-sdk');
      assert.equal(seenContexts[0].config.llmConnectionSlug, 'openai');
      assert.equal(seenContexts[0].config.model, 'gpt-4o-mini');
      assert.equal(seenContexts[0].config.systemPrompt, 'Use the benchmark prompt.');
      assert.equal(seenContexts[0].realBackendIsolation?.kind, 'external');
      assert.equal(seenContexts[0].realBackendIsolation?.label, 'Harbor task container');
      assert.equal(typeof seenContexts[0].realBackendIsolation?.toolExecutor?.exec, 'function');
      assert.equal(typeof seenContexts[0].toolExecutor?.exec, 'function');
    });
  });

  test('injects the default headless prompt before registering a Harbor backend', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let capturedPrompt: string | undefined;

      const result = await runHarborCell({
        config: { ...config, systemPrompt: undefined },
        instruction: 'solve with the default prompt',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: (registry, context) => {
          capturedPrompt = context.config.systemPrompt;
          registerCellBackend(registry);
        },
      });

      assert.equal(
        capturedPrompt,
        [
          'Complete the task by acting with the available tools, not by narrating.',
          'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
          'Verify the result when practical.',
          'Stop when the task is complete.',
        ].join('\n'),
      );
      assert.equal(result.output.executionIdentity?.systemPromptMode, 'default');
    });
  });

  test('rejects a blank Harbor system prompt before registering a backend', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let registered = false;

      await assert.rejects(
        runHarborCellFromEnv(
          {
            MAKA_BACKEND: 'fake',
            MAKA_INSTRUCTION: 'solve with an invalid prompt',
            MAKA_WORKDIR: workspaceDir,
            MAKA_OUTPUT_DIR: outputDir,
            MAKA_STORAGE_ROOT: storageRoot,
            MAKA_SYSTEM_PROMPT: ' \n ',
          },
          {
            registerBackends: (registry) => {
              registered = true;
              registerCellBackend(registry);
            },
          },
        ),
        /Config\.systemPrompt must contain non-whitespace text/,
      );
      assert.equal(registered, false);
    });
  });

  test('parses host-side max steps from MAKA_MAX_STEPS', () => {
    assert.equal(harborCellMaxStepsFromEnv({ MAKA_MAX_STEPS: '200' }), 200);
    assert.throws(
      () => harborCellMaxStepsFromEnv({ MAKA_MAX_STEPS: '0' }),
      /MAKA_MAX_STEPS must be a positive integer/,
    );
    assert.throws(
      () => harborCellMaxStepsFromEnv({ MAKA_MAX_STEPS: 'oops' }),
      /MAKA_MAX_STEPS must be a positive integer/,
    );
    assert.equal(harborCellMaxStepsFromEnv({}), undefined);
  });

  test('rejects a soft timeout above the Node timer limit', () => {
    assert.throws(
      () => harborCellSoftTimeoutMsFromEnv({ MAKA_CELL_SOFT_TIMEOUT_MS: '2147483648' }),
      /MAKA_CELL_SOFT_TIMEOUT_MS must not exceed 2147483647/,
    );
  });

  test('host-side Harbor cell config reads MAKA_ECONOMY_TASK_MODE', async () => {
    const { main } = (await import(
      new URL('../../harbor/run-host-cell.mjs', import.meta.url).href
    )) as {
      main: (options?: {
        registerBackends?: (registry: BackendRegistry, context: HeadlessBackendContext) => void;
      }) => Promise<void>;
    };
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const previousEnv = { ...process.env };
      const seenPrompts: string[] = [];
      const seenAgentTools: Array<boolean | undefined> = [];
      const registerCapturingBackend = (
        registry: BackendRegistry,
        context: HeadlessBackendContext,
      ): void => {
        seenPrompts.push(context.config.systemPrompt ?? '');
        seenAgentTools.push(context.config.agentTools);
        registry.register(
          'ai-sdk',
          (ctx) =>
            new CellReportingBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              store: ctx.store,
            }),
        );
      };
      try {
        process.env.MAKA_PROVIDER = 'openai';
        process.env.MAKA_MODEL = 'openai/gpt-4o-mini';
        process.env.MAKA_HOST_API_KEY = 'test-key';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_URL = 'http://127.0.0.1:1';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN = 'token';
        process.env.MAKA_INSTRUCTION = 'Write a CSV summary of log files.';
        process.env.MAKA_WORKDIR = workspaceDir;
        process.env.MAKA_OUTPUT_DIR = outputDir;
        process.env.MAKA_STORAGE_ROOT = storageRoot;
        process.env.MAKA_SYSTEM_PROMPT = 'Use the host prompt.';
        process.env.MAKA_ECONOMY_TASK_MODE = 'true';
        process.env.MAKA_AGENT_TOOLS = 'true';
        await main({ registerBackends: registerCapturingBackend });
      } finally {
        process.env = previousEnv;
      }

      assert.match(seenPrompts[0] ?? '', /Use the host prompt/);
      assert.match(seenPrompts[0] ?? '', /Economy-task benchmark policy/);
      assert.equal(seenAgentTools[0], true);
    });
  });

  test('host-side Harbor cell attests the configured pricing profile', async () => {
    const { main } = (await import(
      new URL('../../harbor/run-host-cell.mjs', import.meta.url).href
    )) as {
      main: (options?: {
        registerBackends?: (registry: BackendRegistry, context: HeadlessBackendContext) => void;
      }) => Promise<void>;
    };
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const previousEnv = { ...process.env };
      try {
        process.env.MAKA_PROVIDER = 'openai';
        process.env.MAKA_MODEL = 'openai/gpt-4o-mini';
        process.env.MAKA_HOST_API_KEY = 'test-key';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_URL = 'http://127.0.0.1:1';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN = 'token';
        process.env.MAKA_INSTRUCTION = 'Finish the task.';
        process.env.MAKA_WORKDIR = workspaceDir;
        process.env.MAKA_OUTPUT_DIR = outputDir;
        process.env.MAKA_STORAGE_ROOT = storageRoot;
        process.env.MAKA_TRIAL_PRICING_SOURCE = 'frozen-pricing-profile';
        await main({ registerBackends: registerCellBackend });
      } finally {
        process.env = previousEnv;
      }

      const output = JSON.parse(await readFile(join(outputDir, 'maka-cell-output.json'), 'utf8'));
      assert.equal(output.executionIdentity.pricingProfile, 'frozen-pricing-profile');
    });
  });

  test('host-side Harbor cell force-stops a non-cooperative step at its soft deadline', async () => {
    const { main } = (await import(
      new URL('../../harbor/run-host-cell.mjs', import.meta.url).href
    )) as {
      main: (options?: {
        registerBackends?: (registry: BackendRegistry) => void;
      }) => Promise<unknown>;
    };
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const previousEnv = { ...process.env };
      try {
        process.env.MAKA_PROVIDER = 'openai';
        process.env.MAKA_MODEL = 'openai/gpt-4o-mini';
        process.env.MAKA_HOST_API_KEY = 'test-key';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_URL = 'http://127.0.0.1:1';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN = 'token';
        process.env.MAKA_INSTRUCTION = 'Keep working until stopped.';
        process.env.MAKA_WORKDIR = workspaceDir;
        process.env.MAKA_OUTPUT_DIR = outputDir;
        process.env.MAKA_STORAGE_ROOT = storageRoot;
        process.env.MAKA_CELL_SOFT_TIMEOUT_MS = '1000';
        const result = await withTimeout(
          main({
            registerBackends: (registry) => {
              registry.register(
                'ai-sdk',
                (ctx) => new NonCooperativeDeadlineBackend(ctx.sessionId, 'ai-sdk', 2_000),
              );
            },
          }),
          10_000,
          'host cell did not honor its soft deadline',
        );

        assert.equal(Reflect.get(result as object, 'settledByDeadline'), true);
        const output = JSON.parse(
          await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8'),
        );
        assert.equal(output.tokenSummary.total, 18);
        assert.deepEqual(output.deadlineSettlement, {
          source: 'benchmark.deadline',
          mode: 'immediate',
        });
      } finally {
        process.env = previousEnv;
      }
    });
  });

  test('host-side deadline settlement exits with the conventional timeout status', async () => {
    const module = (await import(
      new URL('../../harbor/run-host-cell.mjs', import.meta.url).href
    )) as Record<string, unknown>;
    const hostCellExitCode = module.hostCellExitCode as (result: {
      settledByDeadline: boolean;
    }) => number;

    assert.equal(hostCellExitCode({ settledByDeadline: true }), 124);
    assert.equal(hostCellExitCode({ settledByDeadline: false }), 0);
  });

  test('host-side Harbor cell config treats MAKA_ECONOMY_TASK_MODE=false as explicit disable', async () => {
    const { main } = (await import(
      new URL('../../harbor/run-host-cell.mjs', import.meta.url).href
    )) as {
      main: (options?: {
        registerBackends?: (registry: BackendRegistry, context: HeadlessBackendContext) => void;
      }) => Promise<void>;
    };
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const previousEnv = { ...process.env };
      const seenPrompts: string[] = [];
      const registerCapturingBackend = (
        registry: BackendRegistry,
        context: HeadlessBackendContext,
      ): void => {
        seenPrompts.push(context.config.systemPrompt ?? '');
        registry.register(
          'ai-sdk',
          (ctx) =>
            new CellReportingBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              store: ctx.store,
            }),
        );
      };
      try {
        process.env.MAKA_PROVIDER = 'openai';
        process.env.MAKA_MODEL = 'openai/gpt-4o-mini';
        process.env.MAKA_HOST_API_KEY = 'test-key';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_URL = 'http://127.0.0.1:1';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN = 'token';
        process.env.MAKA_INSTRUCTION = 'Write a CSV summary of log files.';
        process.env.MAKA_WORKDIR = workspaceDir;
        process.env.MAKA_OUTPUT_DIR = outputDir;
        process.env.MAKA_STORAGE_ROOT = storageRoot;
        process.env.MAKA_SYSTEM_PROMPT = 'Use the host prompt.';
        process.env.MAKA_ECONOMY_TASK_MODE = 'false';
        await main({ registerBackends: registerCapturingBackend });
      } finally {
        process.env = previousEnv;
      }

      assert.match(seenPrompts[0] ?? '', /Use the host prompt/);
      assert.doesNotMatch(seenPrompts[0] ?? '', /Economy-task benchmark policy/);
    });
  });

  test('Harbor ai-sdk backend registration forwards the canonical metering sink', async () => {
    // The controller has always exposed `recordModelCallAttempt`; this
    // composition never passed it on, so Harbor produced diagnostic attempts
    // with no canonical record behind them (#1679).
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
          systemPrompt: DEFAULT_HEADLESS_SYSTEM_PROMPT,
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
        ...createHeadlessSessionCapabilityBridge().capabilities,
      });

      const recorded: ModelCallAttempt[] = [];
      const backend = await registry.build('ai-sdk', {
        ...backendContext(workspaceDir),
        recordModelCallAttempt: (attempt: ModelCallAttempt) => {
          recorded.push(attempt);
          return Promise.resolve();
        },
      });
      const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

      assert.equal(typeof backendInput.recordModelCallAttempt, 'function');
      await backendInput.recordModelCallAttempt?.(harborModelCallAttemptFixture());
      assert.equal(recorded.length, 1, 'the sink must reach the controller');
      assert.equal(recorded[0]?.callKind, 'semantic_compact');
    });
  });

  test('Harbor ai-sdk backend registration exposes native file tools to the provider schema', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_STREAM_CONNECT_TIMEOUT_MS: '456000',
          MAKA_STREAM_IDLE_TIMEOUT_MS: '789000',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
          systemPrompt: DEFAULT_HEADLESS_SYSTEM_PROMPT,
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
        ...createHeadlessSessionCapabilityBridge().capabilities,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;
      const toolNames = backendInput.tools.map((tool) => tool.name);

      for (const expected of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) {
        assert.ok(toolNames.includes(expected), `expected provider schema tool ${expected}`);
      }
      for (const unexpected of ['agent_spawn', 'agent_swarm', 'agent_list', 'agent_output']) {
        assert.ok(!toolNames.includes(unexpected), `unexpected default Agent tool ${unexpected}`);
      }
      assert.match(
        typeof backendInput.systemPrompt === 'string' ? backendInput.systemPrompt : '',
        /Prefer Read, Glob, and Grep/,
      );
      assert.equal(backendInput.streamConnectTimeoutMs, 456_000);
      assert.equal(backendInput.streamIdleTimeoutMs, 789_000);
      assert.equal(backendInput.supportsVision, true);
      assert.equal(typeof backendInput.readAttachmentBytes, 'function');
      for (const capability of AGENT_RUNTIME_CAPABILITIES) {
        assert.equal(backendInput[capability], undefined, `unexpected root ${capability}`);
      }

      const scopedBackend = await registry.build('ai-sdk', {
        ...backendContext(workspaceDir),
        tools: [
          {
            name: 'ReadOnlyProbe',
            description: 'Read-only test probe',
            parameters: {},
            impl: () => 'ok',
          },
        ],
        systemPrompt: 'Durable child prompt.',
      });
      const scopedInput = (scopedBackend as unknown as { input: AiSdkBackendInput }).input;
      assert.deepEqual(
        scopedInput.tools.map((tool) => tool.name),
        ['ReadOnlyProbe'],
      );
      assert.equal(scopedInput.systemPrompt, 'Durable child prompt.');
      assert.deepEqual(scopedInput.toolAvailability, { economy: true, groups: [] });
      for (const capability of AGENT_RUNTIME_CAPABILITIES) {
        assert.equal(scopedInput[capability], undefined, `unexpected scoped ${capability}`);
      }
    });
  });

  test('Harbor ai-sdk backend registration binds the deferred Agent group only when enabled', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk-agent-tools',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
          systemPrompt: DEFAULT_HEADLESS_SYSTEM_PROMPT,
          agentTools: true,
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
        ...createHeadlessSessionCapabilityBridge().capabilities,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;
      const toolNames = backendInput.tools.map((tool) => tool.name);

      for (const expected of ['agent_spawn', 'agent_swarm', 'agent_list', 'agent_output']) {
        assert.ok(toolNames.includes(expected), `expected enabled Agent tool ${expected}`);
      }
      assert.deepEqual(
        backendInput.toolAvailability?.groups?.find((group) => group.id === 'agent')?.toolNames,
        ['agent_spawn', 'agent_swarm', 'agent_list', 'agent_output'],
      );
      for (const capability of AGENT_RUNTIME_CAPABILITIES) {
        assert.equal(typeof backendInput[capability], 'function', `expected root ${capability}`);
      }
    });
  });

  test('Harbor replaces each backend cumulative usage snapshot', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const checkpoints: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> =
        [];
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
        recordUsageCheckpoint: (usage) => {
          checkpoints.push(usage);
        },
      });
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const parent = await registry.build('ai-sdk', backendContext(workspaceDir));
      const childContext = backendContext(workspaceDir);
      const child = await registry.build('ai-sdk', {
        ...childContext,
        sessionId: 'child-session',
        header: { ...childContext.header, id: 'child-session' },
      });
      const recordParentUsage = (
        parent as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      const recordChildUsage = (
        child as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      assert.ok(recordParentUsage);
      assert.ok(recordChildUsage);

      await recordParentUsage({
        inputTokens: 11,
        outputTokens: 2,
        cacheHitInputTokens: 3,
        cachedInputTokens: 3,
        cacheMissInputTokens: 7,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 1,
        reasoningTokens: 1,
        totalTokens: 13,
        costUsd: 0.004,
      });
      await recordChildUsage({
        inputTokens: 5,
        outputTokens: 2,
        cacheHitInputTokens: 1,
        cachedInputTokens: 1,
        cacheMissInputTokens: 4,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 7,
        costUsd: 0.002,
      });
      await recordParentUsage({
        inputTokens: 19,
        outputTokens: 5,
        cacheHitInputTokens: 6,
        cachedInputTokens: 6,
        cacheMissInputTokens: 11,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 2,
        reasoningTokens: 4,
        totalTokens: 24,
        costUsd: 0.009,
      });

      assert.deepEqual(
        checkpoints.map(({ inputTokens, outputTokens, totalTokens }) => ({
          inputTokens,
          outputTokens,
          totalTokens,
        })),
        [
          { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
          { inputTokens: 16, outputTokens: 4, totalTokens: 20 },
          { inputTokens: 24, outputTokens: 7, totalTokens: 31 },
        ],
      );
    });
  });

  test('Harbor retains usage across repeated backend registrations for one run', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const checkpoints: Array<{ inputTokens: number; outputTokens: number }> = [];
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
        recordUsageCheckpoint: (usage) => {
          checkpoints.push(usage);
        },
      });
      const context = {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk' as const,
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: {
          kind: 'external' as const,
          label: 'Harbor task container',
          toolExecutor: fakeToolExecutor(),
        },
        toolExecutor: fakeToolExecutor(),
      };
      const recorders: Array<NonNullable<AiSdkBackendInput['recordUsageCheckpoint']>> = [];
      for (const sessionId of ['attempt-1', 'attempt-2']) {
        const registry = new BackendRegistry();
        await registerProjectedAiSdkBackend(register, registry, context);
        const backendContextInput = backendContext(workspaceDir);
        const backend = await registry.build('ai-sdk', {
          ...backendContextInput,
          sessionId,
          header: { ...backendContextInput.header, id: sessionId },
        });
        const recorder = (
          backend as unknown as {
            input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
          }
        ).input.recordUsageCheckpoint;
        assert.ok(recorder);
        recorders.push(recorder);
      }

      await recorders[0]!({
        inputTokens: 90,
        outputTokens: 10,
        cacheHitInputTokens: 20,
        cachedInputTokens: 20,
        cacheMissInputTokens: 70,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 2,
        totalTokens: 100,
        costUsd: 0.01,
      });
      await recorders[1]!({
        inputTokens: 8,
        outputTokens: 2,
        cacheHitInputTokens: 3,
        cachedInputTokens: 3,
        cacheMissInputTokens: 5,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 0,
        reasoningTokens: 1,
        totalTokens: 10,
        costUsd: 0.002,
      });

      assert.deepEqual(
        checkpoints.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })),
        [
          { inputTokens: 90, outputTokens: 10 },
          { inputTokens: 98, outputTokens: 12 },
        ],
      );
    });
  });

  test('Harbor preserves pricing and cache fields in parent-child usage aggregates', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const checkpoints: Array<{
        cacheHitInputTokens: number;
        cacheMissInputTokens: number;
        cacheMissInputSource: 'explicit' | 'derived';
        cacheWriteInputTokens: number;
        reasoningTokens: number;
        costUsd?: number;
      }> = [];
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
        recordUsageCheckpoint: (usage) => {
          checkpoints.push(usage);
        },
      });
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const parent = await registry.build('ai-sdk', backendContext(workspaceDir));
      const child = await registry.build('ai-sdk', backendContext(workspaceDir));
      const recordParentUsage = (
        parent as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      const recordChildUsage = (
        child as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      assert.ok(recordParentUsage);
      assert.ok(recordChildUsage);

      await recordParentUsage({
        inputTokens: 14,
        outputTokens: 3,
        cacheHitInputTokens: 4,
        cachedInputTokens: 4,
        cacheMissInputTokens: 8,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 17,
        costUsd: 0.006,
      });
      await recordChildUsage({
        inputTokens: 9,
        outputTokens: 5,
        cacheHitInputTokens: 5,
        cachedInputTokens: 5,
        cacheMissInputTokens: 4,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 2,
        totalTokens: 14,
        costUsd: 0.008,
      });

      const aggregate = checkpoints.at(-1);
      assert.ok(aggregate);
      assert.deepEqual(
        {
          cacheHitInputTokens: aggregate.cacheHitInputTokens,
          cacheMissInputTokens: aggregate.cacheMissInputTokens,
          cacheMissInputSource: aggregate.cacheMissInputSource,
          cacheWriteInputTokens: aggregate.cacheWriteInputTokens,
          reasoningTokens: aggregate.reasoningTokens,
          costUsd: aggregate.costUsd,
        },
        {
          cacheHitInputTokens: 9,
          cacheMissInputTokens: 12,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 2,
          reasoningTokens: 3,
          costUsd: 0.014,
        },
      );
    });
  });

  test('Harbor serializes concurrent aggregate checkpoint persistence', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const persisted: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> =
        [];
      let persistenceCalls = 0;
      let releaseFirstPersistence = () => {};
      const firstPersistenceBlocked = new Promise<void>((resolve) => {
        releaseFirstPersistence = resolve;
      });
      let observeFirstPersistence = () => {};
      const firstPersistenceStarted = new Promise<void>((resolve) => {
        observeFirstPersistence = resolve;
      });
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
        recordUsageCheckpoint: async (usage) => {
          persistenceCalls += 1;
          if (persistenceCalls === 1) {
            observeFirstPersistence();
            await firstPersistenceBlocked;
          }
          persisted.push(usage);
        },
      });
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const parent = await registry.build('ai-sdk', backendContext(workspaceDir));
      const child = await registry.build('ai-sdk', backendContext(workspaceDir));
      const recordParentUsage = (
        parent as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      const recordChildUsage = (
        child as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      assert.ok(recordParentUsage);
      assert.ok(recordChildUsage);

      const parentWrite = recordParentUsage({
        inputTokens: 8,
        outputTokens: 2,
        cacheHitInputTokens: 1,
        cachedInputTokens: 1,
        cacheMissInputTokens: 7,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 10,
        costUsd: 0.003,
      });
      await firstPersistenceStarted;
      const childWrite = recordChildUsage({
        inputTokens: 15,
        outputTokens: 4,
        cacheHitInputTokens: 5,
        cachedInputTokens: 5,
        cacheMissInputTokens: 10,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 2,
        totalTokens: 19,
        costUsd: 0.007,
      });
      await Promise.resolve();
      const callsBeforeRelease = persistenceCalls;
      releaseFirstPersistence();
      await Promise.all([parentWrite, childWrite]);

      assert.equal(callsBeforeRelease, 1);
      assert.deepEqual(
        persisted.map(({ inputTokens, outputTokens, totalTokens }) => ({
          inputTokens,
          outputTokens,
          totalTokens,
        })),
        [
          { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          { inputTokens: 23, outputTokens: 6, totalTokens: 29 },
        ],
      );
    });
  });

  test('Harbor continues checkpoint aggregation after a persistence failure', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const persisted: Array<{ inputTokens: number; outputTokens: number }> = [];
      let persistenceCalls = 0;
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
        recordUsageCheckpoint: (usage) => {
          persistenceCalls += 1;
          if (persistenceCalls === 1) throw new Error('checkpoint disk unavailable');
          persisted.push(usage);
        },
      });
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const parent = await registry.build('ai-sdk', backendContext(workspaceDir));
      const child = await registry.build('ai-sdk', backendContext(workspaceDir));
      const recordParentUsage = (
        parent as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      const recordChildUsage = (
        child as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      assert.ok(recordParentUsage);
      assert.ok(recordChildUsage);

      await assert.rejects(
        async () =>
          await recordParentUsage({
            inputTokens: 80,
            outputTokens: 20,
            cacheHitInputTokens: 30,
            cachedInputTokens: 30,
            cacheMissInputTokens: 50,
            cacheMissInputSource: 'explicit',
            cacheWriteInputTokens: 0,
            reasoningTokens: 5,
            totalTokens: 100,
            costUsd: 0.01,
          }),
        /checkpoint disk unavailable/,
      );
      await recordChildUsage({
        inputTokens: 8,
        outputTokens: 2,
        cacheHitInputTokens: 3,
        cachedInputTokens: 3,
        cacheMissInputTokens: 5,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 0,
        reasoningTokens: 1,
        totalTokens: 10,
        costUsd: 0.002,
      });

      assert.equal(persistenceCalls, 2);
      assert.deepEqual(
        persisted.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })),
        [{ inputTokens: 88, outputTokens: 22 }],
      );
    });
  });

  test('task-run CLI persists runtime usage checkpoints to the cell artifact directory', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot, artifactStore }) => {
      const cellArtifactDir = join(outputDir, 'cell-artifacts');
      const options = await resolveHarborRunOptions(
        [
          '--mode',
          'task-run',
          '--backend',
          'ai-sdk',
          '--isolation',
          'harbor-local',
          '--instruction',
          'solve',
          '--workdir',
          workspaceDir,
          '--out',
          outputDir,
          '--storage-root',
          storageRoot,
          '--provider',
          'openai',
          '--model',
          'gpt-5.6-sol',
        ],
        {
          OPENAI_API_KEY: 'test-key',
          MAKA_CELL_ARTIFACT_DIR: cellArtifactDir,
        },
      );
      assert.ok(options.registerBackends);
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(options.registerBackends, registry, {
        config: options.config,
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const recordUsageCheckpoint = (
        backend as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      assert.ok(recordUsageCheckpoint);

      await recordUsageCheckpoint({
        inputTokens: 21,
        outputTokens: 4,
        cacheHitInputTokens: 7,
        cachedInputTokens: 7,
        cacheMissInputTokens: 12,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 2,
        reasoningTokens: 3,
        totalTokens: 25,
        costUsd: 0.012,
      });

      assert.deepEqual(
        JSON.parse(
          await readFile(join(cellArtifactDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME), 'utf8'),
        ),
        {
          input: 21,
          output: 4,
          cachedInput: 7,
          cacheHitInput: 7,
          cacheMissInput: 12,
          cacheWriteInput: 2,
          cacheMissInputSource: 'explicit',
          reasoning: 3,
          total: 25,
          costUsd: 0.012,
          pricingSource: 'runtime',
        },
      );
    });
  });

  test('cell-mode CLI keeps usage checkpoints with its canonical cell artifacts', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot, artifactStore }) => {
      const detachedCellArtifactDir = join(outputDir, 'detached-cell-artifacts');
      const options = await resolveHarborRunOptions(
        [
          '--mode',
          'cell',
          '--backend',
          'ai-sdk',
          '--isolation',
          'harbor-local',
          '--instruction',
          'solve',
          '--workdir',
          workspaceDir,
          '--out',
          outputDir,
          '--storage-root',
          storageRoot,
          '--provider',
          'openai',
          '--model',
          'gpt-5.6-sol',
        ],
        {
          OPENAI_API_KEY: 'test-key',
          MAKA_CELL_ARTIFACT_DIR: detachedCellArtifactDir,
        },
      );
      const staleUsage = {
        inputTokens: 500,
        outputTokens: 50,
        cacheHitInputTokens: 200,
        cacheMissInputTokens: 300,
        cacheMissInputSource: 'explicit' as const,
        cacheWriteInputTokens: 0,
        reasoningTokens: 10,
        totalTokens: 550,
        costUsd: 1,
      };
      await writeHarborCellUsageCheckpoint(outputDir, staleUsage);
      const executionIdentity = {
        llmConnectionSlug: 'openai',
        model: 'gpt-5.6-sol',
        systemPromptHash: 'sha256:cell-mode-checkpoint',
        pricingProfile: 'test-profile',
      };
      await writeHarborCellExecutionIdentity(outputDir, executionIdentity);

      assert.ok(options.registerBackends);
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(options.registerBackends, registry, {
        config: options.config,
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const recordUsageCheckpoint = (
        backend as unknown as {
          input: Pick<AiSdkBackendInput, 'recordUsageCheckpoint'>;
        }
      ).input.recordUsageCheckpoint;
      assert.ok(recordUsageCheckpoint);
      await recordUsageCheckpoint({
        inputTokens: 140,
        outputTokens: 20,
        cacheHitInputTokens: 40,
        cachedInputTokens: 40,
        cacheMissInputTokens: 100,
        cacheMissInputSource: 'explicit',
        cacheWriteInputTokens: 0,
        reasoningTokens: 5,
        totalTokens: 160,
        costUsd: 0.012,
      });

      const invocation: InvocationResult = {
        invocationId: 'invocation-1',
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          {
            id: 'parent-usage',
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            runId: 'run-1',
            turnId: 'turn-1',
            ts: 100,
            partial: false,
            role: 'model',
            author: 'agent',
            actions: {
              tokenUsage: {
                input: 100,
                output: 10,
                cacheHitInput: 30,
                cacheMissInput: 70,
                cacheMissInputSource: 'explicit',
                cacheWriteInput: 0,
                reasoning: 2,
                total: 110,
                runtimeSteps: 1,
                costUsd: 0.006,
              },
            },
          },
        ],
        startedAt: 100,
        finishedAt: 200,
      };
      const artifacts = await writeHarborCellArtifacts({
        invocation,
        outputDir,
        executionIdentity,
      });

      assert.deepEqual(artifacts.output.tokenSummary, {
        input: 140,
        output: 20,
        cachedInput: 40,
        cacheHitInput: 40,
        cacheMissInput: 100,
        cacheWriteInput: 0,
        cacheMissInputSource: 'explicit',
        reasoning: 5,
        total: 160,
        costUsd: 0.012,
        pricingSource: 'runtime',
      });
      await assert.rejects(
        readFile(join(detachedCellArtifactDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME), 'utf8'),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    });
  });

  test('Harbor Read persists an isolated screenshot for the provider image input', async () => {
    await withDirs(async ({ workspaceDir, storageRoot, artifactStore }) => {
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
        'base64',
      );
      await writeFile(join(workspaceDir, 'screen.png'), pngBytes);
      const registry = new BackendRegistry();
      const toolExecutor = createHarborCellLocalToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-5.6-sol',
        },
        task: { id: 'harbor-cell', instruction: 'inspect screen', workspaceDir },
        storageRoot,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (
        backend as unknown as {
          input: Pick<AiSdkBackendInput, 'tools' | 'readAttachmentBytes'>;
        }
      ).input;
      const read = backendInput.tools.find((candidate) => candidate.name === 'Read');
      assert.ok(read);
      const result = (await read.impl(
        { path: 'screen.png' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd: workspaceDir,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      )) as {
        kind: string;
        mimeType: string;
        ref: Parameters<NonNullable<AiSdkBackendInput['readAttachmentBytes']>>[0];
      };

      assert.equal(result.kind, 'image');
      assert.equal(result.mimeType, 'image/png');
      assert.ok(backendInput.readAttachmentBytes);
      const stored = await backendInput.readAttachmentBytes(result.ref);
      assert.equal(stored.ok, true);
      if (stored.ok) assert.deepEqual(Buffer.from(stored.bytes), pngBytes);
    });
  });

  test('Harbor persists provider captures and synthesis blocks under the run storage root', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_STORAGE_ROOT: outputDir,
          MAKA_CONTEXT_SYNTHESIS_CACHE: 'on',
          MAKA_CONTEXT_SYNTHESIS_CACHE_MODE: 'read_write',
        },
        now: () => 123,
        newId: testIdFactory(),
      });
      const context: HeadlessBackendContext = {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        storageRoot,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      };
      await registerProjectedAiSdkBackend(register, registry, context);

      const backend = await registry.build('ai-sdk', {
        ...backendContext(workspaceDir),
        recordProviderRequestCapture: async () => {},
      });
      const backendInput = (
        backend as unknown as {
          input: Pick<
            AiSdkBackendInput,
            'loadSynthesisCache' | 'writeSynthesisCache' | 'recordProviderRequestCapture'
          >;
        }
      ).input;
      assert.ok(backendInput.loadSynthesisCache);
      assert.ok(backendInput.writeSynthesisCache);
      assert.ok(backendInput.recordProviderRequestCapture);
      await backendInput.loadSynthesisCache({ sessionId: 'session-1' });
      const capture: ProviderRequestCaptureRecord = {
        schemaVersion: 2,
        traceId: 'trace-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        step: 0,
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        requestHash: 'sha256:request',
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request',
        requestBytes: 18,
        segments: [],
        serializedRequest: '{"prompt":"hello"}',
      };
      await backendInput.recordProviderRequestCapture(capture);

      const sourceResult = { key: 'key-alpha', sentinel: 'SYNTH_SENTINEL' };
      const serializedResult = JSON.stringify(sourceResult);
      const sourceBodySha256 = sha256(serializedResult);
      const synthesisWrite: SynthesisCacheWriteInput = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        source: {
          createdFrom: 'gated_archive_retrieval',
          query: 'Recover key-alpha sentinel',
          hydratedRuntimeEvents: [
            {
              id: 'runtime-result-1',
              sessionId: 'session-1',
              runId: 'run-1',
              turnId: 'turn-1',
              invocationId: 'invocation-1',
              ts: 122,
              partial: false,
              role: 'tool',
              author: 'tool',
              content: {
                kind: 'function_response',
                id: 'tool-call-1',
                name: 'Read',
                result: sourceResult,
              },
            },
          ],
          retrievedArchiveRefs: [
            {
              kind: 'archived_tool_result',
              sessionId: 'session-1',
              turnId: 'turn-1',
              runtimeEventId: 'runtime-result-1',
              toolCallId: 'tool-call-1',
              toolName: 'Read',
              artifactId: 'archive-artifact-1',
              bodySha256: sourceBodySha256,
              originalEstimatedTokens: 12,
              originalBytes: Buffer.byteLength(serializedResult, 'utf8'),
              placeholderReason: 'stale_tool_result_pruned_before_compact',
            },
          ],
          archiveRetrievalMode: 'history_search_gated',
        },
        limits: {
          maxBlocks: 1,
          maxBlockEstimatedTokens: 1_024,
          maxEstimatedTokens: 2_048,
          charsPerToken: 4,
        },
      };
      const synthesisResult = await backendInput.writeSynthesisCache(synthesisWrite);
      assert.equal(synthesisResult?.blocks.length, 1);

      const records = await artifactStore.list('session-1');
      assert.deepEqual(records.map((record) => record.source).sort(), [
        'provider_request_capture',
        'synthesis_cache_block',
      ]);
      const outputStorage = await openHeadlessStorageForWrite(outputDir);
      assert.deepEqual(await outputStorage.artifactStore.list('session-1'), []);
    });
  });

  test('Harbor ai-sdk backend uses the discovered GitHub Copilot wire', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'github-copilot',
        model: 'gpt-5.4',
        env: {
          COPILOT_GITHUB_TOKEN: 'github_pat_account_token',
          MAKA_MODEL_API_PROTOCOL: 'openai-responses',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'github-copilot',
          model: 'gpt-5.4',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (
        backend as unknown as {
          input: {
            connection: LlmConnection;
            apiKey: string;
            modelId: string;
            modelFactory: (input: {
              connection: LlmConnection;
              apiKey: string;
              modelId: string;
            }) => {
              provider: string;
            };
          };
        }
      ).input;
      const model = backendInput.modelFactory({
        connection: backendInput.connection,
        apiKey: backendInput.apiKey,
        modelId: backendInput.modelId,
      });

      assert.equal(model.provider, 'openai.responses');
    });
  });

  test('Harbor task experiment context flag enables task tools and replay only when requested', async () => {
    assert.ok(HARBOR_CELL_CONTEXT_ENV_KEYS.includes('MAKA_CONTEXT_TASK_TOOLS' as never));
    assert.ok(!HARBOR_CELL_CONTEXT_ENV_KEYS.includes('MAKA_CONTEXT_TASK_TOOL_SHAPE' as never));
    assert.deepEqual(
      buildHarborCellTaskLedgerExperimentPolicy({ MAKA_CONTEXT_TASK_TOOLS: 'off' }),
      undefined,
    );
    assert.deepEqual(
      buildHarborCellTaskLedgerExperimentPolicy({
        MAKA_CONTEXT_TASK_TOOLS: 'on',
        MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS: '700',
      }),
      { enabled: true, replayMaxChars: 700 },
    );
    assert.throws(
      () =>
        buildHarborCellTaskLedgerExperimentPolicy({
          MAKA_CONTEXT_TASK_TOOLS: 'on',
          MAKA_CONTEXT_TASK_TOOL_SHAPE: 'crud',
        } as never),
      /unsupported Harbor context env key: MAKA_CONTEXT_TASK_TOOL_SHAPE/,
    );

    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const offRegistry = new BackendRegistry();
      const offRegister = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
      });
      const toolExecutor = fakeToolExecutor();
      await registerProjectedAiSdkBackend(offRegister, offRegistry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const offBackend = await offRegistry.build('ai-sdk', backendContext(workspaceDir));
      const offInput = (
        offBackend as unknown as {
          input: { tools: Array<{ name: string }>; turnTailPrompt?: unknown };
        }
      ).input;
      assert.ok(!offInput.tools.some((tool) => tool.name.startsWith('task_')));
      assert.equal(offInput.turnTailPrompt, undefined);

      const todoRegistry = new BackendRegistry();
      const todoRegister = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_CONTEXT_TASK_TOOLS: 'on',
        },
        now: () => 123,
        newId: testIdFactory(),
      });
      await registerProjectedAiSdkBackend(todoRegister, todoRegistry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const todoBackend = await todoRegistry.build('ai-sdk', backendContext(workspaceDir));
      const todoInput = (
        todoBackend as unknown as {
          input: {
            tools: Array<{ name: string; impl: Function }>;
            turnTailPrompt?: (context: {
              sessionId: string;
              cwd?: string;
              workspaceRoot?: string;
            }) => Promise<string | undefined>;
          };
        }
      ).input;
      assert.ok(todoInput.tools.some((tool) => tool.name === 'todo_write'));
      assert.ok(!todoInput.tools.some((tool) => tool.name.startsWith('task_')));
      assert.ok(todoInput.turnTailPrompt);
      const emptyTodoReplay = await todoInput.turnTailPrompt({
        sessionId: 'session-todo',
        cwd: workspaceDir,
      });
      assert.match(
        emptyTodoReplay ?? '',
        /Use todo_write at the start of long-running, multi-step tasks/,
      );

      const todoWrite = todoInput.tools.find((tool) => tool.name === 'todo_write');
      assert.ok(todoWrite);
      await todoWrite.impl(
        {
          todos: [{ content: 'Run focused benchmark slice', status: 'in_progress' }],
        },
        {
          sessionId: 'session-todo',
          turnId: 'turn-1',
          cwd: workspaceDir,
          toolCallId: 'tool-todo-write',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );

      const todoReplay = await todoInput.turnTailPrompt({
        sessionId: 'session-todo',
        cwd: workspaceDir,
      });
      assert.match(
        todoReplay ?? '',
        /Use todo_write at the start of long-running, multi-step tasks/,
      );
      assert.match(todoReplay ?? '', /Run focused benchmark slice/);
    });
  });

  test('Harbor ai-sdk backend passes an explicit system prompt through unchanged', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: { DEEPSEEK_API_KEY: 'test-key' },
        now: () => 123,
        newId: () => 'id',
      });
      // Trailing newline kept on purpose: the controller hashes these exact bytes.
      const candidatePrompt = 'CANDIDATE SYSTEM PROMPT — exact bytes.\n';
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPrompt: candidatePrompt,
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as { input: { systemPrompt?: string } }).input;
      assert.equal(backendInput.systemPrompt, candidatePrompt);
      assert.doesNotMatch(
        backendInput.systemPrompt ?? '',
        /Maka Runtime|Prefer Read, Glob, and Grep/,
      );
    });
  });

  test('Harbor ai-sdk backend honors MAKA_TRIAL_* pricing override', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: {
          DEEPSEEK_API_KEY: 'test-key',
          MAKA_TRIAL_INPUT_USD_PER_1M: '0.145',
          MAKA_TRIAL_OUTPUT_USD_PER_1M: '0.29',
          MAKA_TRIAL_CACHE_READ_USD_PER_1M: '0.0029',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const lookupPricing = (
        backend as unknown as {
          input: { lookupPricing?: (key: string) => unknown };
        }
      ).input.lookupPricing;
      assert.ok(lookupPricing, 'expected lookupPricing to be wired');
      assert.deepEqual(lookupPricing('deepseek:deepseek-v4-flash'), {
        modelKey: 'deepseek:deepseek-v4-flash',
        inputUsdPer1M: 0.145,
        outputUsdPer1M: 0.29,
        cacheReadUsdPer1M: 0.0029,
      });
    });
  });

  test('Harbor ai-sdk backend wires env-driven tool-result archive pruning', async () => {
    await withDirs(async ({ workspaceDir, outputDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '1',
          MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: '0',
          MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2',
          MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT: 'on',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER: '2',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO: '0.5',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: '16384',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES: '4',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS: '1024',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: 'history_search_gated',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS: '1',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (
        backend as unknown as {
          input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
        }
      ).input;
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.enabled, true);
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.maxResultEstimatedTokens, 1);
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 0);
      assert.equal(backendInput.contextBudget?.activeToolResultPrune?.enabled, true);
      assert.equal(
        backendInput.contextBudget?.activeToolResultPrune?.maxCurrentResultEstimatedTokens,
        2,
      );
      assert.equal(backendInput.contextBudget?.activeToolResultPrune?.minStepNumber, 1);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.enabled, true);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.minStepNumber, 2);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.highWaterRatio, 0.5);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.maxActiveEstimatedTokens, 16384);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.minRecentMessages, 4);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.maxSummaryEstimatedTokens, 1024);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.enabled, true);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.mode, 'history_search_gated');
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxResults, 1);
      assert.ok(backendInput.archiveToolResult, 'expected archive writer');
      assert.ok(backendInput.readToolResultArchive, 'expected archive reader');

      const serializedResult = JSON.stringify({ body: 'large tool result' });
      const bodySha256 = createHash('sha256').update(serializedResult).digest('hex');
      const originalBytes = Buffer.byteLength(serializedResult, 'utf8');
      const archived = await backendInput.archiveToolResult({
        sessionId: 'session-1',
        runtimeEventId: 'rt-result',
        turnId: 'turn-old',
        toolCallId: 'tool-1',
        toolName: 'Read',
        result: { body: 'large tool result' },
        serializedResult,
        originalEstimatedTokens: 99,
        originalBytes,
        rewriteVersion: 1,
        reason: 'stale_tool_result_pruned_before_compact',
        bodySha256,
      });
      assert.ok(archived?.artifactId);
      assert.match(
        await readFile(join(outputDir, 'tool-result-archives', archived.artifactId), 'utf8'),
        /"runtimeEventId":"rt-result"/,
      );

      const read = await backendInput.readToolResultArchive({
        kind: 'maka.archived_tool_result',
        rewriteVersion: 1,
        artifactId: archived.artifactId,
        runtimeEventId: 'rt-result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        bodySha256,
        originalEstimatedTokens: 99,
        originalBytes,
        reason: 'stale_tool_result_pruned_before_compact',
        sessionId: 'session-1',
      });
      assert.deepEqual(read, { ok: true, serializedResult });
    });
  });

  // Eager retrieval only hydrates stale-kind placeholders, so a retrieval arm
  // is structurally inert unless a placeholder producer (stale prune) and the
  // archive reader are wired alongside it. The #340-era arms enabled retrieval
  // without stale prune and it never fired; this contract pins the live shape.
  test('Harbor eager archive-retrieval arm gets a placeholder producer and archive reader by default', async () => {
    await withDirs(async ({ workspaceDir, outputDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (
        backend as unknown as {
          input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
        }
      ).input;
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.enabled, true);
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 0);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.enabled, true);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.mode, undefined);
      assert.ok(
        backendInput.archiveToolResult,
        'expected archive writer for the placeholder producer',
      );
      assert.ok(backendInput.readToolResultArchive, 'expected archive reader for eager hydration');
    });
  });

  test('Harbor ai-sdk backend leaves context budget policy off when explicitly disabled', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_CONTEXT_BUDGET: 'off',
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (
        backend as unknown as {
          input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
        }
      ).input;
      assert.equal(backendInput.contextBudget, undefined);
      assert.equal(backendInput.archiveToolResult, undefined);
      assert.equal(backendInput.readToolResultArchive, undefined);
    });
  });

  test('Harbor context budget env rejects explicit malformed positive integers', async () => {
    for (const raw of ['abc', '0', '-1', '1x']) {
      await withDirs(async ({ workspaceDir, artifactStore }) => {
        const registry = new BackendRegistry();
        const toolExecutor = fakeToolExecutor();

        await assert.rejects(
          async () => {
            const register = buildAiSdkCellBackendRegistration({
              provider: 'openai',
              model: 'gpt-4o-mini',
              env: {
                OPENAI_API_KEY: 'test-key',
                MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
                MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS: raw,
              },
              now: () => 123,
              newId: () => 'id',
            });
            await registerProjectedAiSdkBackend(register, registry, {
              config: {
                id: 'harbor-ai-sdk',
                backend: 'ai-sdk',
                llmConnectionSlug: 'openai',
                model: 'gpt-4o-mini',
              },
              task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
              storageRoot: workspaceDir,
              workspaceDir,
              artifactStore,
              realBackendIsolation: {
                kind: 'external',
                label: 'Harbor task container',
                toolExecutor,
              },
              toolExecutor,
            });
          },
          new RegExp(
            `MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS must be a positive integer, got ${JSON.stringify(raw)}`,
          ),
        );
      });
    }
  });

  test('Harbor context budget env rejects explicit malformed numeric knobs', () => {
    assert.throws(
      () =>
        buildHarborCellContextBudgetBackendOptions({
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_HISTORY_BUDGET_TOKENS: '1000x',
        }),
      /MAKA_CONTEXT_HISTORY_BUDGET_TOKENS must be a non-negative integer, got "1000x"/,
    );
    assert.throws(
      () =>
        buildHarborCellContextBudgetBackendOptions({
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_HISTORY_BUDGET_TURNS: '-1',
        }),
      /MAKA_CONTEXT_HISTORY_BUDGET_TURNS must be a non-negative integer, got "-1"/,
    );
    assert.throws(
      () =>
        buildHarborCellContextBudgetBackendOptions({
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_MIN_RECENT_TURNS: '1.5',
        }),
      /MAKA_CONTEXT_MIN_RECENT_TURNS must be a non-negative integer, got "1.5"/,
    );
    assert.throws(
      () =>
        buildHarborCellContextBudgetBackendOptions({
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS: 'old',
        }),
      /MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS must be a non-negative integer, got "old"/,
    );
  });

  test('Harbor context budget env rejects explicit malformed archive retrieval mode', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();

      await assert.rejects(async () => {
        const register = buildAiSdkCellBackendRegistration({
          provider: 'openai',
          model: 'gpt-4o-mini',
          env: {
            OPENAI_API_KEY: 'test-key',
            MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
            MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: 'histroy_search_gated',
          },
          now: () => 123,
          newId: () => 'id',
        });
        await registerProjectedAiSdkBackend(register, registry, {
          config: {
            id: 'harbor-ai-sdk',
            backend: 'ai-sdk',
            llmConnectionSlug: 'openai',
            model: 'gpt-4o-mini',
          },
          task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
          storageRoot: workspaceDir,
          workspaceDir,
          artifactStore,
          realBackendIsolation: {
            kind: 'external',
            label: 'Harbor task container',
            toolExecutor,
          },
          toolExecutor,
        });
      }, /MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE must be one of eager, history_search_gated, got "histroy_search_gated"/);
    });
  });

  test('Harbor context budget env keeps unset or blank archive retrieval knobs unspecified', async () => {
    await withDirs(async ({ workspaceDir, artifactStore }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: '',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS: '',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS: '',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES: '',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await registerProjectedAiSdkBackend(register, registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        storageRoot: workspaceDir,
        workspaceDir,
        artifactStore,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (
        backend as unknown as {
          input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
        }
      ).input;
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.mode, undefined);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxResults, undefined);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxEstimatedTokens, undefined);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxBytes, undefined);
    });
  });

  test('Harbor context budget env rejects explicit malformed booleans', () => {
    assert.throws(
      () =>
        buildHarborCellContextBudgetBackendOptions({
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'treu',
        }),
      /MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE must be a boolean/,
    );
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'onn' }),
      /MAKA_CONTEXT_ARCHIVE_RETRIEVAL must be a boolean/,
    );
  });

  test('Harbor context budget env treats explicit false-like booleans as disabled', () => {
    // archive retrieval defaults off; stale and active prune default on, so disabling
    // stale/archive alone still leaves an enabled activeToolResultPrune policy.
    assert.deepEqual(
      buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'false' })
        .contextBudget?.activeToolResultPrune,
      { enabled: true },
    );
    assert.deepEqual(
      buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'off' })
        .contextBudget?.activeToolResultPrune,
      { enabled: true },
    );
    assert.deepEqual(
      buildHarborCellContextBudgetBackendOptions({
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'enabled',
      }).contextBudget?.activeToolResultPrune,
      { enabled: true },
    );
  });

  test('Harbor active tool result prune defaults to the measured 2048-token threshold in policy snapshots', () => {
    const snapshot = buildHarborCellContextBudgetPolicySnapshot({
      MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    });

    assert.equal(snapshot?.enabled, true);
    if (!snapshot?.enabled) throw new Error('expected context budget snapshot to be enabled');
    assert.equal(snapshot.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 2048);
  });

  test('Harbor active tool result prune is enabled by default without any env', () => {
    const backend = buildHarborCellContextBudgetBackendOptions({});
    assert.equal(backend.contextBudget?.activeToolResultPrune?.enabled, true);
    assert.deepEqual(backend.contextBudget?.activeToolResultPrune, { enabled: true });

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({});
    assert.equal(snapshot?.enabled, true);
    assert.equal(snapshot?.activeToolResultPrune?.enabled, true);
    assert.equal(snapshot?.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 2048);
    assert.equal(snapshot?.activeToolResultPrune?.minStepNumber, 1);
  });

  test('Harbor active tool result prune can be disabled with explicit off', () => {
    const options = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'off',
    });
    assert.equal(options.contextBudget?.activeToolResultPrune, undefined);
    assert.deepEqual(options.contextBudget?.staleToolResultPrune, {
      enabled: true,
      minRecentTurnsFull: 0,
    });
  });

  test('Harbor stale tool result prune is enabled by default without any env', () => {
    const backend = buildHarborCellContextBudgetBackendOptions({});
    assert.deepEqual(backend.contextBudget?.staleToolResultPrune, {
      enabled: true,
      minRecentTurnsFull: 0,
    });

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({});
    assert.equal(snapshot?.enabled, true);
    assert.equal(snapshot?.staleToolResultPrune?.enabled, true);
    assert.equal(snapshot?.staleToolResultPrune?.maxResultEstimatedTokens, 2048);
    assert.equal(snapshot?.staleToolResultPrune?.minRecentTurnsFull, 0);
  });

  test('Harbor stale tool result prune can be disabled with explicit off', () => {
    const options = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'off',
    });
    assert.equal(options.contextBudget?.staleToolResultPrune, undefined);
    assert.deepEqual(options.contextBudget?.activeToolResultPrune, { enabled: true });
  });

  test('Harbor stale tool result prune does not inherit the general recent-turn window', () => {
    const fallback = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_MIN_RECENT_TURNS: '3',
    });
    assert.equal(fallback.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 0);

    const explicit = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_MIN_RECENT_TURNS: '3',
      MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS: '5',
    });
    assert.equal(explicit.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 5);
  });

  test('Harbor context budget is empty when both default-on prunes are explicitly off', () => {
    const env = {
      MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'off',
      MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'off',
    };
    assert.equal(buildHarborCellContextBudgetBackendOptions({ ...env }).contextBudget, undefined);
    assert.equal(buildHarborCellContextBudgetPolicySnapshot({ ...env }), undefined);
  });

  test('Harbor parses semantic compact policy for headless runs', () => {
    const options = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_SEMANTIC_COMPACT: 'on',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'replace',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER: '2',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: '4096',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES: '3',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS: '2',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAFE_PREFIX_ESTIMATED_TOKENS: '3072',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NEW_PREFIX_ESTIMATED_TOKENS: '2048',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACCEPTED_PROJECTION_ESTIMATED_TOKENS: '640',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS: '512',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS: '128',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO: '0.2',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS: '256',
      MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT: '0.5',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS: '768',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES: '3',
      MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS: '11',
      MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS: '30000',
      MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED: 'true',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL: 'compact-model',
      MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION: 'prompt-v-test',
    });

    assert.equal(options.contextBudget?.semanticCompact?.enabled, true);
    assert.equal(options.contextBudget?.semanticCompact?.mode, 'replace');
    assert.equal(options.contextBudget?.semanticCompact?.minStepNumber, 2);
    assert.equal(options.contextBudget?.semanticCompact?.maxActiveEstimatedTokens, 4096);
    assert.equal(options.contextBudget?.semanticCompact?.minRecentMessages, 3);
    assert.equal(options.contextBudget?.semanticCompact?.minRecentToolPairs, 2);
    assert.equal(options.contextBudget?.semanticCompact?.minSafePrefixEstimatedTokens, 3072);
    assert.equal(options.contextBudget?.semanticCompact?.minNewPrefixEstimatedTokens, 2048);
    assert.equal(options.contextBudget?.semanticCompact?.maxAcceptedProjectionEstimatedTokens, 640);
    assert.equal(options.contextBudget?.semanticCompact?.maxSummaryEstimatedTokens, 512);
    assert.equal(options.contextBudget?.semanticCompact?.minSavingsTokens, 128);
    assert.equal(options.contextBudget?.semanticCompact?.minSavingsRatio, 0.2);
    assert.equal(options.contextBudget?.semanticCompact?.minNetSavingsTokens, 256);
    assert.equal(options.contextBudget?.semanticCompact?.compactCallTokenCostWeight, 0.5);
    assert.equal(options.contextBudget?.semanticCompact?.maxCompactCallTokens, 768);
    assert.equal(options.contextBudget?.semanticCompact?.maxConsecutiveInvalidSummaries, 3);
    assert.equal(options.contextBudget?.semanticCompact?.invalidSummaryCooldownSteps, 11);
    assert.equal(options.contextBudget?.semanticCompact?.timeoutMs, 30000);
    assert.equal(options.contextBudget?.semanticCompact?.archiveRequired, true);
    assert.equal(options.contextBudget?.semanticCompact?.summarizerModel, 'compact-model');
    assert.equal(options.contextBudget?.semanticCompact?.promptVersion, 'prompt-v-test');

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({
      MAKA_CONTEXT_SEMANTIC_COMPACT: 'on',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'validate_only',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS: '1',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS: '64',
    });
    assert.equal(snapshot?.enabled, true);
    if (!snapshot?.enabled) throw new Error('expected context budget snapshot to be enabled');
    assert.equal(snapshot.semanticCompact?.mode, 'validate_only');
    assert.equal(snapshot.semanticCompact?.minRecentToolPairs, 1);
    assert.equal(snapshot.semanticCompact?.minSavingsTokens, 64);
  });

  test('Harbor parses a synthesis-cache-only arm and reflects it in the snapshot', () => {
    // A benchmark arm may enable only the synthesis cache; the backend options
    // must still build a policy (regression guard for the early-return that
    // previously required one of the other context-budget mechanisms).
    const options = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_SYNTHESIS_CACHE: 'on',
      MAKA_CONTEXT_SYNTHESIS_CACHE_MODE: 'read_write',
      MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS: '2',
      MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS: '4096',
      MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS: '2048',
    });
    assert.equal(options.contextBudget?.synthesisCache?.enabled, true);
    assert.equal(options.contextBudget?.synthesisCache?.mode, 'read_write');
    assert.equal(options.contextBudget?.synthesisCache?.maxBlocks, 2);
    assert.equal(options.contextBudget?.synthesisCache?.maxEstimatedTokens, 4096);
    assert.equal(options.contextBudget?.synthesisCache?.maxBlockEstimatedTokens, 2048);
    assert.equal(options.contextBudget?.synthesisCache?.invalidateOnNewToolResult, true);
    assert.equal(options.contextBudget?.synthesisCache?.schemaVersion, 1);

    // Defaults: mode falls back to lookup and the bounds match the runtime policy.
    const defaults = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_SYNTHESIS_CACHE: 'on',
    });
    assert.equal(defaults.contextBudget?.synthesisCache?.mode, 'lookup');
    assert.equal(defaults.contextBudget?.synthesisCache?.maxBlocks, 1);
    assert.equal(defaults.contextBudget?.synthesisCache?.maxEstimatedTokens, 2048);
    assert.equal(defaults.contextBudget?.synthesisCache?.maxBlockEstimatedTokens, 1024);

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({
      MAKA_CONTEXT_SYNTHESIS_CACHE: 'on',
      MAKA_CONTEXT_SYNTHESIS_CACHE_MODE: 'read_write',
      MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS: '2',
    });
    assert.equal(snapshot?.enabled, true);
    if (!snapshot?.enabled) throw new Error('expected context budget snapshot to be enabled');
    assert.equal(snapshot.synthesisCache?.mode, 'read_write');
    assert.equal(snapshot.synthesisCache?.maxBlocks, 2);
    assert.equal(snapshot.synthesisCache?.schemaVersion, 1);
  });

  test('env entrypoint keeps slashful model ids when provider is explicit', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];
      const registerAiSdkBackend = (
        registry: BackendRegistry,
        context: HeadlessBackendContext,
      ): void => {
        seenContexts.push(context);
        registry.register(
          'ai-sdk',
          (ctx) =>
            new CellReportingBackend(
              { sessionId: ctx.sessionId, header: ctx.header, store: ctx.store },
              'ai-sdk',
            ),
        );
      };

      await runHarborCellFromEnv(
        {
          MAKA_INSTRUCTION: 'solve through an OpenAI-compatible gateway',
          MAKA_PROVIDER: 'openai-compatible',
          MAKA_MODEL: 'anthropic/claude-sonnet-4-5',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        },
        {
          registerBackends: registerAiSdkBackend,
        },
      );

      assert.equal(seenContexts[0].config.llmConnectionSlug, 'openai-compatible');
      assert.equal(seenContexts[0].config.model, 'anthropic/claude-sonnet-4-5');
    });
  });

  test('env entrypoint keeps Pi-only model ids out of the Maka provider parser', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];

      const result = await runHarborCellFromEnv(
        {
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: 'solve through pi',
          MAKA_MODEL: 'volcengine/glm-5.2',
          MAKA_PI_PROVIDER: 'volcengine-plan',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        },
        {
          registerBackends: (registry, context) => {
            seenContexts.push(context);
            registerTestPiAgentBackend(registry, () => ({
              async *send() {
                yield { type: 'text_complete', text: 'pi done' };
                yield { type: 'complete' };
              },
            }));
          },
        },
      );

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts[0]?.config.backend, 'pi-agent');
      assert.equal(seenContexts[0]?.config.llmConnectionSlug, 'volcengine-plan');
      assert.equal(seenContexts[0]?.config.model, 'volcengine/glm-5.2');
    });
  });

  test('env entrypoint defaults the Pi connection slug when provider is omitted', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];

      const result = await runHarborCellFromEnv(
        {
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: 'solve through pi',
          MAKA_MODEL: 'glm-5.2',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        },
        {
          registerBackends: (registry, context) => {
            seenContexts.push(context);
            registerTestPiAgentBackend(registry, () => ({
              async *send() {
                yield { type: 'text_complete', text: 'pi done' };
                yield { type: 'complete' };
              },
            }));
          },
        },
      );

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts[0]?.config.llmConnectionSlug, 'pi-agent');
      assert.equal(seenContexts[0]?.config.model, 'glm-5.2');
    });
  });

  test('env entrypoint registers the Pi CLI transport by default for pi-agent', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('pi-default-argv.json', JSON.stringify(process.argv.slice(2)));
writeFileSync('pi-default-stdin.txt', readFileSync(0, 'utf8'));
writeFileSync('pi-default-proof.txt', 'ran via default pi cli\\n');
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi ok' } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.0003 } } }] }));
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through default pi transport',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(
        await readFile(join(workspaceDir, 'pi-default-proof.txt'), 'utf8'),
        'ran via default pi cli\n',
      );
      const argv = JSON.parse(
        await readFile(join(workspaceDir, 'pi-default-argv.json'), 'utf8'),
      ) as string[];
      assert.deepEqual(argv.slice(argv.indexOf('--provider'), argv.indexOf('--provider') + 2), [
        '--provider',
        'deepseek',
      ]);
      assert.equal(argv.includes('pi-agent'), false);
      assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), [
        '--model',
        'pi-test',
      ]);
      assert.equal(argv.at(-1), '-p');
      assert.equal(argv.includes('solve through default pi transport'), false);
      assert.equal(
        await readFile(join(workspaceDir, 'pi-default-stdin.txt'), 'utf8'),
        'solve through default pi transport',
      );
      assert.ok(result.output.tokenSummary);
      assert.equal(result.output.tokenSummary.input, 5);
      assert.equal(result.output.tokenSummary.output, 2);
      assert.equal(result.output.tokenSummary.costUsd, 0.0003);
    });
  });

  test('env entrypoint fails fast when default Pi CLI provider is omitted', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const keyPath = join(outputDir, 'deepseek-key');
      await writeFile(keyPath, 'deepseek-key\n', 'utf8');

      await assert.rejects(
        runHarborCellFromEnv({
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: 'solve through default pi transport',
          MAKA_MODEL: 'pi-test',
          MAKA_PI_COMMAND: join(outputDir, 'pi'),
          DEEPSEEK_API_KEY_FILE: keyPath,
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        }),
        /MAKA_PI_PROVIDER is required when using the default Pi CLI transport/,
      );
    });
  });

  for (const { provider, expectedEnv } of [
    {
      provider: 'volcengine-plan',
      expectedEnv: { XIAOMI_TOKEN_PLAN_CN_API_KEY: 'xiaomi-key' },
    },
    {
      provider: 'MiniMax',
      expectedEnv: {
        MINIMAX_API_KEY: 'minimax-key',
        MINIMAX_API_KEY_FILE: '/tmp/minimax-key',
        MINIMAX_BASE_URL: 'https://api.minimax.test',
      },
    },
    {
      provider: 'minimax-cn',
      expectedEnv: {
        MINIMAX_API_KEY: 'minimax-key',
        MINIMAX_API_KEY_FILE: '/tmp/minimax-key',
        MINIMAX_BASE_URL: 'https://api.minimax.test',
      },
    },
  ]) {
    test(`env entrypoint passes only ${provider} provider env to the Pi CLI child`, async () => {
      await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
        const piCommand = join(outputDir, 'fake-pi-env.mjs');
        await writeFile(
          piCommand,
          `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const providerEnvNames = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_API_KEY_FILE',
  'MINIMAX_BASE_URL',
];
writeFileSync('pi-env.json', JSON.stringify(Object.fromEntries(
  providerEnvNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
)));
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi ok' } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7 } }] }));
`,
          'utf8',
        );
        await chmod(piCommand, 0o755);

        const result = await runHarborCellFromEnv({
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: 'solve through scoped pi env',
          MAKA_MODEL: 'pi-test',
          MAKA_PI_COMMAND: piCommand,
          MAKA_PI_PROVIDER: provider,
          OPENAI_API_KEY: 'openai-key',
          ANTHROPIC_API_KEY: 'anthropic-key',
          GOOGLE_API_KEY: 'google-key',
          XIAOMI_TOKEN_PLAN_CN_API_KEY: 'xiaomi-key',
          MINIMAX_API_KEY: 'minimax-key',
          MINIMAX_API_KEY_FILE: '/tmp/minimax-key',
          MINIMAX_BASE_URL: 'https://api.minimax.test',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        });

        assert.equal(result.output.status, 'completed');
        assert.deepEqual(
          JSON.parse(await readFile(join(workspaceDir, 'pi-env.json'), 'utf8')),
          expectedEnv,
        );
      });
    });
  }

  test('env entrypoint fails the Pi CLI cell on non-JSON stdout', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-noisy.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
console.log('not json');
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through noisy pi transport',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'pi_agent_transport_error');
      assert.match(
        await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8'),
        /pi emitted non-JSON stdout: not json/,
      );
    });
  });

  test('env entrypoint fails the Pi CLI cell when stdout ends before agent_end', async () => {
    const cases = [
      { name: 'empty', body: '' },
      {
        name: 'wrapper-only',
        body: `
console.log(JSON.stringify({ type: 'session', id: 'session-1' }));
console.log(JSON.stringify({ type: 'turn_start' }));
`,
      },
      {
        name: 'text-without-terminal',
        body: `
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }));
`,
      },
    ];

    for (const scenario of cases) {
      await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
        const piCommand = join(outputDir, `fake-pi-${scenario.name}.mjs`);
        await writeFile(piCommand, `#!/usr/bin/env node\n${scenario.body}`, 'utf8');
        await chmod(piCommand, 0o755);

        const result = await runHarborCellFromEnv({
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: `solve through incomplete pi transport: ${scenario.name}`,
          MAKA_MODEL: 'pi-test',
          MAKA_PI_COMMAND: piCommand,
          MAKA_PI_PROVIDER: 'deepseek',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        });

        assert.equal(result.output.status, 'failed', scenario.name);
        assert.equal(result.output.errorClass, 'pi_agent_transport_error', scenario.name);
        assert.match(
          await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8'),
          /pi exited before agent_end/,
          scenario.name,
        );
      });
    }
  });

  test('env entrypoint passes long Pi instructions through stdin instead of argv', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-long-prompt.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const prompt = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});
writeFileSync('pi-long-argv.json', JSON.stringify(argv));
writeFileSync('pi-long-prompt-length.txt', String(prompt.length));
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi ok' } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7 } }] }));
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);
      const instruction = `solve long prompt\n${'x'.repeat(128 * 1024)}`;

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: instruction,
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'completed');
      const argv = JSON.parse(
        await readFile(join(workspaceDir, 'pi-long-argv.json'), 'utf8'),
      ) as string[];
      assert.equal(argv.at(-1), '-p');
      assert.equal(argv.includes(instruction), false);
      assert.equal(
        await readFile(join(workspaceDir, 'pi-long-prompt-length.txt'), 'utf8'),
        String(instruction.length),
      );
    });
  });

  test('env entrypoint fails the Pi CLI cell when the process exits non-zero after agent_end', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-fails-late.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7 } }] }));
setTimeout(() => {
  console.error('late pi failure');
  process.exit(1);
}, 25);
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through default pi transport',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'pi_agent_transport_error');
      assert.match(
        await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8'),
        /pi exited with code 1: late pi failure/,
      );
    });
  });

  test('resolves ai-sdk connection env without constructing a network backend', () => {
    const gateway = resolveHarborCellAiSdkEnv({
      provider: 'openai-compatible',
      model: 'anthropic/claude-sonnet-4-5',
      env: {
        OPENAI_API_KEY: 'gateway-key',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
      },
      ts: 123,
    });
    assert.equal(gateway.apiKey, 'gateway-key');
    assert.equal(gateway.connection.providerType, 'openai-compatible');
    assert.equal(gateway.connection.baseUrl, 'https://gateway.example/v1');
    assert.equal(gateway.connection.defaultModel, 'anthropic/claude-sonnet-4-5');

    const deepseek = resolveHarborCellAiSdkEnv({
      provider: 'deepseek',
      model: 'deepseek-chat',
      env: {
        OPENAI_API_KEY: 'fallback-key',
        OPENAI_BASE_URL: 'https://fallback.example/v1',
      },
      ts: 456,
    });
    assert.equal(deepseek.apiKey, 'fallback-key');
    assert.equal(deepseek.connection.baseUrl, 'https://fallback.example/v1');
  });

  test('requires and preserves the account-discovered GitHub Copilot model protocol', () => {
    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'github-copilot',
      model: 'gpt-5.4',
      env: {
        COPILOT_GITHUB_TOKEN: 'github_pat_copilot_requests',
        MAKA_MODEL_API_PROTOCOL: 'openai-responses',
      },
      ts: 123,
    });

    assert.equal(resolved.apiKey, 'github_pat_copilot_requests');
    assert.deepEqual(resolved.connection.models, [
      { id: 'gpt-5.4', apiProtocol: 'openai-responses' },
    ]);
    assert.throws(
      () =>
        resolveHarborCellAiSdkEnv({
          provider: 'github-copilot',
          model: 'gpt-5.4',
          env: { COPILOT_GITHUB_TOKEN: 'github_pat_copilot_requests' },
          ts: 123,
        }),
      /account-discovered model protocol/,
    );
  });

  test('preserves an explicit Kimi Coding Plan protocol without duplicating the provider', () => {
    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'kimi-coding-plan',
      model: 'k3',
      env: {
        ANTHROPIC_API_KEY: 'kimi-plan-key',
        MAKA_MODEL_API_PROTOCOL: 'openai-chat',
      },
      ts: 123,
    });

    assert.equal(resolved.connection.providerType, 'kimi-coding-plan');
    assert.deepEqual(resolved.connection.models, [{ id: 'k3', apiProtocol: 'openai-chat' }]);
  });

  test('rejects unsupported explicit Kimi Coding Plan protocol overrides', () => {
    for (const env of [
      { MAKA_MODEL_API_PROTOCOL: 'openai-responses' },
      { MAKA_HOST_MODEL_API_PROTOCOL: 'typo' },
    ]) {
      assert.throws(
        () =>
          resolveHarborCellAiSdkEnv({
            provider: 'kimi-coding-plan',
            model: 'k3',
            env: { ANTHROPIC_API_KEY: 'kimi-plan-key', ...env },
            ts: 123,
          }),
        /Kimi Coding Plan protocol must be anthropic-messages or openai-chat/,
      );
    }
  });

  test('resolves LM Studio headless configuration without credentials', () => {
    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'lm-studio',
      model: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF',
      env: {},
      ts: 123,
    });

    assert.equal(resolved.apiKey, '');
    assert.equal(resolved.connection.providerType, 'lm-studio');
    assert.equal(resolved.connection.baseUrl, 'http://127.0.0.1:1234/v1');
    assert.equal(
      resolved.connection.defaultModel,
      'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    );
  });

  test('resolves ai-sdk api key from a *_API_KEY_FILE without exposing the secret on argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-cell-key-'));
    try {
      const keyFile = join(dir, 'deepseek-key');
      await writeFile(keyFile, 'sk-secret-from-file\n', 'utf8');
      const resolved = resolveHarborCellAiSdkEnv({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: { DEEPSEEK_API_KEY_FILE: keyFile },
        ts: 1,
      });
      assert.equal(resolved.apiKey, 'sk-secret-from-file');

      // A raw key still wins over the file companion.
      const rawWins = resolveHarborCellAiSdkEnv({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: { DEEPSEEK_API_KEY: 'sk-raw', DEEPSEEK_API_KEY_FILE: keyFile },
        ts: 1,
      });
      assert.equal(rawWins.apiKey, 'sk-raw');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('falls back to stored Maka credentials for secret-free Harbor configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-cell-credentials-'));
    try {
      const credentialsPath = join(dir, 'credentials.json');
      await writeFile(
        credentialsPath,
        `${JSON.stringify({
          version: 1,
          values: {
            'zai-coding-plan:apiKey': 'stored-zai-secret',
          },
        })}\n`,
        'utf8',
      );

      const stored = resolveHarborCellAiSdkEnv({
        provider: 'zai-coding-plan',
        model: 'glm-5.2',
        env: { MAKA_CREDENTIALS_PATH: credentialsPath },
        ts: 1,
      });
      assert.equal(stored.apiKey, 'stored-zai-secret');

      const rawWins = resolveHarborCellAiSdkEnv({
        provider: 'zai-coding-plan',
        model: 'glm-5.2',
        env: { MAKA_CREDENTIALS_PATH: credentialsPath, ZAI_API_KEY: 'raw-zai-secret' },
        ts: 1,
      });
      assert.equal(rawWins.apiKey, 'raw-zai-secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createHarborHttpToolExecutor', () => {
  const createMockedHarborHttpToolExecutor = (
    env: Parameters<typeof createHarborHttpToolExecutor>[0],
  ) => createHarborHttpToolExecutor(env, globalThis.fetch as never);

  test('uses its explicit HTTP client for real bridge requests', async () => {
    const server = createServer((_request, response) => {
      response.end(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new Error('global fetch must not own Harbor bridge transport');
      };
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const executor = createHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: `http://127.0.0.1:${address.port}`,
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      assert.deepEqual(
        await executor.exec({ command: 'echo hello', cwd: '/workspace', timeoutMs: 10_000 }),
        { exitCode: 0, stdout: 'ok', stderr: '' },
      );
    } finally {
      globalThis.fetch = previousFetch;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('keeps bridge failures out of command stderr', async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'executor bridge failed' }), { status: 500 });
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      await assert.rejects(
        executor.exec({ command: 'printf unreachable', cwd: '/workspace' }),
        /Harbor tool executor failed: executor bridge failed/,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects a malformed successful bridge response', async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify(['not', 'an', 'envelope']));
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      await assert.rejects(
        executor.exec({ command: 'printf unreachable', cwd: '/workspace' }),
        /Harbor tool executor returned an invalid response/,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects conflicting bridge exit-code aliases', async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ exitCode: 0, returnCode: 9, stdout: '', stderr: '' }));
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      await assert.rejects(
        executor.exec({ command: 'printf unreachable', cwd: '/workspace' }),
        /Harbor tool executor returned an invalid response/,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects a bridge timeout paired with a successful exit code', async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ exitCode: 0, stdout: '', stderr: '', timedOut: true }));
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      await assert.rejects(
        executor.exec({ command: 'printf unreachable', cwd: '/workspace' }),
        /Harbor tool executor returned an invalid response/,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects an unsafe bridge exit code', async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ exitCode: Number.MAX_SAFE_INTEGER + 1, stdout: '', stderr: '' }),
        );
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      await assert.rejects(
        executor.exec({ command: 'printf unreachable', cwd: '/workspace' }),
        /Harbor tool executor returned an invalid response/,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('preserves a typed bridge timeout instead of command stderr', async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ exitCode: 124, stdout: '', stderr: '', timedOut: true }));
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      assert.deepEqual(await executor.exec({ command: 'sleep 60', cwd: '/workspace' }), {
        exitCode: 124,
        stdout: '',
        stderr: '',
        timedOut: true,
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('uses a long-running dispatcher without replacing active-tool cancellation', async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    let observedDispatcher: unknown;
    let observedSignal: AbortSignal | null | undefined;
    let observedBody: unknown;
    try {
      globalThis.fetch = async (_input, init) => {
        observedDispatcher = Reflect.get(init ?? {}, 'dispatcher');
        observedSignal = init?.signal;
        observedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '' }), {
          status: 200,
        });
      };
      const executor = createMockedHarborHttpToolExecutor({
        MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1',
        MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'test-token',
      });

      await executor.exec(
        { command: 'sleep until cancelled', cwd: '/workspace', timeoutMs: 600_000 },
        { abortSignal: controller.signal },
      );

      assert.ok(observedDispatcher instanceof Agent);
      // Undici has no public getter for Agent defaults. Its own options symbol is
      // the cheapest observable distinction from the default 300-second Agent.
      const optionsSymbol = Object.getOwnPropertySymbols(observedDispatcher).find(
        (symbol) => symbol.description === 'options',
      );
      assert.ok(optionsSymbol);
      const dispatcherOptions = Reflect.get(observedDispatcher, optionsSymbol);
      assert.equal(Reflect.get(dispatcherOptions, 'headersTimeout'), 0);
      assert.equal(Reflect.has(dispatcherOptions, 'bodyTimeout'), false);
      assert.equal(observedSignal, controller.signal);
      assert.deepEqual(observedBody, {
        command: 'sleep until cancelled',
        cwd: '/workspace',
        timeoutMs: 600_000,
        timeoutSec: 600,
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe('createHarborCellLocalToolExecutor', () => {
  test('cancels a bounded-tail Bash command when the active tool is aborted', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '10000' });
    const controller = new AbortController();
    const run = executor.exec(
      { command: 'sleep 1', cwd: process.cwd(), boundedTail: true },
      { abortSignal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    const result = await withTimeout(run, 250, 'local isolated command ignored tool cancellation');
    assert.notEqual(result.exitCode, 0);
  });

  test('cancels a full-output file command when the active tool is aborted', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '10000' });
    const controller = new AbortController();
    const run = executor.exec(
      { command: 'sleep 1', cwd: process.cwd() },
      { abortSignal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    const result = await withTimeout(
      run,
      250,
      'local isolated file command ignored tool cancellation',
    );
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, undefined);
  });

  test('lets MAKA_CELL_COMMAND_TIMEOUT_MS lower the default per-command timeout', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '50' });
    const result = await executor.exec({ command: 'sleep 1', cwd: process.cwd() });
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
  });

  test('lets MAKA_CELL_COMMAND_TIMEOUT_MS lower the bounded-tail Bash default timeout', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '50' });
    const result = await executor.exec({
      command: 'sleep 1',
      cwd: process.cwd(),
      boundedTail: true,
    });
    assert.notEqual(result.exitCode, 0);
  });

  test('honors an explicit per-command timeout over the configured default', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '60000' });
    const result = await executor.exec({ command: 'sleep 1', cwd: process.cwd(), timeoutMs: 50 });
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
  });

  test('does not classify a command-authored exit 124 as a timeout', async () => {
    const executor = createHarborCellLocalToolExecutor({});
    const result = await executor.exec({ command: 'exit 124', cwd: process.cwd() });
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, undefined);
  });

  test('scrubs secret-shaped env so task commands cannot read unregistered credentials', async () => {
    const executor = createHarborCellLocalToolExecutor({
      DEEPSEEK_API_KEY_FILE: '/run/secrets/deepseek-key',
      DEEPSEEK_API_KEY: 'sk-should-not-leak',
      ACME_API_KEY: 'unregistered-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google-credentials.json',
      PGPASSWORD: 'postgres-secret',
      MAX_TOKENS: '4096',
    });
    const result = await executor.exec({
      command:
        'printf "[%s][%s][%s][%s][%s][%s]" "${DEEPSEEK_API_KEY_FILE:-}" "${DEEPSEEK_API_KEY:-}" "${ACME_API_KEY:-}" "${GOOGLE_APPLICATION_CREDENTIALS:-}" "${PGPASSWORD:-}" "${MAX_TOKENS:-}"',
      cwd: process.cwd(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '[][][][][][4096]');
  });

  test('scrubs provider token env so task commands cannot read OAuth credentials', async () => {
    const executor = createHarborCellLocalToolExecutor({
      OPENAI_CODEX_OAUTH_TOKEN: 'oauth-should-not-leak',
      COPILOT_GITHUB_TOKEN: 'copilot-should-not-leak',
      HF_TOKEN: 'hf-should-not-leak',
    });
    const result = await executor.exec({
      command:
        'printf "[%s][%s][%s]" "${OPENAI_CODEX_OAUTH_TOKEN:-}" "${COPILOT_GITHUB_TOKEN:-}" "${HF_TOKEN:-}"',
      cwd: process.cwd(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '[][][]');
  });
});

function fakeToolExecutor(): IsolatedToolExecutor {
  return {
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

async function registerProjectedAiSdkBackend(
  register: (registry: BackendRegistry, context: HeadlessBackendContext) => void | Promise<void>,
  registry: BackendRegistry,
  context: HeadlessBackendContext,
): Promise<void> {
  assert.ok(context.toolExecutor);
  await register(registry, {
    ...context,
    productToolSurface: buildIsolatedHeadlessProductToolSurface(context.toolExecutor, {
      agentTools: context.config.agentTools,
      snapshotImage: createReadImageSnapshotter(context.artifactStore),
    }),
  });
}

function testIdFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function harborModelCallAttemptFixture(): ModelCallAttempt {
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
    callKind: 'semantic_compact',
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    startedAt: 1,
    completedAt: 2,
    latencyMs: 1,
    status: 'completed',
    usageBasis: 'missing',
    costBasis: 'unpriced',
  };
}

function backendContext(workspaceDir: string): BackendFactoryContext {
  return {
    sessionId: 'session-1',
    workspaceRoot: workspaceDir,
    header: {
      id: 'session-1',
      cwd: workspaceDir,
      workspaceRoot: workspaceDir,
      createdAt: 123,
      lastUsedAt: 123,
      name: 'harbor cell test',
      titleIsManual: true,
      isFlagged: false,
      labels: [],
      isArchived: false,
      status: 'active',
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionSlug: 'openai',
      connectionLocked: true,
      model: 'gpt-4o-mini',
      permissionMode: 'execute',
      schemaVersion: 1,
    },
    store: {
      appendMessage: async () => {},
    } as unknown as SessionStore,
  };
}

async function withDirs<T>(
  fn: (dirs: {
    workspaceDir: string;
    outputDir: string;
    storageRoot: string;
    artifactStore: HeadlessBackendContext['artifactStore'];
  }) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'maka-cell-ws-'));
  const outputDir = await mkdtemp(join(tmpdir(), 'maka-cell-out-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-cell-store-'));
  try {
    const storage = await openHeadlessStorageForWrite(storageRoot);
    return await fn({
      workspaceDir,
      outputDir,
      storageRoot,
      artifactStore: storage.artifactStore,
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
