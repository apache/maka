import type { ProviderRetryEvent, SessionEvent, StoredMessage, UiLocale } from '@maka/core';
import { applyAssistantComplete, applyAssistantDelta } from './assistant-stream.js';
import { projectToolActivityArgs, toolResultActivityStatus } from '@maka/core';
import { isInFlightToolStatus } from '@maka/core';
import type { ToolActivityItem } from './materialize.js';
import { applyThinkingComplete, applyThinkingDelta } from './thinking-stream.js';
import { applyToolOutputChunk } from './tool-output-stream.js';

type LiveTurnContentEvent = Extract<SessionEvent, { type: 'thinking_delta' | 'thinking_complete' | 'text_delta' | 'text_complete' | 'tool_start' | 'tool_output_delta' | 'tool_result' }>;

export interface LiveThinkingProjection {
  text: string;
  truncated: boolean;
  complete: boolean;
}

export interface LiveTurnStepProjection {
  stepId: string;
  contentOrder?: LiveTurnStepContentKind[];
  thinking?: LiveThinkingProjection;
  text?: LiveTextProjection;
  tools: ToolActivityItem[];
}

export type LiveTurnStepContentKind = 'thinking' | 'text' | 'tools';

export interface LiveTextProjection {
  text: string;
  truncated: boolean;
  complete: boolean;
}

export interface LiveTurnProjection {
  turnId: string;
  phase: 'waiting' | 'streamed';
  terminal?: true;
  /**
   * Set by `armLiveTurn` and cleared by the first word the authority says about
   * this turn (`confirmLiveTurn`, or any event carrying the same turnId).
   *
   * A client that just sent cannot tell "the authority has not reached my turn
   * yet" from "my turn is over" by reading session status: it reads the same
   * before a turn starts and after it ends. So a snapshot taken before the send
   * landed would retire the arm the send just placed. This bit says the arm is
   * still waiting for its answer, which is what keeps such a snapshot from
   * settling it. Dropped for good once the answer arrives.
   */
  unconfirmed?: true;
  providerRetry?: ProviderRetryEvent;
  steps: LiveTurnStepProjection[];
}

function projectToolActivityIdentity(event: {
  origin?: ToolActivityItem['origin'];
  modelVisibility?: ToolActivityItem['modelVisibility'];
  parentToolCallId?: string;
  parentOperationId?: string;
}): Pick<
  ToolActivityItem,
  'origin' | 'modelVisibility' | 'parentToolCallId' | 'parentOperationId'
> {
  return {
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
    ...(event.modelVisibility !== undefined ? { modelVisibility: event.modelVisibility } : {}),
    ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
    ...(event.parentOperationId !== undefined ? { parentOperationId: event.parentOperationId } : {}),
  };
}

function terminalizeLiveSteps(steps: readonly LiveTurnStepProjection[]): LiveTurnStepProjection[] {
  return steps.map((step) => ({
    ...step,
    ...(step.thinking ? { thinking: { ...step.thinking, complete: true } } : {}),
    ...(step.text ? { text: { ...step.text, complete: true } } : {}),
    tools: step.tools.map((tool) => (
      isInFlightToolStatus(tool.status) ? { ...tool, status: 'interrupted' as const } : tool
    )),
  }));
}

function inferredContentOrder(step: LiveTurnStepProjection): LiveTurnStepContentKind[] {
  return [
    ...(step.thinking ? ['thinking' as const] : []),
    ...(step.text ? ['text' as const] : []),
    ...(step.tools.length > 0 ? ['tools' as const] : []),
  ];
}

function appendContentKind(
  step: LiveTurnStepProjection,
  kind: LiveTurnStepContentKind,
): LiveTurnStepContentKind[] {
  const order = step.contentOrder ?? inferredContentOrder(step);
  return order.includes(kind) ? order : [...order, kind];
}

export function armLiveTurn(turnId: string): LiveTurnProjection {
  return { turnId, phase: 'waiting', steps: [], unconfirmed: true };
}

/** Drop the `unconfirmed` claim; identity-preserving when there is none. */
function confirmed(projection: LiveTurnProjection): LiveTurnProjection {
  if (!projection.unconfirmed) return projection;
  const { unconfirmed: _unconfirmed, ...rest } = projection;
  return rest;
}

/**
 * The authority answered about `turnId`: clear the arm's pending claim so a
 * later snapshot may retire it. A different turn's answer says nothing about
 * this one, so the projection is returned unchanged (same reference).
 */
export function confirmLiveTurn(
  current: LiveTurnProjection | undefined,
  turnId: string,
): LiveTurnProjection | undefined {
  if (!current || current.turnId !== turnId) return current;
  return confirmed(current);
}

export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: LiveTurnContentEvent,
  locale?: UiLocale,
): LiveTurnProjection;
export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
  locale?: UiLocale,
): LiveTurnProjection | undefined;
export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
  locale: UiLocale = 'zh',
): LiveTurnProjection | undefined {
  if (event.type === 'provider_retry') {
    const prior = current?.turnId === event.turnId
      ? current
      : { turnId: event.turnId, phase: 'waiting' as const, steps: [] };
    return { ...confirmed(prior), providerRetry: event };
  }
  if (event.type === 'error' || event.type === 'abort') {
    if (!current || current.turnId !== event.turnId) return current;
    const steps = terminalizeLiveSteps(current.steps);
    if (steps.length === 0) return undefined;
    const { providerRetry: _providerRetry, ...withoutRetry } = confirmed(current);
    return { ...withoutRetry, terminal: true, steps };
  }
  if (event.type === 'complete') {
    if (!current || current.turnId !== event.turnId) return current;
    if (current.steps.length === 0) return undefined;
    const { providerRetry: _providerRetry, ...withoutRetry } = confirmed(current);
    return {
      ...withoutRetry,
      terminal: true,
      steps: terminalizeLiveSteps(current.steps),
    };
  }
  if (
    event.type !== 'thinking_delta'
    && event.type !== 'thinking_complete'
    && event.type !== 'text_delta'
    && event.type !== 'text_complete'
    && event.type !== 'tool_start'
    && event.type !== 'tool_output_delta'
    && event.type !== 'tool_result'
  ) {
    return current;
  }
  const prior = current?.turnId === event.turnId
    ? current
    : { turnId: event.turnId, phase: 'streamed' as const, steps: [] };
  const { providerRetry: _providerRetry, ...priorWithoutRetry } = confirmed(prior);
  const messageEvent = event.type === 'thinking_delta'
    || event.type === 'thinking_complete'
    || event.type === 'text_delta'
    || event.type === 'text_complete';
  const existingToolStep = event.type === 'tool_start'
    || event.type === 'tool_output_delta'
    || event.type === 'tool_result'
    ? prior.steps.find((candidate) => candidate.tools.some((tool) => tool.toolUseId === event.toolUseId))
    : undefined;
  const stepId = messageEvent
    ? event.messageId
    : event.type === 'tool_start'
      ? event.stepId ?? existingToolStep?.stepId ?? `tool:${event.toolUseId}`
      : existingToolStep?.stepId ?? `tool:${event.toolUseId}`;
  const stepIndex = prior.steps.findIndex((step) => step.stepId === stepId);
  const step = stepIndex >= 0 ? prior.steps[stepIndex]! : { stepId, tools: [] };
  let nextStep: LiveTurnStepProjection;
  if (event.type === 'thinking_delta') {
    const applied = applyThinkingDelta(step.thinking?.text ?? '', event.text, { locale });
    nextStep = {
      ...step,
      thinking: {
        text: applied.text,
        truncated: (step.thinking?.truncated ?? false) || applied.truncated,
        complete: false,
      },
    };
  } else if (event.type === 'thinking_complete') {
    const applied = applyThinkingComplete(event.text, { locale });
    nextStep = {
      ...step,
      thinking: {
        text: applied.text,
        truncated: applied.truncated,
        complete: true,
      },
    };
  } else if (event.type === 'text_delta') {
    const applied = applyAssistantDelta(step.text?.text ?? '', event.text, { locale });
    nextStep = {
      ...step,
      text: {
        text: applied.text,
        truncated: (step.text?.truncated ?? false) || applied.truncated,
        complete: false,
      },
    };
  } else if (event.type === 'text_complete') {
    const applied = applyAssistantComplete(event.text, { locale });
    nextStep = {
      ...step,
      text: {
        text: applied.text,
        truncated: applied.truncated,
        complete: true,
      },
    };
  } else if (event.type === 'tool_start') {
    const startedTool: ToolActivityItem = {
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      ...(event.activityKind !== undefined ? { activityKind: event.activityKind } : {}),
      ...(event.displayName !== undefined ? { displayName: event.displayName } : {}),
      ...(event.intent !== undefined ? { intent: event.intent } : {}),
      ...projectToolActivityIdentity(event),
      ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
      status: 'pending',
      args: projectToolActivityArgs(event.toolName, event.args),
    };
    const existingTool = existingToolStep?.tools.find((candidate) => candidate.toolUseId === event.toolUseId);
    const tool: ToolActivityItem = existingTool
      ? { ...existingTool, ...startedTool, status: existingTool.status }
      : startedTool;
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? { ...candidate, ...tool } : candidate)
        : [...step.tools, tool],
    };
  } else if (event.type === 'tool_output_delta') {
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'running', args: undefined };
    const applied = applyToolOutputChunk(base.outputChunks, {
      seq: event.seq,
      stream: event.stream,
      text: event.chunk,
      redacted: event.redacted,
      createdAt: event.createdAt,
    }, { locale });
    const tool: ToolActivityItem = {
      ...base,
      ...projectToolActivityIdentity(event),
      status: base.status === 'pending' ? 'running' : base.status,
      outputChunks: applied.chunks,
      outputTruncated: base.outputTruncated || applied.truncated,
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  } else {
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'pending', args: undefined };
    const tool: ToolActivityItem = {
      ...base,
      ...projectToolActivityIdentity(event),
      status: toolResultActivityStatus(event.isError, event.content),
      result: event.content,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  }
  const contentKind: LiveTurnStepContentKind = messageEvent
    ? event.type === 'thinking_delta' || event.type === 'thinking_complete' ? 'thinking' : 'text'
    : 'tools';
  nextStep = {
    ...nextStep,
    contentOrder: appendContentKind(step, contentKind),
  };
  let steps: LiveTurnStepProjection[];
  if (existingToolStep && existingToolStep.stepId !== stepId && !messageEvent) {
    const sourceIndex = prior.steps.findIndex((candidate) => candidate.stepId === existingToolStep.stepId);
    const sourceWithoutTool = {
      ...existingToolStep,
      tools: existingToolStep.tools.filter((tool) => tool.toolUseId !== event.toolUseId),
    };
    if (sourceWithoutTool.tools.length === 0 && sourceWithoutTool.contentOrder) {
      sourceWithoutTool.contentOrder = sourceWithoutTool.contentOrder.filter((kind) => kind !== 'tools');
    }
    const sourceIsEmpty = !sourceWithoutTool.thinking && !sourceWithoutTool.text && sourceWithoutTool.tools.length === 0;
    steps = [];
    for (let index = 0; index < prior.steps.length; index += 1) {
      const candidate = prior.steps[index]!;
      if (index === sourceIndex) {
        if (!sourceIsEmpty) steps.push(sourceWithoutTool);
        if (stepIndex < 0 && sourceIsEmpty) steps.push(nextStep);
      } else if (index === stepIndex) {
        steps.push(nextStep);
      } else {
        steps.push(candidate);
      }
    }
    if (stepIndex < 0 && !sourceIsEmpty) steps.push(nextStep);
  } else {
    steps = stepIndex >= 0
      ? prior.steps.map((candidate, index) => index === stepIndex ? nextStep : candidate)
      : [...prior.steps, nextStep];
  }
  return { ...priorWithoutRetry, phase: 'streamed', steps };
}

/**
 * Streaming display handoff: drop the committed text/thinking slots for `stepId`.
 * Tools that still carry live stream evidence (outputChunks) stay — empty
 * shell_run durable results do not cover them, and co-located Bash+answer
 * steps must not lose pre-handoff output when the answer settles.
 */
export function settleLiveTurnStep(
  current: LiveTurnProjection,
  stepId: string,
): LiveTurnProjection | undefined {
  const stepIndex = current.steps.findIndex((step) => step.stepId === stepId);
  if (stepIndex < 0) return current;
  const step = current.steps[stepIndex]!;
  const retainedTools = step.tools.filter((tool) => (tool.outputChunks?.length ?? 0) > 0);
  const steps = retainedTools.length > 0
    ? current.steps.map((candidate, index) => (
      index === stepIndex
        ? {
            stepId: candidate.stepId,
            tools: retainedTools,
            contentOrder: ['tools' as const],
          }
        : candidate
    ))
    : current.steps.filter((candidate) => candidate.stepId !== stepId);
  if (steps.length === current.steps.length && retainedTools.length === 0) return current;
  if (steps.length === 0 && current.terminal) return undefined;
  return { ...current, steps };
}

/**
 * True when a persisted tool_result can replace live stream evidence for the
 * same toolUseId. Empty shell_run/terminal bodies do not cover live chunks —
 * background Bash returns an empty shell_run while live output is the only
 * evidence the user already saw.
 */
function durableStreamEvidence(
  messages: readonly StoredMessage[],
  toolUseId: string,
): boolean {
  for (const message of messages) {
    if (message.type !== 'tool_result' || message.toolUseId !== toolUseId) continue;
    const content = message.content;
    if (!content || typeof content !== 'object') return true;
    if (content.kind === 'terminal' || content.kind === 'shell_run') {
      const output = content.output;
      if (!output) return false;
      return output.mode === 'pty'
        ? true
        : output.stdout.length > 0
          || output.stderr.length > 0
          || output.stdoutTruncated
          || output.stderrTruncated
          || output.redacted;
    }
    return true;
  }
  return false;
}

/**
 * Removes evidence-only steps once the persisted transcript can render the
 * same durable output, including while a later step is still running. Text
 * steps remain owned by the streaming renderer, whose completion callback performs
 * their handoff after the tail is visible.
 */
export function reconcileTerminalLiveTurn(
  current: LiveTurnProjection,
  messages: readonly StoredMessage[],
): LiveTurnProjection | undefined {
  const turnMessages = messages.filter((message) => message.turnId === current.turnId);
  const assistantIds = new Set(turnMessages.flatMap((message) => message.type === 'assistant' ? [message.id] : []));
  const toolCallIds = new Set(turnMessages.flatMap((message) => message.type === 'tool_call' ? [message.id] : []));
  const toolResultIds = new Set(turnMessages.flatMap((message) => message.type === 'tool_result' ? [message.toolUseId] : []));
  const steps = current.steps.filter((step) => {
    if (step.text?.text.length) return true;
    if (step.thinking && !assistantIds.has(step.stepId)) return true;
    const toolsCovered = step.tools.every((tool) => {
      if (!toolCallIds.has(tool.toolUseId)) return false;
      const hasResult = toolResultIds.has(tool.toolUseId);
      // Live stream evidence only hands off when durable result has streams/meta.
      if (tool.outputChunks?.length) {
        if (!hasResult) return false;
        if (!durableStreamEvidence(turnMessages, tool.toolUseId)) return false;
      }
      return tool.status === 'interrupted' || hasResult;
    });
    return !toolsCovered;
  });
  if (steps.length === current.steps.length) return current;
  if (steps.length === 0 && current.terminal) return undefined;
  return { ...current, steps };
}
