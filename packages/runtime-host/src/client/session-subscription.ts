import {
  encodeProtocolMessage,
  type SessionAssistantStreamIdentity,
  type SessionContinuitySnapshot,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  type SubscriptionFrame,
  type SubscriptionOpenResult,
  type SessionTranscriptBootstrap,
  type SessionTranscriptFragment,
  type SessionTranscriptPage,
  type SessionTranscriptPageInput,
} from '../protocol/index.js';

const MAX_CLIENT_QUEUED_FRAMES = 32;
const MAX_CLIENT_QUEUED_BYTES = 256 * 1024;

export type RuntimeHostSubscriptionFailureReason =
  | 'sequence_gap'
  | 'host_epoch_changed'
  | 'correlation_changed'
  | 'projection_revision_invalid'
  | 'slow_consumer'
  | 'connection_closed';

export class RuntimeHostSubscriptionError extends Error {
  constructor(
    readonly reason: RuntimeHostSubscriptionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostSubscriptionError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RuntimeHostSessionSubscription extends AsyncIterable<SubscriptionFrame> {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  readonly transcriptBootstrap: SessionTranscriptBootstrap | null;
  loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]>;
  loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
  ): Promise<SessionTranscriptPage>;
  close(): Promise<void>;
}

interface QueuedFrame {
  frame: SubscriptionFrame;
  encodedBytes: number;
}

export class ClientSessionSubscription
  implements RuntimeHostSessionSubscription, AsyncIterator<SubscriptionFrame>
{
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  readonly transcriptBootstrap: SessionTranscriptBootstrap | null;
  readonly #requestClose: () => Promise<void>;
  readonly #readTranscriptPage: (
    input: SessionTranscriptPageInput,
  ) => Promise<SessionTranscriptPage>;
  readonly #expectedSessionId: string;
  readonly #queue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #expectedSequence: number;
  #latestProjectionRevision: number;
  #waiting:
    | {
        resolve(value: IteratorResult<SubscriptionFrame>): void;
        reject(error: Error): void;
      }
    | undefined;
  #terminalError: Error | undefined;
  #done = false;
  #doneAfterQueue = false;
  #closing = false;
  #closeTask: Promise<void> | undefined;
  #transcriptTask: Promise<unknown[]> | undefined;
  #latestTranscriptThroughSequence: number | null;

  constructor(
    result: SubscriptionOpenResult,
    requestClose: () => Promise<void>,
    readTranscriptPage: (input: SessionTranscriptPageInput) => Promise<SessionTranscriptPage>,
  ) {
    this.hostEpoch = result.hostEpoch;
    this.subscriptionId = result.subscriptionId;
    this.snapshot = result.snapshot;
    this.activeAssistantStreams = result.activeAssistantStreams;
    this.transcriptBootstrap = result.transcript;
    this.#expectedSessionId = result.snapshot.session.sessionId;
    this.#expectedSequence = result.nextSequence;
    this.#latestProjectionRevision = result.snapshot.projectionRevision;
    this.#latestTranscriptThroughSequence = result.transcript?.throughSequence ?? null;
    this.#requestClose = requestClose;
    this.#readTranscriptPage = readTranscriptPage;
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return this;
  }

  next(): Promise<IteratorResult<SubscriptionFrame>> {
    const queued = this.#queue.shift();
    if (queued) {
      this.#queuedBytes -= queued.encodedBytes;
      if (this.#queue.length === 0 && this.#doneAfterQueue) this.#done = true;
      return Promise.resolve({ done: false, value: queued.frame });
    }
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#done || this.#doneAfterQueue) {
      this.#done = true;
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#waiting) {
      return Promise.reject(new Error('Session subscription already has a pending iterator read'));
    }
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<SubscriptionFrame>> {
    await this.close();
    return { done: true, value: undefined };
  }

  close(): Promise<void> {
    if (this.#done || this.#terminalError) return Promise.resolve();
    this.#closing = true;
    if (!this.#closeTask) this.#closeTask = this.#requestClose();
    return this.#closeTask;
  }

  loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]> {
    this.#transcriptTask ??= this.#loadTranscript().catch((error: unknown) => {
      this.#transcriptTask = undefined;
      throw error;
    });
    return this.#transcriptTask.then((messages) => messages.map(decodeMessage));
  }

  loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
  ): Promise<SessionTranscriptPage> {
    this.#assertTranscriptReadable();
    if (!this.transcriptBootstrap) {
      return Promise.reject(
        new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session subscription was opened without transcript access',
        ),
      );
    }
    if (
      input.throughSequence !== null &&
      (this.#latestTranscriptThroughSequence === null ||
        input.throughSequence > this.#latestTranscriptThroughSequence)
    ) {
      return Promise.reject(
        new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript watermark has not been announced',
        ),
      );
    }
    return this.#readTranscriptPage({ subscriptionId: this.subscriptionId, ...input }).then(
      (page) => {
        this.#assertTranscriptReadable();
        this.#assertTranscriptPage(page, input);
        return page;
      },
    );
  }

  async #loadTranscript(): Promise<unknown[]> {
    this.#assertTranscriptReadable();
    const bootstrap = this.transcriptBootstrap;
    if (!bootstrap) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session subscription was opened without transcript access',
      );
    }
    const durablePages = await this.#collectPages(bootstrap.durable);
    const overlayPages = await this.#collectPages(bootstrap.overlay);
    const durable = decodeTranscriptFragments(
      durablePages.flatMap((page) => page.fragments),
      'durable',
    );
    const overlay = decodeTranscriptFragments(
      overlayPages.flatMap((page) => page.fragments),
      'overlay',
    );
    assertCompleteIdentities(durable, bootstrap.throughSequence);
    assertCompleteIdentities(overlay, overlay.at(-1)?.identity ?? null);
    const messages = durable.map((entry) => entry.value);
    const indexById = new Map<string, number>();
    for (const [index, message] of messages.entries()) {
      const id = messageIdentity(message);
      if (id) indexById.set(id, index);
    }
    for (const entry of overlay) {
      const id = messageIdentity(entry.value);
      const index = id ? indexById.get(id) : undefined;
      if (index === undefined) {
        if (id) indexById.set(id, messages.length);
        messages.push(entry.value);
      } else {
        messages[index] = entry.value;
      }
    }
    return messages;
  }

  async #collectPages(initial: SessionTranscriptPage): Promise<SessionTranscriptPage[]> {
    this.#assertTranscriptPage(initial, {
      source: initial.source,
      direction: initial.direction,
      throughSequence: initial.throughSequence,
      maxBytes: Math.max(1, initial.rawBytes),
    });
    const pages = [initial];
    let cursor = initial.nextCursor;
    const seenCursors = new Set<string>();
    while (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript cursor cycle detected',
        );
      }
      seenCursors.add(cursor);
      const page = await this.loadTranscriptPage({
        source: initial.source,
        direction: initial.direction,
        throughSequence: initial.throughSequence,
        cursor,
        anchorSequence: null,
        maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      });
      pages.push(page);
      cursor = page.nextCursor;
    }
    return pages;
  }

  #assertTranscriptReadable(): void {
    if (this.#closing || this.#done || this.#terminalError) {
      throw new RuntimeHostSubscriptionError(
        'connection_closed',
        'Session subscription closed during transcript loading',
      );
    }
  }

  #assertTranscriptPage(
    page: SessionTranscriptPage,
    expected: Pick<
      SessionTranscriptPageInput,
      'source' | 'direction' | 'throughSequence' | 'maxBytes'
    >,
  ): void {
    if (
      page.sessionId !== this.#expectedSessionId ||
      page.source !== expected.source ||
      page.direction !== expected.direction ||
      page.throughSequence !== expected.throughSequence ||
      page.rawBytes > expected.maxBytes
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript page correlation changed',
      );
    }
  }

  accept(frame: SubscriptionFrame): void {
    if (this.#done || this.#terminalError) return;
    if (this.#doneAfterQueue) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session subscription received a frame after closure',
      );
    }
    if (frame.hostEpoch !== this.hostEpoch) {
      throw new RuntimeHostSubscriptionError(
        'host_epoch_changed',
        'Session subscription Host Epoch changed',
      );
    }
    if (frame.subscriptionId !== this.subscriptionId) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session subscription correlation changed',
      );
    }
    if (frame.sequence !== this.#expectedSequence) {
      throw new RuntimeHostSubscriptionError(
        'sequence_gap',
        `Session subscription expected sequence ${this.#expectedSequence} but received ${frame.sequence}`,
      );
    }
    this.#expectedSequence += 1;

    if (frame.kind === 'subscription.session_projection') {
      if (frame.snapshot.session.sessionId !== this.#expectedSessionId) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session subscription projection identity changed',
        );
      }
      if (frame.snapshot.projectionRevision <= this.#latestProjectionRevision) {
        throw new RuntimeHostSubscriptionError(
          'projection_revision_invalid',
          'Session projection revision did not advance',
        );
      }
      this.#latestProjectionRevision = frame.snapshot.projectionRevision;
    } else if (
      (frame.kind === 'subscription.session_delta' ||
        frame.kind === 'subscription.session_event' ||
        frame.kind === 'subscription.transcript_advanced' ||
        frame.kind === 'subscription.session_domain_changed' ||
        frame.kind === 'subscription.runtime_resource_pty_data') &&
      frame.sessionId !== this.#expectedSessionId
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session subscription frame identity changed',
      );
    } else if (
      frame.kind === 'subscription.agent_graph_changed' &&
      frame.rootSessionId !== this.#expectedSessionId
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session subscription Agent graph identity changed',
      );
    }
    if (frame.kind === 'subscription.transcript_advanced') {
      if (
        this.#latestTranscriptThroughSequence !== null &&
        frame.throughSequence <= this.#latestTranscriptThroughSequence
      ) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript watermark did not advance',
        );
      }
      this.#latestTranscriptThroughSequence = frame.throughSequence;
    }

    this.#offer(frame);
    if (frame.kind === 'subscription.closed') this.#doneAfterQueue = true;
  }

  finish(): void {
    if (this.#done || this.#terminalError) return;
    this.#doneAfterQueue = true;
    if (this.#queue.length === 0) {
      this.#done = true;
      this.#waiting?.resolve({ done: true, value: undefined });
      this.#waiting = undefined;
    }
  }

  fail(error: Error): void {
    if (this.#done || this.#terminalError) return;
    this.#terminalError = error;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#waiting?.reject(error);
    this.#waiting = undefined;
  }

  #offer(frame: SubscriptionFrame): void {
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting.resolve({ done: false, value: frame });
      return;
    }
    const encodedBytes = encodeProtocolMessage(frame).byteLength;
    if (
      this.#queue.length >= MAX_CLIENT_QUEUED_FRAMES ||
      this.#queuedBytes + encodedBytes > MAX_CLIENT_QUEUED_BYTES
    ) {
      throw new RuntimeHostSubscriptionError(
        'slow_consumer',
        'Session subscription consumer exceeded its local queue bound',
      );
    }
    this.#queue.push({ frame, encodedBytes });
    this.#queuedBytes += encodedBytes;
  }
}

function decodeTranscriptFragments(
  fragments: readonly SessionTranscriptFragment[],
  source: 'durable' | 'overlay',
): Array<{ identity: number; value: unknown }> {
  const messages = new Map<number, { totalBytes: number; fragments: Map<number, Buffer> }>();
  for (const fragment of fragments) {
    if (fragment.kind !== source) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript fragment source changed',
      );
    }
    const identity = fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex;
    const existing = messages.get(identity) ?? {
      totalBytes: fragment.totalBytes,
      fragments: new Map<number, Buffer>(),
    };
    const bytes = Buffer.from(fragment.data, 'base64');
    const duplicate = existing.fragments.get(fragment.byteOffset);
    if (
      existing.totalBytes !== fragment.totalBytes ||
      (duplicate !== undefined && !duplicate.equals(bytes))
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript fragment identity changed',
      );
    }
    if (duplicate === undefined) existing.fragments.set(fragment.byteOffset, bytes);
    messages.set(identity, existing);
  }
  return [...messages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([identity, message]) => {
      const ordered = [...message.fragments.entries()].sort(([left], [right]) => left - right);
      let expectedOffset = 0;
      const chunks: Buffer[] = [];
      for (const [offset, chunk] of ordered) {
        if (offset !== expectedOffset) {
          throw new RuntimeHostSubscriptionError(
            'correlation_changed',
            'Session transcript message has a fragment gap',
          );
        }
        chunks.push(chunk);
        expectedOffset += chunk.byteLength;
      }
      if (expectedOffset !== message.totalBytes) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript message ended before every fragment arrived',
        );
      }
      try {
        return {
          identity,
          value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        };
      } catch (cause) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          `Session transcript message is invalid JSON: ${errorMessage(cause)}`,
        );
      }
    });
}

function assertCompleteIdentities(
  messages: readonly { identity: number }[],
  throughIdentity: number | null,
): void {
  if (throughIdentity === null) {
    if (messages.length !== 0) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript contains messages without a watermark',
      );
    }
    return;
  }
  if (
    messages.length !== throughIdentity + 1 ||
    messages.some((message, index) => message.identity !== index)
  ) {
    throw new RuntimeHostSubscriptionError(
      'correlation_changed',
      'Session transcript has a message sequence gap',
    );
  }
}

function messageIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}
