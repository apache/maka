import {
  encodeProtocolMessage,
  type SessionAssistantStreamIdentity,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
  type SubscriptionOpenResult,
  type SessionTranscriptQueryInput,
  type SessionTranscriptQueryResult,
} from '../protocol/index.js';

const MAX_CLIENT_QUEUED_FRAMES = 32;
const MAX_CLIENT_QUEUED_BYTES = 256 * 1024;

export type RuntimeHostSubscriptionFailureReason =
  | 'sequence_gap'
  | 'host_epoch_changed'
  | 'correlation_changed'
  | 'projection_revision_invalid'
  | 'slow_consumer'
  | 'connection_closed'
  | 'transcript_expired';

export class RuntimeHostSubscriptionError extends Error {
  constructor(
    readonly reason: RuntimeHostSubscriptionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostSubscriptionError';
  }
}

function bufferLength(chunks: readonly Buffer[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RuntimeHostSessionSubscription extends AsyncIterable<SubscriptionFrame> {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]>;
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
  readonly #requestClose: () => Promise<void>;
  readonly #queryTranscript: (
    input: SessionTranscriptQueryInput,
  ) => Promise<SessionTranscriptQueryResult>;
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
  #closeTask: Promise<void> | undefined;
  #transcriptTask: Promise<unknown[]> | undefined;

  constructor(
    result: SubscriptionOpenResult,
    requestClose: () => Promise<void>,
    queryTranscript: (input: SessionTranscriptQueryInput) => Promise<SessionTranscriptQueryResult>,
  ) {
    this.hostEpoch = result.hostEpoch;
    this.subscriptionId = result.subscriptionId;
    this.snapshot = result.snapshot;
    this.activeAssistantStreams = result.activeAssistantStreams;
    this.#expectedSessionId = result.snapshot.session.sessionId;
    this.#expectedSequence = result.nextSequence;
    this.#latestProjectionRevision = result.snapshot.projectionRevision;
    this.#requestClose = requestClose;
    this.#queryTranscript = queryTranscript;
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

  async #loadTranscript(): Promise<unknown[]> {
    let result = await this.#queryTranscript({
      kind: 'start',
      subscriptionId: this.subscriptionId,
    });
    let snapshotId: string | undefined;
    let messageCount: number | undefined;
    let chunks: Buffer[] = [];
    const messages: unknown[] = [];
    while (true) {
      if (result.kind === 'snapshot_expired') {
        throw new RuntimeHostSubscriptionError(
          'transcript_expired',
          'Session transcript snapshot expired before it was consumed',
        );
      }
      if (result.sessionId !== this.#expectedSessionId) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript belongs to a different Session',
        );
      }
      snapshotId ??= result.snapshotId;
      messageCount ??= result.messageCount;
      if (result.snapshotId !== snapshotId || result.messageCount !== messageCount) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript snapshot identity changed',
        );
      }
      if (result.messageCount === 0) return [];
      if (result.messageIndex !== messages.length || result.byteOffset !== bufferLength(chunks)) {
        throw new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript chunk position changed',
        );
      }
      chunks.push(Buffer.from(result.data, 'base64'));
      if (result.next?.messageIndex !== result.messageIndex) {
        const bytes = Buffer.concat(chunks);
        let decoded: unknown;
        try {
          decoded = JSON.parse(bytes.toString('utf8')) as unknown;
        } catch (cause) {
          throw new RuntimeHostSubscriptionError(
            'correlation_changed',
            `Session transcript message is invalid JSON: ${errorMessage(cause)}`,
          );
        }
        messages.push(decoded);
        chunks = [];
      }
      if (!result.next) {
        if (messages.length !== messageCount) {
          throw new RuntimeHostSubscriptionError(
            'correlation_changed',
            'Session transcript ended before every message was received',
          );
        }
        return messages;
      }
      result = await this.#queryTranscript({
        kind: 'continue',
        subscriptionId: this.subscriptionId,
        snapshotId,
        ...result.next,
      });
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
