import type { StoredMessage } from '@maka/core';

/**
 * Read-model settlement shared by the main chat and the quote companion.
 *
 * After a turn completes, the live projection must not be handed off to the
 * persisted transcript until the matching assistant message is actually stored —
 * otherwise a settlement lag makes the just-finished exchange flicker away. This
 * reads the session's messages and, when a specific assistant message is
 * required, retries with a short backoff until it lands (or the budget is spent).
 */

/** Backoff between committed-assistant settlement reads. */
const COMMITTED_ASSISTANT_SETTLE_DELAYS_MS = [120, 360] as const;

export interface RefreshMessagesOptions {
  requiredAssistantMessageId?: string;
}

export function hasAssistantMessage(
  messages: readonly StoredMessage[],
  messageId: string,
): boolean {
  return messages.some((message) => message.type === 'assistant' && message.id === messageId);
}

/**
 * Read a session's messages, waiting (with backoff) for `requiredAssistantMessageId`
 * to be persisted when one is given. `settled` reports whether that message was
 * found; the caller only hands off from the live projection once it is.
 */
export async function readSettledMessages(
  sessionId: string,
  options: RefreshMessagesOptions = {},
): Promise<{ messages: StoredMessage[]; settled: boolean }> {
  const requiredMessageId = options.requiredAssistantMessageId;
  if (!requiredMessageId) {
    return { messages: await window.maka.sessions.readMessages(sessionId), settled: true };
  }

  let lastError: unknown;
  let lastMessages: StoredMessage[] | undefined;
  for (let attempt = 0; attempt <= COMMITTED_ASSISTANT_SETTLE_DELAYS_MS.length; attempt += 1) {
    try {
      const messages = await window.maka.sessions.readMessages(sessionId);
      if (hasAssistantMessage(messages, requiredMessageId)) {
        return { messages, settled: true };
      }
      lastMessages = messages;
    } catch (error) {
      lastError = error;
    }
    const delayMs = COMMITTED_ASSISTANT_SETTLE_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }
  if (lastMessages) return { messages: lastMessages, settled: false };
  throw lastError;
}
