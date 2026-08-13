import type { StoredMessage } from '@maka/core/session';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';

const COMMITTED_ASSISTANT_SETTLE_TIMEOUT_MS = 480;

export interface RefreshMessagesOptions {
  requiredAssistantMessageId?: string;
}

export function mergeSettledMessages(
  current: readonly StoredMessage[],
  incoming: readonly StoredMessage[],
): StoredMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const knownIds = new Set(current.map((message) => message.id));
  return current
    .map((message) => incomingById.get(message.id) ?? message)
    .concat(incoming.filter((message) => !knownIds.has(message.id)));
}

export async function readSettledMessages(
  sessionId: string,
  options: RefreshMessagesOptions = {},
): Promise<{ messages: StoredMessage[]; settled: boolean }> {
  const store = new DesktopTranscriptRangeStore();
  let notify: () => void = () => {};
  const changed = () => new Promise<void>((resolve) => {
    notify = resolve;
  });
  let nextChange = changed();
  const handle = await window.maka.transcripts.open(sessionId, (batch) => {
    if (!store.accept(batch)) return;
    notify();
    nextChange = changed();
  });
  const deadline = Date.now() + COMMITTED_ASSISTANT_SETTLE_TIMEOUT_MS;
  try {
    while (true) {
      const snapshot = store.snapshot();
      const requiredMessageId = options.requiredAssistantMessageId;
      const settled =
        snapshot.ready &&
        (requiredMessageId === undefined || store.hasDurableMessage(requiredMessageId));
      if (settled || Date.now() >= deadline) {
        return { messages: [...snapshot.messages], settled };
      }
      await Promise.race([
        nextChange,
        new Promise<void>((resolve) =>
          window.setTimeout(resolve, Math.max(0, deadline - Date.now())),
        ),
      ]);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
