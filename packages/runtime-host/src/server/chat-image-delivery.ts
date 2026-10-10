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
import { ImageFileReadError } from '@maka/runtime/image-file-reader';
import type { CompleteEvent, TextCompleteEvent, TextDeltaEvent } from '@maka/core/events';
import {
  IMAGE_MARKDOWN_MAX_LENGTH,
  isRemoteImageSource,
  type ImageArchiveLimits,
  type ImageDeliveryRequest,
  type ImageDeliveryResult,
  type ImageDeliveryFailure,
  type ImageDeliveryIdentity,
  type ImageDeliveryAttempt,
} from '@maka/core/image-delivery';
import {
  ImageArchiveQuotaError,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import { chatImageSources } from './chat-image-markdown.js';
import { readyChatImageArtifact } from './chat-image-artifact.js';
import { abortable } from '../client/wait-for-ready.js';
import {
  downloadChatImage,
  decodedLocalImagePath,
  ImageSourceError,
  localImagePath,
  type ChatImageBytes,
} from './chat-image-source.js';

type DeliveryIdentity = ImageDeliveryIdentity & ImageDeliveryRequest;
interface DeliveryJob {
  readonly done: Promise<void>;
  run(): Promise<void>;
  cancel(): void;
}
export interface ChatImageDeliveryPorts {
  readonly artifacts: Pick<
    InteractiveArtifactStoreWriter,
    'create' | 'findImageDelivery' | 'setImageDeliveryAttempt'
  >;
  readonly admission: SessionAdmissionGate;
  isPresent(sessionId: string): Promise<boolean>;
  readMessage(identity: DeliveryIdentity): Promise<string | undefined>;
  readLocalImage(sessionId: string, path: string, signal: AbortSignal): Promise<ChatImageBytes>;
  canLoadRemote(sessionId: string): Promise<boolean>;
  acquireResidency(): { release(): void };
  persistenceFailed(error: unknown): void;
  presentationFailed(error: unknown): void;
  readonly sourceReadTimeoutMs?: number;
  readonly limits?: ImageArchiveLimits;
  readonly download?: typeof downloadChatImage;
}
/** Host owns capture and persistence; clients can only resolve sources already in an assistant message. */
export class ChatImageDeliveryService {
  readonly #jobs = new Map<string, DeliveryJob>();
  readonly #queue: DeliveryJob[] = [];
  readonly #abort = new AbortController();
  #running = 0;
  #closed = false;
  constructor(private readonly ports: ChatImageDeliveryPorts) {}

  observe(sessionId: string, event: TextDeltaEvent | TextCompleteEvent | CompleteEvent): void {
    if (
      this.#closed ||
      event.type !== 'text_complete' ||
      event.text.length > IMAGE_MARKDOWN_MAX_LENGTH
    )
      return;
    // Reference destinations can grow during streaming. Only settled text
    // grants local capture. Remote media loads only when a client displays it.
    try {
      for (const source of chatImageSources(event.text)) {
        if (isRemoteImageSource(source)) continue;
        this.#enqueue({ sessionId, turnId: event.turnId, messageId: event.messageId, source });
      }
    } catch (error) {
      this.ports.presentationFailed(error);
    }
  }

  async resolve(identity: DeliveryIdentity): Promise<ImageDeliveryResult> {
    if (this.#closed) return { status: 'unavailable' };
    const metadata = await this.ports.artifacts.findImageDelivery(
      identity.sessionId,
      identity.turnId,
      identity.messageId,
      identity.source,
    );
    // A browser decode/read failure is not authority to destroy saved history.
    if (metadata?.status === 'ready') return metadata;
    if (this.#jobs.has(deliveryKey(identity))) return { status: 'pending' };
    if (metadata?.status === 'failed' && !identity.retry) return metadata;
    // A client-provided path is never a read grant. Legacy/restarted deliveries
    // must be found in canonical assistant text before any source is opened.
    if (!metadata) {
      const text = await this.ports.readMessage(identity);
      if (text === undefined || !chatImageSources(text).includes(identity.source))
        return { status: 'unavailable' };
    }
    if (isRemoteImageSource(identity.source)) {
      if (!(await this.ports.canLoadRemote(identity.sessionId)))
        return { status: 'failed', reason: 'not_allowed' };
      if (!identity.loadRemote) return { status: 'requires_confirmation' };
    }
    return this.#enqueue(identity)
      ? { status: 'pending' }
      : { status: 'failed', reason: 'queue_full' };
  }

  #enqueue(identity: DeliveryIdentity): boolean {
    const key = deliveryKey(identity);
    if (this.#jobs.has(key)) return true;
    if (this.#closed || this.#jobs.size >= 128) return false;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const residency = this.ports.acquireResidency();
    const finish = () => {
      this.#jobs.delete(key);
      residency.release();
      settle();
    };
    const job: DeliveryJob = {
      done,
      cancel: finish,
      run: async () => {
        try {
          await this.#capture(identity);
        } catch (error) {
          if (!this.#abort.signal.aborted) {
            if (error instanceof ImagePersistenceError) this.ports.persistenceFailed(error.cause);
            else this.ports.presentationFailed(error);
          }
        } finally {
          finish();
        }
      },
    };
    this.#jobs.set(key, job);
    this.#queue.push(job);
    this.#pump();
    return true;
  }
  #pump(): void {
    while (!this.#closed && this.#running < 2 && this.#queue.length) {
      const job = this.#queue.shift()!;
      this.#running++;
      void job.run().finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }
  async #capture(identity: DeliveryIdentity): Promise<void> {
    const { sessionId, turnId, messageId, source } = identity;
    const existing = await this.ports.artifacts.findImageDelivery(
      sessionId,
      turnId,
      messageId,
      source,
    );
    if (existing?.status === 'ready' || (existing?.status === 'failed' && !identity.retry)) return;
    const metadata = { messageId, source };
    const resultId = `chat_image_result_${deliveryKey(identity)}`;
    const publish = async (write: () => Promise<unknown>) =>
      this.ports.admission.runOrJoin(sessionId, async () => {
        if (this.#abort.signal.aborted || !(await this.ports.isPresent(sessionId))) return;
        try {
          await write();
        } catch (error) {
          if (error instanceof ImageArchiveQuotaError) throw error;
          throw new ImagePersistenceError('Image persistence failed', { cause: error });
        }
      });
    const publishAttempt = (attempt: ImageDeliveryAttempt) =>
      publish(() => this.ports.artifacts.setImageDeliveryAttempt(identity, attempt));
    const publishFailure = (reason: ImageDeliveryFailure) =>
      publishAttempt({ status: 'failed', reason });
    await publishAttempt({ status: 'pending' });
    if (this.#abort.signal.aborted || !(await this.ports.isPresent(sessionId))) return;
    const readAbort = new AbortController();
    // Keep the read deadline alive even when a source has no active handles.
    const deadline = setTimeout(() => readAbort.abort(), this.ports.sourceReadTimeoutMs ?? 10_000);
    const signal = AbortSignal.any([this.#abort.signal, readAbort.signal]);
    let image: ChatImageBytes;
    try {
      const path = localImagePath(source);
      if (path !== undefined) {
        try {
          image = await abortable(() => this.ports.readLocalImage(sessionId, path, signal), signal);
        } catch (error) {
          // Keep readable literal percent filenames authoritative. An encoded cwd
          // can look outside the workspace before decoding, so both missing and
          // denied candidates get one retry through the same Read boundary/budget.
          const decoded = decodedLocalImagePath(source);
          if (
            signal.aborted ||
            !['not_found', 'not_allowed'].includes(failureReason(error, source)) ||
            decoded === undefined
          )
            throw error;
          image = await abortable(
            () => this.ports.readLocalImage(sessionId, decoded, signal),
            signal,
          );
        }
      } else {
        if (!identity.loadRemote || !(await this.ports.canLoadRemote(sessionId)))
          throw new ImageSourceError('not_allowed');
        image = await (this.ports.download ?? downloadChatImage)(source, signal);
      }
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      await publishFailure(failureReason(error, source));
      return;
    } finally {
      clearTimeout(deadline);
    }
    if (this.#abort.signal.aborted) return;
    if (signal.aborted) {
      await publishFailure(failureReason(signal.reason, source));
      return;
    }
    try {
      await publish(() =>
        this.ports.artifacts.create(
          readyChatImageArtifact({
            id: resultId,
            sessionId,
            turnId,
            name: 'chat-image',
            ...metadata,
            image,
            limits: this.ports.limits,
          }),
        ),
      );
    } catch (error) {
      if (!(error instanceof ImageArchiveQuotaError)) throw error;
      await publishFailure('quota_exceeded');
    }
  }
  beginDrain(): void {
    this.#closed = true;
    this.#abort.abort();
    for (const job of this.#queue.splice(0)) job.cancel();
  }
  async close(): Promise<void> {
    this.beginDrain();
    await this.waitForIdle();
  }
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }
}
class ImagePersistenceError extends Error {}
function deliveryKey(i: DeliveryIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([i.sessionId, i.turnId, i.messageId, i.source]))
    .digest('hex');
}
function failureReason(error: unknown, source: string): ImageDeliveryFailure {
  if (error instanceof ImageSourceError) return error.reason;
  if (error instanceof ImageFileReadError) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'not_allowed';
  return isRemoteImageSource(source) ? 'download_failed' : 'read_failed';
}
