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

const SESSION_COPY_ATTEMPTS_KEY = 'maka-session-copy-attempts-v3';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type SessionCopyAttemptKey = {
  scope: string;
  kind: 'branch' | 'revision';
  sourceSessionId: string;
};

export type SessionCopyAttemptPhase = 'reserved' | 'started' | 'abandoning';

export interface SessionCopyAttempt {
  copyId: string;
  sourceTurnId: string;
  phase: SessionCopyAttemptPhase;
  complete(): void;
}

export type PersistedSessionCopyAttempt = Pick<
  SessionCopyAttempt,
  'copyId' | 'sourceTurnId' | 'phase'
>;

export interface PersistedSessionCopyAttemptEntry {
  key: SessionCopyAttemptKey;
  attempt: PersistedSessionCopyAttempt;
}

const memoryAttempts = new Map<string, PersistedSessionCopyAttempt>();

function rendererSessionStorage(): SessionStorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Acquire the stable target and source boundary for one logical Session copy.
 * The lease survives renderer reload through sessionStorage, but ends with the
 * window. Ambiguous failures deliberately leave it open; confirmed success or
 * authoritative cleanup calls complete so the next user action starts fresh.
 */
export function acquireSessionCopyAttempt(
  key: SessionCopyAttemptKey,
  sourceTurnId: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
  newId: () => string = () => crypto.randomUUID(),
): SessionCopyAttempt {
  const encodedKey = encodeAttemptKey(key);
  const attempts = readAttempts(storage);
  let attempt = attempts.get(encodedKey);
  if (!attempt) {
    attempt = { copyId: newId(), sourceTurnId, phase: 'reserved' };
    attempts.set(encodedKey, attempt);
    writeAttempts(storage, attempts);
  }
  memoryAttempts.set(encodedKey, attempt);
  return {
    ...attempt,
    complete: () => completeSessionCopyAttempt(key, attempt.copyId, storage),
  };
}

export function startSessionCopyAttempt(
  key: SessionCopyAttemptKey,
  copyId: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): boolean {
  const encodedKey = encodeAttemptKey(key);
  const attempts = readAttempts(storage);
  const current = attempts.get(encodedKey);
  if (!current || current.copyId !== copyId) return false;
  if (current.phase === 'abandoning') return false;
  if (current.phase === 'reserved') {
    const started = { ...current, phase: 'started' as const };
    attempts.set(encodedKey, started);
    memoryAttempts.set(encodedKey, started);
    writeAttempts(storage, attempts);
  }
  return true;
}

export function abandonSessionCopyAttempt(
  key: SessionCopyAttemptKey,
  copyId: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): boolean {
  const encodedKey = encodeAttemptKey(key);
  const attempts = readAttempts(storage);
  const current = attempts.get(encodedKey);
  if (!current || current.copyId !== copyId) return false;
  if (current.phase !== 'abandoning') {
    const abandoning = { ...current, phase: 'abandoning' as const };
    attempts.set(encodedKey, abandoning);
    memoryAttempts.set(encodedKey, abandoning);
    writeAttempts(storage, attempts);
  }
  return true;
}

export function readSessionCopyAttempt(
  key: SessionCopyAttemptKey,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): PersistedSessionCopyAttempt | undefined {
  return readAttempts(storage).get(encodeAttemptKey(key));
}

export function listSessionCopyAttempts(
  scopePrefix: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): PersistedSessionCopyAttemptEntry[] {
  const entries: PersistedSessionCopyAttemptEntry[] = [];
  for (const [encodedKey, attempt] of readAttempts(storage)) {
    const key = decodeAttemptKey(encodedKey);
    if (key?.scope.startsWith(scopePrefix)) entries.push({ key, attempt });
  }
  return entries;
}

export function completeSessionCopyAttempt(
  key: SessionCopyAttemptKey,
  copyId: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  const encodedKey = encodeAttemptKey(key);
  const current = readAttempts(storage);
  if (current.get(encodedKey)?.copyId === copyId) {
    current.delete(encodedKey);
    writeAttempts(storage, current);
  }
  if (memoryAttempts.get(encodedKey)?.copyId === copyId) memoryAttempts.delete(encodedKey);
}

function encodeAttemptKey(key: SessionCopyAttemptKey): string {
  return JSON.stringify([key.scope, key.kind, key.sourceSessionId]);
}

function decodeAttemptKey(encodedKey: string): SessionCopyAttemptKey | undefined {
  try {
    const value = JSON.parse(encodedKey) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== 'string' ||
      value[0].length === 0 ||
      value[0].length > 512 ||
      (value[1] !== 'branch' && value[1] !== 'revision') ||
      typeof value[2] !== 'string' ||
      value[2].length === 0 ||
      value[2].length > 128
    ) {
      return undefined;
    }
    return { scope: value[0], kind: value[1], sourceSessionId: value[2] };
  } catch {
    return undefined;
  }
}

function readAttempts(
  storage: SessionStorageLike | undefined,
): Map<string, PersistedSessionCopyAttempt> {
  try {
    const raw = storage?.getItem(SESSION_COPY_ATTEMPTS_KEY);
    if (!raw) return new Map(memoryAttempts);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map(memoryAttempts);
    const attempts = new Map<string, PersistedSessionCopyAttempt>();
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        entry[0].length <= 1_024 &&
        isPersistedAttempt(entry[1])
      ) {
        attempts.set(entry[0], entry[1]);
      }
    }
    for (const [key, attempt] of memoryAttempts) {
      attempts.set(key, attempt);
    }
    return attempts;
  } catch {
    return new Map(memoryAttempts);
  }
}

function writeAttempts(
  storage: SessionStorageLike | undefined,
  attempts: Map<string, PersistedSessionCopyAttempt>,
): void {
  try {
    if (attempts.size === 0) storage?.removeItem(SESSION_COPY_ATTEMPTS_KEY);
    else storage?.setItem(SESSION_COPY_ATTEMPTS_KEY, JSON.stringify([...attempts]));
  } catch {
    // Restricted renderer contexts keep the process-local lease until reload.
  }
}

function isPersistedAttempt(value: unknown): value is PersistedSessionCopyAttempt {
  if (!value || typeof value !== 'object') return false;
  const attempt = value as { copyId?: unknown; sourceTurnId?: unknown; phase?: unknown };
  return (
    typeof attempt.copyId === 'string' &&
    attempt.copyId.length > 0 &&
    attempt.copyId.length <= 128 &&
    typeof attempt.sourceTurnId === 'string' &&
    attempt.sourceTurnId.length > 0 &&
    attempt.sourceTurnId.length <= 128 &&
    (attempt.phase === 'reserved' ||
      attempt.phase === 'started' ||
      attempt.phase === 'abandoning')
  );
}
