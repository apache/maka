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

import { Worker } from 'node:worker_threads';
import type { RuntimeTranscriptRun } from '@maka/storage/execution-stores';
import type { RuntimeStorageCodec } from '@maka/storage/cold-runtime-storage';
import { RUNTIME_PAYLOAD_MAX_BYTES } from '@maka/storage/cold-runtime-storage';
import type { CanonicalPermissionOutcomeRecord } from '@maka/runtime/interaction-authority';
import type { createTranscriptProjection } from './session-transcript-reader.js';
import type { SessionTurnLandmark } from '../protocol/session-turns.js';
import { SESSION_TURN_LANDMARK_MAX_ITEMS } from '../protocol/session-turns.js';

export interface ProjectedTranscriptRun {
  run: RuntimeTranscriptRun;
  ordinals: [string, number][];
  projected: ReturnType<ReturnType<typeof createTranscriptProjection>['finishWithOutcomes']>;
}

export type TranscriptStorageJob = { id: number; cancel: Int32Array } & (
  | {
      kind: 'run';
      sessionId: string;
      request: { direction: 'older' | 'newer'; throughOrdinal: number; position: number };
    }
  | { kind: 'codec'; mode: 'encode' | 'decode'; values: readonly string[] }
  | { kind: 'recall'; sessionIds: readonly string[]; terms: readonly string[] }
  | {
      kind: 'landmarks';
      sessionId: string;
      request: { throughOrdinal: number; maxLandmarks: number; turnId: string | null };
    }
);
type Pending = {
  job: TranscriptStorageJob;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

/** One bounded worker queue: foreground scans precede queued physical maintenance. */
export class TranscriptStorageWorker {
  #worker?: Worker;
  #active?: Pending;
  #queue: Pending[] = [];
  #nextId = 0;
  #closed = false;
  #failure?: Error;
  #closeTask?: Promise<void>;
  readonly #pins = new Map<string, number>();

  constructor(
    private readonly input: {
      databasePath: string;
      permissions: (
        ids: readonly string[],
      ) => Promise<ReadonlyMap<string, CanonicalPermissionOutcomeRecord>>;
    },
  ) {}

  get reading(): boolean {
    return this.#pins.size > 0;
  }
  isProtected(sessionId: string): boolean {
    return this.#pins.has(sessionId);
  }

  /** Protect the complete frontend read, including Host-side authority I/O between scan jobs. */
  async withSessionRead<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#failure) throw this.#failure ?? new Error('Storage worker is closed');
    this.#pins.set(sessionId, (this.#pins.get(sessionId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      this.#releasePin(sessionId);
    }
  }

  readRun(
    sessionId: string,
    request: Extract<TranscriptStorageJob, { kind: 'run' }>['request'],
  ): Promise<ProjectedTranscriptRun | undefined> {
    return this.#enqueue({ kind: 'run', sessionId, request });
  }

  readonly codec: RuntimeStorageCodec = (mode, values) =>
    this.#enqueue({ kind: 'codec', mode, values });

  readLandmarks(
    sessionId: string,
    request: Extract<TranscriptStorageJob, { kind: 'landmarks' }>['request'],
  ): Promise<SessionTurnLandmark[]> {
    return this.#enqueue({ kind: 'landmarks', sessionId, request });
  }

  readRecallCandidates(sessionIds: readonly string[], terms: readonly string[]): Promise<string[]> {
    return this.#enqueue({ kind: 'recall', sessionIds, terms });
  }

  beginDrain(): void {
    this.#closed = true;
    if (this.#active) Atomics.store(this.#active.job.cancel, 0, 1);
    for (const pending of this.#queue.splice(0))
      this.#reject(pending, new Error('Storage worker is closing'));
  }

  close(): Promise<void> {
    this.beginDrain();
    return (this.#closeTask ??= (async () => {
      if (this.#active) {
        this.#reject(this.#active, new Error('Storage worker is closing'));
        this.#active = undefined;
      }
      await this.#worker?.terminate();
    })());
  }

  #enqueue<T>(
    job:
      | Omit<Extract<TranscriptStorageJob, { kind: 'run' }>, 'id' | 'cancel'>
      | Omit<Extract<TranscriptStorageJob, { kind: 'codec' }>, 'id' | 'cancel'>
      | Omit<Extract<TranscriptStorageJob, { kind: 'recall' }>, 'id' | 'cancel'>
      | Omit<Extract<TranscriptStorageJob, { kind: 'landmarks' }>, 'id' | 'cancel'>,
  ): Promise<T> {
    if (this.#closed || this.#failure)
      return Promise.reject(this.#failure ?? new Error('Storage worker is closed'));
    if (this.#queue.length >= 32) return Promise.reject(new Error('Storage worker queue is full'));
    if (
      job.kind === 'codec' &&
      (job.values.length > 16 ||
        job.values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) >
          RUNTIME_PAYLOAD_MAX_BYTES)
    )
      return Promise.reject(new Error('Storage codec batch exceeds its byte or record budget'));
    if (
      job.kind === 'landmarks' &&
      (!Number.isSafeInteger(job.request.maxLandmarks) ||
        job.request.maxLandmarks < 1 ||
        job.request.maxLandmarks > SESSION_TURN_LANDMARK_MAX_ITEMS)
    )
      return Promise.reject(new Error('Storage landmark query exceeds its record budget'));
    const sessions =
      job.kind === 'codec' ? [] : job.kind === 'recall' ? job.sessionIds : [job.sessionId];
    for (const sessionId of sessions)
      this.#pins.set(sessionId, (this.#pins.get(sessionId) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        job: { ...job, id: ++this.#nextId, cancel: new Int32Array(new SharedArrayBuffer(4)) },
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#closed || this.#failure || this.#active || this.#queue.length === 0) return;
    if (!this.#worker) {
      this.#worker = new Worker(new URL('./transcript-storage-worker.js', import.meta.url), {
        workerData: { databasePath: this.input.databasePath },
      });
      this.#worker.on('error', (error: unknown) =>
        this.#fail(error instanceof Error ? error : new Error('Storage worker failed')),
      );
      this.#worker.on('exit', (code) => {
        if (!this.#closed) this.#fail(new Error(`Storage worker exited (${code})`));
      });
      this.#worker.on(
        'message',
        (message: {
          id: number;
          kind: string;
          ids?: string[];
          value?: unknown;
          error?: { name: string; message: string };
        }) => {
          const active = this.#active;
          if (!active || message.id !== active.job.id || this.#closed) return;
          if (message.kind === 'permissions') {
            void this.input.permissions(message.ids ?? []).then(
              (outcomes) => {
                if (this.#active === active && !this.#closed)
                  this.#worker!.postMessage({ kind: 'permissions', id: message.id, outcomes });
              },
              (error: unknown) => {
                if (this.#active === active && !this.#closed)
                  this.#worker!.postMessage({
                    kind: 'permissions-error',
                    id: message.id,
                    error:
                      error instanceof Error ? error.message : 'Permission outcome read failed',
                  });
              },
            );
            return;
          }
          this.#active = undefined;
          this.#unpin(active);
          if (message.error)
            active.reject(
              Object.assign(new Error(message.error.message), { name: message.error.name }),
            );
          else active.resolve(message.value);
          this.#worker!.unref();
          this.#pump();
        },
      );
    }
    const priority = this.#queue.findIndex(({ job }) => job.kind !== 'codec');
    this.#active = this.#queue.splice(priority < 0 ? 0 : priority, 1)[0]!;
    this.#worker.ref();
    this.#worker.postMessage(this.#active.job);
  }

  #unpin(pending: Pending): void {
    if (pending.job.kind === 'codec') return;
    const sessions =
      pending.job.kind === 'recall' ? pending.job.sessionIds : [pending.job.sessionId];
    for (const sessionId of sessions) this.#releasePin(sessionId);
  }

  #releasePin(id: string): void {
    const count = this.#pins.get(id)! - 1;
    if (count === 0) this.#pins.delete(id);
    else this.#pins.set(id, count);
  }

  #reject(pending: Pending, error: Error): void {
    this.#unpin(pending);
    pending.reject(error);
  }

  #fail(error: Error): void {
    this.#failure = error;
    if (this.#active) {
      this.#reject(this.#active, error);
      this.#active = undefined;
    }
    for (const pending of this.#queue.splice(0)) this.#reject(pending, error);
  }
}
