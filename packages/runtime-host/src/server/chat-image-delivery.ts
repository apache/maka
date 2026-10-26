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

import {
  isSessionMediaInput,
  type SessionMediaInput,
  type SessionContentPart,
} from '@maka/core/session-media';
import { redactSecrets } from '@maka/core/redaction';
import { checkedChatImage } from './chat-image-source.js';
import { createHash, randomUUID } from 'node:crypto';
import { ImageFileReadError } from '@maka/runtime/image-file-reader';
import type { TextCompleteEvent } from '@maka/core/events';
import {
  IMAGE_MARKDOWN_MAX_LENGTH,
  isRemoteImageSource,
  type ImageArchiveLimits,
  type ImageDeliveryRequest,
  type ImageDeliveryResult,
  type ImageDeliveryFailure,
  type ImageDeliveryIdentity,
} from '@maka/core/image-delivery';
import {
  ImageArchiveQuotaError,
  ImageDeliveryCapacityError,
  type ImageDeliveryJob,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import { chatImageSources } from './chat-image-markdown.js';
import { readyChatImageArtifact } from './chat-image-artifact.js';
import { abortable } from '../client/wait-for-ready.js';
import {
  downloadChatImage,
  ImageSourceError,
  localImagePath,
  type ChatImageBytes,
} from './chat-image-source.js';

type DeliveryIdentity = ImageDeliveryIdentity &
  ImageDeliveryRequest & {
    /** Mutable sources are captured separately for each executor publication. */
    readonly publicationId?: string;
    readonly publicationRunId?: string;
  };
interface DeliveryJob {
  readonly done: Promise<ImageDeliveryResult | undefined>;
  run(): Promise<void>;
  cancel(): void;
}
export interface ChatImageDeliveryPorts {
  readonly artifacts: Pick<
    InteractiveArtifactStoreWriter,
    | 'create'
    | 'findImageDelivery'
    | 'setImageDeliveryAttempt'
    | 'getInSession'
    | 'putImageDeliveryJob'
    | 'readImageDeliveryJob'
    | 'listImageDeliveryJobs'
    | 'deleteImageDeliveryJob'
  >;
  readonly admission: SessionAdmissionGate;
  isPresent(sessionId: string): Promise<boolean>;
  readMessage(identity: DeliveryIdentity): Promise<string | undefined>;
  /** Uses the Session read boundary and normalizes failures to ImageFileReadError. */
  readLocalImage(sessionId: string, path: string, signal: AbortSignal): Promise<ChatImageBytes>;
  canLoadRemote(sessionId: string): Promise<boolean>;
  acquireResidency(): { release(): void };
  persistenceFailed(error: unknown): void;
  presentationFailed(error: unknown): void;
  readonly sourceReadTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly limits?: ImageArchiveLimits;
  readonly download?: typeof downloadChatImage;
}
/** Host owns capture and persistence; clients can only resolve sources already in an assistant message. */
export class ChatImageDeliveryService {
  readonly #jobs = new Map<string, DeliveryJob>();
  readonly #queue: DeliveryJob[] = [];
  readonly #abort = new AbortController();
  #running = 0;
  #inlineBytes = 0;
  #closed = false;
  #recoveryTimer?: ReturnType<typeof setInterval>;
  #recovering?: Promise<void>;
  readonly #submissions = new Map<string, Promise<boolean>>();
  constructor(private readonly ports: ChatImageDeliveryPorts) {}

  /** Startup barrier: recover received bytes without waiting on source I/O. */
  async recoverReceived(): Promise<void> {
    for (const job of await this.ports.artifacts.listImageDeliveryJobs(Number.MAX_SAFE_INTEGER)) {
      if (this.#closed) return;
      if (!(await this.ports.isPresent(job.sessionId))) {
        await this.ports.artifacts.deleteImageDeliveryJob(job.id);
        continue;
      }
      if ((await this.ports.artifacts.readImageDeliveryJob(job.id))?.bytes)
        await this.#capture(job);
    }
  }

  /** Recovery is Host-owned and does not depend on mounting a transcript. */
  async start(): Promise<void> {
    if (this.#closed || this.#recoveryTimer) return;
    await this.#recover();
    if (this.#closed) return;
    this.#recoveryTimer = setInterval(() => {
      void this.#recover();
    }, 1000);
    this.#recoveryTimer.unref();
  }
  #recover(): Promise<void> {
    if (this.#recovering) return this.#recovering;
    this.#recovering = (async () => {
      try {
        for (const job of await this.ports.artifacts.listImageDeliveryJobs(Date.now())) {
          if (this.#closed) break;
          if (!(await this.ports.isPresent(job.sessionId))) {
            await this.ports.artifacts.deleteImageDeliveryJob(job.id);
            continue;
          }
          this.#schedule(job);
        }
      } catch (error) {
        if (!this.#closed) this.ports.persistenceFailed(error);
      }
    })().finally(() => {
      this.#recovering = undefined;
    });
    return this.#recovering;
  }

  /** Executor publication is Host-scoped; it never grants arbitrary client reads. */
  async publish(
    owner: { sessionId: string; turnId: string; messageId: string; runId?: string },
    input: SessionMediaInput,
  ): Promise<SessionContentPart> {
    if (!isSessionMediaInput(input))
      return { kind: 'text', text: '[Media unavailable: invalid input]' };
    const source =
      input.kind === 'source'
        ? input.source
        : `inline:base64-sha256:${createHash('sha256').update(input.base64, 'ascii').digest('hex')}`;
    const identity: DeliveryIdentity = {
      ...owner,
      ...(owner.runId ? { publicationRunId: owner.runId } : {}),
      source,
      loadRemote: true,
      ...(input.kind === 'source' ? { publicationId: randomUUID() } : {}),
    };
    let saved =
      input.kind === 'inline'
        ? await this.ports.artifacts.findImageDelivery(
            owner.sessionId,
            owner.turnId,
            owner.messageId,
            source,
          )
        : undefined;
    if (saved?.status !== 'ready') {
      // Reserve queue capacity before decoding, including concurrent publishers waiting on metadata.
      if (
        !this.#jobs.has(deliveryKey(identity)) &&
        input.kind === 'inline' &&
        this.#inlineBytes +
          (input.base64.length * 3) / 4 -
          (input.base64.endsWith('==') ? 2 : input.base64.endsWith('=') ? 1 : 0) >
          8 * 1024 * 1024
      )
        return { kind: 'text', text: '[Media unavailable: queue full]' };
      const bytes =
        !this.#jobs.has(deliveryKey(identity)) && input.kind === 'inline'
          ? Buffer.from(input.base64, 'base64')
          : undefined;
      if (
        bytes &&
        bytes.toString('base64') !==
          (input as Extract<SessionMediaInput, { kind: 'inline' }>).base64
      )
        return { kind: 'text', text: '[Media unavailable: invalid encoding]' };
      if (!(await this.#enqueue(identity, bytes)))
        return { kind: 'text', text: '[Media unavailable: queue full]' };
      saved = await this.#waitForDelivery(identity);
    }
    if (saved?.status !== 'ready')
      return {
        kind: 'text',
        text: `[Media unavailable: ${saved?.status === 'failed' ? saved.reason : 'not saved'}]`,
      };
    const { record } = await this.ports.artifacts.getInSession(owner.sessionId, saved.artifactId);
    if (!record?.mimeType) return { kind: 'text', text: '[Media unavailable: missing artifact]' };
    return {
      kind: 'image',
      mimeType: record.mimeType,
      ref: { kind: 'session_file', sessionId: owner.sessionId, relativePath: saved.artifactId },
    };
  }

  async observe(sessionId: string, event: TextCompleteEvent): Promise<void> {
    if (this.#closed || event.text.length > IMAGE_MARKDOWN_MAX_LENGTH) return;
    // Only settled canonical text grants source reads. Receiving authorized remote
    // media is independent of viewport rendering, which remains lazy.
    let sources: string[];
    try {
      sources = chatImageSources(event.text);
    } catch (error) {
      this.ports.presentationFailed(error);
      return;
    }
    for (const source of sources) {
      const remote = isRemoteImageSource(source);
      if (
        remote &&
        (source.includes('<redacted>') ||
          redactSecrets(source) !== source ||
          !(await this.ports.canLoadRemote(sessionId)))
      )
        continue;
      await this.#enqueue({
        sessionId,
        turnId: event.turnId,
        messageId: event.messageId,
        source,
        loadRemote: remote,
      });
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
    return (await this.#enqueue(identity))
      ? { status: 'pending' }
      : { status: 'failed', reason: 'queue_full' };
  }

  async #enqueue(identity: DeliveryIdentity, inline?: Uint8Array): Promise<boolean> {
    const key = deliveryKey(identity);
    if (this.#jobs.has(key)) return true;
    const pending = this.#submissions.get(key);
    if (pending) return pending;
    if (this.#closed || this.#inlineBytes + (inline?.byteLength ?? 0) > 8 * 1024 * 1024)
      return false;
    this.#inlineBytes += inline?.byteLength ?? 0;
    const submission = this.ports.admission
      .runOrJoin(identity.sessionId, async () => {
        if (this.#closed || !(await this.ports.isPresent(identity.sessionId))) return false;
        if (!identity.publicationId && !identity.retry) {
          const previous = await this.ports.artifacts.findImageDelivery(
            identity.sessionId,
            identity.turnId,
            identity.messageId,
            identity.source,
          );
          if (previous?.status === 'ready' || previous?.status === 'failed') return true;
        }
        const existing = await this.ports.artifacts.readImageDeliveryJob(key);
        if (existing?.job.failure && !identity.retry) return true;
        const job: ImageDeliveryJob = existing
          ? {
              ...existing.job,
              ...(identity.retry ? { attempts: 0, nextAttemptAt: 0, failure: undefined } : {}),
            }
          : {
              id: key,
              sessionId: identity.sessionId,
              turnId: identity.turnId,
              messageId: identity.messageId,
              source: identity.source,
              ...(identity.publicationRunId ? { publicationRunId: identity.publicationRunId } : {}),
              ...(identity.publicationId ? { publicationId: identity.publicationId } : {}),
              loadRemote: identity.loadRemote === true,
              attempts: 0,
              nextAttemptAt: 0,
            };
        await this.ports.artifacts.putImageDeliveryJob({
          job,
          ...(inline ? { bytes: inline } : {}),
        });
        this.#schedule(job);
        return true;
      })
      .catch(async (error) => {
        if (error instanceof ImageDeliveryCapacityError) {
          await this.ports.admission.runOrJoin(identity.sessionId, async () => {
            if (!this.#closed && (await this.ports.isPresent(identity.sessionId)))
              await this.ports.artifacts.setImageDeliveryAttempt(identity, {
                status: 'failed',
                reason: 'queue_full',
              });
          });
        } else if (!this.#closed) this.ports.persistenceFailed(error);
        return false;
      })
      .finally(() => {
        this.#inlineBytes -= inline?.byteLength ?? 0;
        this.#submissions.delete(key);
      });
    this.#submissions.set(key, submission);
    return submission;
  }

  #schedule(input: ImageDeliveryJob): void {
    const key = input.id;
    if (this.#closed || this.#jobs.has(key) || this.#jobs.size >= 128 || input.failure) return;
    let settle!: (result?: ImageDeliveryResult) => void;
    const done = new Promise<ImageDeliveryResult | undefined>((resolve) => {
      settle = resolve;
    });
    const residency = this.ports.acquireResidency();
    const finish = (result?: ImageDeliveryResult) => {
      this.#jobs.delete(key);
      residency.release();
      settle(result);
    };
    const job: DeliveryJob = {
      done,
      cancel: finish,
      run: async () => {
        let result: ImageDeliveryResult | undefined;
        try {
          result = await this.#capture(input);
        } catch (error) {
          if (!this.#closed) this.ports.persistenceFailed(error);
        } finally {
          finish(result);
        }
      },
    };
    this.#jobs.set(key, job);
    this.#queue.push(job);
    this.#pump();
  }

  async #waitForDelivery(identity: DeliveryIdentity): Promise<ImageDeliveryResult | undefined> {
    const key = deliveryKey(identity);
    while (!this.#closed) {
      const running = this.#jobs.get(key);
      if (running) return running.done;
      const staged = await this.ports.artifacts.readImageDeliveryJob(key);
      if (!staged) {
        const { record } = await this.ports.artifacts.getInSession(identity.sessionId, key);
        return record?.imageDelivery?.status === 'ready'
          ? { status: 'ready', artifactId: key }
          : await this.ports.artifacts.findImageDelivery(
              identity.sessionId,
              identity.turnId,
              identity.messageId,
              identity.source,
            );
      }
      if (staged.job.failure) return { status: 'failed', reason: staged.job.failure };
      this.#schedule(staged.job);
      if (!this.#jobs.has(key)) await this.#delay(50);
    }
    return undefined;
  }

  async #delay(ms: number): Promise<void> {
    if (this.#closed) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.#abort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#abort.signal.addEventListener('abort', finish, { once: true });
    });
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
  async #capture(initial: ImageDeliveryJob): Promise<ImageDeliveryResult | undefined> {
    let job = initial;
    const { sessionId, turnId, messageId, source } = job;
    const saved = await this.ports.artifacts.getInSession(sessionId, job.id);
    if (saved.record?.imageDelivery?.status === 'ready') {
      await this.ports.artifacts.deleteImageDeliveryJob(job.id);
      return { status: 'ready', artifactId: job.id };
    }
    const failed = async (reason: ImageDeliveryFailure): Promise<ImageDeliveryResult> => {
      await this.ports.admission.runOrJoin(sessionId, async () => {
        if (!this.#closed && (await this.ports.isPresent(sessionId)))
          await this.ports.artifacts.putImageDeliveryJob({ job: { ...job, failure: reason } });
      });
      return { status: 'failed', reason };
    };
    while (!this.#closed && (await this.ports.isPresent(sessionId))) {
      if (job.nextAttemptAt > Date.now()) await this.#delay(job.nextAttemptAt - Date.now());
      if (this.#closed) return;
      const staged = await this.ports.artifacts.readImageDeliveryJob(job.id);
      if (!staged) return;
      let image: ChatImageBytes;
      const readAbort = new AbortController();
      const deadline = setTimeout(
        () => readAbort.abort(),
        this.ports.sourceReadTimeoutMs ?? 10_000,
      );
      const signal = AbortSignal.any([this.#abort.signal, readAbort.signal]);
      try {
        if (staged.bytes) image = checkedChatImage(staged.bytes);
        else {
          if (job.attempts >= 3)
            return await failed(isRemoteImageSource(source) ? 'download_failed' : 'read_failed');
          job = { ...job, attempts: job.attempts + 1 };
          let accepted = false;
          await this.ports.admission.runOrJoin(sessionId, async () => {
            if (this.#closed || !(await this.ports.isPresent(sessionId))) return;
            await this.ports.artifacts.putImageDeliveryJob({ job });
            accepted = true;
          });
          if (!accepted) return;
          const path = localImagePath(source);
          if (path !== undefined)
            image = await abortable(
              () => this.ports.readLocalImage(sessionId, path, signal),
              signal,
            );
          else {
            if (!job.loadRemote || !(await this.ports.canLoadRemote(sessionId)))
              throw new ImageSourceError('not_allowed');
            image = await (this.ports.download ?? downloadChatImage)(source, signal);
          }
        }
      } catch (error) {
        if (this.#closed) return;
        const reason = failureReason(error, source);
        if (
          ['download_failed', 'read_failed'].includes(reason) &&
          job.attempts < 3 &&
          !staged.bytes
        ) {
          job = {
            ...job,
            nextAttemptAt:
              Date.now() + (this.ports.retryDelayMs ?? 500) * 2 ** Math.max(0, job.attempts - 1),
          };
          await this.ports.admission.runOrJoin(sessionId, async () => {
            if (!this.#closed && (await this.ports.isPresent(sessionId)))
              await this.ports.artifacts.putImageDeliveryJob({ job });
          });
          continue;
        }
        return await failed(reason);
      } finally {
        clearTimeout(deadline);
      }
      if (this.#closed) return;
      try {
        let committed = false;
        await this.ports.admission.runOrJoin(sessionId, async () => {
          if (this.#closed || !(await this.ports.isPresent(sessionId))) return;
          // Keep received bytes until publication commits. Restart never needs the
          // original temporary path or URL once this durable spool is written.
          await this.ports.artifacts.putImageDeliveryJob({ job, bytes: image.bytes });
          await this.ports.artifacts.create(
            readyChatImageArtifact({
              id: job.id,
              ...(job.publicationRunId ? { publicationRunId: job.publicationRunId } : {}),
              sessionId,
              turnId,
              messageId,
              source,
              name: 'chat-image',
              image,
              limits: this.ports.limits,
            }),
          );
          committed = true;
        });
        return committed ? { status: 'ready', artifactId: job.id } : undefined;
      } catch (error) {
        if (error instanceof ImageArchiveQuotaError) return failed('quota_exceeded');
        if (error instanceof ImageDeliveryCapacityError) return failed('queue_full');
        throw error;
      }
    }
    if (!this.#closed) await this.ports.artifacts.deleteImageDeliveryJob(job.id);
    return undefined;
  }
  beginDrain(): void {
    this.#closed = true;
    clearInterval(this.#recoveryTimer);
    this.#abort.abort();
    for (const job of this.#queue.splice(0)) job.cancel();
  }
  async close(): Promise<void> {
    this.beginDrain();
    await this.waitForIdle();
  }
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#submissions.values()]);
    await this.#recovering;
    await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }
}
function deliveryKey(i: DeliveryIdentity): string {
  return (
    'chat_image_result_' +
    createHash('sha256')
      .update(
        JSON.stringify([
          i.sessionId,
          i.turnId,
          i.messageId,
          i.source,
          ...(i.publicationId ? [i.publicationId] : []),
        ]),
      )
      .digest('hex')
  );
}
function failureReason(error: unknown, source: string): ImageDeliveryFailure {
  if (error instanceof ImageSourceError) return error.reason;
  if (error instanceof ImageFileReadError) return error.reason;
  return isRemoteImageSource(source) ? 'download_failed' : 'read_failed';
}
