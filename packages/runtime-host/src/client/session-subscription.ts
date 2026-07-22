import {
  encodeProtocolFrame,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
  type SubscriptionOpenResult,
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

export interface RuntimeHostSessionSubscription extends AsyncIterable<SubscriptionFrame> {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
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
  readonly #requestClose: () => Promise<void>;
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

  constructor(result: SubscriptionOpenResult, requestClose: () => Promise<void>) {
    this.hostEpoch = result.hostEpoch;
    this.subscriptionId = result.subscriptionId;
    this.snapshot = result.snapshot;
    this.#expectedSessionId = result.snapshot.session.sessionId;
    this.#expectedSequence = result.nextSequence;
    this.#latestProjectionRevision = result.snapshot.projectionRevision;
    this.#requestClose = requestClose;
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
        frame.kind === 'subscription.session_event') &&
      frame.sessionId !== this.#expectedSessionId
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session subscription frame identity changed',
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
    const encodedBytes = encodeProtocolFrame(frame).byteLength;
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
