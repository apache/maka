import { useEffect } from 'react';
import { publishMakaSkinEvent } from './skin-events';

export function useSkinSemanticEvents(options: {
  sessionId: string | undefined;
  messages: ReadonlyArray<{ id: string; type: string }>;
  streaming: boolean;
  turnInFlight: boolean;
  hasInFlightTools: boolean;
  interaction: { type: string } | undefined;
  tools: ReadonlyArray<{ toolUseId: string; toolName: string; status: string }>;
}): void {
  const {
    sessionId,
    messages,
    streaming,
    turnInFlight,
    hasInFlightTools,
    interaction,
    tools,
  } = options;

  useEffect(() => {
    publishMakaSkinEvent('session.changed', { sessionId: sessionId ?? null });
  }, [sessionId]);

  useEffect(() => {
    const last = messages.at(-1);
    publishMakaSkinEvent('messages.changed', {
      sessionId: sessionId ?? null,
      count: messages.length,
      ...(last ? { lastMessage: { id: last.id, type: last.type } } : {}),
    });
  }, [messages, sessionId]);

  useEffect(() => {
    const state = interaction
      ? 'waiting'
      : streaming
        ? 'streaming'
        : hasInFlightTools
          ? 'tool'
          : turnInFlight
            ? 'processing'
            : 'idle';
    publishMakaSkinEvent('generation.changed', {
      sessionId: sessionId ?? null,
      state,
    });
  }, [hasInFlightTools, interaction, sessionId, streaming, turnInFlight]);

  useEffect(() => {
    publishMakaSkinEvent('tools.changed', {
      sessionId: sessionId ?? null,
      tools: tools.map((tool) => ({
        id: tool.toolUseId,
        name: tool.toolName,
        status: tool.status,
      })),
    });
  }, [sessionId, tools]);

  useEffect(() => {
    publishMakaSkinEvent('interaction.changed', {
      sessionId: sessionId ?? null,
      kind: interaction?.type === 'sandbox_boundary_request'
        ? 'permission'
        : interaction?.type === 'user_question_request'
          ? 'question'
          : null,
      waiting: Boolean(interaction),
    });
  }, [interaction, sessionId]);
}
