/**
 * RuntimeEvent adapters — narrow bridges between the durable StoredMessage
 * model and the canonical RuntimeEvent fact model.
 *
 * Architecture: docs/architecture/runtime-core-architecture-draft.md
 *
 * Phase 1 scope: pure, synchronous, allocation-only adapters. They do NOT
 * touch storage, do NOT mutate their inputs, and do NOT invent fields the
 * source message cannot supply. Every adapter is total: when a message
 * kind cannot be converted safely, the helper returns `null` (singular) or
 * omits the entry (plural) rather than throwing.
 *
 * The reverse direction (RuntimeEvent → StoredMessage draft) is provided
 * only for the straightforward user/model text cases. Tool, permission,
 * token-usage, and lifecycle events are deliberately NOT forced back into
 * StoredMessage shapes — those projections are owned by later nodes and
 * the materializer already covers the UI path.
 *
 * NOTE: imports the new `@maka/core/runtime-event` subpath. The steward
 * node re-exports it from the core barrel; until then the subpath in
 * `packages/core/package.json` is the canonical entry point.
 */

import type {
  StoredMessage,
  UserMessage,
  AssistantMessage,
  SystemNoteMessage,
} from '@maka/core/session';
import { createRuntimeEventId, type RuntimeEvent } from '@maka/core/runtime-event';

// ============================================================================
// Shared context for legacy → event conversion
// ============================================================================

export interface StoredMessageEventContext {
  sessionId: string;
  invocationId: string;
  runId: string;
  /** Defaults to the message turnId (or '' for session-level notes). */
  turnId?: string;
  /** Defaults to the message ts. */
  ts?: number;
  /** id generator for new RuntimeEvents; defaults to createRuntimeEventId. */
  newId?: () => string;
}

interface ResolvedEventCtx {
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  ts: number;
  newId: () => string;
}

function resolveCtx(ctx: StoredMessageEventContext, message: StoredMessage): ResolvedEventCtx {
  return {
    sessionId: ctx.sessionId,
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    turnId: ctx.turnId ?? message.turnId ?? '',
    ts: ctx.ts ?? message.ts,
    newId: ctx.newId ?? (() => createRuntimeEventId('rt-legacy')),
  };
}

// ============================================================================
// StoredMessage → RuntimeEvent
// ============================================================================

/**
 * Convert a legacy StoredMessage into the PRIMARY RuntimeEvent it carries.
 *
 * Safe conversions:
 *   user         → role 'user',  author 'user',   text content
 *   assistant    → role 'model', author 'agent',  text content (thinking omitted)
 *   system_note  → role 'system', author 'system', text content
 *
 * Returns null for tool_call, tool_result, permission_decision,
 * token_usage, and turn_state — these need richer mapping (function_call /
 * function_response content, actions, refs) that the runtime runner owns.
 *
 * Assistant `thinking` is dropped in this narrow singular form; use
 * `storedMessageToRuntimeEvents` to capture thinking as a separate event.
 */
export function storedMessageToRuntimeEvent(
  message: StoredMessage,
  ctx: StoredMessageEventContext,
): RuntimeEvent | null {
  const d = resolveCtx(ctx, message);
  switch (message.type) {
    case 'user':
      return {
        id: d.newId(),
        invocationId: d.invocationId,
        runId: d.runId,
        sessionId: d.sessionId,
        turnId: d.turnId,
        ts: d.ts,
        partial: false,
        role: 'user',
        author: message.origin ? 'host' : 'user',
        content: {
          kind: 'text',
          text: message.text,
          ...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
          ...(message.origin !== undefined ? { origin: message.origin } : {}),
          ...(message.attachments !== undefined && message.attachments.length > 0
            ? { attachments: message.attachments }
            : {}),
          ...(message.quotes !== undefined && message.quotes.length > 0
            ? { quotes: message.quotes }
            : {}),
          ...(message.inlineReferences !== undefined
            ? { inlineReferences: message.inlineReferences }
            : {}),
        },
        refs: { storedMessageId: message.id },
      };

    case 'assistant':
      return {
        id: d.newId(),
        invocationId: d.invocationId,
        runId: d.runId,
        sessionId: d.sessionId,
        turnId: d.turnId,
        ts: d.ts,
        partial: false,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'text',
          text: message.text,
          ...(message.providerOptions !== undefined
            ? { providerOptions: structuredClone(message.providerOptions) }
            : {}),
        },
        refs: { storedMessageId: message.id },
      };

    case 'system_note':
      return {
        id: d.newId(),
        invocationId: d.invocationId,
        runId: d.runId,
        sessionId: d.sessionId,
        turnId: d.turnId,
        ts: d.ts,
        partial: false,
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: systemNoteText(message) },
        refs: { storedMessageId: message.id },
      };

    default:
      return null;
  }
}

/**
 * Convert a legacy StoredMessage into ALL RuntimeEvents it implies.
 *
 * Multi-event cases:
 *   assistant with thinking → [model text event, model thinking event]
 *
 * Returns an empty array for message kinds that have no safe conversion
 * (tool_call, tool_result, permission_decision, token_usage, turn_state).
 */
export function storedMessageToRuntimeEvents(
  message: StoredMessage,
  ctx: StoredMessageEventContext,
): RuntimeEvent[] {
  const primary = storedMessageToRuntimeEvent(message, ctx);
  const out: RuntimeEvent[] = [];
  if (primary) out.push(primary);

  if (message.type === 'assistant' && message.thinking) {
    const d = resolveCtx(ctx, message);
    const parts = message.thinking.parts ?? [message.thinking];
    for (const part of parts) {
      out.push({
        id: d.newId(),
        invocationId: d.invocationId,
        runId: d.runId,
        sessionId: d.sessionId,
        turnId: d.turnId,
        ts: d.ts,
        partial: false,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'thinking',
          text: part.text,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
          ...(part.providerOptions !== undefined
            ? { providerOptions: structuredClone(part.providerOptions) }
            : {}),
        },
        refs: { storedMessageId: message.id },
      });
    }
  }

  return out;
}

/**
 * Stable, machine-readable label for a SystemNoteMessage. The model-history
 * projection excludes system-role events by default, so this text never
 * leaks into prompts; it exists only so the event carries a non-empty
 * content payload for audit/UI projections.
 */
function systemNoteText(m: SystemNoteMessage): string {
  return `system_note:${m.kind}`;
}

// ============================================================================
// RuntimeEvent → StoredMessage draft
// ============================================================================

export interface RuntimeEventToDraftOptions {
  /**
   * Required to emit AssistantMessage drafts from model-role text events.
   * When omitted, model-role events return null (no safe legacy shape).
   */
  modelId?: string;
  /** id generator for new StoredMessages; defaults to createRuntimeEventId. */
  newId?: () => string;
}

/**
 * Convert a RuntimeEvent into a legacy StoredMessage draft, when the
 * mapping is straightforward and lossless.
 *
 * Straightforward cases:
 *   role 'user'  + text content → UserMessage
 *   role 'model' + text content → AssistantMessage (requires options.modelId)
 *
 * Returns null for every other shape (thinking, function_call,
 * function_response, error, actions-only, system notes) — these are not
 * forced into legacy storage. Tool/function projections will be owned by
 * the runtime runner / tool-runtime nodes.
 *
 * The returned message is a complete StoredMessage with id/turnId/ts
 * filled from the event (or generated when absent). The caller is
 * responsible for appending it to the store.
 */
export function runtimeEventToStoredMessageDraft(
  event: RuntimeEvent,
  options: RuntimeEventToDraftOptions = {},
): StoredMessage | null {
  if (event.partial) return null;
  const newId = options.newId ?? (() => createRuntimeEventId('msg'));
  const content = event.content;
  if (!content) return null;

  if (event.role === 'user' && content.kind === 'text') {
    const draft: UserMessage = {
      type: 'user',
      id: event.refs?.storedMessageId ?? newId(),
      turnId: event.turnId,
      ts: event.ts,
      text: content.text,
      ...(content.displayText !== undefined ? { displayText: content.displayText } : {}),
      ...(content.origin !== undefined ? { origin: content.origin } : {}),
      ...(content.attachments !== undefined && content.attachments.length > 0
        ? { attachments: content.attachments }
        : {}),
      ...(content.quotes !== undefined && content.quotes.length > 0
        ? { quotes: content.quotes }
        : {}),
      ...(content.inlineReferences !== undefined
        ? { inlineReferences: content.inlineReferences }
        : {}),
    };
    return draft;
  }

  if (event.role === 'model' && content.kind === 'text') {
    if (!options.modelId) return null;
    const draft: AssistantMessage = {
      type: 'assistant',
      id: event.refs?.storedMessageId ?? newId(),
      turnId: event.turnId,
      ts: event.ts,
      text: content.text,
      ...(content.providerOptions !== undefined
        ? { providerOptions: structuredClone(content.providerOptions) }
        : {}),
      modelId: options.modelId,
    };
    return draft;
  }

  return null;
}

// Re-export the id helper for adapter callers that want the same default.
export { createRuntimeEventId } from '@maka/core/runtime-event';
