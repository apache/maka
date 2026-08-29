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

const WORKHUB_ACTION_KEY = 'maka-workhub-action-v1';
const WORKHUB_DRAFT_STORAGE_KEY = 'maka-workhub-draft-v1';
const WORKHUB_DRAFT_KEY = 'workhub';
const MAX_DRAFT_CHARS = 120_000;
const MAX_SCOPE_CHARS = 1_024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

type WorkHubSendLeaseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface WorkHubSendLeaseOptions {
  readonly scope: string;
  readonly storage?: WorkHubSendLeaseStorage;
  readonly createId?: () => string;
}

export interface WorkHubSendAttempt {
  readonly requestId: string;
  readonly text: string;
  readonly retrying: boolean;
}

/**
 * Keeps only the Host-scoped idempotency key until the Host acknowledges it.
 * Composer draft text has its own storage key and lifecycle.
 */
export class WorkHubSendLease {
  readonly #storage: WorkHubSendLeaseStorage | undefined;
  readonly #createId: () => string;
  readonly #actionKey: string;
  readonly #draftKey: string;
  #memoryRequestId: string | undefined;
  #memoryDraft: string | undefined;
  #storageHealthy = true;

  constructor(options: WorkHubSendLeaseOptions) {
    if (!options.scope || options.scope.length > MAX_SCOPE_CHARS) {
      throw new TypeError('WorkHub send lease requires a bounded Runtime Host scope');
    }
    const scope = encodeURIComponent(options.scope);
    this.#storage = options.storage ?? rendererPersistentStorage();
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#actionKey = `${WORKHUB_ACTION_KEY}:${scope}`;
    this.#draftKey = `${WORKHUB_DRAFT_STORAGE_KEY}:${scope}`;
  }

  acquire(text: string): string {
    return this.acquireAttempt(text).requestId;
  }

  acquireAttempt(text: string): WorkHubSendAttempt {
    const existing = this.#readRequestId();
    if (existing) return { requestId: existing, text, retrying: true };
    const requestId = this.#createId();
    if (!SAFE_REQUEST_ID.test(requestId)) {
      throw new Error('WorkHub action identity is invalid');
    }
    this.#writeRequestId(requestId);
    return { requestId, text, retrying: false };
  }

  complete(requestId: string): void {
    if (this.#readRequestId() !== requestId) return;
    this.#removeRequestId();
  }

  settle(requestId: string, text: string, clearsDraft: boolean): boolean {
    if (!clearsDraft || this.#readRequestId() !== requestId) return false;
    const draftUnchanged = this.read(WORKHUB_DRAFT_KEY) === text;
    this.#removeRequestId();
    return draftUnchanged;
  }

  abandon(requestId: string): void {
    this.complete(requestId);
  }

  read(key: string | undefined): string | undefined {
    if (key !== WORKHUB_DRAFT_KEY) return undefined;
    if (!this.#storageHealthy) return this.#memoryDraft;
    try {
      const draft = this.#storage?.getItem(this.#draftKey) ?? undefined;
      if (draft === undefined || draft.length > MAX_DRAFT_CHARS) return this.#memoryDraft;
      this.#memoryDraft = draft;
      return draft;
    } catch {
      this.#storageHealthy = false;
      return this.#memoryDraft;
    }
  }

  write(key: string | undefined, draft: string): void {
    if (key !== WORKHUB_DRAFT_KEY) return;
    if (draft.length > MAX_DRAFT_CHARS) return;
    this.#memoryDraft = draft || undefined;
    if (!this.#storageHealthy) return;
    try {
      if (draft) this.#storage?.setItem(this.#draftKey, draft);
      else this.#storage?.removeItem(this.#draftKey);
    } catch {
      this.#storageHealthy = false;
    }
  }

  #readRequestId(): string | undefined {
    if (!this.#storageHealthy) return this.#memoryRequestId;
    try {
      const requestId = this.#storage?.getItem(this.#actionKey) ?? undefined;
      if (!requestId || !SAFE_REQUEST_ID.test(requestId)) return this.#memoryRequestId;
      this.#memoryRequestId = requestId;
      return requestId;
    } catch {
      this.#storageHealthy = false;
      return this.#memoryRequestId;
    }
  }

  #writeRequestId(requestId: string): void {
    this.#memoryRequestId = requestId;
    if (!this.#storageHealthy) return;
    try {
      this.#storage?.setItem(this.#actionKey, requestId);
    } catch {
      this.#storageHealthy = false;
    }
  }

  #removeRequestId(): void {
    this.#memoryRequestId = undefined;
    if (!this.#storageHealthy) return;
    try {
      this.#storage?.removeItem(this.#actionKey);
    } catch {
      this.#storageHealthy = false;
    }
  }
}

function rendererPersistentStorage(): WorkHubSendLeaseStorage | undefined {
  try {
    return typeof window === 'undefined' || typeof document === 'undefined'
      ? undefined
      : window.localStorage;
  } catch {
    return undefined;
  }
}
