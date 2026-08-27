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

const WORKHUB_SEND_LEASE_KEY = 'maka-workhub-send-lease-v2';
const WORKHUB_DRAFT_KEY = 'workhub';
const MAX_DRAFT_CHARS = 120_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_SCOPE_CHARS = 1_024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

type WorkHubSendLeaseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface WorkHubSendLeaseState {
  readonly version: 2;
  readonly draft: string;
  readonly action?: {
    readonly requestId: string;
    readonly text: string;
    readonly state: 'active' | 'settled';
    readonly summary?: string;
  };
}

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
 * Persists a Composer draft beside, but independently from, the Action Gate
 * identity that owns an in-flight delivery. This lets a user type the next
 * draft without revoking or overwriting recovery for the previous action.
 */
export class WorkHubSendLease {
  #memory: WorkHubSendLeaseState | undefined;
  readonly #scope: string;
  readonly #storage: WorkHubSendLeaseStorage | undefined;
  readonly #createId: () => string;
  readonly #storageKey: string;
  #storageHealthy = true;

  constructor(options: WorkHubSendLeaseOptions) {
    if (!options.scope || options.scope.length > MAX_SCOPE_CHARS) {
      throw new TypeError('WorkHub send lease requires a bounded Runtime Host scope');
    }
    this.#scope = options.scope;
    this.#storage = options.storage ?? rendererPersistentStorage();
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#storageKey = `${WORKHUB_SEND_LEASE_KEY}:${encodeURIComponent(this.#scope)}`;
  }

  acquire(text: string): string {
    return this.acquireAttempt(text).requestId;
  }

  acquireAttempt(
    text: string,
    options: { readonly preserveDraft?: boolean } = {},
  ): WorkHubSendAttempt {
    const existing = this.#read();
    if (existing?.action?.state === 'active') {
      return {
        requestId: existing.action.requestId,
        text: existing.action.text,
        retrying: true,
      };
    }
    if (
      !options.preserveDraft &&
      existing?.action?.state === 'settled' &&
      existing.draft === text &&
      existing.action.text === text
    ) {
      return {
        requestId: existing.action.requestId,
        text: existing.action.text,
        retrying: true,
      };
    }
    const requestId = this.#createId();
    this.#write({
      version: 2,
      draft: options.preserveDraft ? existing?.draft ?? text : text,
      action: { requestId, text, state: 'active' },
    });
    return { requestId, text, retrying: false };
  }

  complete(requestId: string): void {
    const existing = this.#read();
    if (existing?.action?.requestId !== requestId) return;
    this.#write({ version: 2, draft: existing.draft });
  }

  settle(requestId: string, clearsDraft: boolean): boolean {
    const existing = this.#read();
    if (!clearsDraft || existing?.action?.requestId !== requestId) return false;
    const draftUnchanged = existing.draft === existing.action.text;
    if (!existing.draft) {
      this.#write({ version: 2, draft: '' });
    } else {
      this.#write({
        ...existing,
        action: { ...existing.action, state: 'settled' },
      });
    }
    return draftUnchanged;
  }

  abandon(requestId: string): void {
    this.complete(requestId);
  }

  summary(requestId: string, create: () => string): string {
    const existing = this.#read();
    if (existing?.action?.requestId !== requestId) {
      throw new Error('WorkHub summary identity does not own the active send lease');
    }
    if (existing.action.summary) return existing.action.summary;
    const summary = create();
    if (!summary || summary.length > MAX_SUMMARY_CHARS) {
      throw new Error('WorkHub coordination summary is invalid');
    }
    this.#write({
      ...existing,
      action: { ...existing.action, summary },
    });
    return summary;
  }

  read(key: string | undefined): string | undefined {
    return key === WORKHUB_DRAFT_KEY ? this.#read()?.draft : undefined;
  }

  write(key: string | undefined, draft: string): void {
    if (key !== WORKHUB_DRAFT_KEY) return;
    if (!draft) {
      const existing = this.#read();
      if (existing?.action?.state === 'active') {
        this.#write({ ...existing, draft: '' });
      } else {
        this.#remove();
      }
      return;
    }
    const existing = this.#read();
    // Composer permits the user to type the next draft while the current send
    // is still settling. Draft edits therefore cannot revoke the identity that
    // owns an already-admitted target effect or its Coordination summary.
    this.#write({
      version: 2,
      draft,
      ...(existing?.action ? { action: existing.action } : {}),
    });
  }

  #read(): WorkHubSendLeaseState | undefined {
    if (!this.#storageHealthy) return this.#memory;
    try {
      const raw = this.#storage?.getItem(this.#storageKey);
      if (!raw) return this.#memory;
      const value = JSON.parse(raw) as Partial<WorkHubSendLeaseState>;
      if (
        value.version !== 2 ||
        typeof value.draft !== 'string' ||
        value.draft.length > MAX_DRAFT_CHARS ||
        (value.action !== undefined && !isWorkHubSendAction(value.action))
      ) {
        return undefined;
      }
      const decoded = {
        version: 2,
        draft: value.draft,
        ...(value.action ? { action: value.action } : {}),
      } satisfies WorkHubSendLeaseState;
      this.#memory = decoded;
      return decoded;
    } catch {
      this.#storageHealthy = false;
      return this.#memory;
    }
  }

  #write(value: WorkHubSendLeaseState): void {
    this.#memory = value;
    if (!this.#storageHealthy) return;
    try {
      this.#storage?.setItem(this.#storageKey, JSON.stringify(value));
    } catch {
      this.#storageHealthy = false;
    }
  }

  #remove(): void {
    this.#memory = undefined;
    if (!this.#storageHealthy) return;
    try {
      this.#storage?.removeItem(this.#storageKey);
    } catch {
      this.#storageHealthy = false;
    }
  }
}

function isWorkHubSendAction(
  value: unknown,
): value is NonNullable<WorkHubSendLeaseState['action']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NonNullable<WorkHubSendLeaseState['action']>>;
  return (
    typeof candidate.requestId === 'string' &&
    SAFE_REQUEST_ID.test(candidate.requestId) &&
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    candidate.text.length <= MAX_DRAFT_CHARS &&
    (candidate.state === 'active' || candidate.state === 'settled') &&
    (candidate.summary === undefined ||
      (typeof candidate.summary === 'string' &&
        candidate.summary.length > 0 &&
        candidate.summary.length <= MAX_SUMMARY_CHARS))
  );
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
