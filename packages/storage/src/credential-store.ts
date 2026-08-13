import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileUpdateLock } from './file-update-lock.js';

/**
 * Pure-Node credential store. Shared by the desktop app and any
 * non-desktop consumer (CLI / third party) that runs the
 * runtime outside Electron.
 *
 * At rest this is plaintext JSON behind 0600 file perms (file-first;
 * see issue #32). The OS user account is the security boundary
 * (SECURITY.md). At-rest encryption (an OS keychain via a pure-Node
 * binding, or a passphrase) is a later addition — deliberately deferred
 * until there is a real backend, so its sync/async shape is designed
 * against that backend instead of guessed now.
 *
 * Writes are serialized across processes by an atomic-mkdir lockfile that is
 * never stolen (see withCredentialFileLock), so two store instances (or
 * processes) sharing one file can't lose each other's update through a
 * read-modify-write race.
 *
 * Secret VALUES are never logged. Callers expose the typed
 * `CredentialStore` API to third parties — never the raw file format,
 * which stays an internal implementation detail.
 */

type StoredCredentialKind =
  | 'apiKey'
  | 'oauthToken'
  | 'requestHeaders'
  | 'botToken'
  | 'botAppSecret'
  | 'proxyPassword'
  | 'tavilyApiKey'
  | 'runtimeHostAccess';
export type CredentialKind =
  | 'api_key'
  | 'oauth_token'
  | 'request_headers'
  | 'bot_token'
  | 'app_secret'
  | 'proxy_password'
  | 'tavily_api_key'
  | 'runtime_host_access';

/** Current on-disk schema version. Unknown versions fail closed on read. */
export const CREDENTIAL_SCHEMA_VERSION = 1;

interface CredentialFile {
  version: number;
  values: Record<string, string>;
}

/**
 * Outcome of a compare-and-set write.
 *
 * `committed: true` — the basis was still the stored authority, so the new
 * value was persisted (this caller is the winner).
 *
 * `committed: false` — the basis was stale; someone committed first. `current`
 * is what the store holds instead, and it distinguishes the two loser cases the
 * refresh lifecycle must tell apart:
 *   - `current === null`: the entry is gone. A terminal delete (e.g. a logout)
 *     happened after the caller read its basis; the caller must NOT resurrect it.
 *   - `current` is a string: the entry was changed by a concurrent winner. The
 *     caller adopts `current` instead of overwriting it.
 */
export type CredentialCasResult =
  | { committed: true }
  | { committed: false; current: string | null };

export interface CredentialStore {
  getSecret(slug: string, kind: CredentialKind): Promise<string | null>;
  setSecret(slug: string, kind: CredentialKind, value: string): Promise<void>;
  /** Delete one kind, or — with no kind — every kind for the slug (e.g. a
   *  connection being removed). */
  deleteSecret(slug: string, kind?: CredentialKind): Promise<void>;
  /**
   * Optional compare-and-set write. Persist `value` for `(slug, kind)` only
   * while the stored entry still equals `expected` — the basis the caller read
   * before deciding to write. `expected: null` asserts the entry is absent.
   *
   * The basis check and the write run together under the same cross-process
   * lock as `setSecret`, so no concurrent writer can slip in between them; the
   * check is a specialization of the current read-modify-write, not a lease held
   * across any external I/O.
   *
   * Optional capability: third-party `CredentialStore` implementations and the
   * future `credential_provider` backends stay source-compatible without it.
   * When it is absent, callers fall back to an unconditional `setSecret`
   * (today's behavior).
   */
  compareAndSetSecret?(
    slug: string,
    kind: CredentialKind,
    expected: string | null,
    value: string,
  ): Promise<CredentialCasResult>;
}

export function createFileCredentialStore(workspaceRoot: string): CredentialStore {
  return new FileCredentialStore(join(workspaceRoot, 'credentials.json'));
}

class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  getSecret(slug: string, kind: CredentialKind): Promise<string | null> {
    return this.get(slug, toStoredKind(kind));
  }

  setSecret(slug: string, kind: CredentialKind, value: string): Promise<void> {
    return this.set(slug, toStoredKind(kind), value);
  }

  async deleteSecret(slug: string, kind?: CredentialKind): Promise<void> {
    await this.mutate((values) => {
      if (kind) {
        delete values[this.key(slug, toStoredKind(kind))];
        return;
      }
      // No kind: clear every kind for the slug in one read-modify-write.
      for (const storedKind of STORED_CREDENTIAL_KINDS) {
        delete values[this.key(slug, storedKind)];
      }
    });
  }

  private async get(slug: string, kind: StoredCredentialKind): Promise<string | null> {
    const value = (await this.readUnlocked()).values[this.key(slug, kind)];
    return value === undefined ? null : value;
  }

  private set(slug: string, kind: StoredCredentialKind, value: string): Promise<void> {
    return this.mutate((values) => {
      values[this.key(slug, kind)] = value;
    });
  }

  /**
   * Compare-and-set specialization of the read-modify-write: read under the
   * lock, verify the stored entry still equals the caller's basis, and only then
   * write. A mismatch commits nothing and reports what the store holds so the
   * loser can distinguish a terminal delete (`current === null`) from a
   * concurrent winner it must adopt (`current` is a string).
   */
  compareAndSetSecret(
    slug: string,
    kind: CredentialKind,
    expected: string | null,
    value: string,
  ): Promise<CredentialCasResult> {
    const key = this.key(slug, toStoredKind(kind));
    return withCredentialFileLock(this.path, async () => {
      const file = await this.readUnlocked();
      const stored = file.values[key];
      const current = stored === undefined ? null : stored;
      if (current !== expected) {
        return { committed: false, current };
      }
      file.values[key] = value;
      await this.write(file);
      return { committed: true };
    });
  }

  /**
   * Read-modify-write the whole file under the cross-process lockfile. The lock
   * serializes concurrent calls on this instance and a second store instance /
   * process alike, so one mechanism covers both — no separate in-instance queue.
   */
  private mutate(apply: (values: Record<string, string>) => void): Promise<void> {
    return withCredentialFileLock(this.path, async () => {
      const file = await this.readUnlocked();
      apply(file.values);
      await this.write(file);
    });
  }

  private key(slug: string, kind: StoredCredentialKind): string {
    return `${slug}:${kind}`;
  }

  private async readUnlocked(): Promise<CredentialFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return { version: CREDENTIAL_SCHEMA_VERSION, values: {} };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<CredentialFile>;
    // Fail closed on an unknown schema rather than inventing defaults.
    if (parsed.version !== CREDENTIAL_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported credentials.json schema version: ${String(parsed.version)} ` +
          `(expected ${CREDENTIAL_SCHEMA_VERSION}). Remove the file and re-authenticate.`,
      );
    }
    // A v1 file must carry a well-formed `values` map. Treat a missing or
    // malformed `values` as corruption and fail closed rather than silently
    // serving an empty store (which would read as "no credentials").
    const values = parsed.values;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Corrupt credentials.json: `values` is missing or not an object.');
    }
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== 'string') {
        throw new Error(`Corrupt credentials.json: value for "${k}" is not a string.`);
      }
    }
    return { version: CREDENTIAL_SCHEMA_VERSION, values: values as Record<string, string> };
  }

  private write(file: CredentialFile): Promise<void> {
    return writeSecretFileAtomic(this.path, JSON.stringify(file, null, 2) + '\n');
  }
}

/**
 * Create (or harden) the directory that holds a secret file: 0700, and
 * re-chmod a pre-existing looser dir so neither the secret nor the lock can sit
 * world-readable. mkdir's mode only applies on creation, so the chmod is what
 * fixes an existing dir. On POSIX a chmod failure fails closed (we must not
 * write plaintext credentials into a dir we couldn't lock down); no-op on
 * Windows. Shared by the writer and the lock so their dir hardening can't drift.
 */
async function ensureSecretDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmodStrict(dir, 0o700);
}

/**
 * Owner-only atomic write for a credentials file: a 0700 dir, an exclusive
 * 0600 temp ('wx'/O_EXCL so we never follow a pre-planted symlink at a
 * predictable path), 0600 re-enforced, an atomic rename, and temp cleanup on
 * failure.
 */
async function writeSecretFileAtomic(path: string, contents: string): Promise<void> {
  await ensureSecretDir(dirname(path));
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmodStrict(tempPath, 0o600);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * chmod that fails loud on POSIX and is best-effort on Windows. A secret file
 * or its directory left looser than intended breaks the 0600/0700 boundary, so
 * on POSIX we surface the failure rather than write plaintext into it; Windows
 * has no POSIX mode, so a failure there is a no-op. One policy for both the
 * secret file (0600) and its directory (0700) so they can't drift apart.
 */
async function chmodStrict(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') {
    await chmod(path, mode).catch(() => {});
    return;
  }
  await chmod(path, mode);
}

const LOCK_TIMEOUT_MS = 10_000;

/**
 * Serialize a read-modify-write across processes / store instances that share
 * one credentials.json, so two writers can't lose each other's update through a
 * read, read, write, write race.
 *
 * Acquire is an atomic `mkdir` of `${targetPath}.lock` (POSIX mkdir is atomic
 * and fails EEXIST if it already exists); release deletes it. The lock is NEVER
 * stolen — a held or leftover lock is waited on, then we fail loud. That is the
 * whole design, and the reason it is correct. Every "detect a crashed holder's
 * stale lock, then remove it and re-acquire" scheme — the earlier hand-rolled
 * ones AND proper-lockfile — is a TOCTOU race: between judging a lock stale and
 * deleting it, another contender can reclaim it, so the delete drops a live
 * lock and both writers enter the critical section. There is no safe userspace
 * compare-and-steal, so we do not steal at all.
 *
 * The cost: a hard crash (SIGKILL / power loss) mid-write leaves the lock
 * directory behind, and the next writer fails loud until it is removed — an
 * explicit, one-command recovery, never a silent lost update. A clean exit or a
 * completed write releases it via the finally. credentials.json is written
 * rarely and is local, so this is the right trade for credential data.
 *
 * `timeoutMs` defaults to LOCK_TIMEOUT_MS; it is a parameter only so a test can
 * drive the fail-loud path with a small value. Exported for that test — it is
 * deliberately NOT re-exported from index.ts, so the package's public surface
 * stays the typed store and callers can't drive the lock directly.
 */
export async function withCredentialFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  await ensureSecretDir(dirname(targetPath));
  return withFileUpdateLock(targetPath, fn, timeoutMs);
}

const STORED_CREDENTIAL_KINDS = [
  'apiKey',
  'oauthToken',
  'requestHeaders',
  'botToken',
  'botAppSecret',
  'proxyPassword',
  'tavilyApiKey',
  'runtimeHostAccess',
] as const satisfies readonly StoredCredentialKind[];

function toStoredKind(kind: CredentialKind): StoredCredentialKind {
  switch (kind) {
    case 'api_key':
      return 'apiKey';
    case 'oauth_token':
      return 'oauthToken';
    case 'request_headers':
      return 'requestHeaders';
    case 'bot_token':
      return 'botToken';
    case 'app_secret':
      return 'botAppSecret';
    case 'proxy_password':
      return 'proxyPassword';
    case 'tavily_api_key':
      return 'tavilyApiKey';
    case 'runtime_host_access':
      return 'runtimeHostAccess';
  }
}
