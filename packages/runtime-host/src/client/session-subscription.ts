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

import { createHash } from 'node:crypto';
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
  | 'transcript_release_failed'
  | 'connection_closed';

export class RuntimeHostSubscriptionError extends Error {
  constructor(
    readonly reason: RuntimeHostSubscriptionFailureReason,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
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
  loadTranscriptOverlay<T>(
    decodeMessage: (value: unknown) => T,
    maxMessageBytes?: number,
    accountAssemblyBytes?: (deltaBytes: number) => void,
  ): Promise<T[]>;
  decodeTranscriptPage<T>(
    page: SessionTranscriptPage,
    decodeMessage: (value: unknown) => T,
    maxMessageBytes?: number,
    accountAssemblyBytes?: (deltaBytes: number) => void,
  ): Promise<DecodedSessionTranscriptPage<T>>;
  loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
  ): Promise<SessionTranscriptPage>;
  close(): Promise<void>;
}

export interface DecodedSessionTranscriptPage<T> {
  readonly messages: readonly {
    readonly identity: number;
    readonly message: T;
  }[];
  readonly nextCursor: string | null;
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
  readonly #releaseTranscriptOverlay: () => Promise<void>;
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
  #overlayTask: Promise<Array<{ identity: number; value: unknown }>> | undefined;
  #overlayConsumed = false;
  #latestTranscriptThroughSequence: number | null;

  constructor(
    result: SubscriptionOpenResult,
    requestClose: () => Promise<void>,
    readTranscriptPage: (input: SessionTranscriptPageInput) => Promise<SessionTranscriptPage>,
    releaseTranscriptOverlay: () => Promise<void> = async () => undefined,
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
    this.#releaseTranscriptOverlay = releaseTranscriptOverlay;
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

  loadTranscriptOverlay<T>(
    decodeMessage: (value: unknown) => T,
    maxMessageBytes = Number.MAX_SAFE_INTEGER,
    accountAssemblyBytes: (deltaBytes: number) => void = () => undefined,
  ): Promise<T[]> {
    this.#assertTranscriptReadable();
    const bootstrap = this.transcriptBootstrap;
    if (!bootstrap) {
      return Promise.reject(
        new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session subscription was opened without transcript access',
        ),
      );
    }
    return this.#consumeTranscriptOverlay(bootstrap, maxMessageBytes, accountAssemblyBytes).then(
      (messages) => messages.map((entry) => decodeMessage(entry.value)),
    );
  }

  async decodeTranscriptPage<T>(
    page: SessionTranscriptPage,
    decodeMessage: (value: unknown) => T,
    maxMessageBytes = Number.MAX_SAFE_INTEGER,
    accountAssemblyBytes: (deltaBytes: number) => void = () => undefined,
  ): Promise<DecodedSessionTranscriptPage<T>> {
    this.#assertTranscriptReadable();
    this.#assertTranscriptPage(page, {
      source: page.source,
      direction: page.direction,
      throughSequence: page.throughSequence,
      maxBytes: Math.max(1, page.rawBytes),
    });
    const assembler = new TranscriptFragmentAssembler(
      page.source,
      page.direction,
      maxMessageBytes,
      accountAssemblyBytes,
    );
    try {
      assembler.accept(page.fragments);
      let cursor = page.nextCursor;
      while (assembler.continuationBytes !== null) {
        if (cursor === null) {
          throw new RuntimeHostSubscriptionError(
            'correlation_changed',
            'Session transcript message ended before every fragment arrived',
          );
        }
        const requestedCursor = cursor;
        const continuation = await this.loadTranscriptPage({
          source: page.source,
          direction: page.direction,
          throughSequence: page.throughSequence,
          cursor,
          anchorSequence: null,
          maxBytes: Math.min(SESSION_TRANSCRIPT_PAGE_MAX_BYTES, assembler.continuationBytes),
        });
        if (continuation.nextCursor === requestedCursor) {
          throw new RuntimeHostSubscriptionError(
            'correlation_changed',
            'Session transcript cursor did not advance',
          );
        }
        assembler.accept(continuation.fragments);
        cursor = continuation.nextCursor;
      }
      return {
        messages: assembler.finish().map((entry) => ({
          identity: entry.identity,
          message: decodeMessage(entry.value),
        })),
        nextCursor: cursor,
      };
    } finally {
      assembler.release();
    }
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
    return this.#readTranscriptPage({
      subscriptionId: this.subscriptionId,
      ...input,
    }).then((page) => {
      this.#assertTranscriptReadable();
      this.#assertTranscriptPage(page, input);
      return page;
    });
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
    const overlay = await this.#consumeTranscriptOverlay(bootstrap);
    const durable = await this.#loadTranscriptSource(bootstrap.durable);
    assertCompleteIdentities(durable, bootstrap.throughSequence);
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

  #consumeTranscriptOverlay(
    bootstrap: SessionTranscriptBootstrap,
    maxMessageBytes = Number.MAX_SAFE_INTEGER,
    accountAssemblyBytes: (deltaBytes: number) => void = () => undefined,
  ): Promise<Array<{ identity: number; value: unknown }>> {
    if (this.#overlayConsumed && !this.#overlayTask) {
      return Promise.reject(
        new RuntimeHostSubscriptionError(
          'correlation_changed',
          'Session transcript overlay was already consumed',
        ),
      );
    }
    this.#overlayTask ??= (async () => {
      const overlay = await this.#loadTranscriptSource(
        bootstrap.overlay,
        maxMessageBytes,
        accountAssemblyBytes,
      );
      assertCompleteIdentities(
        overlay,
        bootstrap.overlayMessageCount === 0 ? null : bootstrap.overlayMessageCount - 1,
      );
      if (bootstrap.overlayMessageCount === 0) {
        this.#overlayConsumed = true;
        return overlay;
      }
      try {
        await this.#releaseTranscriptOverlay();
      } catch (cause) {
        await this.close().catch(() => undefined);
        throw new RuntimeHostSubscriptionError(
          'transcript_release_failed',
          'Runtime Host Session transcript overlay release was not confirmed',
          { cause },
        );
      }
      this.#overlayConsumed = true;
      return overlay;
    })();
    const task = this.#overlayTask;
    return task.finally(() => {
      if (this.#overlayTask === task) this.#overlayTask = undefined;
    });
  }

  async #loadTranscriptSource(
    initial: SessionTranscriptPage,
    maxMessageBytes = Number.MAX_SAFE_INTEGER,
    accountAssemblyBytes: (deltaBytes: number) => void = () => undefined,
  ): Promise<Array<{ identity: number; value: unknown }>> {
    this.#assertTranscriptPage(initial, {
      source: initial.source,
      direction: initial.direction,
      throughSequence: initial.throughSequence,
      maxBytes: Math.max(1, initial.rawBytes),
    });
    const assembler = new TranscriptFragmentAssembler(
      initial.source,
      initial.direction,
      maxMessageBytes,
      accountAssemblyBytes,
    );
    try {
      assembler.accept(initial.fragments);
      let cursor = initial.nextCursor;
      while (cursor !== null) {
        const page = await this.loadTranscriptPage({
          source: initial.source,
          direction: initial.direction,
          throughSequence: initial.throughSequence,
          cursor,
          anchorSequence: null,
          maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
        });
        if (page.nextCursor === cursor) {
          throw new RuntimeHostSubscriptionError(
            'correlation_changed',
            'Session transcript cursor did not advance',
          );
        }
        assembler.accept(page.fragments);
        cursor = page.nextCursor;
      }
      return assembler.finish();
    } finally {
      assembler.release();
    }
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

class TranscriptFragmentAssembler {
  readonly #messages: Array<{ identity: number; value: unknown }> = [];
  #assemblyBytes = 0;
  #current:
    | {
        identity: number;
        totalBytes: number;
        payloadDigest: `sha256:${string}` | null;
        data: Buffer;
        edge: number;
      }
    | undefined;
  #lastStartedIdentity: number | undefined;

  constructor(
    private readonly source: 'durable' | 'overlay',
    private readonly direction: 'older' | 'newer',
    private readonly maxMessageBytes = Number.MAX_SAFE_INTEGER,
    private readonly accountAssemblyBytes: (deltaBytes: number) => void = () => undefined,
  ) {}

  accept(fragments: readonly SessionTranscriptFragment[]): void {
    for (const fragment of fragments) this.#accept(fragment);
  }

  get continuationBytes(): number | null {
    const current = this.#current;
    if (!current) return null;
    return this.direction === 'older' ? current.edge : current.totalBytes - current.edge;
  }

  finish(): Array<{ identity: number; value: unknown }> {
    if (this.#current) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript message ended before every fragment arrived',
      );
    }
    if (this.direction === 'older') this.#messages.reverse();
    return this.#messages;
  }

  release(): void {
    if (this.#assemblyBytes === 0) return;
    this.accountAssemblyBytes(-this.#assemblyBytes);
    this.#assemblyBytes = 0;
  }

  #accept(fragment: SessionTranscriptFragment): void {
    if (fragment.kind !== this.source) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript fragment source changed',
      );
    }
    const identity = fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex;
    const bytes = Buffer.from(fragment.data, 'base64');
    const payloadDigest = fragment.kind === 'durable' ? fragment.payloadDigest : null;
    if (!this.#current) this.#start(identity, fragment.totalBytes, payloadDigest);
    if (
      this.#current?.identity !== identity ||
      this.#current.totalBytes !== fragment.totalBytes ||
      this.#current.payloadDigest !== payloadDigest
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript message identity changed between fragments',
      );
    }
    const expectedOffset =
      this.direction === 'older' ? this.#current.edge - bytes.byteLength : this.#current.edge;
    if (fragment.byteOffset !== expectedOffset) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript message has a fragment gap',
      );
    }
    if (fragment.byteOffset + bytes.byteLength > this.#current.totalBytes) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript fragment exceeds its declared message size',
      );
    }
    bytes.copy(this.#current.data, fragment.byteOffset);
    this.#current.edge =
      this.direction === 'older' ? fragment.byteOffset : fragment.byteOffset + bytes.byteLength;
    if (
      (this.direction === 'older' && this.#current.edge === 0) ||
      (this.direction === 'newer' && this.#current.edge === fragment.totalBytes)
    ) {
      this.#completeCurrent();
    }
  }

  #start(identity: number, totalBytes: number, payloadDigest: `sha256:${string}` | null): void {
    if (totalBytes > this.maxMessageBytes) {
      throw new RangeError('Session transcript message exceeds the local byte limit');
    }
    if (
      this.#lastStartedIdentity !== undefined &&
      (this.direction === 'older'
        ? identity >= this.#lastStartedIdentity
        : identity <= this.#lastStartedIdentity)
    ) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        'Session transcript message order changed between pages',
      );
    }
    this.#lastStartedIdentity = identity;
    this.accountAssemblyBytes(totalBytes);
    try {
      this.#current = {
        identity,
        totalBytes,
        payloadDigest,
        data: Buffer.allocUnsafe(totalBytes),
        edge: this.direction === 'older' ? totalBytes : 0,
      };
      this.#assemblyBytes += totalBytes;
    } catch (error) {
      this.accountAssemblyBytes(-totalBytes);
      throw error;
    }
  }

  #completeCurrent(): void {
    const current = this.#current!;
    try {
      if (
        current.payloadDigest !== null &&
        `sha256:${createHash('sha256').update(current.data).digest('hex')}` !==
          current.payloadDigest
      ) {
        throw new Error('payload digest mismatch');
      }
      this.#messages.push({
        identity: current.identity,
        value: JSON.parse(current.data.toString('utf8')) as unknown,
      });
    } catch (cause) {
      throw new RuntimeHostSubscriptionError(
        'correlation_changed',
        `Session transcript message failed integrity validation: ${errorMessage(cause)}`,
      );
    }
    this.#current = undefined;
  }
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
