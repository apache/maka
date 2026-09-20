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

import {
  decodeToolStepProgress,
  type MessageContent,
  type ProviderRetryEvent,
  type SessionEvent,
} from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { materializeToolResultPreviewForActivity } from '@maka/core/tool-result-preview';
import { applyAssistantComplete, applyAssistantDelta } from './assistant-stream.js';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import { toolResultActivityStatus } from '@maka/core/tool-result-status';
import { isInFlightToolStatus } from '@maka/core/tool-result-status';
import type { ToolActivityItem } from './materialize.js';
import { applyThinkingComplete, applyThinkingDelta } from './thinking-stream.js';
import type { StreamingDisplayRedactionState } from './streaming-display-redaction.js';
import { applyToolOutputChunk } from './tool-output-stream.js';

type LiveTurnContentEvent = Extract<SessionEvent, { type: 'thinking_delta' | 'thinking_complete' | 'text_delta' | 'text_complete' | 'tool_start' | 'tool_output_delta' | 'tool_progress' | 'tool_result_preview' | 'tool_result' }>;

/**
 * A provider retry event plus the CLIENT-local time it entered this
 * projection. Counting down from `receivedAtMs` keeps the whole countdown in
 * one clock domain — the event's `ts` is stamped on the (possibly remote)
 * Runtime Host clock, so subtracting it from a client clock would skew the
 * display by the clock offset between the two machines. The countdown length
 * itself comes from the skew-free `remainingMs` duration when the emitter
 * provided one.
 */
export interface LiveProviderRetry {
  event: ProviderRetryEvent;
  receivedAtMs: number;
}

export interface LiveThinkingProjection {
  text: string;
  truncated: boolean;
  complete: boolean;
  /** Raw source length, independent of redaction and display truncation. */
  sourceEndOffset?: number;
  /** Internal bounded state; removed when the stream becomes terminal. */
  redactionState?: StreamingDisplayRedactionState;
}

export interface LiveTurnStepProjection {
  stepId: string;
  /** Event ts of the first word that opened this step or slice. */
  startedAt?: number;
  contentOrder?: LiveTurnStepContentKind[];
  /**
   * A steering boundary slice: the steering row is emitted at this position
   * and the slice holds no content. Content events never resolve to it
   * (`steering:`-prefixed stepIds collide with no real stepId).
   */
  steering?: LiveSteeringProjection;
  /**
   * A steering boundary can split a step mid-flight; the continuation slice
   * keeps the same durable stepId. Replayed deltas trim against the earlier
   * slice's source length through these baselines instead of re-appending it.
   */
  continuedThinkingEndOffset?: number;
  continuedTextEndOffset?: number;
  thinking?: LiveThinkingProjection;
  text?: LiveTextProjection;
  tools: ToolActivityItem[];
}

export type LiveTurnStepContentKind = 'thinking' | 'text' | 'tools';

export interface LiveTextProjection {
  interrupted?: true;
  text: string;
  truncated: boolean;
  complete: boolean;
  /** Raw source length, independent of redaction and display truncation. */
  sourceEndOffset?: number;
  /** Internal bounded state; removed when the stream becomes terminal. */
  redactionState?: StreamingDisplayRedactionState;
}

export interface LiveSteeringProjection {
  id: string;
  content: MessageContent;
  ts: number;
}

export interface LiveTurnProjection {
  turnId: string;
  terminal?: true;
  /**
   * Set when this live Turn is a host-owned explicit context-compaction run.
   * A `context_compact` Turn emits no assistant content, so `overlayLiveTurn`
   * renders a single "compacting" system row from this flag while the Turn is in
   * flight; the row disappears when the Turn settles (no durable turn state).
   */
  rootExecutionKind?: 'context_compact';
  /** Event ts of the first authority word about this Turn, so a Turn the
   *  transcript has not reached yet still has a stable start. */
  startedAt?: number;
  /**
   * Set by `armLiveTurn` and cleared by the first word the authority says about
   * this turn (any event carrying the same turnId).
   *
   * A client that just sent cannot tell "the authority has not reached my turn
   * yet" from "my turn is over" by reading session status: it reads the same
   * before a turn starts and after it ends. So a snapshot taken before the send
   * landed would retire the arm the send just placed. This bit says the arm is
   * still waiting for its answer, which is what keeps such a snapshot from
   * settling it. Dropped for good once the answer arrives.
   */
  unconfirmed?: true;
  providerRetry?: LiveProviderRetry;
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
    ...(step.thinking ? { thinking: terminalThinking(step.thinking) } : {}),
    ...(step.text ? { text: terminalText(step.text) } : {}),
    tools: step.tools.map((tool) => (
      isInFlightToolStatus(tool.status) ? { ...tool, status: 'interrupted' as const } : tool
    )),
  }));
}

function terminalThinking(thinking: LiveThinkingProjection): LiveThinkingProjection {
  const { redactionState: _redactionState, ...safe } = thinking;
  return { ...safe, complete: true };
}

function terminalText(text: LiveTextProjection): LiveTextProjection {
  const { redactionState: _redactionState, ...safe } = text;
  return { ...safe, complete: true };
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
  return { turnId, steps: [], unconfirmed: true };
}

/** Drop the `unconfirmed` claim; identity-preserving when there is none. */
function confirmed(projection: LiveTurnProjection): LiveTurnProjection {
  if (!projection.unconfirmed) return projection;
  const { unconfirmed: _unconfirmed, ...rest } = projection;
  return rest;
}

export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: LiveTurnContentEvent,
  locale: UiLocale,
): LiveTurnProjection;
export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
  locale: UiLocale,
): LiveTurnProjection | undefined;
export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
  locale: UiLocale,
): LiveTurnProjection | undefined {
  const next = projectLiveTurnEvent(current, event, locale);
  if (!next || next === current || next.startedAt !== undefined) return next;
  const startedAt = current?.turnId === next.turnId ? current.startedAt : undefined;
  return { ...next, startedAt: startedAt ?? event.ts };
}

function projectLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
  locale: UiLocale,
): LiveTurnProjection | undefined {
  if (event.type === 'steering_message') {
    const prior = current?.turnId === event.turnId
      ? current
      : { turnId: event.turnId, steps: [] };
    if (liveSteeringMessages(prior).some((message) => message.id === event.messageId)) {
      return confirmed(prior);
    }
    // A steering's position is fixed by stream order: it becomes a boundary
    // slice immediately instead of parking until a later event claims it.
    return {
      ...confirmed(prior),
      steps: [
        ...prior.steps,
        {
          stepId: `steering:${event.messageId}`,
          startedAt: event.ts,
          tools: [],
          steering: {
            id: event.messageId,
            content: structuredClone(event.content),
            ts: event.ts,
          },
        },
      ],
    };
  }
  if (event.type === 'provider_retry') {
    const prior = current?.turnId === event.turnId
      ? current
      : { turnId: event.turnId, steps: [] };
    return { ...confirmed(prior), providerRetry: { event, receivedAtMs: Date.now() } };
  }
  if (event.type === 'error' || event.type === 'abort') {
    if (!current || current.turnId !== event.turnId) return current;
    const steps = terminalizeLiveSteps(current.steps);
    if (steps.length === 0 && liveSteeringMessages(current).length === 0) return undefined;
    const { providerRetry: _providerRetry, ...withoutRetry } = confirmed(current);
    return { ...withoutRetry, terminal: true, steps };
  }
  if (event.type === 'complete') {
    if (!current || current.turnId !== event.turnId) return current;
    if (current.steps.length === 0 && liveSteeringMessages(current).length === 0) {
      return undefined;
    }
    const { providerRetry: _providerRetry, ...withoutRetry } = confirmed(current);
    return {
      ...withoutRetry,
      terminal: true,
      steps: terminalizeLiveSteps(current.steps),
    };
  }
  if (event.type === 'context_compaction_started') {
    const prior =
      current?.turnId === event.turnId
        ? current
        : { turnId: event.turnId, steps: [] };
    return { ...confirmed(prior), rootExecutionKind: 'context_compact', startedAt: event.ts };
  }
  if (
    event.type !== 'thinking_delta'
    && event.type !== 'thinking_complete'
    && event.type !== 'text_delta'
    && event.type !== 'text_complete'
    && event.type !== 'tool_start'
    && event.type !== 'tool_output_delta'
    && event.type !== 'tool_progress'
    && event.type !== 'tool_result_preview'
    && event.type !== 'tool_result'
  ) {
    return current;
  }
  const prior = current?.turnId === event.turnId
    ? current
    : { turnId: event.turnId, steps: [] };
  const { providerRetry: _providerRetry, ...priorWithoutRetry } = confirmed(prior);
  const messageEvent = event.type === 'thinking_delta'
    || event.type === 'thinking_complete'
    || event.type === 'text_delta'
    || event.type === 'text_complete';
  const existingToolStep = event.type === 'tool_start'
    || event.type === 'tool_output_delta'
    || event.type === 'tool_progress'
    || event.type === 'tool_result_preview'
    || event.type === 'tool_result'
    ? prior.steps.find((candidate) => candidate.tools.some((tool) => tool.toolUseId === event.toolUseId))
    : undefined;
  const stepId = messageEvent
    ? event.messageId
    : event.type === 'tool_start'
      ? event.stepId ?? existingToolStep?.stepId ?? `tool:${event.toolUseId}`
      : existingToolStep?.stepId ?? `tool:${event.toolUseId}`;
  // A steering boundary freezes the positions before it: same-stepId deltas
  // arriving after one continue the step in a fresh slice, so a stepId can
  // repeat across the array. Completions and events for an existing tool row
  // are updates to a row whose position is already fixed — they resolve to
  // the row's last slice wherever it sits, on either side of a boundary.
  const boundaryIndex = prior.steps.findLastIndex((candidate) => candidate.steering !== undefined);
  const sameStepIndex = prior.steps.findLastIndex((candidate) => candidate.stepId === stepId);
  const stepIndex = existingToolStep === undefined
    ? event.type === 'thinking_complete' || event.type === 'text_complete'
      ? sameStepIndex
      : sameStepIndex > boundaryIndex ? sameStepIndex : -1
    : event.type !== 'tool_start'
        || event.stepId === undefined
        || event.stepId === existingToolStep.stepId
      ? prior.steps.indexOf(existingToolStep)
      : sameStepIndex;
  const continuedFrom = stepIndex < 0 && sameStepIndex >= 0 ? prior.steps[sameStepIndex]! : undefined;
  const continuedThinkingEnd = continuedFrom?.thinking?.sourceEndOffset ?? continuedFrom?.continuedThinkingEndOffset;
  const continuedTextEnd = continuedFrom?.text?.sourceEndOffset ?? continuedFrom?.continuedTextEndOffset;
  const step: LiveTurnStepProjection = stepIndex < 0
    ? {
        stepId,
        startedAt: event.ts,
        tools: [],
        ...(continuedThinkingEnd === undefined
          ? {}
          : { continuedThinkingEndOffset: continuedThinkingEnd }),
        ...(continuedTextEnd === undefined
          ? {}
          : { continuedTextEndOffset: continuedTextEnd }),
      }
    : prior.steps[stepIndex]!;
  let nextStep: LiveTurnStepProjection;
  if (event.type === 'thinking_delta') {
    const delta = replaySafeDelta(step.thinking?.sourceEndOffset ?? step.continuedThinkingEndOffset, event);
    const applied = applyThinkingDelta(step.thinking?.text ?? '', delta.text, {
      locale,
      ...(step.thinking?.redactionState === undefined
        ? {}
        : { redactionState: step.thinking.redactionState }),
    });
    nextStep = {
      ...step,
      thinking: {
        text: applied.text,
        truncated: (step.thinking?.truncated ?? false) || applied.truncated,
        complete: false,
        ...(delta.sourceEndOffset === undefined
          ? {}
          : { sourceEndOffset: delta.sourceEndOffset }),
        ...(applied.redactionState === undefined
          ? {}
          : { redactionState: applied.redactionState }),
      },
    };
  } else if (event.type === 'thinking_complete') {
    const applied = applyThinkingComplete(
      completionRemainder(prior, step, 'thinking', event.text),
      { locale },
    );
    nextStep = {
      ...step,
      thinking: {
        text: applied.text,
        truncated: applied.truncated,
        complete: true,
        ...((step.thinking?.sourceEndOffset ?? step.continuedThinkingEndOffset) === undefined
          ? {}
          : { sourceEndOffset: event.text.length }),
      },
    };
  } else if (event.type === 'text_delta') {
    const delta = replaySafeDelta(step.text?.sourceEndOffset ?? step.continuedTextEndOffset, event);
    const applied = applyAssistantDelta(step.text?.text ?? '', delta.text, {
      locale,
      ...(step.text?.redactionState === undefined
        ? {}
        : { redactionState: step.text.redactionState }),
    });
    nextStep = {
      ...step,
      text: {
        text: applied.text,
        truncated: (step.text?.truncated ?? false) || applied.truncated,
        complete: false,
        ...(delta.sourceEndOffset === undefined
          ? {}
          : { sourceEndOffset: delta.sourceEndOffset }),
        ...(applied.redactionState === undefined
          ? {}
          : { redactionState: applied.redactionState }),
      },
    };
  } else if (event.type === 'text_complete') {
    const applied = applyAssistantComplete(
      completionRemainder(prior, step, 'text', event.text),
      { locale },
    );
    nextStep = {
      ...step,
      text: {
        ...(event.interrupted ? { interrupted: true } : {}),
        text: applied.text,
        truncated: applied.truncated,
        complete: true,
        ...((step.text?.sourceEndOffset ?? step.continuedTextEndOffset) === undefined
          ? {}
          : { sourceEndOffset: event.text.length }),
      },
    };
  } else if (event.type === 'tool_start') {
    const startedTool: ToolActivityItem = {
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      ...(event.activityKind !== undefined ? { activityKind: event.activityKind } : {}),
      ...(event.displayName !== undefined ? { displayName: event.displayName } : {}),
      ...(event.intent !== undefined ? { intent: event.intent } : {}),
      ...(event.argsPreview !== undefined ? { argsPreview: event.argsPreview } : {}),
      ...projectToolActivityIdentity(event),
      ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
      status: 'running',
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
      status: base.status,
      outputChunks: applied.chunks,
      outputTruncated: base.outputTruncated || applied.truncated,
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  } else if (event.type === 'tool_progress') {
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'running', args: undefined };
    const progress = decodeToolStepProgress(event.chunk);
    const tool: ToolActivityItem = {
      ...base,
      ...projectToolActivityIdentity(event),
      status: isInFlightToolStatus(base.status) ? 'running' : base.status,
      ...(progress ? { progress } : {}),
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  } else if (event.type === 'tool_result_preview') {
    // Live-only open-facts: materialize into activity.result with empty bulk
    // so ToolTrow can Open without dual storage.
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'running', args: undefined };
    const tool: ToolActivityItem = {
      ...base,
      ...projectToolActivityIdentity(event),
      status: isInFlightToolStatus(base.status) ? 'running' : base.status,
      result: materializeToolResultPreviewForActivity(event.content),
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
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'running', args: undefined };
    const tool: ToolActivityItem = {
      ...base,
      ...projectToolActivityIdentity(event),
      status: toolResultActivityStatus(event.isError, event.content),
      result: event.contentOmitted ? base.result : event.content,
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
    const sourceIndex = prior.steps.indexOf(existingToolStep);
    const sourceWithoutTool = {
      ...existingToolStep,
      tools: existingToolStep.tools.filter((tool) => tool.toolUseId !== event.toolUseId),
    };
    if (sourceWithoutTool.tools.length === 0 && sourceWithoutTool.contentOrder) {
      sourceWithoutTool.contentOrder = sourceWithoutTool.contentOrder.filter((kind) => kind !== 'tools');
    }
    const sourceIsEmpty = !sourceWithoutTool.thinking
      && !sourceWithoutTool.text
      && sourceWithoutTool.tools.length === 0
      && sourceWithoutTool.steering === undefined;
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
  // A completion finalizes the message across every slice it occupies: an
  // earlier slice keeps the portion it rendered — marked complete — so a
  // steering boundary never relocates pre-steering content into the full text
  // a later slice finalizes.
  const finalizedKind = event.type === 'thinking_complete'
    ? 'thinking'
    : event.type === 'text_complete' ? 'text' : undefined;
  if (finalizedKind !== undefined) {
    steps = steps.map((candidate) =>
      candidate !== nextStep
          && candidate.stepId === stepId
          && candidate[finalizedKind] !== undefined
        ? { ...candidate, [finalizedKind]: { ...candidate[finalizedKind]!, complete: true } }
        : candidate);
  }
  return { ...priorWithoutRetry, steps };
}

function liveSteeringMessages(current: LiveTurnProjection): LiveSteeringProjection[] {
  return current.steps.flatMap((step) => (step.steering ? [step.steering] : []));
}

/**
 * A completion's full text shares the delta stream's coordinates only when it
 * extends the already-rendered prefix — a provider summary replaces the
 * streamed text outright (`reasoningSummaryText` adoption), so a bare offset
 * would cut real content. Trim only on a verified prefix; otherwise land the
 * payload whole.
 */
function completionRemainder(
  prior: LiveTurnProjection,
  step: LiveTurnStepProjection,
  kind: 'thinking' | 'text',
  fullText: string,
): string {
  const rendered = prior.steps.flatMap((candidate) =>
    candidate !== step && candidate.stepId === step.stepId && candidate[kind]
      ? [candidate[kind]!.text]
      : []);
  const prefix = rendered.join('');
  return fullText.startsWith(prefix) ? fullText.slice(prefix.length) : fullText;
}

function replaySafeDelta(
  currentEndOffset: number | undefined,
  event: Extract<SessionEvent, { type: 'text_delta' | 'thinking_delta' }>,
): { text: string; sourceEndOffset?: number } {
  if (event.startOffset === undefined) {
    return {
      text: event.text,
      sourceEndOffset: (currentEndOffset ?? 0) + event.text.length,
    };
  }
  const endOffset = event.startOffset + event.text.length;
  if (currentEndOffset === undefined || event.startOffset > currentEndOffset) {
    return { text: event.text, sourceEndOffset: endOffset };
  }
  const overlapLength = Math.min(currentEndOffset - event.startOffset, event.text.length);
  return {
    text: event.text.slice(overlapLength),
    sourceEndOffset: Math.max(currentEndOffset, endOffset),
  };
}

/**
 * Streaming display handoff: drop the committed text/thinking slots for `stepId`.
 * Tools that still carry live stream evidence (outputChunks) stay — empty
 * shell_run durable results do not cover them, and co-located Bash+answer
 * steps must not lose pre-handoff output when the answer settles. `stepId`
 * can match multiple slices once a steering boundary split the step;
 * steering boundary slices carry their own namespaced id and never match.
 */
export function settleLiveTurnStep(
  current: LiveTurnProjection,
  stepId: string,
): LiveTurnProjection | undefined {
  let found = false;
  const steps = current.steps.flatMap((step) => {
    if (step.stepId !== stepId) return [step];
    found = true;
    const retainedTools = step.tools.filter((tool) => (tool.outputChunks?.length ?? 0) > 0);
    if (retainedTools.length === 0) {
      return [];
    }
    return [{
      stepId,
      tools: retainedTools,
      ...(retainedTools.length > 0 ? { contentOrder: ['tools' as const] } : {}),
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    }];
  });
  if (!found) return current;
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
  const transcriptReachedTerminal = turnMessages.some(
    (message) => message.type === 'turn_state' && message.status !== 'running',
  );
  let projection = current;
  if (transcriptReachedTerminal && current.terminal !== true) {
    const { providerRetry: _providerRetry, ...withoutRetry } = confirmed(current);
    projection = {
      ...withoutRetry,
      terminal: true,
      steps: terminalizeLiveSteps(current.steps),
    };
  }
  if (
    projection.terminal === true
    && liveSteeringMessages(projection).length > 0
    && !transcriptReachedTerminal
  ) return projection;
  const assistantIds = new Set(turnMessages.flatMap((message) => message.type === 'assistant' ? [message.id] : []));
  const toolCallIds = new Set(turnMessages.flatMap((message) => message.type === 'tool_call' ? [message.id] : []));
  const toolResultIds = new Set(turnMessages.flatMap((message) => message.type === 'tool_result' ? [message.toolUseId] : []));
  let steps = projection.steps.filter((step) => {
    // Steering boundary slices hold no durable-comparable content; the
    // overlay dedupes against the persisted user row by id.
    if (step.steering !== undefined) return true;
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
  // Once persisted turn_state records the terminal handoff, the transcript is
  // authoritative for accepted steering; retaining the live copy would leave
  // a duplicate or a nacked ghost instruction on screen.
  const steeringSettled = projection.terminal === true
    && transcriptReachedTerminal
    && liveSteeringMessages(projection).length > 0;
  if (steeringSettled) {
    steps = steps.filter((step) => step.steering === undefined);
  }
  if (
    steps.length === 0
    && projection.terminal
    && (
      projection.rootExecutionKind === 'context_compact'
      || transcriptReachedTerminal
      || steps.length !== projection.steps.length
    )
  ) return undefined;
  if (steps.length === projection.steps.length && !steeringSettled) return projection;
  return { ...projection, steps };
}
