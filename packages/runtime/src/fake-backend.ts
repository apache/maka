import { randomUUID } from 'node:crypto';
import type { BackendKind, SessionHeader, StoredMessage } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import type {
  AgentBackend,
  BackendSendInput,
  HostedSandboxBoundarySettlement,
  HostedUserQuestionAnswer,
  HostedUserQuestionSettlement,
} from '@maka/core/backend-types';
import type {
  SandboxBoundaryResponse,
  SandboxBoundarySettlement,
} from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import {
  RuntimeInteractionInvariantError,
  type RuntimeUserQuestionClosureReason,
} from './interaction-authority.js';
import type { SessionStore } from './session-manager.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const FAKE_ASK_USER_QUESTION_PROMPT = '__e2e_ask_user_question__';
export const FAKE_ASK_SANDBOX_BOUNDARY_PROMPT = '__e2e_ask_sandbox_boundary__';
export const FAKE_WAIT_FOR_STEERING_PROMPT = '__e2e_wait_for_steering__';
export const FAKE_HOLD_OPEN_PROMPT = '__e2e_hold_open__';
export const FAKE_HOLD_OPEN_REWRITE_PROMPT = '__e2e_hold_open_rewrite__';
export const FAKE_MERMAID_PROMPT = '__e2e_mermaid__';
export const FAKE_MERMAID_HOSTILE_PROMPT = '__e2e_mermaid_hostile__';
export const FAKE_ERROR_PROMPT_PREFIX = '__e2e_error__:';

type PendingQuestion = {
  turnId: string;
  requestId: string;
  hosted: boolean;
  resolve(response: UserQuestionResponse | null): void;
};

type PendingSandboxBoundary = {
  turnId: string;
  requestId: string;
  hosted: boolean;
  resolve(settlement: SandboxBoundarySettlement | null): void;
};

export class FakeBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  private stopped = false;
  private pendingQuestion: PendingQuestion | undefined;
  private pendingSandboxBoundary: PendingSandboxBoundary | undefined;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      store: SessionStore;
      appendMessage?: (message: StoredMessage) => Promise<void>;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.stopped = false;
    if (input.text === FAKE_ASK_USER_QUESTION_PROMPT) {
      yield* this.sendQuestionScenario(input);
      return;
    }
    if (input.text === FAKE_ASK_SANDBOX_BOUNDARY_PROMPT) {
      yield* this.sendSandboxBoundaryScenario(input);
      return;
    }
    if (input.text.startsWith(FAKE_ERROR_PROMPT_PREFIX)) {
      yield* this.sendErrorScenario(input, input.text.slice(FAKE_ERROR_PROMPT_PREFIX.length));
      return;
    }
    const turnId = input.turnId;
    const messageId = randomUUID();
    const attNames = (input.attachments ?? []).map((a) => a.name);
    const attLine = attNames.length > 0 ? `\nAttachments received: ${attNames.join(', ')}` : '';
    let text =
      input.text === FAKE_MERMAID_PROMPT
        ? [
            'Fake backend Mermaid fixture:',
            '',
            '```mermaid',
            'flowchart TB',
            'subgraph Input["1. Input layer"]',
            '  A[User prompt] --> B{Fence settled?}',
            '  B -->|No| C[Keep source visible]',
            '  B -->|Yes| D[Sanitize Markdown]',
            'end',
            'subgraph Render["2. Render layer"]',
            '  D --> E[Lazy-load Mermaid]',
            '  E --> F[Render strict SVG]',
            '  F --> G{Valid diagram?}',
            '  G -->|No| H[Show source fallback]',
            'end',
            'subgraph Inspect["3. Inspect layer"]',
            '  G -->|Yes| I[Fit to viewport]',
            '  I --> J{User action}',
            '  J -->|Zoom| K[Scale around pointer]',
            '  J -->|Pan| L[Move canvas]',
            '  J -->|Expand| M[Open fullscreen]',
            '  K --> N[Inspect details]',
            '  L --> N',
            '  M --> N',
            'end',
            'C --> O[Continue streaming]',
            'H --> O',
            'N --> P[Resume task]',
            '```',
          ].join('\n')
        : input.text === FAKE_MERMAID_HOSTILE_PROMPT
          ? [
              'Fake backend hostile Mermaid fixture:',
              '',
              '```mermaid',
              '%%{init: {"securityLevel":"loose","flowchart":{"htmlLabels":true}}}%%',
              'flowchart LR',
              '  A["<img src=x onerror=alert(1)>"] --> B[Safe output]',
              '  click A "javascript:alert(1)"',
              '```',
            ].join('\n')
          : `Fake backend received: ${input.text}${attLine}\n\nThis proves the session stream, SQLite storage, and renderer loop are connected.`;
    // Every delta must concatenate to text_complete; `.` would silently drop
    // line terminators and make structured Markdown reflow only at completion.
    const chunks = text.match(/[\s\S]{1,9}/g) ?? [text];

    // Mid-turn steering: drain the caller's pending steering at each step
    // boundary (here, between streamed chunks), echoing every message as a
    // `steering_message` so the ledger/transcript render the interjection, and
    // remembering them so the fake reply acknowledges them like a real model.
    const steered: string[] = [];
    // Lease accounting (backend-types contract): settlement is per LEASE,
    // never per batch. A lease is acked only after its OWN echoed event has
    // been received by the consumer — the fake has no durable ledger, so
    // consumption is its delivery boundary, and resuming past an event's
    // yield proves receipt. A consumer that detaches or throws lands in the
    // finally, which nacks exactly the leases whose events never crossed
    // their yield; batch settlement would nack an already-delivered lease
    // into a redelivery.
    const outstanding: string[] = [];
    const settleOutstanding = (leaseId: string): void => {
      const index = outstanding.indexOf(leaseId);
      if (index === -1) return;
      outstanding.splice(index, 1);
      input.ackSteering?.([leaseId]);
    };
    const drainSteering = (): Array<{ leaseId: string; event: SessionEvent }> => {
      const leases = input.pullSteering?.() ?? [];
      if (leases.length === 0) return [];
      outstanding.push(...leases.map((lease) => lease.id));
      return leases.map((lease) => {
        steered.push(lease.content.text);
        return {
          leaseId: lease.id,
          event: {
            type: 'steering_message',
            id: randomUUID(),
            turnId,
            ts: Date.now(),
            messageId: lease.messageId,
            content: lease.content,
            ...(lease.submittedContentDigest
              ? { submittedContentDigest: lease.submittedContentDigest }
              : {}),
          } satisfies SessionEvent,
        };
      });
    };

    try {
      if (input.text === FAKE_HOLD_OPEN_PROMPT || input.text === FAKE_HOLD_OPEN_REWRITE_PROMPT) {
        const rewriteTarget = input.text === FAKE_HOLD_OPEN_REWRITE_PROMPT;
        const waitingPrefix = rewriteTarget
          ? 'prefix sk-123456789012345'
          : 'Fake backend waiting for the test to stop the Turn.';
        let waitingText = waitingPrefix;
        yield {
          type: 'text_delta',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          messageId,
          text: waitingText,
        };
        while (!this.stopped) {
          const pending = drainSteering();
          for (const { leaseId, event } of pending) {
            yield event;
            settleOutstanding(leaseId);
          }
          if (pending.length > 0) {
            const nextText = rewriteTarget
              ? `${waitingPrefix}6 NEW`
              : `${waitingPrefix}\n\nAcknowledged steering: ${steered.join(' | ')}`;
            const delta = nextText.slice(waitingText.length);
            waitingText = nextText;
            yield {
              type: 'text_delta',
              id: randomUUID(),
              turnId,
              ts: Date.now(),
              messageId,
              text: delta,
            };
          }
          await sleep(5);
        }
        yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
        yield {
          type: 'complete',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          stopReason: 'user_stop',
        };
        return;
      }

      if (input.text === FAKE_WAIT_FOR_STEERING_PROMPT) {
        let pending = drainSteering();
        while (pending.length === 0 && !this.stopped) {
          await sleep(5);
          pending = drainSteering();
        }
        for (const { leaseId, event } of pending) {
          yield event;
          settleOutstanding(leaseId);
        }
      }

      for (const chunk of chunks) {
        if (this.stopped) {
          yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
          yield {
            type: 'complete',
            id: randomUUID(),
            turnId,
            ts: Date.now(),
            stopReason: 'user_stop',
          };
          return;
        }
        if (input.text !== FAKE_WAIT_FOR_STEERING_PROMPT) await sleep(45);
        for (const { leaseId, event } of drainSteering()) {
          yield event;
          settleOutstanding(leaseId);
        }
        yield {
          type: 'text_delta',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          messageId,
          text: chunk,
        };
      }

      // Final stranded drain (grok-build safety): a steer that landed after the
      // last boundary still lands in this turn instead of being lost.
      for (const { leaseId, event } of drainSteering()) {
        yield event;
        settleOutstanding(leaseId);
      }
      if (steered.length > 0) {
        const ack = `\n\nAcknowledged steering: ${steered.join(' | ')}`;
        text += ack;
        yield {
          type: 'text_delta',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          messageId,
          text: ack,
        };
      }

      const ts = Date.now();
      const appendMessage =
        this.ctx.appendMessage ??
        ((message: StoredMessage) => this.ctx.store.appendMessage(this.sessionId, message));
      await appendMessage({
        type: 'assistant',
        id: messageId,
        turnId,
        ts,
        text,
        modelId: this.ctx.header.model,
      });
      yield { type: 'text_complete', id: randomUUID(), turnId, ts, messageId, text };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'end_turn' };
    } finally {
      if (outstanding.length > 0) input.nackSteering?.(outstanding.splice(0));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pendingQuestion && !this.pendingQuestion.hosted) {
      this.pendingQuestion.resolve(null);
      this.pendingQuestion = undefined;
    }
    if (this.pendingSandboxBoundary && !this.pendingSandboxBoundary.hosted) {
      this.pendingSandboxBoundary.resolve(null);
      this.pendingSandboxBoundary = undefined;
    }
  }

  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (this.pendingQuestion?.requestId !== response.requestId) return;
    if (this.pendingQuestion.hosted) {
      throw new RuntimeInteractionInvariantError(
        `Hosted fake question ${response.requestId} must settle through its captured continuation`,
      );
    }
    this.settleQuestionAnswer(this.pendingQuestion.turnId, response.requestId, response.answers);
  }

  async dispose(): Promise<void> {}

  private async *sendErrorScenario(
    input: BackendSendInput,
    requestedReason: string,
  ): AsyncIterable<SessionEvent> {
    await sleep(250);
    const turnId = input.turnId;
    if (this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }
    const reason =
      requestedReason === 'network' ||
      requestedReason === 'auth' ||
      requestedReason === 'rate_limit'
        ? requestedReason
        : undefined;
    yield {
      type: 'error',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      recoverable: false,
      ...(reason ? { reason } : {}),
      message: reason ? `Deterministic ${reason} failure` : 'Operation failed',
    };
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      stopReason: 'error',
    };
  }

  private async *sendQuestionScenario(input: BackendSendInput): AsyncIterable<SessionEvent> {
    // A real model needs time to produce its first tool call. Mirror that
    // boundary so a newly-created Desktop session can mount its event
    // subscription before this deterministic fake emits the request.
    await sleep(100);
    const turnId = input.turnId;
    if (this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }
    const toolUseId = randomUUID();
    const requestId = randomUUID();
    const stepId = randomUUID();
    const questions = [
      {
        question: '首批发布范围选哪个？',
        options: [
          { label: '邀请制', description: '先验证核心流程，再逐步扩大范围。' },
          { label: '公开测试', description: '允许所有访客注册，但保留 Beta 标识。' },
        ],
      },
      {
        question: '上线时间怎么安排？',
        options: [{ label: '本周' }, { label: '下周' }],
      },
      {
        question: '是否同步发布公告？',
        options: [{ label: '是' }, { label: '否' }],
      },
    ];
    const appendMessage =
      this.ctx.appendMessage ??
      ((message: StoredMessage) => this.ctx.store.appendMessage(this.sessionId, message));
    const startedAt = Date.now();
    await appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      stepId,
      ts: startedAt,
      toolName: 'AskUserQuestion',
      args: { questions },
    });
    yield {
      type: 'tool_start',
      id: randomUUID(),
      turnId,
      stepId,
      ts: startedAt,
      toolUseId,
      toolName: 'AskUserQuestion',
      args: { questions },
    };

    let resolveResponse!: (response: UserQuestionResponse | null) => void;
    const responsePromise = new Promise<UserQuestionResponse | null>((resolve) => {
      resolveResponse = resolve;
    });
    this.pendingQuestion = {
      turnId,
      requestId,
      hosted: input.hostedInteraction !== undefined,
      resolve: resolveResponse,
    };
    const request = {
      type: 'user_question_request',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      questions,
    } satisfies Extract<SessionEvent, { type: 'user_question_request' }>;
    if (input.hostedInteraction) {
      const settlement = this.createQuestionSettlement(turnId, requestId);
      try {
        await input.hostedInteraction.admitUserQuestionRequest({ request, settlement });
      } catch (error) {
        this.takePendingQuestion(turnId, requestId).resolve(null);
        throw error;
      }
    }
    yield request;

    const response = await responsePromise;
    if (this.pendingQuestion?.requestId === requestId) this.pendingQuestion = undefined;
    if (!response || this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }

    yield {
      type: 'user_question_answer_ack',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
    };

    const result = {
      answers: questions.map((question, index) => ({
        question: question.question,
        answer: response.answers[index] ?? null,
      })),
    };
    const resultContent = { kind: 'json' as const, value: result };
    const resultTs = Date.now();
    await appendMessage({
      type: 'tool_result',
      id: randomUUID(),
      turnId,
      ts: resultTs,
      toolUseId,
      isError: false,
      content: resultContent,
    });
    yield {
      type: 'tool_result',
      id: randomUUID(),
      turnId,
      ts: resultTs,
      toolUseId,
      isError: false,
      content: resultContent,
    };

    const messageId = randomUUID();
    const text = `Fake question answers: ${response.answers.map((answer) => answer ?? '未回答').join(' / ')}`;
    for (const chunk of text.match(/[\s\S]{1,9}/g) ?? [text]) {
      yield {
        type: 'text_delta',
        id: randomUUID(),
        turnId,
        ts: Date.now(),
        messageId,
        text: chunk,
      };
    }
    const completedAt = Date.now();
    await appendMessage({
      type: 'assistant',
      id: messageId,
      turnId,
      ts: completedAt,
      text,
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: randomUUID(), turnId, ts: completedAt, messageId, text };
    yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'end_turn' };
  }

  private async *sendSandboxBoundaryScenario(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await sleep(100);
    const turnId = input.turnId;
    if (this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }
    if (!input.hostedInteraction) {
      throw new RuntimeInteractionInvariantError(
        'Fake sandbox boundary scenario requires hosted Interaction authority',
      );
    }

    const toolUseId = randomUUID();
    const requestId = randomUUID();
    const stepId = randomUUID();
    const expansion = { network: { enabled: true as const } };
    const justification = 'Connect to the deterministic fake test endpoint.';
    const appendMessage =
      this.ctx.appendMessage ??
      ((message: StoredMessage) => this.ctx.store.appendMessage(this.sessionId, message));
    const startedAt = Date.now();
    await appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      stepId,
      ts: startedAt,
      toolName: 'RequestSandboxBoundary',
      args: { expansion, justification },
    });
    yield {
      type: 'tool_start',
      id: randomUUID(),
      turnId,
      stepId,
      ts: startedAt,
      toolUseId,
      toolName: 'RequestSandboxBoundary',
      args: { expansion, justification },
    };

    let resolveSettlement!: (settlement: SandboxBoundarySettlement | null) => void;
    const settlementPromise = new Promise<SandboxBoundarySettlement | null>((resolve) => {
      resolveSettlement = resolve;
    });
    this.pendingSandboxBoundary = {
      turnId,
      requestId,
      hosted: true,
      resolve: resolveSettlement,
    };
    const request = {
      type: 'sandbox_boundary_request',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      expansion,
      justification,
    } satisfies Extract<SessionEvent, { type: 'sandbox_boundary_request' }>;
    try {
      await input.hostedInteraction.admitSandboxBoundaryRequest({
        request,
        settlement: this.createSandboxBoundarySettlement(turnId, requestId),
      });
    } catch (error) {
      this.takePendingSandboxBoundary(turnId, requestId).resolve(null);
      throw error;
    }
    yield request;

    const settlement = await settlementPromise;
    if (this.pendingSandboxBoundary?.requestId === requestId) {
      this.pendingSandboxBoundary = undefined;
    }
    if (!settlement || this.stopped) {
      yield { type: 'abort', id: randomUUID(), turnId, ts: Date.now(), reason: 'user_stop' };
      yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'user_stop' };
      return;
    }

    if (settlement.request.status === 'pending') {
      throw new RuntimeInteractionInvariantError(
        `Fake sandbox boundary settlement ${requestId} is still pending`,
      );
    }
    const decision = settlement.request.status === 'denied' ? 'deny' : 'allow';
    yield {
      type: 'sandbox_boundary_decision_ack',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      decision,
      status: settlement.request.status,
      revision: settlement.boundary.revision,
    };
    const resultContent = {
      kind: 'json' as const,
      value: { decision, status: settlement.request.status },
    };
    const resultTs = Date.now();
    await appendMessage({
      type: 'tool_result',
      id: randomUUID(),
      turnId,
      ts: resultTs,
      toolUseId,
      isError: decision === 'deny',
      content: resultContent,
    });
    yield {
      type: 'tool_result',
      id: randomUUID(),
      turnId,
      ts: resultTs,
      toolUseId,
      isError: decision === 'deny',
      content: resultContent,
    };

    const messageId = randomUUID();
    const text = `Fake sandbox boundary decision: ${decision}`;
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      messageId,
      text,
    };
    const completedAt = Date.now();
    await appendMessage({
      type: 'assistant',
      id: messageId,
      turnId,
      ts: completedAt,
      text,
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: randomUUID(), turnId, ts: completedAt, messageId, text };
    yield { type: 'complete', id: randomUUID(), turnId, ts: Date.now(), stopReason: 'end_turn' };
  }

  private createQuestionSettlement(
    turnId: string,
    requestId: string,
  ): HostedUserQuestionSettlement {
    return Object.freeze({
      applyAnswer: async (answer: HostedUserQuestionAnswer): Promise<void> => {
        if (Object.hasOwn(answer, 'requestId')) {
          throw new RuntimeInteractionInvariantError(
            `Fake question settlement ${requestId} received a routed answer`,
          );
        }
        this.settleQuestionAnswer(turnId, requestId, answer.answers);
      },
      applyClosure: async (_reason: RuntimeUserQuestionClosureReason): Promise<void> => {
        this.takePendingQuestion(turnId, requestId).resolve(null);
      },
    });
  }

  private createSandboxBoundarySettlement(
    turnId: string,
    requestId: string,
  ): HostedSandboxBoundarySettlement {
    return Object.freeze({
      applyDecision: async (settlement: SandboxBoundarySettlement): Promise<void> => {
        if (
          settlement.request.sessionId !== this.sessionId ||
          settlement.request.requestId !== requestId
        ) {
          throw new RuntimeInteractionInvariantError(
            `Fake sandbox boundary settlement ${requestId} changed identity`,
          );
        }
        this.takePendingSandboxBoundary(turnId, requestId).resolve(settlement);
      },
      applyClosure: async (_reason: RuntimeUserQuestionClosureReason): Promise<void> => {
        this.takePendingSandboxBoundary(turnId, requestId).resolve(null);
      },
    });
  }

  private takePendingQuestion(turnId: string, requestId: string): PendingQuestion {
    const pending = this.pendingQuestion;
    if (!pending || pending.turnId !== turnId || pending.requestId !== requestId) {
      throw new RuntimeInteractionInvariantError(
        `Fake question settlement did not exact-take ${requestId} from turn ${turnId}`,
      );
    }
    this.pendingQuestion = undefined;
    return pending;
  }

  private takePendingSandboxBoundary(turnId: string, requestId: string): PendingSandboxBoundary {
    const pending = this.pendingSandboxBoundary;
    if (!pending || pending.turnId !== turnId || pending.requestId !== requestId) {
      throw new RuntimeInteractionInvariantError(
        `Fake sandbox boundary settlement did not exact-take ${requestId} from turn ${turnId}`,
      );
    }
    this.pendingSandboxBoundary = undefined;
    return pending;
  }

  private settleQuestionAnswer(
    turnId: string,
    requestId: string,
    answers: readonly (string | null)[],
  ): void {
    this.takePendingQuestion(turnId, requestId).resolve({
      requestId,
      answers: [...answers],
    });
  }
}
