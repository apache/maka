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

import type { StoredMessage } from '@maka/core/session';
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';

const COMMITTED_ASSISTANT_SETTLE_TIMEOUT_MS = 480;

export interface RefreshMessagesOptions {
  requiredAssistantMessageId?: string;
  requiredTurnId?: string;
  signal?: AbortSignal;
}

export type TranscriptSettlementSource = {
  transcripts: Pick<MakaBridge['transcripts'], 'open' | 'readTurn'>;
};

export async function readSettledMessages(
  sessionId: string,
  options: RefreshMessagesOptions = {},
): Promise<{ messages: StoredMessage[]; settled: boolean }> {
  return readSettledMessagesFrom(window.maka, sessionId, options);
}

export async function readSettledMessagesFrom(
  source: TranscriptSettlementSource,
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
  let tailRevision = 0;
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
  const opening = source.transcripts.open(
    sessionId,
    (batch) => {
      if (!store.accept(batch)) return;
      tailRevision += 1;
      notify();
      nextChange = changed();
    },
    (close) => {
      cancelOpen = close;
      if (cancelled) close();
    },
    'tail',
  );
  void opening.catch(() => undefined);
  let handle: Awaited<typeof opening> | undefined;
  try {
    handle = await Promise.race([opening, cancellation]);
    globalThis.clearTimeout(openTimeout);
    const requiredTurnId = options.requiredTurnId;
    /*
     * The tail is byte-bounded and can begin inside the required Turn, so what
     * it holds of that Turn says nothing about how much of it exists — a
     * terminal row in the tail is evidence about execution, not about
     * coverage. Only the targeted read walks the whole Turn, so the Turn is
     * claimed complete only when that read comes back with its ending.
     */
    let turnMessages: readonly StoredMessage[] = [];
    let turnComplete = false;
    let reading = false;
    let readAtRevision = -1;
    const readRequiredTurn = (): void => {
      // Re-read only for a tail that has moved since the last one: the Turn may
      // have been running then and ended since.
      if (requiredTurnId === undefined || turnComplete || reading) return;
      if (readAtRevision === tailRevision) return;
      reading = true;
      readAtRevision = tailRevision;
      void source.transcripts.readTurn(sessionId, requiredTurnId).then((messages) => {
        if (cancelled) return;
        turnMessages = messages;
        turnComplete = transcriptRecordsTerminalTurn(messages, requiredTurnId);
      }).catch(() => undefined).finally(() => {
        reading = false;
        notify();
        nextChange = changed();
      });
    };
    while (true) {
      readRequiredTurn();
      const snapshot = store.snapshot();
      const tailIds = new Set(snapshot.messages.map((message) => message.id));
      const messages = turnMessages
        .filter((message) => !tailIds.has(message.id))
        .concat(snapshot.messages);
      const requiredMessageId = options.requiredAssistantMessageId;
      const settled =
        snapshot.ready &&
        (requiredMessageId === undefined || store.hasDurableMessage(requiredMessageId)) &&
        (requiredTurnId === undefined || turnComplete);
      if (settled || Date.now() >= deadline) return { messages, settled };
      await Promise.race([
        nextChange,
        cancellation,
        new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, Math.max(0, deadline - Date.now())),
        ),
      ]);
    }
  } finally {
    cancelled = true;
    globalThis.clearTimeout(openTimeout);
    options.signal?.removeEventListener('abort', abort);
    await handle?.close().catch(() => undefined);
  }
}

function transcriptRecordsTerminalTurn(
  messages: readonly StoredMessage[],
  turnId: string,
): boolean {
  return messages.some(
    (message) =>
      message.type === 'turn_state' &&
      message.turnId === turnId &&
      message.status !== 'running',
  );
}
