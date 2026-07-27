import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  BackendRegistry,
  FakeBackend,
  SessionManager,
  type AgentBackend,
  type SessionStore,
} from '@maka/runtime';
import {
  isTerminalRuntimeEvent,
  type AgentRunHeader,
  type BackendKind,
  type RuntimeEvent,
  type SessionEvent,
  type SessionHeader,
} from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import { StorageRootAuthorityError } from '@maka/storage/root-authority';
import type { Config, Task } from '../contracts.js';
import { openHeadlessStorageForWrite } from '../headless-storage.js';
import type { HeadlessBackendContext } from '../isolation.js';
import { commandResourceScope, hashNormalizedArgs } from '../permission-grants.js';
import {
  runTaskOnce,
  runTaskOnceWithStorage,
  TaskAgentController,
  type RunTaskOnceResult,
} from '../task-agent-controller.js';
import type { TaskPermissionGrant } from '../task-contracts.js';
import { buildIsolatedHeadlessTools } from '../tools.js';

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};
const agentToolsConfig: Config = {
  ...fakeConfig,
  backend: 'ai-sdk',
  agentTools: true,
};

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

function latestInvocation(result: RunTaskOnceResult) {
  const invocation = result.invocations.at(-1);
  assert.ok(invocation, 'task attempt must contain at least one invocation');
  return invocation;
}

class ReportingBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const { turnId } = input;
    const ts = Date.now();
    const messageId = 'reporting-message';
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text: 'done',
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: 'report-text', turnId, ts, messageId, text: 'done' };
    yield {
      type: 'tool_start',
      id: 'report-tool-start',
      turnId,
      ts,
      toolUseId: 'tool-1',
      toolName: 'bash',
      args: { command: 'printf artifact' },
    };
    yield {
      type: 'tool_result',
      id: 'report-artifact',
      turnId,
      ts,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'archived_tool_result',
        status: 'not_loaded',
        runtimeEventId: 'runtime-old',
        toolCallId: 'tool-1',
        toolName: 'bash',
        artifactId: 'artifact-1',
        originalEstimatedTokens: 12,
        originalBytes: 34,
        rewriteVersion: 1,
        reason: 'stale_tool_result_pruned_before_compact',
      },
    };
    yield {
      type: 'token_usage',
      id: 'report-usage',
      turnId,
      ts,
      input: 10,
      output: 5,
      reasoning: 2,
      total: 17,
      costUsd: 0.123,
      contextBudget: {
        enabled: true,
        policyName: 'unit-budget',
        estimatedTokensBefore: 20,
        estimatedTokensAfter: 10,
        keptTurns: 1,
        droppedTurns: 1,
        keptEvents: 2,
        droppedEvents: 1,
      },
    };
    yield { type: 'complete', id: 'report-complete', turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class DeadlineBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  private release!: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await this.stopped;
    yield {
      type: 'complete',
      id: 'deadline-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.release();
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ChildCapabilityBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly context: HeadlessBackendContext,
    private readonly observed: {
      childSessionId?: string;
      childStatus?: string;
      listedSessionIds?: string[];
      outputSessionId?: string;
    },
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    assert.ok(this.context.spawnChildSession);
    assert.ok(this.context.listChildAgents);
    assert.ok(this.context.readChildAgentOutput);
    assert.ok(input.runId);
    const child = await this.context.spawnChildSession(this.sessionId, {
      spawnedBy: {
        parentRunId: input.runId,
        parentTurnId: input.turnId,
        toolCallId: 'child-capability-call',
      },
      agentProfile: 'local_read',
      prompt: 'inspect the task workspace',
    });
    const listed = await this.context.listChildAgents(this.sessionId);
    const output = await this.context.readChildAgentOutput(this.sessionId, {
      execution: {
        kind: 'child_session',
        sessionId: child.childSessionId,
        currentRunId: child.runId,
      },
    });
    this.observed.childSessionId = child.childSessionId;
    this.observed.childStatus = child.status;
    this.observed.listedSessionIds = listed.executions.flatMap((execution) =>
      execution.execution.kind === 'child_session' ? [execution.execution.sessionId] : [],
    );
    this.observed.outputSessionId =
      output.execution.kind === 'child_session' ? output.execution.sessionId : undefined;
    yield {
      type: 'text_complete',
      id: 'capability-parent-text',
      turnId: input.turnId,
      ts: Date.now(),
      messageId: 'capability-parent-message',
      text: 'done',
    };
    yield {
      type: 'complete',
      id: 'capability-parent-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ChildAdmissionProbeBackend implements AgentBackend {
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
          toolCallId: 'child-admission-probe',
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
      type: 'text_complete',
      id: 'child-admission-probe-text',
      turnId: input.turnId,
      ts: Date.now(),
      messageId: 'child-admission-probe-message',
      text: 'child admission checked',
    };
    yield {
      type: 'complete',
      id: 'child-admission-probe-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class BackgroundChildBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;
  stopCalls = 0;
  runId?: string;
  private release!: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(
    sessionId: string,
    private readonly onStarted: () => void,
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.runId = input.runId;
    this.onStarted();
    await this.stopped;
    yield {
      type: 'complete',
      id: 'background-child-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.release();
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ParentWithBackgroundChildBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;
  private release!: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(
    sessionId: string,
    private readonly context: HeadlessBackendContext,
    private readonly childStarted: Promise<void>,
    private readonly observeChild: (promise: Promise<unknown>) => void,
    private readonly waitForStop: boolean,
    private readonly stopError?: Error,
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    assert.ok(input.runId);
    assert.ok(this.context.spawnChildSession);
    this.observeChild(
      this.context.spawnChildSession(this.sessionId, {
        spawnedBy: {
          parentRunId: input.runId,
          parentTurnId: input.turnId,
          toolCallId: 'background-child-call',
        },
        agentProfile: 'local_read',
        prompt: 'wait for parent cleanup',
      }),
    );
    await this.childStarted;
    if (this.waitForStop) await this.stopped;
    yield {
      type: 'text_complete',
      id: 'background-parent-text',
      turnId: input.turnId,
      ts: Date.now(),
      messageId: 'background-parent-message',
      text: 'done',
    };
    yield {
      type: 'complete',
      id: 'background-parent-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: this.waitForStop ? 'user_stop' : 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.release();
    if (this.stopError) throw this.stopError;
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class FailingStopBackgroundChildBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;
  stopCalls = 0;
  private finish!: () => void;
  private readonly finished = new Promise<void>((resolve) => {
    this.finish = resolve;
  });

  constructor(
    sessionId: string,
    private readonly onStarted: () => void,
    private readonly stopError: Error,
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.onStarted();
    await this.finished;
    yield {
      type: 'complete',
      id: 'failing-stop-child-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw this.stopError;
  }

  finishForTest(): void {
    this.finish();
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ResettingDeadlineBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';

  constructor(
    readonly sessionId: string,
    private readonly counters: { sendCalls: number },
  ) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.counters.sendCalls += 1;
    yield {
      type: 'complete',
      id: 'resetting-deadline-complete',
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class DeadlineRepairBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';

  constructor(
    readonly sessionId: string,
    private readonly state: { now: number; prompts: string[] },
  ) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.state.prompts.push(input.text);
    if (this.state.prompts.length === 1) this.state.now = 100;
    yield {
      type: 'complete',
      id: `deadline-repair-complete-${this.state.prompts.length}`,
      turnId: input.turnId,
      ts: this.state.now,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerDeadlineBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new DeadlineBackend(ctx.sessionId));
};

const registerReportingBackend = (registry: BackendRegistry): void => {
  registry.register(
    'ai-sdk',
    (ctx) =>
      new ReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class ProtectedTamperBackend implements AgentBackend {
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
    const messageId = 'tamper-message';
    await writeFile(join(this.ctx.header.cwd, 'check.mjs'), 'process.exit(0);\n', 'utf8');
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text: 'tampered with verifier asset',
      modelId: this.ctx.header.model,
    });
    yield {
      type: 'text_complete',
      id: 'tamper-text',
      turnId,
      ts,
      messageId,
      text: 'tampered with verifier asset',
    };
    yield { type: 'complete', id: 'tamper-complete', turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerProtectedTamperBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) =>
      new ProtectedTamperBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        store: ctx.store,
      }),
  );
};

class FailingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'error',
      id: 'fail-error',
      turnId: input.turnId,
      ts,
      recoverable: false,
      reason: 'backend_failed',
      message: 'backend exploded',
    };
    yield { type: 'complete', id: 'fail-complete', turnId: input.turnId, ts, stopReason: 'error' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerFailingBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new FailingBackend(ctx.sessionId));
};

class IncompleteBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'token_usage',
      id: 'incomplete-usage',
      turnId: input.turnId,
      ts,
      input: 1,
      output: 2,
      rawFinishReason: 'tool_calls',
    };
    yield {
      type: 'complete',
      id: 'incomplete-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerIncompleteBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new IncompleteBackend(ctx.sessionId));
};

class PermissionRequestBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly onRespond: () => void,
    private readonly command: string,
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'permission-request-event',
      turnId: input.turnId,
      ts,
      requestId: 'permission-request-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: this.command },
      rememberForTurnAllowed: true,
    };
    yield {
      type: 'complete',
      id: 'permission-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'permission_handoff',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {
    this.onRespond();
    throw new Error('headless task facade must not answer interactive permission requests');
  }
  async dispose(): Promise<void> {}
}

const registerPermissionRequestBackend =
  (onRespond: () => void, command = 'rm -rf /tmp/example') =>
  (registry: BackendRegistry): void => {
    registry.register(
      'fake',
      (ctx) => new PermissionRequestBackend(ctx.sessionId, onRespond, command),
    );
  };

class ProgressToolBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      tools: ReturnType<typeof buildIsolatedHeadlessTools>;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const bash = this.ctx.tools.find((tool) => tool.name === 'Bash');
    const inventorySubmit = this.ctx.tools.find((tool) => tool.name === 'inventory_submit');
    const todoUpdate = this.ctx.tools.find((tool) => tool.name === 'todo_update');
    const selfCheckPlanSubmit = this.ctx.tools.find(
      (tool) => tool.name === 'self_check_plan_submit',
    );
    const selfCheckSubmit = this.ctx.tools.find((tool) => tool.name === 'self_check_submit');
    assert.ok(bash);
    assert.ok(inventorySubmit);
    assert.ok(todoUpdate);
    assert.ok(selfCheckPlanSubmit);
    assert.ok(selfCheckSubmit);
    const toolCtx = {
      sessionId: this.sessionId,
      turnId: input.turnId,
      cwd: this.ctx.header.cwd,
      toolCallId: 'progress-tool-call',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };
    await bash.impl({ command: 'npm test' }, { ...toolCtx, toolCallId: 'bash-tool-call' });
    await inventorySubmit.impl(
      {
        summary: 'Inspected public files.',
        items: [{ path: 'README.md', kind: 'file', status: 'observed' }],
      },
      toolCtx,
    );
    await todoUpdate.impl(
      {
        items: [
          {
            id: 'artifact',
            kind: 'runnable_artifact',
            content: 'Patch first runnable artifact',
            status: 'in_progress',
            priority: 'high',
          },
          {
            id: 'check',
            kind: 'public_check',
            content: 'Run public check after artifact exists',
            status: 'pending',
            priority: 'high',
          },
        ],
      },
      toolCtx,
    );
    await selfCheckPlanSubmit.impl(
      {
        finalArtifacts: [
          {
            path: '/app/README.md',
            purpose: 'visible public artifact inspected by the check',
            publicReason: 'visible task notes are public',
          },
        ],
        selfCheckScratch: {
          root: '/tmp/maka-self-check/progress',
          expectedGeneratedPaths: ['/tmp/maka-self-check/progress/check.log'],
          publicReason: 'public check outputs stay under scratch',
        },
        workspaceGuardPlan: {
          checkedPaths: ['/app/README.md'],
          expectedAddedPaths: [],
          expectedGeneratedPathsOutsideScratch: [],
          publicReason: 'public guard checks visible artifact paths',
        },
        publicReason: 'plan is derived from visible public task files',
      },
      toolCtx,
    );
    await selfCheckSubmit.impl(
      {
        status: 'pass',
        publicReason: 'npm test passed using public README.md-backed fixture state.',
        commandEvidence: [
          { command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' },
        ],
        artifactEvidence: [{ path: '/app/README.md', kind: 'file', exists: true }],
      },
      toolCtx,
    );
    const ts = Date.now();
    yield {
      type: 'tool_start',
      id: 'progress-bash-start',
      turnId: input.turnId,
      ts,
      toolUseId: 'bash-tool-call',
      toolName: 'Bash',
      args: { command: 'npm test' },
    };
    yield {
      type: 'tool_result',
      id: 'progress-bash-result',
      turnId: input.turnId,
      ts,
      toolUseId: 'bash-tool-call',
      isError: false,
      content: { kind: 'text', text: 'tests passed' },
    };
    yield {
      type: 'tool_start',
      id: 'progress-self-check-start',
      turnId: input.turnId,
      ts,
      toolUseId: 'progress-tool-call',
      toolName: 'self_check_submit',
      args: { status: 'pass' },
    };
    yield {
      type: 'tool_result',
      id: 'progress-self-check-result',
      turnId: input.turnId,
      ts,
      toolUseId: 'progress-tool-call',
      isError: false,
      content: { kind: 'text', text: 'self-check accepted' },
    };
    yield {
      type: 'complete',
      id: 'progress-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerProgressToolBackend =
  (seen: HeadlessBackendContext[]) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    seen.push(context);
    assert.ok(context.toolExecutor);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new ProgressToolBackend({
          sessionId: ctx.sessionId,
          header: ctx.header,
          tools: buildIsolatedHeadlessTools(context.toolExecutor!, {
            ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
          }),
        }),
    );
  };

class GateRepairBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      tools: ReturnType<typeof buildIsolatedHeadlessTools>;
      prompts: string[];
      repairSubmitsSelfCheck: boolean;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.prompts.push(input.text);
    const ts = Date.now();
    const turnNumber = this.ctx.prompts.length;
    if (turnNumber === 2 && this.ctx.repairSubmitsSelfCheck) {
      const todoUpdate = this.ctx.tools.find((tool) => tool.name === 'todo_update');
      const selfCheckPlanSubmit = this.ctx.tools.find(
        (tool) => tool.name === 'self_check_plan_submit',
      );
      const selfCheckSubmit = this.ctx.tools.find((tool) => tool.name === 'self_check_submit');
      assert.ok(todoUpdate);
      assert.ok(selfCheckPlanSubmit);
      assert.ok(selfCheckSubmit);
      const toolCtx = {
        sessionId: this.sessionId,
        turnId: input.turnId,
        cwd: this.ctx.header.cwd,
        toolCallId: 'gate-repair-tool-call',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      };
      await todoUpdate.impl(
        {
          items: [
            {
              id: 'artifact',
              kind: 'runnable_artifact',
              content: 'Keep marker.txt as the runnable artifact',
              status: 'completed',
              priority: 'high',
              evidence: 'test -f marker.txt passed.',
            },
            {
              id: 'check',
              kind: 'public_check',
              content: 'Run public marker check',
              status: 'completed',
              priority: 'high',
              evidence: 'test -f marker.txt passed.',
            },
          ],
        },
        toolCtx,
      );
      await selfCheckPlanSubmit.impl(
        {
          finalArtifacts: [
            {
              path: 'marker.txt',
              purpose: 'visible runnable artifact',
              publicReason: 'visible task asks for marker.txt to exist',
            },
          ],
          selfCheckScratch: {
            root: '/tmp/maka-self-check/gate-repair',
            expectedGeneratedPaths: ['/tmp/maka-self-check/gate-repair/check.log'],
            publicReason: 'public check outputs stay under scratch',
          },
          workspaceGuardPlan: {
            checkedPaths: ['marker.txt'],
            expectedAddedPaths: [],
            expectedGeneratedPathsOutsideScratch: [],
            publicReason: 'public guard checks marker.txt',
          },
          publicReason: 'plan is derived from visible public task evidence',
        },
        toolCtx,
      );
      await selfCheckSubmit.impl(
        {
          status: 'pass',
          publicReason: 'test -f marker.txt passed from public workspace evidence.',
          commandEvidence: [
            {
              command: 'test -f marker.txt',
              exitCode: 0,
              outputExcerpt: 'marker present',
              artifactRefs: ['marker.txt'],
            },
          ],
          artifactEvidence: [{ path: 'marker.txt', kind: 'file', exists: true }],
          executionHygiene: {
            sandbox: {
              root: '/tmp/maka-self-check/gate-repair',
              strategy: 'read_only_deliverable_refs',
              commandCwd: '/tmp/maka-self-check/gate-repair',
              outputPolicy: 'scratch_only',
            },
            scratchUsed: true,
            scratchPath: '/tmp/maka-self-check/gate-repair',
            cleanupPerformed: true,
            workspaceSideEffects: 'none',
            workspaceGuard: {
              checked: true,
              checkedPaths: ['marker.txt'],
              beforeListingCommand: 'find . -maxdepth 1 -type f | sort',
              afterListingCommand: 'find . -maxdepth 1 -type f | sort',
              addedPaths: [],
              modifiedPaths: [],
              removedPaths: [],
            },
          },
        },
        toolCtx,
      );
    }
    const toolUseId = `gate-tool-${turnNumber}`;
    yield {
      type: 'tool_start',
      id: `gate-tool-start-${turnNumber}`,
      turnId: input.turnId,
      ts,
      toolUseId,
      toolName: turnNumber === 1 ? 'initial_tool' : 'repair_tool',
      args: {},
    };
    yield {
      type: 'tool_result',
      id: `gate-tool-result-${turnNumber}`,
      turnId: input.turnId,
      ts,
      toolUseId,
      isError: false,
      content: { kind: 'text', text: 'ok' },
    };
    yield {
      type: 'token_usage',
      id: `gate-usage-${turnNumber}`,
      turnId: input.turnId,
      ts,
      input: turnNumber * 10,
      output: turnNumber,
      total: turnNumber * 11,
    };
    yield {
      type: 'text_complete',
      id: `gate-text-${turnNumber}`,
      turnId: input.turnId,
      ts,
      messageId: `gate-message-${turnNumber}`,
      text: 'done',
    };
    yield {
      type: 'complete',
      id: `gate-complete-${turnNumber}`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerGateRepairBackend =
  (prompts: string[], repairSubmitsSelfCheck: boolean) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    assert.ok(context.toolExecutor);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new GateRepairBackend({
          sessionId: ctx.sessionId,
          header: ctx.header,
          tools: buildIsolatedHeadlessTools(context.toolExecutor!, {
            ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
          }),
          prompts,
          repairSubmitsSelfCheck,
        }),
    );
  };

class GateLaunderBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      tools: ReturnType<typeof buildIsolatedHeadlessTools>;
      prompts: string[];
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.prompts.push(input.text);
    const ts = Date.now();
    const turnNumber = this.ctx.prompts.length;
    const selfCheckPlanSubmit = this.ctx.tools.find(
      (tool) => tool.name === 'self_check_plan_submit',
    );
    const selfCheckSubmit = this.ctx.tools.find((tool) => tool.name === 'self_check_submit');
    assert.ok(selfCheckPlanSubmit);
    assert.ok(selfCheckSubmit);
    const toolCtx = {
      sessionId: this.sessionId,
      turnId: input.turnId,
      cwd: this.ctx.header.cwd,
      toolCallId: `launder-tool-call-${turnNumber}`,
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };
    await selfCheckPlanSubmit.impl(
      {
        finalArtifacts: [
          {
            path: '/app/polyglot/main.py.c',
            purpose: 'single-file polyglot source',
            publicReason: 'visible task asks for this final file',
          },
        ],
        selfCheckScratch: {
          root: '/tmp/maka-self-check/polyglot',
          expectedGeneratedPaths: ['/tmp/maka-self-check/polyglot/cmain'],
          publicReason: 'compile checks should stay under scratch',
        },
        workspaceGuardPlan: {
          checkedPaths: ['/app/polyglot'],
          expectedAddedPaths: [],
          expectedGeneratedPathsOutsideScratch: turnNumber === 1 ? [] : ['/app/polyglot/cmain'],
          publicReason:
            turnNumber === 1
              ? 'first plan only declares the final source file'
              : 'repair attempt tries to launder the observed cmain path',
        },
        publicReason: 'public polyglot self-check plan',
      },
      toolCtx,
    );
    await selfCheckSubmit.impl(
      {
        status: 'pass',
        publicReason: 'python and gcc checks passed, but cmain remains in /app/polyglot',
        commandEvidence: [
          {
            command: 'gcc /app/polyglot/main.py.c -o /app/polyglot/cmain && /app/polyglot/cmain 10',
            exitCode: 0,
            outputExcerpt: '55',
            artifactRefs: ['/app/polyglot/main.py.c', '/app/polyglot/cmain'],
          },
        ],
        artifactEvidence: [
          { path: '/app/polyglot/main.py.c', kind: 'file', exists: true },
          { path: '/app/polyglot/cmain', kind: 'file', exists: true },
        ],
        executionHygiene: {
          sandbox: {
            root: '/tmp/maka-self-check/polyglot',
            strategy: 'copied_inputs',
            commandCwd: '/tmp/maka-self-check/polyglot',
            outputPolicy: 'scratch_only',
          },
          scratchUsed: true,
          scratchPath: '/tmp/maka-self-check/polyglot',
          cleanupPerformed: true,
          workspaceSideEffects: 'present',
          workspaceGuard: {
            checked: true,
            checkedPaths: ['/app/polyglot'],
            beforeListingCommand: 'find /app/polyglot -maxdepth 1',
            afterListingCommand: 'find /app/polyglot -maxdepth 1',
            addedPaths: ['/app/polyglot/cmain'],
            modifiedPaths: [],
            removedPaths: [],
          },
        },
      },
      toolCtx,
    );
    yield {
      type: 'text_complete',
      id: `launder-text-${turnNumber}`,
      turnId: input.turnId,
      ts,
      messageId: `launder-message-${turnNumber}`,
      text: 'done',
    };
    yield {
      type: 'complete',
      id: `launder-complete-${turnNumber}`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerGateLaunderBackend =
  (prompts: string[]) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    assert.ok(context.toolExecutor);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new GateLaunderBackend({
          sessionId: ctx.sessionId,
          header: ctx.header,
          tools: buildIsolatedHeadlessTools(context.toolExecutor!, {
            ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
          }),
          prompts,
        }),
    );
  };

async function withDirs<T>(
  fn: (fixtureDir: string, storageRoot: string) => Promise<T>,
): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-task-controller-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-controller-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function readRuntimeEventLedger(
  storageRoot: string,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent[]> {
  const runtimeEventsPath = join(
    storageRoot,
    'sessions',
    sessionId,
    'runs',
    runId,
    'runtime-events.jsonl',
  );
  const content = await readFile(runtimeEventsPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}

async function readAgentRunHeader(
  storageRoot: string,
  sessionId: string,
  runId: string,
): Promise<AgentRunHeader> {
  const runPath = join(storageRoot, 'sessions', sessionId, 'runs', runId, 'run.json');
  return JSON.parse(await readFile(runPath, 'utf8')) as AgentRunHeader;
}

describe('runTaskOnce', () => {
  test('gives task-run backends the authoritative current-run event reader', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      let loadTurnRuntimeEvents: ((turnId: string) => Promise<RuntimeEvent[]>) | undefined;
      const task: Task = {
        id: 'runtime-event-reader-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce({ ...fakeConfig, backend: 'ai-sdk' }, task, {
        storageRoot,
        registerBackends: (registry) => {
          registry.register('ai-sdk', (ctx) => {
            loadTurnRuntimeEvents = ctx.loadTurnRuntimeEvents;
            return new ReportingBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              store: ctx.store,
            });
          });
        },
        realBackendIsolation: { kind: 'external', label: 'unit isolation' },
      });

      assert.ok(loadTurnRuntimeEvents);
      const events = await loadTurnRuntimeEvents(latestInvocation(result).turnId);
      assert.ok(
        events.some(
          (event) =>
            event.role === 'user' &&
            event.content?.kind === 'text' &&
            event.content.text === task.instruction,
        ),
      );
      assert.ok(events.some((event) => event.status === 'completed'));
    });
  });

  test('does not provision child tools when Agent tools are disabled by default', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const observed: { spawned?: boolean; error?: string } = {};
      let buildCount = 0;
      const task: Task = {
        id: 'disabled-child-capability-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce({ ...fakeConfig, backend: 'ai-sdk' }, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ChildAdmissionProbeBackend(ctx.sessionId, context, observed);
            }
            return new FakeBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              store: ctx.store,
            });
          });
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
      assert.equal(buildCount, 1);
      assert.ok(
        !result.projection.toolExecutors[0]?.toolNames.some((name) => name.startsWith('agent_')),
      );
      assert.equal(
        result.resultRecord.status,
        'completed',
        JSON.stringify(result.resultRecord, null, 2),
      );
    });
  });

  test('lets a task-run backend spawn, list, and read a linked child session', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const observed: {
        childSessionId?: string;
        childStatus?: string;
        childToolNames?: string[];
        listedSessionIds?: string[];
        outputSessionId?: string;
      } = {};
      let buildCount = 0;
      const task: Task = {
        id: 'child-capability-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(agentToolsConfig, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ChildCapabilityBackend(ctx.sessionId, context, observed);
            }
            observed.childToolNames = ctx.tools?.map((tool) => tool.name);
            return new FakeBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              store: ctx.store,
            });
          });
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

      assert.equal(
        result.resultRecord.status,
        'completed',
        JSON.stringify(result.resultRecord, null, 2),
      );
      assert.equal(observed.childStatus, 'completed');
      assert.deepEqual(observed.childToolNames, ['Read', 'Glob', 'Grep']);
      assert.ok(observed.childSessionId);
      assert.deepEqual(observed.listedSessionIds, [observed.childSessionId]);
      assert.equal(observed.outputSessionId, observed.childSessionId);
      for (const toolName of ['agent_spawn', 'agent_swarm', 'agent_list', 'agent_output']) {
        assert.ok(result.projection.toolExecutors[0]?.toolNames.includes(toolName));
      }
    });
  });

  test('settles background child sessions after a normal task-run completion', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      let resolveChildStarted!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        resolveChildStarted = resolve;
      });
      let childBackend: BackgroundChildBackend | undefined;
      let childPromise: Promise<unknown> | undefined;
      let childSettled = false;
      let buildCount = 0;
      const task: Task = {
        id: 'normal-background-child',
        instruction: 'coordinate child work',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(agentToolsConfig, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ParentWithBackgroundChildBackend(
                ctx.sessionId,
                context,
                childStarted,
                (promise) => {
                  childPromise = promise.finally(() => {
                    childSettled = true;
                  });
                },
                false,
              );
            }
            childBackend = new BackgroundChildBackend(ctx.sessionId, resolveChildStarted);
            return childBackend;
          });
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

      assert.equal(
        result.resultRecord.status,
        'completed',
        JSON.stringify(result.resultRecord, null, 2),
      );
      assert.equal(result.settledByDeadline, false);
      assert.equal(childBackend?.stopCalls, 1);
      assert.equal(childSettled, true);
      await childPromise;
      assert.ok(childBackend?.runId);
      const childRunHeader = await readAgentRunHeader(
        storageRoot,
        childBackend.sessionId,
        childBackend.runId,
      );
      assert.equal(childRunHeader.abortSource, 'user_stop');
    });
  });

  test('surfaces a cleanup error when the task runtime succeeds', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const cleanupError = new Error('child cleanup stop failed');
      let resolveChildStarted!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        resolveChildStarted = resolve;
      });
      let childBackend: FailingStopBackgroundChildBackend | undefined;
      let childPromise: Promise<unknown> | undefined;
      let buildCount = 0;
      const task: Task = {
        id: 'successful-runtime-cleanup-failure',
        instruction: 'surface cleanup failure',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const run = runTaskOnce(agentToolsConfig, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ParentWithBackgroundChildBackend(
                ctx.sessionId,
                context,
                childStarted,
                (promise) => {
                  childPromise = promise;
                },
                false,
              );
            }
            childBackend = new FailingStopBackgroundChildBackend(
              ctx.sessionId,
              resolveChildStarted,
              cleanupError,
            );
            return childBackend;
          });
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
      try {
        await assert.rejects(run, (error: unknown) => {
          assert.equal(error, cleanupError);
          return true;
        });
        assert.equal(childBackend?.stopCalls, 1);
      } finally {
        childBackend?.finishForTest();
        await childPromise;
      }
    });
  });

  test('settles background child sessions at the task-run deadline', async (t) => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const realSetTimeout = setTimeout;
      const realClearTimeout = clearTimeout;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let resolveChildStarted!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        resolveChildStarted = resolve;
      });
      let childBackend: BackgroundChildBackend | undefined;
      let childPromise: Promise<unknown> | undefined;
      let childSettled = false;
      let buildCount = 0;
      const task: Task = {
        id: 'deadline-background-child',
        instruction: 'coordinate child work',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const run = runTaskOnce(agentToolsConfig, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ParentWithBackgroundChildBackend(
                ctx.sessionId,
                context,
                childStarted,
                (promise) => {
                  childPromise = promise.finally(() => {
                    childSettled = true;
                  });
                },
                true,
              );
            }
            childBackend = new BackgroundChildBackend(ctx.sessionId, resolveChildStarted);
            return childBackend;
          });
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
        now: () => 0,
        deadlineAtMs: 100,
      });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await childStarted;
        t.mock.timers.tick(100);
        const result = await Promise.race([
          run,
          new Promise<never>((_resolve, reject) => {
            watchdog = realSetTimeout(
              () => reject(new Error('deadline child lifecycle watchdog expired')),
              1_000,
            );
          }),
        ]);

        assert.ok(childBackend);
        assert.equal(result.settledByDeadline, true);
        assert.equal(childBackend.stopCalls, 1);
        assert.equal(childSettled, true);
        await childPromise;
      } finally {
        if (watchdog) realClearTimeout(watchdog);
        t.mock.timers.reset();
      }
    });
  });

  test('settles child sessions with deadline provenance when parent settlement fails', async (t) => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const realSetTimeout = setTimeout;
      const realClearTimeout = clearTimeout;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const runtimeError = new Error('parent deadline stop failed');
      let resolveChildStarted!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        resolveChildStarted = resolve;
      });
      let childBackend: BackgroundChildBackend | undefined;
      let childPromise: Promise<unknown> | undefined;
      let childSettled = false;
      let buildCount = 0;
      const task: Task = {
        id: 'deadline-parent-settlement-failure',
        instruction: 'preserve deadline provenance',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const run = runTaskOnce(agentToolsConfig, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ParentWithBackgroundChildBackend(
                ctx.sessionId,
                context,
                childStarted,
                (promise) => {
                  childPromise = promise.finally(() => {
                    childSettled = true;
                  });
                },
                true,
                runtimeError,
              );
            }
            childBackend = new BackgroundChildBackend(ctx.sessionId, resolveChildStarted);
            return childBackend;
          });
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
        now: () => 0,
        deadlineAtMs: 100,
      });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await childStarted;
        t.mock.timers.tick(100);
        await assert.rejects(
          Promise.race([
            run,
            new Promise<never>((_resolve, reject) => {
              watchdog = realSetTimeout(
                () => reject(new Error('deadline settlement failure watchdog expired')),
                1_000,
              );
            }),
          ]),
          (error: unknown) => {
            assert.equal(error, runtimeError);
            return true;
          },
        );
        assert.ok(childBackend?.runId);
        assert.equal(childBackend.stopCalls, 1);
        assert.equal(childSettled, true);
        await childPromise;
        const childRunHeader = await readAgentRunHeader(
          storageRoot,
          childBackend.sessionId,
          childBackend.runId,
        );
        assert.equal(childRunHeader.abortSource, 'benchmark.deadline');
      } finally {
        if (watchdog) realClearTimeout(watchdog);
        t.mock.timers.reset();
      }
    });
  });

  test('preserves the runtime error when deadline cleanup also fails', async (t) => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const realSetTimeout = setTimeout;
      const realClearTimeout = clearTimeout;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      class ParentSettlementError extends Error {}
      const runtimeError = new ParentSettlementError('parent deadline stop failed');
      const cleanupError = new Error('child cleanup stop failed');
      let resolveChildStarted!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        resolveChildStarted = resolve;
      });
      let childBackend: FailingStopBackgroundChildBackend | undefined;
      let childPromise: Promise<unknown> | undefined;
      let buildCount = 0;
      const task: Task = {
        id: 'deadline-runtime-and-cleanup-failure',
        instruction: 'preserve the primary runtime failure',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const run = new TaskAgentController({
        storageRoot,
        registerBackends: (registry, context) => {
          registry.register('ai-sdk', (ctx) => {
            buildCount += 1;
            if (buildCount === 1) {
              return new ParentWithBackgroundChildBackend(
                ctx.sessionId,
                context,
                childStarted,
                (promise) => {
                  childPromise = promise;
                },
                true,
                runtimeError,
              );
            }
            childBackend = new FailingStopBackgroundChildBackend(
              ctx.sessionId,
              resolveChildStarted,
              cleanupError,
            );
            return childBackend;
          });
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
        now: () => 0,
        deadlineAtMs: 100,
      }).runOnce(agentToolsConfig, task);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await childStarted;
        t.mock.timers.tick(100);
        await assert.rejects(
          Promise.race([
            run,
            new Promise<never>((_resolve, reject) => {
              watchdog = realSetTimeout(
                () => reject(new Error('dual failure watchdog expired')),
                1_000,
              );
            }),
          ]),
          (error: unknown) => {
            assert.equal(error, runtimeError);
            assert.ok(error instanceof ParentSettlementError);
            assert.equal(error.cause, cleanupError);
            return true;
          },
        );
        assert.equal(childBackend?.stopCalls, 1);
      } finally {
        if (watchdog) realClearTimeout(watchdog);
        childBackend?.finishForTest();
        await childPromise;
        t.mock.timers.reset();
      }
    });
  });

  test('does not dispatch a runtime attempt after the benchmark deadline', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const counters = { sendCalls: 0 };
      const task: Task = {
        id: 'expired-benchmark-deadline',
        instruction: 'must not start',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: (registry) => {
          registry.register('fake', (ctx) => new ResettingDeadlineBackend(ctx.sessionId, counters));
        },
        deadlineAtMs: Date.now() - 1,
      });

      assert.equal(counters.sendCalls, 0);
      assert.equal(result.settledByDeadline, true);
      const invocation = latestInvocation(result);
      assert.equal(invocation.status, 'failed');
      assert.equal(invocation.failure?.class, 'aborted');
      const runtimeEvents = await readRuntimeEventLedger(
        storageRoot,
        invocation.sessionId,
        invocation.runId,
      );
      const terminal = runtimeEvents.at(-1);
      assert.equal(terminal?.status, 'aborted');
      assert.equal(terminal?.actions?.endInvocation, true);
      assert.equal(terminal?.actions?.stateDelta?.abortSource, 'benchmark.deadline');
    });
  });

  test('rejects a benchmark deadline beyond the Node timer limit', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'oversized-benchmark-deadline',
        instruction: 'must not start',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      await assert.rejects(
        runTaskOnce(fakeConfig, task, {
          storageRoot,
          registerBackends: registerFakeBackend,
          deadlineAtMs: 2_147_483_648,
          now: () => 0,
        }),
        /deadlineAtMs exceeds the Node timer limit of 2147483647ms/,
      );
    });
  });

  test('settles an active runtime at the benchmark soft deadline', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'benchmark-deadline',
        instruction: 'wait forever',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerDeadlineBackend,
        deadlineAtMs: Date.now() + 25,
      });

      assert.equal(result.settledByDeadline, true);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.events.at(-1)?.type, 'task_run_budget_exhausted');
      const runHeader = await readAgentRunHeader(
        storageRoot,
        latestInvocation(result).sessionId,
        latestInvocation(result).runId,
      );
      assert.equal(runHeader.status, 'cancelled');
      assert.equal(runHeader.abortSource, 'benchmark.deadline');
    });
  });

  test('skips optional heavy-task work after a repair settles at the deadline', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const state = { now: 0, prompts: [] as string[] };
      const config: Config = { ...fakeConfig, backend: 'ai-sdk', heavyTaskMode: true };
      const task: Task = {
        id: 'repair-deadline',
        instruction: 'complete the heavy task',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        now: () => state.now,
        registerBackends: (registry) => {
          registry.register('ai-sdk', (ctx) => new DeadlineRepairBackend(ctx.sessionId, state));
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
        deadlineAtMs: 50,
      });

      assert.equal(state.prompts.length, 1);
      assert.equal(result.settledByDeadline, true);
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_gate_recorded',
        ).length,
        1,
      );
    });
  });

  test('injects the default headless system prompt before registering a backend', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'default-prompt-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };
      let capturedPrompt: string | undefined;

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: (registry, context) => {
          capturedPrompt = context.config.systemPrompt;
          registerFakeBackend(registry);
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
      assert.equal(result.resultRecord.systemPromptMode, 'default');
      assert.equal(
        result.resultRecord.systemPromptHash,
        `sha256:${createHash('sha256').update(JSON.stringify(capturedPrompt)).digest('hex')}`,
      );
    });
  });

  test('uses RuntimeRunner path without SessionManager.sendMessage and writes a passing ledger', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const original = SessionManager.prototype.sendMessage;
      SessionManager.prototype.sendMessage = async function* () {
        throw new Error('interactive sendMessage path must not be used');
      } as typeof original;
      try {
        const task: Task = {
          id: 'pass-task',
          instruction: 'do the thing',
          workspaceDir: fixtureDir,
          verification: { command: 'test -f marker.txt', protectedPaths: [] },
        };

        const result = await runTaskOnce(fakeConfig, task, {
          storageRoot,
          registerBackends: registerFakeBackend,
        });

        assert.equal(result.resultRecord.status, 'completed');
        assert.equal(result.resultRecord.passed, true);
        assert.equal(result.projection.status, 'completed');
        assert.equal(result.projection.latestScoreResult?.passed, true);
        assert.deepEqual(
          result.projection.events.map((event) => event.type),
          [
            'task_run_created',
            'task_run_queued',
            'heavy_task_mode_recorded',
            'economy_task_mode_recorded',
            'isolation_policy_recorded',
            'workspace_lease_recorded',
            'tool_executor_identity_recorded',
            'task_run_started',
            'task_attempt_started',
            'task_attempt_execution_linked',
            'feedback_observed',
            'task_run_verifying',
            'verifier_result_recorded',
            'score_result_recorded',
            'task_attempt_completed',
            'task_run_completed',
          ],
        );
        assert.equal(result.projection.heavyTaskMode?.enabled, false);
        assert.equal(result.projection.isolation?.mode, 'inert_fake_backend');
        assert.equal(result.projection.workspaceLease?.taskRunId, result.taskRunId);
        assert.equal(result.projection.toolExecutors[0]?.isolationMode, 'inert_fake_backend');
        const tools = result.projection.latestScoreResult?.details?.tools as
          | Record<string, unknown>
          | undefined;
        assert.ok(tools, 'score details should include tool economy summary');
        assert.equal(tools.actualToolCalls, 0);
        assert.deepEqual(tools.actualToolNames, []);
        assert.deepEqual(tools.actualToolCallCounts, {});
        const runtimeLedger = await readRuntimeEventLedger(
          storageRoot,
          latestInvocation(result).sessionId,
          latestInvocation(result).runId,
        );
        const lineage = result.projection.attempts[0]?.executionLineage[0];
        assert.equal(lineage?.execution?.invocationId, latestInvocation(result).invocationId);
        assert.equal(lineage?.execution?.agentRunId, latestInvocation(result).runId);
        assert.equal(lineage?.runtimeCoverage?.lowWater?.sequence, 0);
        assert.equal(lineage?.runtimeCoverage?.lowWater?.eventId, runtimeLedger[0]?.id);
        assert.equal(lineage?.runtimeCoverage?.highWater.sequence, runtimeLedger.length - 1);
        assert.equal(lineage?.runtimeCoverage?.highWater.eventId, runtimeLedger.at(-1)?.id);
        assert.equal(lineage?.runtimeCoverage?.eventCount, runtimeLedger.length);
        const runHeader = await readAgentRunHeader(
          storageRoot,
          latestInvocation(result).sessionId,
          latestInvocation(result).runId,
        );
        assert.equal(runHeader.invocationId, latestInvocation(result).invocationId);
      } finally {
        SessionManager.prototype.sendMessage = original;
      }
    });
  });

  test('records task-metadata heavy-task mode selection without changing scoring authority', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'heavy-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
        benchmark: { metadata: { heavyTaskMode: { enabled: true, reason: 'declared long task' } } },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.projection.heavyTaskMode?.enabled, true);
      assert.equal(result.projection.heavyTaskMode?.triggerSource, 'task_metadata');
      assert.equal(result.projection.heavyTaskMode?.triggerReason, 'declared long task');
      assert.equal(result.projection.latestVerifierResult?.authority, undefined);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.passed, true);
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('inventory_submit'));
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('todo_update'));
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('self_check_plan_submit'));
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('self_check_submit'));
    });
  });

  test('records config economy-task mode selection without changing scoring authority', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'economy-task',
        instruction: 'write a csv summary',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(
        {
          ...fakeConfig,
          economyTaskMode: { enabled: true, reason: 'declared simple task' },
        },
        task,
        {
          storageRoot,
          registerBackends: registerFakeBackend,
        },
      );

      assert.equal(result.projection.economyTaskMode?.enabled, true);
      assert.equal(result.projection.economyTaskMode?.triggerSource, 'config');
      assert.equal(result.projection.economyTaskMode?.triggerReason, 'declared simple task');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.passed, true);
    });
  });

  test('enabled heavy-task run exposes progress tools and records submitted snapshots', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'README.md'), 'public task notes\n', 'utf8');
      const seenContexts: HeadlessBackendContext[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'progress-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f README.md', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerProgressToolBackend(seenContexts),
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

      assert.equal(seenContexts[0]?.heavyTaskMode?.enabled, true);
      assert.ok(seenContexts[0]?.heavyTaskEvidence);
      assert.ok(seenContexts[0]?.heavyTaskProgress);
      assert.ok(seenContexts[0]?.heavyTaskSelfCheck);
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('inventory_submit'));
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('todo_update'));
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('self_check_plan_submit'));
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('self_check_submit'));
      assert.equal(result.projection.latestHeavyTaskInventory?.summary, 'Inspected public files.');
      assert.equal(result.projection.latestHeavyTaskInventory?.items[0]?.path, 'README.md');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[0]?.status, 'in_progress');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[0]?.kind, 'runnable_artifact');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[1]?.kind, 'public_check');
      assert.equal(result.projection.latestHeavyTaskSelfCheck?.status, 'pass');
      assert.equal(result.projection.latestHeavyTaskSelfCheckPlan?.guard.status, 'accepted');
      assert.equal(result.projection.latestHeavyTaskSelfCheck?.guard.status, 'accepted');
      assert.equal(
        result.projection.latestHeavyTaskSelfCheck?.freshness,
        'current',
        JSON.stringify({
          warnings: result.projection.warnings,
          selfCheck: result.projection.latestHeavyTaskSelfCheck,
          evidenceLinks: result.projection.events.filter(
            (event) => event.type === 'heavy_task_self_check_evidence_linked',
          ),
          observations: result.projection.heavyTaskWorkspaceObservations,
        }),
      );
      assert.ok(result.projection.latestHeavyTaskSelfCheck?.provenance?.runtimeCoverage);
      assert.ok(result.projection.latestHeavyTaskSelfCheck?.provenance?.taskCoverage);
      assert.equal(
        result.projection.latestHeavyTaskSelfCheck?.provenance?.workspace?.kind,
        'manifest',
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_evidence_linked',
        ).length,
        result.projection.heavyTaskSelfChecks.length,
      );
      assert.equal(
        result.projection.events.filter((event) => event.type === 'heavy_task_inventory_recorded')
          .length,
        2,
      );
      assert.equal(
        result.projection.events.filter((event) => event.type === 'heavy_task_todos_recorded')
          .length,
        2,
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_plan_recorded',
        ).length,
        2,
      );
      assert.equal(
        result.projection.events.filter((event) => event.type === 'heavy_task_self_check_recorded')
          .length,
        2,
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_gate_recorded',
        ).length,
        2,
      );
      const linkedEvidence = result.projection.heavyTaskEvidence.filter((item) => item.provenance);
      const linkedAgentRuns = new Set(
        result.projection.executionLineage.map((item) => item.execution?.agentRunId),
      );
      assert.ok(linkedEvidence.length > 0);
      assert.ok(
        linkedEvidence.every((item) => {
          const provenance = item.provenance;
          return (
            provenance !== undefined &&
            linkedAgentRuns.has(provenance.execution?.agentRunId) &&
            provenance.execution?.turnId === item.source.turnId &&
            Boolean(provenance.runtimeCoverage?.highWater.eventId)
          );
        }),
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_evidence_provenance_linked',
        ).length,
        linkedEvidence.length,
      );
      const replayDerivedSelfCheckEvidence = result.projection.heavyTaskEvidence.filter((item) =>
        item.evidenceId.includes(':compact-'),
      );
      assert.ok(replayDerivedSelfCheckEvidence.length > 0);
      assert.ok(replayDerivedSelfCheckEvidence.every((item) => item.provenance === undefined));
    });
  });

  test('enabled heavy-task run performs one bounded self-check repair turn before verifying', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const prompts: string[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'gate-repair-task',
        instruction: 'Ensure marker.txt exists and verify it publicly.',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerGateRepairBackend(prompts, true),
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

      assert.equal(prompts.length, 2);
      assert.match(prompts[1] ?? '', /not accepted for heavy-task finalization/);
      assert.equal(result.projection.latestHeavyTaskSelfCheckPlan?.guard.status, 'accepted');
      assert.equal(result.projection.latestHeavyTaskSelfCheck?.status, 'pass');
      assert.equal(result.projection.latestHeavyTaskSelfCheckGate?.action, 'allow_finalize');
      assert.equal(result.projection.latestVerifierResult?.passed, true);
      assert.equal(result.resultRecord.passed, true);
      assert.equal(result.invocations.length, 2);
      const budget = result.projection.latestScoreResult?.details?.budget as
        | { totals?: { input?: number; output?: number; total?: number } }
        | undefined;
      assert.deepEqual(budget?.totals, {
        input: 30,
        output: 3,
        reasoning: 0,
        total: 33,
        costUsd: 0,
      });
      const tools = result.projection.latestScoreResult?.details?.tools as
        | { actualToolCalls?: number; actualToolNames?: string[] }
        | undefined;
      assert.equal(tools?.actualToolCalls, 2);
      assert.deepEqual(tools?.actualToolNames, ['initial_tool', 'repair_tool']);
      assert.equal(result.projection.attempts[0]?.executionLineage.length, 2);
      assert.equal(
        new Set(
          result.projection.attempts[0]?.executionLineage.map((ref) => ref.execution?.agentRunId),
        ).size,
        2,
      );
      const gateIndexes = result.projection.events
        .map((event, index) => (event.type === 'heavy_task_self_check_gate_recorded' ? index : -1))
        .filter((index) => index >= 0);
      const verifyingIndex = result.projection.events.findIndex(
        (event) => event.type === 'task_run_verifying',
      );
      assert.equal(gateIndexes.length, 2);
      assert.ok(gateIndexes.every((index) => index < verifyingIndex));
    });
  });

  test('bounded self-check gate does not loop and official verifier remains authoritative', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const prompts: string[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'gate-still-missing-task',
        instruction: 'Ensure marker.txt exists and verify it publicly.',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerGateRepairBackend(prompts, false),
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

      assert.equal(prompts.length, 2);
      assert.equal(result.projection.latestHeavyTaskSelfCheck, undefined);
      assert.equal(
        result.projection.latestHeavyTaskSelfCheckGate?.action,
        'allow_official_verifier_after_bounded_attempt',
      );
      assert.match(
        result.projection.latestHeavyTaskSelfCheckGate?.reason ?? '',
        /missing accepted public self-check/,
      );
      assert.equal(result.projection.latestVerifierResult?.passed, true);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.passed, true);
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_gate_recorded',
        ).length,
        2,
      );
    });
  });

  test('bounded repair records model-reported workspace side-effect diagnostic before official verifier', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const prompts: string[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'polyglot-launder-task',
        instruction: 'Write a single file in /app/polyglot/main.py.c.',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerGateLaunderBackend(prompts),
        realBackendIsolation: {
          kind: 'external',
          label: 'unit isolated executor',
          toolExecutor: {
            async exec() {
              return {
                exitCode: 0,
                stdout: 'file\t/app/polyglot/main.py.c\t\nfile\t/app/polyglot/cmain\t\n',
                stderr: '',
              };
            },
          },
        },
      });

      assert.equal(prompts.length, 2);
      assert.equal(
        result.projection.latestHeavyTaskSelfCheckGate?.action,
        'allow_official_verifier_after_bounded_attempt',
      );
      assert.match(
        result.projection.latestHeavyTaskSelfCheckGate?.reason ?? '',
        /\/app\/polyglot\/cmain/,
      );
      assert.match(
        result.projection.latestHeavyTaskSelfCheckGate?.reason ?? '',
        /unplanned_added_path/,
      );
      assert.equal(result.projection.latestVerifierResult?.passed, true);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.passed, true);
      assert.equal(
        result.projection.events.some((event) => event.type === 'task_run_verifying'),
        true,
      );
    });
  });

  test('records a failing verifier as a completed task run with passed=false', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'verify-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.runnerCompleted, true);
      assert.equal(result.resultRecord.scored, true);
      assert.equal(result.resultRecord.eligible, true);
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.result?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
    });
  });

  test('records benchmark adapter hooks as unsupported instead of silently scoring', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'terminal-bench-hook',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'terminal-bench/example',
          protectedPaths: [],
        },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.runnerCompleted, true);
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.scored, false);
      assert.equal(result.resultRecord.eligible, false);
      assert.equal(result.resultRecord.errorClass, 'unsupported_adapter');
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.latestVerifierResult?.kind, 'terminal_bench');
      assert.equal(result.projection.latestVerifierResult?.errorClass, 'unsupported_adapter');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'unsupported_adapter');
    });
  });

  test('records official Harbor verifier result and container artifacts from benchmark adapter', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'terminal-bench-official',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'terminal-bench/example',
          protectedPaths: [],
        },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        benchmarkAdapters: {
          'terminal-bench': {
            name: 'terminal-bench',
            runVerifier: () => ({
              kind: 'terminal_bench',
              passed: true,
              exitCode: 0,
              score: 1,
              maxScore: 1,
              authority: { source: 'official_harbor_verifier', authoritative: true },
              details: { source: 'harbor', official: true, instanceId: 'terminal-bench/example' },
              artifacts: [
                {
                  kind: 'container_workspace',
                  workspacePath: '/app',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'workspace_diff',
                  path: '/logs/artifacts/submission.diff',
                  workspacePath: '/app',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'source_code',
                  path: '/logs/artifacts/app/vm.js',
                  workspacePath: '/app/vm.js',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'generated_output',
                  path: '/logs/artifacts/frame.bmp',
                  workspacePath: '/app/frame.bmp',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'benchmark_manifest',
                  path: '/logs/artifacts/manifest.json',
                  authority: { source: 'official_harbor_verifier', authoritative: true },
                },
              ],
            }),
          },
        },
      });

      assert.equal(result.resultRecord.passed, true);
      assert.equal(result.resultRecord.scored, true);
      assert.equal(
        result.projection.latestVerifierResult?.authority?.source,
        'official_harbor_verifier',
      );
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.projection.artifacts.length, 5);
      assert.equal(result.projection.artifacts[0]?.workspacePath, '/app');
      assert.equal(result.projection.artifacts[2]?.workspacePath, '/app/vm.js');
      assert.equal(result.projection.artifacts[3]?.path, '/logs/artifacts/frame.bmp');
      assert.equal(result.projection.artifacts[4]?.kind, 'benchmark_manifest');
    });
  });

  test('freezes submitted workspace before restoring protected paths for verifier', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'src.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
      await writeFile(
        join(fixtureDir, 'check.mjs'),
        "import { add } from './src.mjs';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
        'utf8',
      );
      const task: Task = {
        id: 'freeze-before-restore',
        instruction: 'fix the bug',
        workspaceDir: fixtureDir,
        verification: { command: 'node check.mjs', protectedPaths: ['check.mjs'] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerProtectedTamperBackend,
      });

      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.scored, true);
      assert.equal(result.projection.latestVerifierResult?.exitCode, 1);
      const snapshot = result.projection.latestScoreResult?.details?.submittedSnapshot as
        | { snapshotPath?: string }
        | undefined;
      assert.ok(snapshot?.snapshotPath, 'expected submitted snapshot metadata in score details');
      assert.equal(
        await readFile(join(snapshot.snapshotPath, 'check.mjs'), 'utf8'),
        'process.exit(0);\n',
      );
    });
  });

  test('persists the submitted snapshot from an explicitly owned external workspace', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const externalWorkspaceDir = await mkdtemp(join(storageRoot, 'external-workspace-'));
      const submittedSnapshotRoot = join(storageRoot, 'submitted-snapshots');
      await writeFile(join(fixtureDir, 'check.mjs'), 'fixture copy\n', 'utf8');
      await writeFile(join(externalWorkspaceDir, 'check.mjs'), 'external copy\n', 'utf8');
      const task: Task = {
        id: 'external-workspace-snapshot',
        instruction: 'modify the external workspace',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerProtectedTamperBackend,
        realBackendIsolation: {
          kind: 'external',
          label: 'locally accessible task container',
          workspaceDir: externalWorkspaceDir,
          submittedSnapshotRoot,
        },
      });

      const snapshot = result.projection.latestScoreResult?.details?.submittedSnapshot as
        | { snapshotPath?: string; workspaceRoot?: string }
        | undefined;
      assert.ok(snapshot?.snapshotPath, 'expected persisted external submitted snapshot');
      assert.equal(snapshot.workspaceRoot, externalWorkspaceDir);
      assert.match(snapshot.snapshotPath, new RegExp(`^${submittedSnapshotRoot}`));
      assert.equal(
        await readFile(join(snapshot.snapshotPath, 'check.mjs'), 'utf8'),
        'process.exit(0);\n',
      );
    });
  });

  test('maps backend failure and incomplete runtime to terminal failure taxonomy', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'backend-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const failed = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId: 'backend-failure-run',
        registerBackends: registerFailingBackend,
      });
      assert.equal(failed.resultRecord.status, 'failed');
      assert.equal(failed.projection.status, 'failed');
      assert.equal(failed.projection.latestScoreResult?.taxonomy, 'agent_failed');
      assert.equal(failed.projection.error?.class, 'backend_failed');
      const failedRuntimeEvents = await readRuntimeEventLedger(
        storageRoot,
        latestInvocation(failed).sessionId,
        latestInvocation(failed).runId,
      );
      assert.deepEqual(
        failedRuntimeEvents
          .filter((event) => event.content?.kind === 'error' && !isTerminalRuntimeEvent(event))
          .map((event) => event.id),
        [],
      );
      const failedTerminalEvents = failedRuntimeEvents.filter(isTerminalRuntimeEvent);
      assert.equal(failedTerminalEvents.length, 1);
      assert.equal(failedTerminalEvents[0]?.status, 'failed');

      const incomplete = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId: 'incomplete-run',
        registerBackends: registerIncompleteBackend,
      });
      assert.equal(incomplete.resultRecord.status, 'failed');
      assert.equal(incomplete.projection.status, 'incomplete');
      assert.equal(incomplete.projection.latestScoreResult?.taxonomy, 'agent_incomplete');
    });
  });

  test('rejects a copied Headless storage aggregate before execution', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'forged-storage',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      const storage = await openHeadlessStorageForWrite(storageRoot);
      let backendRegistrationCalled = false;

      await assert.rejects(
        () =>
          runTaskOnceWithStorage(
            fakeConfig,
            task,
            {
              storageRoot,
              registerBackends: (registry) => {
                backendRegistrationCalled = true;
                registerFakeBackend(registry);
              },
            },
            { ...storage },
          ),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      assert.equal(backendRegistrationCalled, false);
    });
  });

  test('fails closed on permission requests without answering the interactive permission API', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      let respondCalls = 0;
      const task: Task = {
        id: 'permission-handoff',
        instruction: 'run a dangerous command',
        workspaceDir: _fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend(() => {
          respondCalls += 1;
        }),
      });

      assert.equal(respondCalls, 0);
      assert.equal(result.resultRecord.status, 'failed');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.errorClass, 'policy_denied');
      assert.equal(result.projection.status, 'policy_denied');
      assert.equal(result.projection.latestVerifierResult?.exitCode, 0);
      assert.equal(result.projection.latestScoreResult?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'policy_denied');
      assert.ok(
        result.projection.events.some((event) => event.type === 'task_run_policy_denied'),
        'expected a policy-denied terminal task event',
      );
      assert.equal(result.projection.permissionRequests.length, 1);
      assert.equal(result.projection.permissionRequests[0]?.toolName, 'Bash');
      assert.equal(result.projection.permissionRequests[0]?.resourceScope.kind, 'command');
      const runtimeEvents = await readRuntimeEventLedger(
        storageRoot,
        latestInvocation(result).sessionId,
        latestInvocation(result).runId,
      );
      assert.equal(runtimeEvents.some(isTerminalRuntimeEvent), false);
      assert.ok(
        runtimeEvents.some(
          (event) => event.actions?.permissionRequest?.requestId === 'permission-request-1',
        ),
        'expected the permission request fact to stay in the runtime ledger',
      );
      assert.equal(result.projection.inboxItems[0]?.kind, 'approval_request');
      assert.equal(result.projection.inboxItems[0]?.status, 'resolved');
      assert.ok(
        result.projection.events.some(
          (event) => event.type === 'permission_decision_recorded' && event.decision === 'deny',
        ),
        'expected a fail-closed permission denial event',
      );
    });
  });

  test('does not treat post-hoc matching permission grants as runtime authorization', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      let respondCalls = 0;
      const taskRunId = 'grant-run';
      const command = 'rm -rf /tmp/example';
      const grant: TaskPermissionGrant = {
        schemaVersion: 1,
        grantId: 'grant-posthoc',
        requestId: 'permission-request-1',
        taskRunId,
        attemptId: `${taskRunId}-attempt-1`,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        normalizedArgsHash: hashNormalizedArgs({ command }),
        resourceScope: commandResourceScope(command),
        decision: 'allow',
        actor: { kind: 'test', id: 'unit' },
        source: 'test_fixture',
        decidedAt: 10,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
      const task: Task = {
        id: 'permission-grant-posthoc',
        instruction: 'run a dangerous command',
        workspaceDir: _fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId,
        registerBackends: registerPermissionRequestBackend(() => {
          respondCalls += 1;
        }, command),
        permissionGrants: [grant],
      });

      assert.equal(respondCalls, 0);
      assert.equal(result.resultRecord.status, 'failed');
      assert.equal(result.resultRecord.errorClass, 'policy_denied');
      assert.equal(result.projection.status, 'policy_denied');
      assert.equal(result.projection.permissionGrants.length, 1);
      assert.equal(result.projection.permissionGrants[0]?.grantId, 'grant-posthoc');
      assert.equal(
        result.projection.events.some(
          (event) => event.type === 'permission_decision_recorded' && event.decision === 'allow',
        ),
        false,
      );
      const denyDecision = result.projection.events.find(
        (event) => event.type === 'permission_decision_recorded',
      );
      assert.ok(denyDecision);
      if (denyDecision.type !== 'permission_decision_recorded') {
        throw new Error('expected permission_decision_recorded event');
      }
      assert.equal(denyDecision.decision, 'deny');
      assert.match(denyDecision.reason ?? '', /post-hoc permission requests/);
    });
  });

  test('redacts bash permission scopes and inbox previews while preserving args hash', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      const secret = 'SECRET_TOKEN_123456';
      const command = `printf ${secret} > /tmp/secret-output`;
      const task: Task = {
        id: 'permission-redaction',
        instruction: 'request permission',
        workspaceDir: _fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend(() => {}, command),
      });

      const request = result.projection.permissionRequests[0];
      assert.ok(request);
      assert.equal(request.normalizedArgsHash, hashNormalizedArgs({ command }));
      assert.deepEqual(request.resourceScope, commandResourceScope(command));
      const serializedPermissionFacts = JSON.stringify({
        permissionRequests: result.projection.permissionRequests,
        inboxItems: result.projection.inboxItems,
        permissionEvents: result.projection.events.filter(
          (event) =>
            event.type === 'permission_request_recorded' ||
            event.type === 'task_inbox_item_recorded' ||
            event.type === 'task_inbox_item_resolved',
        ),
      });
      assert.equal(serializedPermissionFacts.includes(secret), false);
      assert.equal(serializedPermissionFacts.includes(command), false);
      assert.match(serializedPermissionFacts, new RegExp(request.normalizedArgsHash));
    });
  });

  test('parks permission requests in desktop intervention mode without verifying', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'permission-park',
        instruction: 'run a dangerous command',
        workspaceDir: _fixtureDir,
        verification: { command: 'false', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend(() => {}),
        interventionPolicy: { mode: 'park' },
      });

      assert.equal(result.resultRecord.status, 'failed');
      assert.equal(result.resultRecord.errorClass, 'needs_approval');
      assert.equal(result.projection.status, 'needs_approval');
      assert.equal(result.projection.parked?.reason, 'approval');
      assert.equal(result.projection.latestVerifierResult, undefined);
      assert.equal(result.projection.latestScoreResult, undefined);
      assert.equal(result.projection.attempts[0]?.status, 'needs_approval');
      assert.equal(result.projection.inboxItems[0]?.kind, 'approval_request');
      assert.equal(result.projection.inboxItems[0]?.status, 'open');
    });
  });

  test('persists runtime refs, isolation, budget, and artifact metadata', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'metadata-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      const config: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'test',
        model: 'test-model',
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerReportingBackend,
        realBackendIsolation: { kind: 'external', label: 'unit isolation' },
      });

      const feedback = result.projection.feedback.find((entry) => entry.source === 'runtime');
      assert.ok(feedback?.details);
      assert.equal((feedback.details.isolation as { label?: string }).label, 'unit isolation');
      assert.equal(
        (feedback.details.runtimeRefs as { runId?: string }).runId,
        latestInvocation(result).runId,
      );
      assert.ok(
        (feedback.details.runtimeRefs as { runtimeEventIds?: string[] }).runtimeEventIds?.includes(
          'report-usage',
        ),
      );
      assert.deepEqual(feedback.details.artifactRefs, [
        { runtimeEventId: 'report-artifact', artifactId: 'artifact-1', toolCallId: 'tool-1' },
      ]);
      assert.equal((feedback.details.budget as { totals: { input: number } }).totals.input, 10);
      assert.deepEqual(
        result.projection.latestScoreResult?.details?.artifactRefs,
        feedback.details.artifactRefs,
      );

      const runtimeEventsPath = join(
        storageRoot,
        'sessions',
        latestInvocation(result).sessionId,
        'runs',
        latestInvocation(result).runId,
        'runtime-events.jsonl',
      );
      const runtimeEvents = await readFile(runtimeEventsPath, 'utf8');
      assert.match(runtimeEvents, /report-usage/);
      assert.match(runtimeEvents, /report-artifact/);
    });
  });

  test('carries the configured reasoning effort into the runtime session', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      let observedThinkingLevel: SessionHeader['thinkingLevel'];
      const task: Task = {
        id: 'thinking-level-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      await runTaskOnce({ ...fakeConfig, thinkingLevel: 'xhigh' }, task, {
        storageRoot,
        registerBackends: (registry) => {
          registry.register('fake', (ctx) => {
            observedThinkingLevel = ctx.header.thinkingLevel;
            return new FakeBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              store: ctx.store,
            });
          });
        },
      });

      assert.equal(observedThinkingLevel, 'xhigh');
    });
  });
});
