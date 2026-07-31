import { useEffect, useRef } from 'react';
import { displayRedactSecrets, type SessionSummary, type StoredMessage } from '@maka/core';
import type { LiveTurnProjection, ToolActivityItem } from '@maka/ui';
import {
  publishMakaSkinEvent,
  type MakaSkinSemanticEventMap,
} from './skin-events';

const MAX_DETAIL_TEXT = 12_000;
const SKIN_OWNER_SELECTOR = '[data-maka-skin-overlay], [data-maka-skin-mount]';

function boundedDisplayText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  const redacted = displayRedactSecrets(text);
  return redacted.length > MAX_DETAIL_TEXT
    ? `${redacted.slice(0, MAX_DETAIL_TEXT)}\n…[truncated]`
    : redacted;
}

function projectConversation(messages: readonly StoredMessage[], liveTurn: LiveTurnProjection | undefined) {
  const projected = new Map<string, {
    id: string;
    turnId: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp?: number;
    streaming: boolean;
    truncated?: boolean;
  }>();
  for (const message of messages) {
    if (message.type === 'user') {
      projected.set(message.id, {
        id: message.id,
        turnId: message.turnId,
        role: 'user',
        text: displayRedactSecrets(message.displayText ?? message.text),
        timestamp: message.ts,
        streaming: false,
      });
    } else if (message.type === 'assistant') {
      projected.set(message.id, {
        id: message.id,
        turnId: message.turnId,
        role: 'assistant',
        text: displayRedactSecrets(message.text),
        timestamp: message.ts,
        streaming: false,
      });
    }
  }
  if (liveTurn) {
    for (const step of liveTurn.steps) {
      if (!step.text) continue;
      projected.set(step.stepId, {
        id: step.stepId,
        turnId: liveTurn.turnId,
        role: 'assistant',
        text: displayRedactSecrets(step.text.text),
        streaming: step.text.complete !== true,
        ...(step.text.truncated ? { truncated: true } : {}),
      });
    }
  }
  return [...projected.values()];
}

function projectTools(
  messages: readonly StoredMessage[],
  liveTools: readonly ToolActivityItem[],
) {
  const projected = new Map<string, {
    id: string;
    turnId?: string;
    name: string;
    displayName?: string;
    status: string;
    argsText?: string;
    outputText?: string;
    durationMs?: number;
    truncated?: boolean;
  }>();
  for (const message of messages) {
    if (message.type === 'tool_call') {
      projected.set(message.id, {
        id: message.id,
        turnId: message.turnId,
        name: message.toolName,
        ...(message.displayName ? { displayName: message.displayName } : {}),
        status: 'completed',
        ...(boundedDisplayText(message.args) ? { argsText: boundedDisplayText(message.args) } : {}),
      });
    } else if (message.type === 'tool_result') {
      const existing = projected.get(message.toolUseId);
      projected.set(message.toolUseId, {
        id: message.toolUseId,
        turnId: message.turnId,
        name: existing?.name ?? 'Tool',
        ...(existing?.displayName ? { displayName: existing.displayName } : {}),
        status: message.isError ? 'errored' : 'completed',
        ...(existing?.argsText ? { argsText: existing.argsText } : {}),
        ...(boundedDisplayText(message.content) ? { outputText: boundedDisplayText(message.content) } : {}),
        ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
      });
    }
  }
  for (const tool of liveTools) {
    const existing = projected.get(tool.toolUseId);
    const outputText = tool.outputChunks?.map((chunk) => chunk.text).join('')
      ?? boundedDisplayText(tool.result);
    projected.set(tool.toolUseId, {
      id: tool.toolUseId,
      ...(existing?.turnId ? { turnId: existing.turnId } : {}),
      name: tool.toolName === 'Tool' ? existing?.name ?? tool.toolName : tool.toolName,
      ...(tool.displayName || existing?.displayName
        ? { displayName: tool.displayName ?? existing?.displayName }
        : {}),
      status: tool.status,
      ...(boundedDisplayText(tool.args) || existing?.argsText
        ? { argsText: boundedDisplayText(tool.args) ?? existing?.argsText }
        : {}),
      ...(outputText ? { outputText: boundedDisplayText(outputText) } : {}),
      ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
      ...(tool.outputTruncated ? { truncated: true } : {}),
    });
  }
  return [...projected.values()];
}

function navigationProjection(selection: { section: string; module?: string }) {
  return {
    section: selection.section,
    ...('module' in selection && selection.module ? { module: selection.module } : {}),
  };
}

export function useSkinSemanticEvents(options: {
  sessionId: string | undefined;
  sessions: readonly SessionSummary[];
  messages: readonly StoredMessage[];
  liveTurn?: LiveTurnProjection;
  streaming: boolean;
  turnInFlight: boolean;
  hasInFlightTools: boolean;
  interaction: {
    type: string;
    requestId?: string;
    toolUseId?: string;
    questions?: ReadonlyArray<{
      question: string;
      options: ReadonlyArray<{ label: string; description?: string }>;
    }>;
  } | undefined;
  tools: readonly ToolActivityItem[];
  navigation: { section: string; module?: string };
  composer: {
    readDraft(): string;
    readSkills(): ReadonlyArray<{ id: string; ref?: string; name: string }>;
    attachments: ReadonlyArray<{ displayName: string; kind: string; size: number; mimeType?: string }>;
    model?: string;
    permissionMode?: string;
    busy: boolean;
    revision: number;
  };
}): void {
  const {
    sessionId,
    sessions,
    messages,
    liveTurn,
    streaming,
    turnInFlight,
    hasInFlightTools,
    interaction,
    tools,
    navigation,
    composer,
  } = options;
  const generationState = interaction
    ? 'waiting'
    : streaming
      ? 'streaming'
      : hasInFlightTools
        ? 'tool'
        : turnInFlight
          ? 'processing'
          : 'idle';
  const interactionKind = interaction?.type === 'sandbox_boundary_request'
    ? 'permission'
    : interaction?.type === 'user_question_request'
      ? 'question'
      : null;
  const readComposerSnapshot = (): MakaSkinSemanticEventMap['composer.changed'] => ({
    sessionId: sessionId ?? null,
    draft: composer.readDraft(),
    skills: composer.readSkills(),
    attachments: composer.attachments.map((attachment, index) => ({
      index,
      name: attachment.displayName,
      kind: attachment.kind,
      size: attachment.size,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    })),
    ...(composer.model ? { model: composer.model } : {}),
    ...(composer.permissionMode ? { permissionMode: composer.permissionMode } : {}),
    busy: composer.busy,
  });
  const snapshotsRef = useRef<Partial<MakaSkinSemanticEventMap>>({});
  const latestComposerRef = useRef(composer);
  latestComposerRef.current = composer;
  snapshotsRef.current = {
    ...snapshotsRef.current,
    'session.changed': { sessionId: sessionId ?? null },
    'messages.changed': {
      sessionId: sessionId ?? null,
      count: messages.length,
      ...(messages.at(-1)
        ? { lastMessage: { id: messages.at(-1)!.id, type: messages.at(-1)!.type } }
        : {}),
    },
    'generation.changed': { sessionId: sessionId ?? null, state: generationState },
    'tools.changed': {
      sessionId: sessionId ?? null,
      tools: tools.map((tool) => ({ id: tool.toolUseId, name: tool.toolName, status: tool.status })),
    },
    'interaction.changed': {
      sessionId: sessionId ?? null,
      kind: interactionKind,
      waiting: Boolean(interaction),
    },
    'sessions.changed': {
      currentSessionId: sessionId ?? null,
      sessions: sessions.map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
        flagged: session.isFlagged,
        archived: session.isArchived,
        unread: session.hasUnread,
        ...(session.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
        ...(session.lastMessagePreview ? { lastMessagePreview: displayRedactSecrets(session.lastMessagePreview) } : {}),
      })),
    },
    'conversation.changed': {
      sessionId: sessionId ?? null,
      messages: projectConversation(messages, liveTurn),
    },
    'tools.detail.changed': {
      sessionId: sessionId ?? null,
      tools: projectTools(messages, tools),
    },
    'interaction.detail.changed': {
      sessionId: sessionId ?? null,
      interaction: interactionKind
        ? {
            kind: interactionKind,
            ...(interaction?.requestId ? { requestId: interaction.requestId } : {}),
            ...(interaction?.toolUseId ? { toolUseId: interaction.toolUseId } : {}),
            ...(interactionKind === 'question' && interaction?.questions
              ? { questions: interaction.questions }
              : {}),
          }
        : null,
    },
    'composer.changed': readComposerSnapshot(),
    'navigation.did-change': {
      from: navigationProjection(navigation),
      to: navigationProjection(navigation),
    },
    'navigation.will-change': {
      from: navigationProjection(navigation),
      to: navigationProjection(navigation),
    },
  };

  useEffect(() => {
    const receiveRequest = (event: Event) => {
      const request = event.target;
      if (!(request instanceof HTMLElement) || !request.closest(SKIN_OWNER_SELECTOR)) return;
      const type = request.dataset.makaSkinSnapshotType as keyof MakaSkinSemanticEventMap | undefined;
      if (!type) return;
      const storedSnapshot = snapshotsRef.current[type];
      const snapshot = type === 'composer.changed' && storedSnapshot
        ? {
            ...storedSnapshot,
            draft: latestComposerRef.current.readDraft(),
            skills: latestComposerRef.current.readSkills(),
          }
        : storedSnapshot;
      if (snapshot === undefined) request.dataset.makaSkinSnapshotError = `Unknown skin snapshot: ${type}`;
      else request.dataset.makaSkinSnapshotResult = JSON.stringify(snapshot);
      request.dispatchEvent(new Event('maka:skin-snapshot-response'));
    };
    window.addEventListener('maka:skin-snapshot-request', receiveRequest);
    return () => window.removeEventListener('maka:skin-snapshot-request', receiveRequest);
  }, []);

  useEffect(() => {
    publishMakaSkinEvent('session.changed', snapshotsRef.current['session.changed']!);
    publishMakaSkinEvent('sessions.changed', snapshotsRef.current['sessions.changed']!);
  }, [sessionId, sessions]);
  useEffect(() => {
    publishMakaSkinEvent('messages.changed', snapshotsRef.current['messages.changed']!);
    publishMakaSkinEvent('conversation.changed', snapshotsRef.current['conversation.changed']!);
  }, [liveTurn, messages, sessionId]);
  useEffect(() => {
    publishMakaSkinEvent('generation.changed', snapshotsRef.current['generation.changed']!);
  }, [generationState, sessionId]);
  useEffect(() => {
    publishMakaSkinEvent('tools.changed', snapshotsRef.current['tools.changed']!);
    publishMakaSkinEvent('tools.detail.changed', snapshotsRef.current['tools.detail.changed']!);
  }, [messages, sessionId, tools]);
  useEffect(() => {
    publishMakaSkinEvent('interaction.changed', snapshotsRef.current['interaction.changed']!);
    publishMakaSkinEvent('interaction.detail.changed', snapshotsRef.current['interaction.detail.changed']!);
  }, [interaction, sessionId]);
  useEffect(() => {
    publishMakaSkinEvent('composer.changed', readComposerSnapshot());
  }, [composer.attachments, composer.busy, composer.model, composer.permissionMode, composer.revision, sessionId]);
}
