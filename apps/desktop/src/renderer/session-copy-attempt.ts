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

type PersistedSessionCopyAttempt = Pick<SessionCopyAttempt, 'copyId' | 'sourceTurnId' | 'phase'>;

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
      if (!attempts.has(key)) attempts.set(key, attempt);
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
