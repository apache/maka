import type { StoredMessage } from '@maka/core/session';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';

const COMMITTED_ASSISTANT_SETTLE_TIMEOUT_MS = 480;

export interface RefreshMessagesOptions {
  requiredAssistantMessageId?: string;
  signal?: AbortSignal;
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
  const deadline = Date.now() + COMMITTED_ASSISTANT_SETTLE_TIMEOUT_MS;
  const store = new DesktopTranscriptRangeStore(sessionId);
  let notify: () => void = () => {};
  const changed = () => new Promise<void>((resolve) => {
    notify = resolve;
  });
  let nextChange = changed();
  let cancelOpen = () => {};
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  void cancellation.catch(() => undefined);
  let cancelled = false;
  const cancel = (error: Error) => {
    if (cancelled) return;
    cancelled = true;
    cancelOpen();
    rejectCancellation(error);
  };
  const abort = () => cancel(new Error('Desktop transcript settlement was cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const openTimeout = globalThis.setTimeout(
    () => cancel(new Error('Desktop transcript settlement timed out while opening')),
    Math.max(0, deadline - Date.now()),
  );
  const opening = window.maka.transcripts.open(
    sessionId,
    (batch) => {
      if (!store.accept(batch)) return;
      notify();
      nextChange = changed();
    },
    (close) => {
      cancelOpen = close;
      if (cancelled) close();
    },
  );
  void opening.catch(() => undefined);
  let handle: Awaited<typeof opening> | undefined;
  try {
    handle = await Promise.race([opening, cancellation]);
    globalThis.clearTimeout(openTimeout);
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
        cancellation,
        new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, Math.max(0, deadline - Date.now())),
        ),
      ]);
    }
  } finally {
    globalThis.clearTimeout(openTimeout);
    options.signal?.removeEventListener('abort', abort);
    await handle?.close().catch(() => undefined);
  }
}
