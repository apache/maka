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
import type { MakaBridge } from '../preload/bridge-contract.js';
import { DesktopTranscriptRangeStore } from './desktop-transcript-range-store.js';

const COMMITTED_ASSISTANT_SETTLE_TIMEOUT_MS = 480;

export interface RefreshMessagesOptions {
  requiredAssistantMessageId?: string;
  requiredTurnId?: string;
  signal?: AbortSignal;
}

export type TranscriptSettlementSource = Pick<MakaBridge['transcripts'], 'open'>;

export async function readSettledMessagesFrom(
  transcripts: TranscriptSettlementSource,
  sessionId: string,
  options: RefreshMessagesOptions = {},
): Promise<{ messages: StoredMessage[]; settled: boolean }> {
  return readSettledMessagesUsing(transcripts, sessionId, options);
}

export async function readSettledMessages(
  sessionId: string,
  options: RefreshMessagesOptions = {},
): Promise<{ messages: StoredMessage[]; settled: boolean }> {
  return readSettledMessagesUsing(window.maka.transcripts, sessionId, options);
}

async function readSettledMessagesUsing(
  transcripts: TranscriptSettlementSource,
  sessionId: string,
  options: RefreshMessagesOptions,
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
  const opening = transcripts.open(
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
    const requiredTurnId = options.requiredTurnId;
    let retainedDurable: ReturnType<DesktopTranscriptRangeStore['durableEntries']> | undefined;
    if (
      requiredTurnId !== undefined &&
      !transcriptRecordsTerminalTurn(store.snapshot().messages, requiredTurnId)
    ) {
      retainedDurable = store.durableEntries();
      const navigation = {
        navigationVersion: 1,
        intent: 'history' as const,
        preserveRange: true,
        readingTurnId: requiredTurnId,
      };
      store.expectNavigation(navigation.navigationVersion);
      const targetedRead = handle.loadAround(null, undefined, navigation);
      void targetedRead.catch(() => undefined);
    }
    while (true) {
      const snapshot = store.snapshot();
      const requiredMessageId = options.requiredAssistantMessageId;
      const settled =
        snapshot.ready &&
        (requiredMessageId === undefined || store.hasDurableMessage(requiredMessageId)) &&
        (requiredTurnId === undefined ||
          transcriptRecordsTerminalTurn(snapshot.messages, requiredTurnId));
      if (settled || Date.now() >= deadline) {
        return {
          messages: retainedDurable
            ? mergeTranscriptRanges(retainedDurable, store.durableEntries(), snapshot.messages)
            : [...snapshot.messages],
          settled,
        };
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

function mergeTranscriptRanges(
  retained: ReturnType<DesktopTranscriptRangeStore['durableEntries']>,
  current: ReturnType<DesktopTranscriptRangeStore['durableEntries']>,
  currentMessages: readonly StoredMessage[],
): StoredMessage[] {
  const durableBySequence = new Map(retained.map(({ sequence, message }) => [sequence, message]));
  for (const { sequence, message } of current) durableBySequence.set(sequence, message);
  const durable = [...durableBySequence]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message);
  const durableIds = new Set(durable.map((message) => message.id));
  return durable.concat(currentMessages.filter((message) => !durableIds.has(message.id)));
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
