/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import type {
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  BackendSendInput,
} from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import type { PlanStepStatus, PlanStore } from '@maka/core/plan';
import { buildHistoryCompactCheckpoint } from '@maka/runtime/history-compact-checkpoint';
import { buildSubmitPlanTool, buildUpdatePlanTool } from '@maka/runtime/plan-tools';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { type BackendFactoryContext } from '@maka/runtime/session-manager';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type { ExecutionRuntimeHostCandidateDependencies } from '../server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fresh Desktop E2E workspaces never reconnect; keep election retry, skip production grace. */
export const DESKTOP_E2E_IDLE_GRACE_MS = 500;

/**
 * Plan-mode sentinel prompt. Its Turn submits a deterministic three-step
 * proposal through the real `SubmitPlan` tool, so the Plan panel renders a
 * proposal that came out of the durable Plan store instead of fixture JSON.
 */
export const DESKTOP_E2E_PLAN_PROPOSAL_PROMPT = '__e2e_plan_proposal__';

/**
 * Step ids the spec names. Canonical Plan entity ids, with titles short enough
 * that the panel row stays readable at every status.
 */
export const DESKTOP_E2E_PLAN_STEP_IDS = [
  'e2e-plan-step-1',
  'e2e-plan-step-2',
  'e2e-plan-step-3',
] as const;

const DESKTOP_E2E_PLAN_STEPS = [
  {
    id: DESKTOP_E2E_PLAN_STEP_IDS[0],
    title: 'Collect the failing evidence',
    description: 'Record the current failure output before changing anything.',
  },
  {
    id: DESKTOP_E2E_PLAN_STEP_IDS[1],
    title: 'Apply the narrow fix',
    description: 'Change only the code the recorded evidence points at.',
  },
  {
    id: DESKTOP_E2E_PLAN_STEP_IDS[2],
    title: 'Verify the fix end to end',
    description: 'Re-run the affected checks and confirm they pass.',
  },
];

/**
 * One stable `toolCallId` per logical Plan action. Both Plan tools declare
 * `recoveryMode: 'idempotent'`, and the durable operation id also carries the
 * Turn id, so a replayed action reconciles against its receipt instead of
 * writing a second mutation.
 */
const DESKTOP_E2E_PLAN_TOOL_CALL_ID = 'desktop-e2e-plan';

/**
 * The composed Host authority the real Plan tools are built from.
 *
 * Deliberately not `BackendFactoryContext.tools`: that field is a subagent-only
 * tool ceiling (`runtime-kernel.ts` fills it inside the subagent activation
 * branch), so a main-session fake backend never receives a tool list. The Host
 * publishes the interactive Plan store through
 * `ExecutionRuntimeHostCompositionDependencies.observePlanStore`, and the real
 * Plan tools are built from exactly that instance.
 */
export type DesktopE2ePlanAuthority = () => PlanStore | undefined;

/** A step line as the Host renders it into an execution request. */
interface DesktopE2ePlanRequestStep {
  readonly id: string;
  readonly status: PlanStepStatus;
}

/**
 * `renderExecutionRequest` (plan-coordinator.ts) renders the request the model
 * reads as a header plus one `- <id> [<status>] <title>` line per step. Nothing
 * else the model sees carries the ids `update_plan` requires, so this shape is
 * what identifies a Plan execution Turn.
 */
const DESKTOP_E2E_PLAN_REQUEST_HEADER =
  /^(?:Execute|Resume) the approved plan execution [A-Za-z0-9_-]+\.$/;
const DESKTOP_E2E_PLAN_REQUEST_STEP =
  /^- ([A-Za-z0-9_-]+) \[(pending|in_progress|completed|skipped)\] /;

function parsePlanExecutionRequest(text: string): DesktopE2ePlanRequestStep[] | undefined {
  const lines = text.split('\n');
  if (!DESKTOP_E2E_PLAN_REQUEST_HEADER.test(lines[0] ?? '')) return undefined;
  const steps: DesktopE2ePlanRequestStep[] = [];
  for (const line of lines) {
    const match = DESKTOP_E2E_PLAN_REQUEST_STEP.exec(line);
    if (match) steps.push({ id: match[1]!, status: match[2] as PlanStepStatus });
  }
  return steps.length > 0 ? steps : undefined;
}

/** The desktop E2E backend mirrors the one control capability exercised by the slash menu. */
export class DesktopE2eBackend extends FakeBackend {
  /** Set by `stop()`; the Plan progress Turn is held open until the test stops it. */
  private planTurnStopped = false;

  constructor(
    private readonly backendContext: BackendFactoryContext,
    private readonly planAuthority: DesktopE2ePlanAuthority,
  ) {
    super(backendContext);
  }

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    const recordCheckpoint = this.backendContext.recordHistoryCompactCheckpoint;
    if (!recordCheckpoint) {
      throw new Error('Desktop E2E compaction requires a checkpoint recorder');
    }
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: this.sessionId,
      coveredRuntimeEvents: input.runtimeContext,
      // Shaped like a real sectioned checkpoint so the builder's summary
      // validation (#3029) admits this deterministic fixture.
      summary: [
        '## Goal',
        'Deterministic Desktop E2E context checkpoint.',
        '',
        '## Progress',
        '- deterministic compaction exercised',
        '',
        '## Next Steps',
        '1. continue',
        '',
        '## Critical Context',
        '- (none)',
      ].join('\n'),
    });
    await recordCheckpoint(checkpoint, input.turnId);
    return { outcome: { kind: 'compacted', checkpointId: checkpoint.checkpointId } };
  }

  /**
   * The base `FakeBackend.stop()` flips a private flag this subclass cannot
   * read, so the Plan hold observes the same public call the runtime makes when
   * the user stops the Turn.
   */
  override async stop(): Promise<void> {
    this.planTurnStopped = true;
    await super.stop();
  }

  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.text === DESKTOP_E2E_PLAN_PROPOSAL_PROMPT) {
      yield* this.sendPlanProposalTurn(input);
      return;
    }
    const request = parsePlanExecutionRequest(input.text);
    if (request) {
      // The Host binds `update_plan` only while an execution is active, and to
      // exactly that execution's id (interactive-run-composer.ts). Read the id
      // now rather than caching one across Turns: a resumed execution keeps its
      // identity, while a new proposal produces a new execution.
      const executionId = await this.activePlanExecutionId();
      if (executionId) {
        yield* this.sendPlanExecutionTurn(input, request, executionId);
        return;
      }
    }
    yield* super.send(input);
  }

  private async activePlanExecutionId(): Promise<string | undefined> {
    return (await this.requirePlanStore().readState(this.sessionId)).activeExecutionId;
  }

  private requirePlanStore(): PlanStore {
    const store = this.planAuthority();
    if (!store) {
      throw new Error('Desktop E2E Plan capability requires the composed Plan store observer');
    }
    return store;
  }

  /**
   * Which Plan Turn this is, and why the tools list cannot answer it:
   *
   * `BackendFactoryContext.tools` is filled only for subagent activations
   * (runtime-kernel.ts), so a main-session fake backend never sees a tool list.
   * The equivalent binding is read from the same authority the Host composes
   * from — the Host binds `update_plan` (and `cancel_plan`) only while an
   * execution is active, and to that execution's id.
   *
   *  - no active execution: not a Plan execution Turn, so the plain reply runs;
   *  - every rendered step `pending`: the approve Turn. A freshly approved
   *    execution starts with every step pending, so the fake records one real
   *    step of progress (first `completed`, next `in_progress`) and then holds
   *    the Turn open until the test stops it, which is what makes the interrupt
   *    leg land on durable progress rather than on an untouched execution;
   *  - any step already `completed`, `skipped` or `in_progress`: the resume
   *    Turn. Progress survived the interruption, so the fake completes every
   *    remaining step and lets the Turn settle into the terminal state.
   */
  private async *sendPlanExecutionTurn(
    input: BackendSendInput,
    request: readonly DesktopE2ePlanRequestStep[],
    executionId: string,
  ): AsyncIterable<SessionEvent> {
    this.planTurnStopped = false;
    const turnId = input.turnId;
    const fresh = request.every(({ status }) => status === 'pending');
    const steps = request.map((step, index) => ({
      id: step.id,
      status: fresh
        ? index === 0
          ? ('completed' as const)
          : index === 1
            ? ('in_progress' as const)
            : ('pending' as const)
        : step.status === 'completed' || step.status === 'skipped'
          ? step.status
          : ('completed' as const),
    }));
    const updatePlan = buildUpdatePlanTool(this.requirePlanStore(), executionId);
    yield* this.recordPlanToolCall({
      turnId,
      toolName: updatePlan.name,
      args: { steps },
      run: (context) => updatePlan.impl({ steps }, context),
      text: fresh
        ? 'Recorded the first Plan step and started the next one.'
        : 'Completed the remaining Plan steps.',
    });
    if (!fresh) {
      yield this.turnEnd(turnId, 'end_turn');
      return;
    }
    // Hold the Turn open the way FAKE_HOLD_OPEN_PROMPT does, so the composer
    // still offers Stop while the panel shows the intermediate count.
    while (!this.planTurnStopped) await sleep(5);
    yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
    yield this.turnEnd(turnId, 'user_stop');
  }

  private async *sendPlanProposalTurn(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.planTurnStopped = false;
    // A real model needs a moment before its first tool call; giving the
    // session subscription the same room keeps this fixture from racing setup.
    await sleep(100);
    const turnId = input.turnId;
    const submitPlan = buildSubmitPlanTool(this.requirePlanStore());
    const args = {
      title: 'Ship the deterministic Plan fixture',
      overview: 'Three bounded steps that keep the panel readable while the run is in flight.',
      steps: [...DESKTOP_E2E_PLAN_STEPS],
    };
    yield* this.recordPlanToolCall({
      turnId,
      toolName: submitPlan.name,
      args,
      run: (context) => submitPlan.impl(args, context),
      text: 'Plan submitted for approval.',
    });
    yield this.turnEnd(turnId, 'end_turn');
  }

  /**
   * Runs one real Plan tool and emits the transcript events a provider-backed
   * Turn would have emitted for that call, so the Turn carries its own evidence
   * that the branch ran.
   */
  private async *recordPlanToolCall(input: {
    turnId: string;
    toolName: string;
    args: unknown;
    run: (context: MakaToolContext) => unknown;
    text: string;
  }): AsyncIterable<SessionEvent> {
    const toolUseId = randomUUID();
    yield {
      type: 'tool_start',
      id: randomUUID(),
      turnId: input.turnId,
      stepId: randomUUID(),
      ts: Date.now(),
      toolUseId,
      toolName: input.toolName,
      args: input.args,
    };
    const result = await input.run(this.planToolContext(input.turnId));
    yield {
      type: 'tool_result',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      toolUseId,
      isError: false,
      content: { kind: 'json', value: result },
    };
    const messageId = randomUUID();
    for (const chunk of input.text.match(/[\s\S]{1,9}/g) ?? [input.text]) {
      yield {
        type: 'text_delta',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        messageId,
        text: chunk,
      };
    }
    yield {
      type: 'text_complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId,
      text: input.text,
    };
  }

  private turnEnd(turnId: string, stopReason: 'end_turn' | 'user_stop'): SessionEvent {
    return { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason };
  }

  /**
   * The Plan tools read only `sessionId`, `turnId` and `toolCallId` (see
   * `planToolOperationId`). Everything else on `MakaToolContext` belongs to
   * Runtime dispatch — abort signal, output emitters, child-spawn authority —
   * which this deterministic fixture deliberately bypasses.
   */
  private planToolContext(turnId: string): MakaToolContext {
    return {
      sessionId: this.sessionId,
      turnId,
      toolCallId: DESKTOP_E2E_PLAN_TOOL_CALL_ID,
    } as unknown as MakaToolContext;
  }
}

const DESKTOP_E2E_OAUTH_AUTHORIZATION = {
  startCodexAuthorization: async () => ({
    deviceAuthId: 'desktop-e2e-device-authorization',
    userCode: 'MAKA-E2E',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: Date.now() + 60_000,
    intervalMs: 1,
  }),
  pollCodexAuthorization: async () => ({
    authorizationCode: 'desktop-e2e-authorization-code',
    codeVerifier: 'desktop-e2e-code-verifier',
  }),
  exchangeCodexCode: async () => ({
    access_token: 'desktop-e2e-access-token',
    refresh_token: 'desktop-e2e-refresh-token',
    expires_at: Date.now() + 3_600_000,
  }),
};

export function createDesktopE2eExecutionCandidateDependencies(): ExecutionRuntimeHostCandidateDependencies {
  // One captured authority per composed Host. The backend factory runs when a
  // Turn activates, always after the composition handed its Plan store over, so
  // the backend reads the captured instance rather than a copy.
  let planStore: PlanStore | undefined;
  return {
    createComposition: async (context, compositionOptions) => {
      const composition = await createExecutionRuntimeHostComposition(
        context,
        {
          ...compositionOptions,
          bootstrapRuntimePolicy: false,
        },
        {
          primaryBackendFactory: (backendContext) =>
            new DesktopE2eBackend(backendContext, () => planStore),
          oauthAuthorization: DESKTOP_E2E_OAUTH_AUTHORIZATION,
          observePlanStore: (store) => {
            planStore = store;
          },
        },
      );
      return composition;
    },
  };
}

export function watchDesktopE2eParentProcess(close: () => Promise<void>): () => void {
  const desktopParentPid = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid === desktopParentPid && isProcessAlive(desktopParentPid)) return;
    clearInterval(parentWatch);
    void close().catch(() => {
      process.exitCode = 1;
    });
  }, 100);
  parentWatch.unref();
  return () => clearInterval(parentWatch);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
