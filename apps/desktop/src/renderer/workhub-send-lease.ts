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

const WORKHUB_SEND_LEASE_KEY = 'maka-workhub-send-lease-v1';
const WORKHUB_DRAFT_KEY = 'workhub';
const MAX_DRAFT_CHARS = 120_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_SCOPE_CHARS = 1_024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

type WorkHubSendLeaseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface WorkHubSendLeaseState {
  readonly version: 1;
  readonly draft: string;
  readonly requestId?: string;
  readonly summary?: string;
}

export interface WorkHubSendLeaseOptions {
  readonly scope: string;
  readonly storage?: WorkHubSendLeaseStorage;
  readonly createId?: () => string;
}

export interface WorkHubSendAttempt {
  readonly requestId: string;
  readonly retrying: boolean;
}

/**
 * Couples the reload-safe Composer draft to the Action Gate identity that owns
 * its delivery. A failed send keeps both; a fully settled send retires only the
 * identity and lets Composer decide whether the text itself should clear.
 */
export class WorkHubSendLease {
  #memory: WorkHubSendLeaseState | undefined;
  readonly #scope: string;
  readonly #storage: WorkHubSendLeaseStorage | undefined;
  readonly #createId: () => string;
  readonly #storageKey: string;

  constructor(options: WorkHubSendLeaseOptions) {
    if (!options.scope || options.scope.length > MAX_SCOPE_CHARS) {
      throw new TypeError('WorkHub send lease requires a bounded Runtime Host scope');
    }
    this.#scope = options.scope;
    this.#storage = options.storage ?? rendererSessionStorage();
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#storageKey = `${WORKHUB_SEND_LEASE_KEY}:${encodeURIComponent(this.#scope)}`;
  }

  acquire(text: string): string {
    return this.acquireAttempt(text).requestId;
  }

  acquireAttempt(text: string): WorkHubSendAttempt {
    const existing = this.#read();
    if (existing?.draft === text && existing.requestId) {
      return { requestId: existing.requestId, retrying: true };
    }
    const requestId = this.#createId();
    this.#write({ version: 1, draft: text, requestId });
    return { requestId, retrying: false };
  }

  complete(requestId: string): void {
    const existing = this.#read();
    if (existing?.requestId !== requestId) return;
    this.#write({ version: 1, draft: existing.draft });
  }

  settle(requestId: string, _clearsDraft: boolean): void {
    if (_clearsDraft) this.complete(requestId);
  }

  summary(requestId: string, create: () => string): string {
    const existing = this.#read();
    if (existing?.requestId !== requestId) {
      throw new Error('WorkHub summary identity does not own the active send lease');
    }
    if (existing.summary) return existing.summary;
    const summary = create();
    if (!summary || summary.length > MAX_SUMMARY_CHARS) {
      throw new Error('WorkHub coordination summary is invalid');
    }
    this.#write({ ...existing, summary });
    return summary;
  }

  read(key: string | undefined): string | undefined {
    return key === WORKHUB_DRAFT_KEY ? this.#read()?.draft : undefined;
  }

  write(key: string | undefined, draft: string): void {
    if (key !== WORKHUB_DRAFT_KEY) return;
    if (!draft) {
      this.#remove();
      return;
    }
    const existing = this.#read();
    const preservesIdentity = existing?.draft === draft && existing.requestId;
    this.#write({
      version: 1,
      draft,
      ...(preservesIdentity ? { requestId: existing.requestId } : {}),
      ...(preservesIdentity && existing.summary ? { summary: existing.summary } : {}),
    });
  }

  #read(): WorkHubSendLeaseState | undefined {
    try {
      const raw = this.#storage?.getItem(this.#storageKey);
      if (!raw) return this.#memory;
      const value = JSON.parse(raw) as Partial<WorkHubSendLeaseState>;
      if (
        value.version !== 1 ||
        typeof value.draft !== 'string' ||
        value.draft.length > MAX_DRAFT_CHARS ||
        (value.requestId !== undefined &&
          (typeof value.requestId !== 'string' || !SAFE_REQUEST_ID.test(value.requestId))) ||
        (value.summary !== undefined &&
          (typeof value.summary !== 'string' ||
            !value.summary ||
            value.summary.length > MAX_SUMMARY_CHARS ||
            value.requestId === undefined))
      ) {
        return undefined;
      }
      const decoded = {
        version: 1,
        draft: value.draft,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        ...(value.summary ? { summary: value.summary } : {}),
      } satisfies WorkHubSendLeaseState;
      this.#memory = decoded;
      return decoded;
    } catch {
      return this.#memory;
    }
  }

  #write(value: WorkHubSendLeaseState): void {
    this.#memory = value;
    try {
      this.#storage?.setItem(this.#storageKey, JSON.stringify(value));
    } catch {
      // Restricted renderer contexts may not expose web storage.
    }
  }

  #remove(): void {
    this.#memory = undefined;
    try {
      this.#storage?.removeItem(this.#storageKey);
    } catch {
      // Restricted renderer contexts may not expose web storage.
    }
  }
}

function rendererSessionStorage(): WorkHubSendLeaseStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
