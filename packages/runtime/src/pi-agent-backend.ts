import { isDeepStrictEqual } from 'node:util';

import type {
  BackendKind,
  SessionEvent,
  SessionHeader,
  ToolCallMessage,
  ToolOutputStream,
  ToolResultContent,
  ToolResultMessage,
  TokenUsageMessage,
} from '@maka/core';
import {
  computerUseModelCallArgs,
  decodeCanonicalToolResultContent,
  TOOL_OUTPUT_DELTA_MAX_CHARS,
} from '@maka/core';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { redactSecrets } from '@maka/core/redaction';

import type { AgentBackend } from '@maka/core/backend-types';
import type { AppendMessageFn } from './ai-sdk-backend.js';

export interface PiAgentBackendInput {
  sessionId: string;
  header: SessionHeader;
  appendMessage: AppendMessageFn;
  transport: PiAgentTransport;
  newId?: () => string;
  now?: () => number;
}

export interface PiAgentTransport {
  send(input: PiAgentSendInput): AsyncIterable<PiAgentFrame>;
  stop?(reason: 'user_stop' | 'redirect'): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface PiAgentSendInput {
  sessionId: string;
  turnId: string;
  cwd: string;
  text: string;
}

export type PiAgentFrame =
  | { type: 'text_delta'; text: string; messageId?: string }
  | { type: 'text_complete'; text?: string; messageId?: string }
  | {
      type: 'tool_start';
      toolUseId: string;
      toolName: string;
      args?: unknown;
      displayName?: string;
      intent?: string;
    }
  | { type: 'tool_output_delta'; toolUseId: string; stream?: ToolOutputStream; chunk: string }
  | {
      type: 'tool_result';
      toolUseId: string;
      isError?: boolean;
      content?: ToolResultContent | unknown;
    }
  | {
      type: 'token_usage';
      input: number;
      output: number;
      cacheHitInput?: number;
      cacheMissInput?: number;
      cacheWriteInput?: number;
      reasoning?: number;
      total?: number;
      costUsd?: number;
    }
  | { type: 'error'; message: string; code?: string; details?: unknown }
  | { type: 'complete'; stopReason?: 'end_turn' | 'error' | 'max_tokens' };

export class PiAgentBackend implements AgentBackend {
  readonly kind: BackendKind = 'pi-agent';
  readonly sessionId: string;

  private readonly input: PiAgentBackendInput;
  private readonly newId: () => string;
  private readonly now: () => number;
  private stopped = false;
  private currentTurnId: string | null = null;
  private outputSeqByTool = new Map<string, number>();
  private toolCallsByUseId = new Map<string, { toolName: string; args: unknown }>();

  constructor(input: PiAgentBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.toolMode === 'code_mode') {
      throw new Error('Pi-agent backend does not support code_mode tool mode');
    }
    const turnId = input.turnId;
    let messageId = this.newId();
    let currentProviderMessageId: string | undefined;
    const usedMessageIds = new Set([messageId]);
    let assistantText = '';
    let assistantPersisted = false;
    let textCompleteEmitted = false;
    let stepHasTools = false;
    const activeToolUseIds = new Set<string>();
    this.stopped = false;
    this.currentTurnId = turnId;
    this.outputSeqByTool = new Map();
    this.toolCallsByUseId = new Map();

    const beginStep = (preferredMessageId?: string, nextProviderMessageId?: string): void => {
      let nextMessageId = preferredMessageId;
      while (!nextMessageId || usedMessageIds.has(nextMessageId)) nextMessageId = this.newId();
      messageId = nextMessageId;
      currentProviderMessageId = nextProviderMessageId;
      usedMessageIds.add(messageId);
      assistantText = '';
      assistantPersisted = false;
      textCompleteEmitted = false;
      stepHasTools = false;
      activeToolUseIds.clear();
    };
    const persistAssistant = async (): Promise<void> => {
      if (assistantPersisted || assistantText.length === 0) return;
      await this.appendAssistant(turnId, messageId, assistantText);
      assistantPersisted = true;
    };
    const completeStepText = async (): Promise<
      Extract<SessionEvent, { type: 'text_complete' }> | undefined
    > => {
      if (textCompleteEmitted || assistantText.length === 0) return undefined;
      await persistAssistant();
      textCompleteEmitted = true;
      return {
        type: 'text_complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        messageId,
        text: assistantText,
      };
    };
    const prepareTextStep = (providerMessageId?: string): void => {
      const stepEnded = textCompleteEmitted || (stepHasTools && activeToolUseIds.size === 0);
      if (stepEnded) {
        const preferredMessageId =
          providerMessageId !== currentProviderMessageId ? providerMessageId : undefined;
        beginStep(preferredMessageId, providerMessageId);
      } else if (providerMessageId && providerMessageId !== currentProviderMessageId) {
        beginStep(providerMessageId, providerMessageId);
      }
    };

    try {
      for await (const rawFrame of this.input.transport.send({
        sessionId: this.sessionId,
        turnId,
        cwd: this.input.header.cwd,
        text: input.text,
      })) {
        if (this.stopped) {
          await persistAssistant();
          yield this.abortEvent(turnId);
          yield this.completeEvent(turnId, 'user_stop');
          return;
        }

        const frame = normalizePiAgentFrame(rawFrame);
        if (!frame) continue;

        switch (frame.type) {
          case 'text_delta': {
            prepareTextStep(frame.messageId);
            const text = redactBoundedText(frame.text);
            assistantText += text;
            yield {
              type: 'text_delta',
              id: this.newId(),
              turnId,
              ts: this.now(),
              messageId,
              text,
            };
            break;
          }
          case 'text_complete': {
            prepareTextStep(frame.messageId);
            const text = redactBoundedText(frame.text ?? assistantText);
            assistantText = text;
            const complete = await completeStepText();
            if (complete) yield complete;
            break;
          }
          case 'tool_start': {
            const frameArgs = structuredClone(frame.args);
            await persistAssistant();
            const canonicalArgs = await this.ensureToolCall(
              turnId,
              frame.toolUseId,
              frame.toolName,
              frameArgs,
              {
                ...(frame.displayName ? { displayName: frame.displayName } : {}),
                ...(frame.intent ? { intent: frame.intent } : {}),
                stepId: messageId,
              },
            );
            stepHasTools = true;
            activeToolUseIds.add(frame.toolUseId);
            const projectedArgs = projectPiToolArgs(frame.toolName, canonicalArgs);
            yield {
              type: 'tool_start',
              id: this.newId(),
              turnId,
              ts: this.now(),
              toolUseId: frame.toolUseId,
              toolName: frame.toolName,
              args: projectedArgs,
              ...(frame.displayName ? { displayName: frame.displayName } : {}),
              ...(frame.intent ? { intent: redactBoundedText(frame.intent, 240) } : {}),
              stepId: messageId,
            };
            break;
          }
          case 'tool_output_delta': {
            const seq = (this.outputSeqByTool.get(frame.toolUseId) ?? 0) + 1;
            this.outputSeqByTool.set(frame.toolUseId, seq);
            const redacted = redactBoundedText(frame.chunk);
            yield {
              type: 'tool_output_delta',
              id: this.newId(),
              turnId,
              ts: this.now(),
              sessionId: this.sessionId,
              toolCallId: frame.toolUseId,
              toolUseId: frame.toolUseId,
              seq,
              stream: frame.stream ?? 'stdout',
              chunk: redacted,
              redacted: redacted !== frame.chunk,
              createdAt: this.now(),
            };
            break;
          }
          case 'tool_result': {
            const content = normalizeToolResultContent(frame.content);
            await this.appendToolResult(turnId, frame.toolUseId, Boolean(frame.isError), content);
            yield {
              type: 'tool_result',
              id: this.newId(),
              turnId,
              ts: this.now(),
              toolUseId: frame.toolUseId,
              isError: Boolean(frame.isError),
              content,
            };
            activeToolUseIds.delete(frame.toolUseId);
            if (stepHasTools && activeToolUseIds.size === 0) {
              const complete = await completeStepText();
              if (complete) yield complete;
            }
            break;
          }
          case 'token_usage': {
            const event = this.tokenUsageEvent(turnId, frame);
            await this.input.appendMessage(event);
            yield event;
            break;
          }
          case 'error': {
            await persistAssistant();
            yield {
              type: 'error',
              id: this.newId(),
              turnId,
              ts: this.now(),
              recoverable: false,
              ...(frame.code ? { code: frame.code } : {}),
              reason: 'pi_agent_error',
              message: redactBoundedText(frame.message),
              ...(frame.details
                ? { details: redactUnknown(frame.details) as Record<string, unknown> }
                : {}),
            };
            yield this.completeEvent(turnId, 'error');
            return;
          }
          case 'complete': {
            const complete = await completeStepText();
            if (complete) yield complete;
            yield this.completeEvent(turnId, frame.stopReason ?? 'end_turn');
            return;
          }
        }
      }

      const complete = await completeStepText();
      if (complete) yield complete;
      yield this.completeEvent(turnId, 'end_turn');
    } catch (error) {
      if (this.stopped) {
        await persistAssistant();
        yield this.abortEvent(turnId);
        yield this.completeEvent(turnId, 'user_stop');
        return;
      }
      await persistAssistant();
      yield {
        type: 'error',
        id: this.newId(),
        turnId,
        ts: this.now(),
        recoverable: false,
        reason: 'pi_agent_transport_error',
        message: redactBoundedText(error instanceof Error ? error.message : String(error)),
      };
      yield this.completeEvent(turnId, 'error');
    } finally {
      this.currentTurnId = null;
      this.outputSeqByTool.clear();
      this.toolCallsByUseId.clear();
      this.stopped = false;
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    this.stopped = true;
    await this.input.transport.stop?.(reason);
  }

  async respondToSandboxBoundary(decision: SandboxBoundaryResponse): Promise<void> {
    throw new Error(`No pending sandbox boundary request ${decision.requestId}`);
  }

  async dispose(): Promise<void> {
    await this.input.transport.dispose?.();
  }

  private async ensureToolCall(
    turnId: string,
    toolUseId: string,
    toolName: string,
    args: unknown,
    metadata: {
      displayName?: string;
      intent?: string;
      stepId?: string;
    } = {},
  ): Promise<unknown> {
    const existing = this.toolCallsByUseId.get(toolUseId);
    if (existing) {
      if (existing.toolName !== toolName || !isDeepStrictEqual(existing.args, args)) {
        throw new Error(`Pi tool call ${toolUseId} changed after its first frame`);
      }
      return structuredClone(existing.args);
    }
    const snapshot = structuredClone(args);
    this.toolCallsByUseId.set(toolUseId, { toolName, args: snapshot });
    await this.input.appendMessage({
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: this.now(),
      toolName,
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.intent ? { intent: redactBoundedText(metadata.intent, 240) } : {}),
      args: projectPiToolArgs(toolName, snapshot),
      ...(metadata.stepId ? { stepId: metadata.stepId } : {}),
    } satisfies ToolCallMessage);
    return structuredClone(snapshot);
  }

  private async appendAssistant(turnId: string, messageId: string, text: string): Promise<void> {
    await this.input.appendMessage({
      type: 'assistant',
      id: messageId,
      turnId,
      ts: this.now(),
      text,
      modelId: this.input.header.model,
    });
  }

  private async appendToolResult(
    turnId: string,
    toolUseId: string,
    isError: boolean,
    content: ToolResultContent,
  ): Promise<void> {
    await this.input.appendMessage({
      type: 'tool_result',
      id: this.newId(),
      turnId,
      ts: this.now(),
      toolUseId,
      isError,
      content,
    } satisfies ToolResultMessage);
  }

  private toolResultEvent(
    turnId: string,
    toolUseId: string,
    isError: boolean,
    content: ToolResultContent,
  ): SessionEvent {
    return {
      type: 'tool_result',
      id: this.newId(),
      turnId,
      ts: this.now(),
      toolUseId,
      isError,
      content,
    };
  }

  private tokenUsageEvent(
    turnId: string,
    frame: Extract<PiAgentFrame, { type: 'token_usage' }>,
  ): TokenUsageMessage {
    const cacheHitInput = frame.cacheHitInput ?? 0;
    const cacheWriteInput = frame.cacheWriteInput ?? 0;
    return {
      type: 'token_usage',
      id: this.newId(),
      turnId,
      ts: this.now(),
      input: frame.input,
      output: frame.output,
      ...(cacheHitInput > 0 ? { cacheHitInput, cacheRead: cacheHitInput } : {}),
      ...(frame.cacheMissInput !== undefined
        ? { cacheMissInput: frame.cacheMissInput, cacheMissInputSource: 'explicit' }
        : {}),
      ...(cacheWriteInput > 0 ? { cacheWriteInput, cacheCreation: cacheWriteInput } : {}),
      ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
      ...(frame.total !== undefined ? { total: frame.total } : {}),
      ...(frame.costUsd !== undefined ? { costUsd: frame.costUsd } : {}),
    };
  }

  private abortEvent(turnId: string): SessionEvent {
    return { type: 'abort', id: this.newId(), turnId, ts: this.now(), reason: 'user_stop' };
  }

  private completeEvent(
    turnId: string,
    stopReason: 'end_turn' | 'user_stop' | 'error' | 'max_tokens',
  ): SessionEvent {
    return { type: 'complete', id: this.newId(), turnId, ts: this.now(), stopReason };
  }
}

/**
 * The args written into the persisted `tool_call` message and the `tool_start`
 * event — the record of the call the model reads back on its next turn.
 *
 * Computer Use used the host's approval summary here. That projection exists to
 * decide and display a permission: it renames `window_id` to `windowId`, adds
 * `approvalClass` and `rememberForTurnAllowed`, and drops every argument it does
 * not need. None of that is what the model sent, so the model's own history
 * showed it calling `maka_computer` in a dialect the tool rejects, with the key
 * or value it had chosen missing. `computerUseModelCallArgs` keeps the same
 * privacy boundary and speaks the tool's own argument names.
 */
function projectPiToolArgs(toolName: string, args: unknown): unknown {
  const projected =
    toolName === 'maka_computer' ? computerUseModelCallArgs(args) : redactUnknown(args);
  return structuredClone(projected);
}

export function normalizePiAgentFrame(frame: unknown): PiAgentFrame | null {
  if (!frame || typeof frame !== 'object') return null;
  const value = frame as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : undefined;
  if (type === 'text_delta' && typeof value.text === 'string') {
    return {
      type,
      text: value.text,
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    };
  }
  if (type === 'text_complete') {
    return {
      type,
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    };
  }
  if (
    type === 'tool_start' &&
    typeof value.toolUseId === 'string' &&
    typeof value.toolName === 'string'
  ) {
    return {
      type,
      toolUseId: value.toolUseId,
      toolName: value.toolName,
      args: value.args ?? null,
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
      ...(typeof value.intent === 'string' ? { intent: value.intent } : {}),
    };
  }
  if (
    type === 'tool_output_delta' &&
    typeof value.toolUseId === 'string' &&
    typeof value.chunk === 'string'
  ) {
    const stream = value.stream === 'stderr' ? 'stderr' : 'stdout';
    return { type, toolUseId: value.toolUseId, stream, chunk: value.chunk };
  }
  if (type === 'tool_result' && typeof value.toolUseId === 'string') {
    return {
      type,
      toolUseId: value.toolUseId,
      isError: value.isError === true,
      content: value.content ?? null,
    };
  }
  if (type === 'token_usage') {
    const input = finiteNumber(value.input);
    const output = finiteNumber(value.output);
    if (input === undefined || output === undefined) return null;
    return {
      type,
      input,
      output,
      ...numberField('cacheHitInput', value.cacheHitInput),
      ...numberField('cacheMissInput', value.cacheMissInput),
      ...numberField('cacheWriteInput', value.cacheWriteInput),
      ...numberField('reasoning', value.reasoning),
      ...numberField('total', value.total),
      ...numberField('costUsd', value.costUsd),
    };
  }
  if (type === 'error' && typeof value.message === 'string') {
    return {
      type,
      message: value.message,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(value.details !== undefined ? { details: value.details } : {}),
    };
  }
  if (type === 'complete') {
    const stopReason =
      value.stopReason === 'error' || value.stopReason === 'max_tokens'
        ? value.stopReason
        : 'end_turn';
    return { type, stopReason };
  }
  return null;
}

function numberField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const number = finiteNumber(value);
  return number === undefined ? {} : ({ [key]: number } as { [P in K]?: number });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolResultContent(content: unknown): ToolResultContent {
  if (typeof content === 'string') return { kind: 'text', text: redactBoundedText(content) };
  const redacted = redactUnknown(content ?? null);
  try {
    return decodeCanonicalToolResultContent(redacted);
  } catch {
    return { kind: 'json', value: redacted };
  }
}

const TRUNCATED_TEXT_MARKER = '\n[内容已截断]';

function redactBoundedText(text: string, maxChars = TOOL_OUTPUT_DELTA_MAX_CHARS): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= maxChars) return redacted;
  const marker = TRUNCATED_TEXT_MARKER.slice(0, maxChars);
  return `${redacted.slice(0, maxChars - marker.length)}${marker}`;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactBoundedText(value);
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return '[无法序列化的参数]';
  }
}
