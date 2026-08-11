/**
 * Model history projection — build the model-visible message history from a
 * RuntimeEvent stream.
 *
 * Architecture: docs/architecture/llm-compaction-events-log-projection-draft.md
 *
 * Phase 1 scope: pure, synchronous projection. Replaces the ad-hoc
 * StoredMessage filtering in AiSdkBackend.materializePriorMessages with an
 * explicit, policy-driven filter over canonical events. The output is a
 * neutral `ModelHistoryEntry[]` that callers (ai-sdk backend, flow runner)
 * translate into provider-specific message shapes.
 *
 * Policy (why an event is KEPT):
 *   - non-partial (final content, not a transient streaming chunk)
 *   - model-visible content kind: text / thinking / function_call /
 *     function_response (per runtimeEventHasModelVisibleContent)
 *   - role is user, model, or tool (system excluded unless opted in)
 *
 * Policy (why an event is DROPPED):
 *   - partial === true (streaming chunks superseded by a later final event)
 *   - error-only content (a tool error surfaced to the model is a
 *     function_response with isError, which stays visible)
 *   - actions-only / refs-only events (token usage, permission acks,
 *     state deltas, end-invocation markers)
 *   - system-role events by default (UI-only notes; system instructions
 *     are injected fresh by the runner, not replayed from history)
 *
 * Thinking and tool events are opt-in/opt-out so callers can match the
 * replay contract of their provider (V0.1 text-only replay cannot use
 * them; Anthropic replay can re-use signed thinking, etc.).
 *
 * NOTE: imports the new `@maka/core/runtime-event` subpath. The steward
 * node re-exports it from the core barrel.
 */

import {
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  runtimeEventHasModelVisibleContent,
  type RuntimeEvent,
  type RuntimeEventTextContent,
  type RuntimeEventContent,
  type RuntimeEventRole,
} from '@maka/core/runtime-event';
import { formatAttachmentResourceRef } from '@maka/core/attachments';
import { decodeCanonicalShellToolResultContent } from '@maka/core/shell-run-result';
import type { AttachmentRef, QuoteRef } from '@maka/core/events';
import type { ModelMessage, UserContent, UserModelMessage } from './model-protocol.js';
import { projectBashToolResultForModel } from './bash-model-output.js';
import { projectFileWriteToolResultForModel } from './file-tool-model-output.js';

export const PROVIDER_REPLAY_PROJECTION_VERSION = 1;

// ============================================================================
// Output type
// ============================================================================

/**
 * One model-facing history entry. `content` is the canonical
 * RuntimeEventContent (discriminated by `kind`); `role` is the
 * model-history lane the entry plays for the next model call.
 */
export interface ModelHistoryEntry {
  role: RuntimeEventRole;
  content: RuntimeEventContent;
  ts: number;
  eventId: string;
}

export interface TextModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Structured steering identity (see steeringProviderOptions): a steering
   * message keeps its ledger event id even in the text-only projection, so
   * id-based dedupe against the live injection set holds on every base.
   */
  providerOptions?: NonNullable<ModelMessage['providerOptions']>;
}

export type RuntimeEventReplayFallbackGate =
  | 'runtime_replay_text_only'
  | 'runtime_replay_provider_native'
  | 'runtime_replay_unsupported_semantics';

export type RuntimeEventReplayDiagnosticCode =
  | 'partial_skipped'
  | 'unsupported_role'
  | 'unsupported_content'
  | 'system_runtime_fact_diagnostic_only'
  | 'terminal_fact_diagnostic_only'
  | 'error_content_diagnostic_only'
  | 'empty_text_skipped'
  | 'model_hidden_skipped'
  | 'signed_thinking_in_tool_turn_skipped'
  | 'unmatched_tool_result'
  | 'unmatched_tool_call'
  | 'tool_id_mismatch';

export interface RuntimeEventReplayDiagnostic {
  code: RuntimeEventReplayDiagnosticCode;
  message: string;
  eventId?: string;
  turnId?: string;
  detail?: Record<string, unknown>;
}

export type RuntimeEventReplaySemanticKind = 'text' | 'thinking' | 'tool_call' | 'tool_result';

export type RuntimeEventModelReplayItem =
  | {
      kind: 'text';
      role: 'user' | 'assistant' | 'system';
      content: string;
      providerOptions?: NonNullable<ModelMessage['providerOptions']>;
      /** Original attachments (if any) so replay can render image parts. */
      attachments?: AttachmentRef[];
      /** Assistant step id (model-role text only); groups a step's parts. */
      stepId?: string;
      /**
       * Set when this user text replays a steered mid-turn message. `content`
       * is already envelope-wrapped; materializers MUST carry the structured
       * steering marker (see steeringModelMessage) onto the ModelMessage so
       * dedupe works on identity, never on text.
       */
      steering?: { eventId: string };
      eventId: string;
      ts: number;
    }
  | {
      kind: 'thinking';
      text: string;
      signature?: string;
      providerOptions?: NonNullable<ModelMessage['providerOptions']>;
      /** Assistant step id; pairs this reasoning with its step's tool calls. */
      stepId?: string;
      eventId: string;
      ts: number;
    }
  | {
      kind: 'tool_call';
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerOptions?: NonNullable<ModelMessage['providerOptions']>;
      providerExecuted?: boolean;
      /** Assistant step id (from tool_start); groups the call with its step. */
      stepId?: string;
      eventId: string;
      ts: number;
    }
  | {
      kind: 'tool_result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
      providerExecuted?: boolean;
      eventId: string;
      ts: number;
    };

export interface RuntimeEventModelReplayPlan {
  items: RuntimeEventModelReplayItem[];
  textMessages: TextModelMessage[];
  semanticKinds: RuntimeEventReplaySemanticKind[];
  diagnostics: RuntimeEventReplayDiagnostic[];
  hasProviderNativeSemantics: boolean;
}

// ============================================================================
// Options
// ============================================================================

export interface BuildModelHistoryOptions {
  /**
   * Include function_call / function_response entries. Default `true`.
   * Set `false` for providers whose replay format cannot represent prior
   * tool turns (the V0.1 ai-sdk text-only replay path).
   */
  includeToolEvents?: boolean;
  /**
   * Include system-role events (system notes / instructions). Default
   * `false`. System instructions are normally injected fresh by the
   * runner each turn, not replayed from durable history.
   */
  includeSystemEvents?: boolean;
  /**
   * Include thinking-content entries. Default `false`. Thinking replay
   * is provider-specific (Anthropic signed signatures); callers that
   * need it opt in and reattach signatures from the event content.
   */
  includeThinking?: boolean;
}

// ============================================================================
// Projection
// ============================================================================

/**
 * Build the model-visible history from a RuntimeEvent stream.
 *
 * Events SHOULD be supplied in causal order; the projection preserves
 * input order. Partial events are always excluded — callers MUST NOT
 * replay transient streaming chunks into the next model call.
 *
 * The default options match the durable-history policy: user/model text
 * and tool calls/responses are kept; thinking, system notes, token usage,
 * permission acks, and diagnostics are dropped.
 */
export function buildModelHistoryFromRuntimeEvents(
  events: readonly RuntimeEvent[],
  options: BuildModelHistoryOptions = {},
): ModelHistoryEntry[] {
  const includeToolEvents = options.includeToolEvents ?? true;
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const includeThinking = options.includeThinking ?? false;

  const out: ModelHistoryEntry[] = [];
  for (const event of events) {
    // 1. Never replay transient streaming chunks.
    if (isPartialRuntimeEvent(event)) continue;

    // 2. Only model-visible content kinds (text/thinking/function_*).
    if (!runtimeEventHasModelVisibleContent(event)) continue;

    const content = event.content;
    if (!content) continue;

    // 3. System-role events are UI notes by default; opt in for
    //    model-injected system instructions.
    if (event.role === 'system' && !includeSystemEvents) continue;

    // 4. Thinking replay is provider-specific; opt in.
    if (content.kind === 'thinking' && !includeThinking) continue;

    // 5. Tool function_call / function_response; opt out for text-only.
    if (
      !includeToolEvents &&
      (content.kind === 'function_call' || content.kind === 'function_response')
    ) {
      continue;
    }

    out.push({
      role: event.role,
      content,
      ts: event.ts,
      eventId: event.id,
    });
  }
  return out;
}

export interface RuntimeEventTextMessageOptions {
  includeSystemEvents?: boolean;
}

export interface BuildRuntimeEventModelReplayPlanOptions {
  includeSystemEvents?: boolean;
  /**
   * Turn IDs known — from the FULL prior ledger — to contain tool activity.
   *
   * The signed-thinking-in-tool-turn skip (see `turnsWithToolActivity` in the
   * planner) is a whole-history invariant, but `events` here may be a
   * budget-pruned / history-search slice that dropped a turn's
   * tool_call/tool_response while keeping its (query-matched) signed thinking.
   * Scanning only the slice would then miss the tool activity and wrongly
   * replay that thinking provider-native. Callers that slice MUST pass the
   * full-ledger tool-turn ids (see `collectToolActivityTurnIds`); the planner
   * unions them with tool activity found in `events`.
   */
  toolActivityTurnIds?: ReadonlySet<string>;
}

/**
 * Collect the turn ids that contain tool activity (function_call /
 * function_response) from a RuntimeEvent ledger. Pass the result as
 * `toolActivityTurnIds` when the events handed to the replay planner are a
 * slice of this ledger.
 */
export function collectToolActivityTurnIds(events: readonly RuntimeEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    if (event.modelVisibility === 'hidden') continue;
    const kind = event.content?.kind;
    if ((kind === 'function_call' || kind === 'function_response') && event.turnId) {
      ids.add(event.turnId);
    }
  }
  return ids;
}

function assistantReplayStepId(event: RuntimeEvent): string | undefined {
  return event.refs?.providerEventId ?? event.refs?.storedMessageId;
}

export function buildRuntimeEventModelReplayPlan(
  events: readonly RuntimeEvent[],
  options: BuildRuntimeEventModelReplayPlanOptions = {},
): RuntimeEventModelReplayPlan {
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const items: RuntimeEventModelReplayItem[] = [];
  const diagnostics: RuntimeEventReplayDiagnostic[] = [];
  const callsById = new Map<
    string,
    {
      name: string;
      eventId: string;
      item: Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>;
    }
  >();

  // Signed thinking in a tool turn is only replayable when the turn's tool calls
  // carry a step id (RuntimeEventRefs.stepId, stamped from tool_start): the
  // materializer then merges the step's reasoning + tool calls into one provider
  // assistant message. Legacy per-turn history has no step id — its single
  // end-of-turn reasoning lands after the tool events and cannot be reattached
  // to the tool-use assistant message (Anthropic 400), so it is still skipped.
  //
  // Classify each tool turn: paired (all its function_call events carry a
  // stepId) vs unpaired (any lacks one). Union caller-supplied whole-ledger
  // tool-turn ids that this (possibly sliced) `events` view cannot confirm as
  // paired, so a sliced-away tool turn degrades safely to the legacy skip.
  //
  // The judgment is deliberately TURN-granular, not per-step: one turn is
  // written by one backend build, so old (no stepId) and new (stepId) tool
  // calls cannot mix within a turn — per-step classification would add
  // complexity for a state that cannot exist. And pairedToolTurnIds is not
  // dead state: it is what lets a caller-supplied tool-turn id (from the FULL
  // ledger) stay replayable when this sliced view can prove the turn's calls
  // are step-paired — without it every sliced tool turn would degrade.
  const pairedToolTurnIds = new Set<string>();
  const unpairedToolTurnIds = new Set<string>();
  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    if (event.modelVisibility === 'hidden') continue;
    if (event.content?.kind === 'function_call' && event.turnId) {
      if (event.refs?.stepId) pairedToolTurnIds.add(event.turnId);
      else unpairedToolTurnIds.add(event.turnId);
    }
  }
  for (const id of options.toolActivityTurnIds ?? []) {
    if (!pairedToolTurnIds.has(id)) unpairedToolTurnIds.add(id);
  }

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) {
      diagnostics.push(
        diagnostic(event, 'partial_skipped', 'partial RuntimeEvent skipped for model replay'),
      );
      continue;
    }

    if (event.modelVisibility === 'hidden') {
      diagnostics.push(
        diagnostic(
          event,
          'model_hidden_skipped',
          'explicitly model-hidden RuntimeEvent skipped for model replay',
        ),
      );
      continue;
    }

    if (isTerminalRuntimeEvent(event)) {
      diagnostics.push(
        diagnostic(
          event,
          'terminal_fact_diagnostic_only',
          'terminal RuntimeEvent status is diagnostic-only for model replay',
          { status: event.status },
        ),
      );
    }

    if (!event.content) {
      if (event.actions && !isTerminalRuntimeEvent(event)) {
        diagnostics.push(
          diagnostic(
            event,
            'system_runtime_fact_diagnostic_only',
            'RuntimeEvent actions are diagnostic-only for model replay',
            { actionKeys: Object.keys(event.actions) },
          ),
        );
      }
      continue;
    }

    if (!runtimeEventHasModelVisibleContent(event)) {
      // A model-role empty text event is the step closer of a thinking-only /
      // tool-only step (the backend emits text_complete with '' so the
      // read-model gets an assistant row for the step's reasoning). It carries
      // nothing to replay but is NOT unsupported history — flagging it
      // unsupported_content would block provider-native replay of the whole
      // ledger (hasBlockingReplayDiagnostics). Skip it benignly; the
      // materializer pairs the step's parked reasoning with its tool calls by
      // stepId at flush time, so no text closer is needed.
      if (event.content.kind === 'text' && event.role === 'model') {
        diagnostics.push(
          diagnostic(
            event,
            'empty_text_skipped',
            'empty model text RuntimeEvent (thinking/tool-only step closer) skipped for model replay',
          ),
        );
        continue;
      }
      // Error content is a run/turn failure fact (a flow error event or a
      // terminal recovery commit), not model conversation. It must stay
      // diagnostic-only: `unsupported_content` is a BLOCKING diagnostic (see
      // hasBlockingReplayDiagnostics), and one persisted failure would
      // otherwise degrade every later turn of the session to the
      // stored-message projection.
      if (event.content.kind === 'error') {
        diagnostics.push(
          diagnostic(
            event,
            'error_content_diagnostic_only',
            'error RuntimeEvent content is diagnostic-only for model replay',
          ),
        );
        continue;
      }
      diagnostics.push(
        diagnostic(
          event,
          'unsupported_content',
          'RuntimeEvent content kind is not model-replayable',
          { kind: event.content.kind },
        ),
      );
      continue;
    }

    if (event.role === 'system' && !includeSystemEvents) {
      diagnostics.push(
        diagnostic(
          event,
          'system_runtime_fact_diagnostic_only',
          'system RuntimeEvent content is diagnostic-only unless system replay is enabled',
        ),
      );
      continue;
    }

    switch (event.content.kind) {
      case 'text': {
        const role = modelTextRole(event.role);
        if (!role) {
          diagnostics.push(
            diagnostic(
              event,
              'unsupported_role',
              'text RuntimeEvent role is not model-replayable',
              {
                role: event.role,
              },
            ),
          );
          continue;
        }
        const steeringReplay = event.content.steering === true && role === 'user';
        const assistantStepId = role === 'assistant' ? assistantReplayStepId(event) : undefined;
        items.push({
          kind: 'text',
          role,
          // A steered user event replays in its canonical provider form (the
          // envelope); the raw text is a UI/transcript projection only.
          content: steeringReplay
            ? buildSteeringEnvelope(formatTextWithInlineRefs(event.content))
            : formatTextWithInlineRefs(event.content),
          ...(steeringReplay ? { steering: { eventId: event.id } } : {}),
          ...(event.content.attachments ? { attachments: event.content.attachments } : {}),
          ...(event.content.providerOptions !== undefined
            ? {
                providerOptions: event.content.providerOptions as NonNullable<
                  ModelMessage['providerOptions']
                >,
              }
            : {}),
          // Live events carry providerEventId; missing-ledger recovery carries
          // the same assistant message identity as storedMessageId.
          ...(assistantStepId ? { stepId: assistantStepId } : {}),
          eventId: event.id,
          ts: event.ts,
        });
        break;
      }
      case 'thinking': {
        if (event.role !== 'model') {
          diagnostics.push(
            diagnostic(event, 'unsupported_role', 'thinking RuntimeEvent must use model role', {
              role: event.role,
            }),
          );
          continue;
        }
        if (event.content.signature && event.turnId && unpairedToolTurnIds.has(event.turnId)) {
          // Its turn has tool calls with no step id to pair against (legacy
          // per-turn history) — the end-of-turn reasoning cannot be
          // reattached to the tool-use assistant message. Keep it in the
          // read-model for the UI; skip it from replay without downgrading the
          // whole history. Per-step history (paired tool calls) is not skipped:
          // the materializer merges each step's reasoning with its tool calls.
          diagnostics.push(
            diagnostic(
              event,
              'signed_thinking_in_tool_turn_skipped',
              'signed thinking RuntimeEvent skipped for model replay: its turn calls tools with no step id to pair the reasoning to a tool-use assistant message',
            ),
          );
          continue;
        }
        const thinkingStepId = assistantReplayStepId(event);
        items.push({
          kind: 'thinking',
          text: event.content.text,
          ...(event.content.signature ? { signature: event.content.signature } : {}),
          ...(event.content.providerOptions !== undefined
            ? {
                providerOptions: event.content.providerOptions as NonNullable<
                  ModelMessage['providerOptions']
                >,
              }
            : {}),
          ...(thinkingStepId ? { stepId: thinkingStepId } : {}),
          eventId: event.id,
          ts: event.ts,
        });
        break;
      }
      case 'function_call': {
        if (event.role !== 'model') {
          diagnostics.push(
            diagnostic(
              event,
              'unsupported_role',
              'function_call RuntimeEvent must use model role',
              {
                role: event.role,
              },
            ),
          );
          continue;
        }
        const item: Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }> = {
          kind: 'tool_call',
          toolCallId: event.content.id,
          toolName: event.content.name,
          input: event.content.args,
          ...(event.content.providerOptions !== undefined
            ? {
                providerOptions: event.content.providerOptions as NonNullable<
                  ModelMessage['providerOptions']
                >,
              }
            : {}),
          ...(event.content.providerExecuted !== undefined
            ? { providerExecuted: event.content.providerExecuted }
            : {}),
          ...(event.refs?.stepId ? { stepId: event.refs.stepId } : {}),
          eventId: event.id,
          ts: event.ts,
        };
        callsById.set(event.content.id, {
          name: event.content.name,
          eventId: event.id,
          item,
        });
        items.push(item);
        break;
      }
      case 'function_response': {
        if (event.role !== 'tool') {
          diagnostics.push(
            diagnostic(
              event,
              'unsupported_role',
              'function_response RuntimeEvent must use tool role',
              {
                role: event.role,
              },
            ),
          );
          continue;
        }
        const shellResult = decodeCanonicalShellToolResultContent(event.content.result);
        let invalidResultMessage: string | undefined;
        let normalizedResult: unknown =
          event.content.providerExecuted && event.content.providerOutput !== undefined
            ? event.content.providerOutput
            : event.content.result;
        if (shellResult.state === 'invalid') {
          invalidResultMessage = 'function_response contains an invalid shell tool result';
        } else if (shellResult.state === 'valid') {
          normalizedResult = shellResult.content;
        }
        if (!invalidResultMessage && event.content.name === 'Bash') {
          normalizedResult = projectBashToolResultForModel(normalizedResult);
        } else if (!invalidResultMessage) {
          normalizedResult = projectFileWriteToolResultForModel(
            event.content.name,
            normalizedResult,
          );
        }
        if (invalidResultMessage) {
          const call = callsById.get(event.content.id);
          if (call) {
            const callIndex = items.indexOf(call.item);
            if (callIndex >= 0) items.splice(callIndex, 1);
            callsById.delete(event.content.id);
          }
          diagnostics.push(diagnostic(event, 'unsupported_content', invalidResultMessage));
          continue;
        }
        const call = callsById.get(event.content.id);
        if (!call) {
          diagnostics.push(
            diagnostic(
              event,
              'unmatched_tool_result',
              'function_response has no prior matching function_call',
              {
                toolCallId: event.content.id,
              },
            ),
          );
        } else if (call.name !== event.content.name) {
          diagnostics.push(
            diagnostic(
              event,
              'tool_id_mismatch',
              'function_response name differs from matching function_call',
              {
                toolCallId: event.content.id,
                callName: call.name,
                resultName: event.content.name,
                callEventId: call.eventId,
              },
            ),
          );
        }
        items.push({
          kind: 'tool_result',
          toolCallId: event.content.id,
          toolName: event.content.name,
          output: normalizedResult,
          isError: event.content.isError === true,
          ...(event.content.providerExecuted !== undefined
            ? { providerExecuted: event.content.providerExecuted }
            : {}),
          eventId: event.id,
          ts: event.ts,
        });
        callsById.delete(event.content.id);
        break;
      }
      default:
        diagnostics.push(
          diagnostic(
            event,
            'unsupported_content',
            'RuntimeEvent content kind is not model-replayable',
            { kind: (event.content as RuntimeEventContent).kind },
          ),
        );
        break;
    }
  }

  // A call whose result never landed (the app died during tool execution;
  // recovery appends the terminal error but cannot invent the result) must not
  // replay: a tool_use with no tool_result is a provider 400. Drop it — the
  // deliberately non-blocking mirror of unmatched_tool_result — so consumers
  // that read `items` directly (materializer, compact summarizer) stay valid.
  for (const [toolCallId, call] of callsById) {
    const index = items.indexOf(call.item);
    if (index >= 0) items.splice(index, 1);
    diagnostics.push({
      code: 'unmatched_tool_call',
      message: 'function_call has no matching function_response; dropped from model replay',
      eventId: call.eventId,
      detail: { toolCallId },
    });
  }

  const textMessages = items
    .filter(
      (item): item is Extract<RuntimeEventModelReplayItem, { kind: 'text' }> =>
        item.kind === 'text',
    )
    .map((item) =>
      item.steering
        ? {
            role: item.role,
            content: item.content,
            providerOptions: steeringProviderOptions(item.steering.eventId),
          }
        : { role: item.role, content: item.content },
    );
  const semanticKinds = [...new Set(items.map((item) => item.kind))];
  return {
    items,
    textMessages,
    semanticKinds,
    diagnostics,
    hasProviderNativeSemantics:
      semanticKinds.includes('thinking') ||
      semanticKinds.includes('tool_call') ||
      semanticKinds.includes('tool_result'),
  };
}

/**
 * Convert projected RuntimeEvent history into the current AI SDK text-only
 * message shape. Tool/function and thinking entries are intentionally skipped.
 */
export function buildTextModelMessagesFromRuntimeEvents(
  events: readonly RuntimeEvent[],
  options: RuntimeEventTextMessageOptions = {},
): TextModelMessage[] {
  const history = buildModelHistoryFromRuntimeEvents(events, {
    includeToolEvents: false,
    includeSystemEvents: options.includeSystemEvents ?? false,
    includeThinking: false,
  });
  const out: TextModelMessage[] = [];
  for (const entry of history) {
    if (entry.content.kind !== 'text') continue;
    if (entry.role === 'tool') continue;
    if (entry.role === 'system' && !options.includeSystemEvents) continue;
    const role =
      entry.role === 'model'
        ? 'assistant'
        : entry.role === 'user'
          ? 'user'
          : entry.role === 'system'
            ? 'system'
            : undefined;
    if (!role) continue;
    const steering = entry.content.steering === true && role === 'user';
    out.push({
      role,
      content: steering
        ? buildSteeringEnvelope(formatTextWithInlineRefs(entry.content))
        : formatTextWithInlineRefs(entry.content),
      // Keep the structured identity even in the text-only shape: dedupe
      // against the live injection set works by ledger event id.
      ...(steering ? { providerOptions: steeringProviderOptions(entry.eventId) } : {}),
    });
  }
  return out;
}

function modelTextRole(role: RuntimeEventRole): TextModelMessage['role'] | undefined {
  switch (role) {
    case 'user':
      return 'user';
    case 'model':
      return 'assistant';
    case 'system':
      return 'system';
    default:
      return undefined;
  }
}

function diagnostic(
  event: RuntimeEvent,
  code: RuntimeEventReplayDiagnosticCode,
  message: string,
  detail?: Record<string, unknown>,
): RuntimeEventReplayDiagnostic {
  return {
    code,
    message,
    eventId: event.id,
    turnId: event.turnId,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Wrap a steered user message so the model does not confuse a mid-turn
 * interjection with a tool result (mirrors the grok-build steering envelope).
 * This is THE canonical provider projection of a steering event: replay
 * plans and the live injection both emit this exact form, so a steering
 * message has one identity in every provider request — the envelope text —
 * and dedupe never has to guess against bare user text.
 */
export function buildSteeringEnvelope(text: string): string {
  return `The user sent a message while you were working:\n<user_query>\n${text}\n</user_query>`;
}

/**
 * Structured steering identity on a provider message. Carried in a
 * Maka-namespaced providerOptions entry — provider adapters only read their
 * own namespace, so it never reaches a provider request body — keyed by the
 * ledger event id. Identity, not text: user text can equal the envelope
 * verbatim and must never be mistaken for (or cancel) a real steering
 * message.
 */
const STEERING_PROVIDER_OPTIONS_NAMESPACE = 'maka';

/** The structured steering marker for a provider message. */
export function steeringProviderOptions(
  eventId: string,
): NonNullable<ModelMessage['providerOptions']> {
  return {
    [STEERING_PROVIDER_OPTIONS_NAMESPACE]: { steeringEventId: eventId },
  };
}

/** Add structured steering identity to already-canonical provider content. */
export function steeringModelMessage(
  eventId: string,
  providerContent: UserContent,
): UserModelMessage {
  return {
    role: 'user',
    content: providerContent,
    providerOptions: steeringProviderOptions(eventId),
  };
}

/** The ledger event id of a steering-marked message, else undefined. */
export function steeringEventIdOf(message: ModelMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  const namespace = (message.providerOptions as Record<string, unknown> | undefined)?.[
    STEERING_PROVIDER_OPTIONS_NAMESPACE
  ];
  if (!namespace || typeof namespace !== 'object') return undefined;
  const eventId = (namespace as Record<string, unknown>).steeringEventId;
  return typeof eventId === 'string' ? eventId : undefined;
}

/**
 * The injected steering messages whose ledger event id is not already present
 * in the request base. Ledger-derived bases (mid-turn capacity replacement,
 * overflow rebuild, degraded-projection fallbacks) carry the same structured
 * marker, so membership is exact — by id, never by text.
 */
export function steeringMessagesMissingFromBase(
  injected: readonly ModelMessage[],
  baseMessages: readonly ModelMessage[],
): ModelMessage[] {
  if (injected.length === 0) return [];
  const present = new Set<string>();
  for (const message of baseMessages) {
    const eventId = steeringEventIdOf(message);
    if (eventId !== undefined) present.add(eventId);
  }
  return injected.filter((message) => {
    const eventId = steeringEventIdOf(message);
    return eventId === undefined || !present.has(eventId);
  });
}

/**
 * The messages with THIS TURN'S injected steering removed (transport-retry
 * base). Only the injected set may be stripped: the retry attempt's own
 * request projection re-appends exactly that accumulator, while a historical,
 * ledger-replayed steering message (same marker, different event id) is part
 * of the base that nothing re-appends — stripping it would erase it from
 * every post-retry request.
 */
export function stripSteeringMessages(
  messages: readonly ModelMessage[],
  injected: readonly ModelMessage[],
): ModelMessage[] {
  const ids = new Set<string>();
  for (const message of injected) {
    const eventId = steeringEventIdOf(message);
    if (eventId !== undefined) ids.add(eventId);
  }
  if (ids.size === 0) return [...messages];
  return messages.filter((message) => {
    const eventId = steeringEventIdOf(message);
    return eventId === undefined || !ids.has(eventId);
  });
}

/**
 * Fold a user turn's inline references into its model-facing text. Attachments
 * render as a name/type block with exact Read instructions when the reference
 * is safely addressable (their bytes, when the model can see them, are appended
 * separately as image parts); quotes carry their excerpt inline, since a quote
 * has no backing storage — the text IS the reference. Presentation layers
 * render both as chips and never show this folded form.
 */
export function formatTextWithInlineRefs(
  textOrContent: string | RuntimeEventTextContent,
  refs?: { attachments?: AttachmentRef[]; quotes?: QuoteRef[] },
): string {
  const fromContent = typeof textOrContent !== 'string';
  const text = fromContent ? textOrContent.text : textOrContent;
  const attachments = fromContent ? textOrContent.attachments : refs?.attachments;
  const quotes = fromContent ? textOrContent.quotes : refs?.quotes;
  const blocks: string[] = [];
  if (quotes && quotes.length > 0) blocks.push(formatQuoteRefs(quotes));
  if (attachments && attachments.length > 0) blocks.push(formatAttachmentRefs(attachments));
  if (blocks.length === 0) return text;
  return [text, ...blocks].join('\n\n');
}

function formatAttachmentRefs(attachments: readonly AttachmentRef[]): string {
  return attachments
    .map((attachment) => {
      const resourceRef = formatAttachmentResourceRef(attachment.ref);
      const readArgument = resourceRef
        ? { ref: resourceRef }
        : attachment.ref.kind === 'workspace_file'
          ? { path: attachment.ref.relativePath }
          : attachment.ref.kind === 'external_file'
            ? { path: attachment.ref.absolutePath }
            : null;
      const access = readArgument
        ? resourceRef
          ? [
              `Read argument: ${JSON.stringify(readArgument)}`,
              'This is a Session resource, not a workspace file. Use the ref above; never use the display name as a path.',
            ].join('\n')
          : `Read argument: ${JSON.stringify(readArgument)}`
        : 'The attachment content is unavailable to Read.';
      return [
        '<attachment>',
        access,
        `name: ${JSON.stringify(attachment.name)}`,
        `mime_type: ${JSON.stringify(attachment.mimeType)}`,
        '</attachment>',
      ].join('\n');
    })
    .join('\n');
}

function formatQuoteRefs(quotes: readonly QuoteRef[]): string {
  return quotes
    .map((q) => {
      const label = q.label === undefined ? '' : ` label="${q.label.replace(/"/g, "'")}"`;
      return `<quoted_excerpt${label}>\n${q.text}\n</quoted_excerpt>`;
    })
    .join('\n');
}
