import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  CREDENTIAL_SCHEMA_VERSION,
  createFileCredentialStore,
  withCredentialFileLock,
  type CredentialCasResult,
  type CredentialKind,
  type CredentialStore,
} from '../credential-store.js';

const isPosix = process.platform !== 'win32';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-cred-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('FileCredentialStore', () => {
  test('round-trips secrets and returns null for missing ones', async () => {
    await withTempDir(async (dir) => {
      const store = createFileCredentialStore(dir);
      assert.equal(await store.getSecret('openai-prod', 'api_key'), null);

      await store.setSecret('openai-prod', 'api_key', 'sk-test-123');
      assert.equal(await store.getSecret('openai-prod', 'api_key'), 'sk-test-123');

      await store.deleteSecret('openai-prod', 'api_key');
      assert.equal(await store.getSecret('openai-prod', 'api_key'), null);
    });
  });

  test('deleteSecret(slug) with no kind clears every kind for that slug only', async () => {
    await withTempDir(async (dir) => {
      const store = createFileCredentialStore(dir);
      await store.setSecret('a', 'api_key', 'key-a');
      await store.setSecret('a', 'oauth_token', 'tok-a');
      await store.setSecret('b', 'api_key', 'key-b');

      await store.deleteSecret('a');

      assert.equal(await store.getSecret('a', 'api_key'), null);
      assert.equal(await store.getSecret('a', 'oauth_token'), null);
      assert.equal(await store.getSecret('b', 'api_key'), 'key-b');
    });
  });

  test('writes a versioned, plaintext (file-first) file', async () => {
    await withTempDir(async (dir) => {
      const store = createFileCredentialStore(dir);
      await store.setSecret('openai-prod', 'api_key', 'sk-plain');

      const raw = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8')) as {
        version: number;
        values: Record<string, string>;
      };
      assert.equal(raw.version, CREDENTIAL_SCHEMA_VERSION);
      // File-first: the value is stored as plaintext, not encoded.
      assert.equal(raw.values['openai-prod:apiKey'], 'sk-plain');
    });
  });

  test('reading an unknown / pre-migration schema fails closed', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'credentials.json');

      // Legacy file: no `version` field (the safeStorage-era shape).
      await writeFile(path, JSON.stringify({ values: { 'x:apiKey': 'enc' } }), 'utf8');
      const legacy = createFileCredentialStore(dir);
      await assert.rejects(legacy.getSecret('x', 'api_key'), /schema version/);

      // Future version we don't understand.
      await writeFile(path, JSON.stringify({ version: 999, values: {} }), 'utf8');
      const future = createFileCredentialStore(dir);
      await assert.rejects(future.getSecret('x', 'api_key'), /schema version/);
    });
  });

  test('leaves no temp file behind after a write', async () => {
    await withTempDir(async (dir) => {
      const store = createFileCredentialStore(dir);
      await store.setSecret('a', 'api_key', 'k');
      const entries = await readdir(dir);
      assert.deepEqual(entries, ['credentials.json']);
    });
  });

  test('creates the file 0600 on POSIX', { skip: !isPosix }, async () => {
    await withTempDir(async (dir) => {
      const store = createFileCredentialStore(dir);
      await store.setSecret('a', 'api_key', 'k');
      const mode = (await stat(join(dir, 'credentials.json'))).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  });

  test('re-chmods a pre-existing world-readable file to 0600 on write', {
    skip: !isPosix,
  }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'credentials.json');
      // A valid v1 file that was created with a loose mode.
      await writeFile(path, JSON.stringify({ version: CREDENTIAL_SCHEMA_VERSION, values: {} }), {
        encoding: 'utf8',
        mode: 0o644,
      });
      const store = createFileCredentialStore(dir);
      await store.setSecret('a', 'api_key', 'k');
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  });

  test('hardens a pre-existing world-accessible workspace dir to 0700 on write', {
    skip: !isPosix,
  }, async () => {
    await withTempDir(async (dir) => {
      await chmod(dir, 0o777); // a loose dir that predates the hardening
      const store = createFileCredentialStore(dir);
      await store.setSecret('a', 'api_key', 'k');
      // ensureSecretDir re-chmods an existing dir (mkdir's mode only applies on
      // creation); the writer and the lock share it, so the lock can't leave
      // the dir loose either.
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    });
  });

  test('serializes concurrent writes across slugs without clobbering', async () => {
    await withTempDir(async (dir) => {
      // With no in-instance queue, these contend directly on the file lock —
      // this proves the lock alone serializes a read-modify-write so no slug is
      // dropped. A handful is enough; more just adds lock-poll wall-clock.
      const store = createFileCredentialStore(dir);
      const count = 8;
      await Promise.all(
        Array.from({ length: count }, (_unused, i) =>
          store.setSecret(`conn-${i}`, 'api_key', `key-${i}`),
        ),
      );
      for (let i = 0; i < count; i++) {
        assert.equal(await store.getSecret(`conn-${i}`, 'api_key'), `key-${i}`);
      }
    });
  });

  test('two independent store instances writing concurrently both survive (cross-process lock)', async () => {
    await withTempDir(async (dir) => {
      // Separate instances => separate in-instance queues; only the file
      // lock can stop a read-modify-write lost update between them.
      const a = createFileCredentialStore(dir);
      const b = createFileCredentialStore(dir);
      await Promise.all([
        a.setSecret('slug-a', 'api_key', 'AAA'),
        b.setSecret('slug-b', 'api_key', 'BBB'),
      ]);

      const reader = createFileCredentialStore(dir);
      assert.equal(await reader.getSecret('slug-a', 'api_key'), 'AAA');
      assert.equal(await reader.getSecret('slug-b', 'api_key'), 'BBB');
    });
  });

  test('a held lock is waited on, never stolen (no lost update)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'credentials.json');
      // Hold the lock as another process (or a crashed one) would: the lock is
      // the `${path}.lock` directory. The store must wait for it, never steal it.
      const lockPath = `${path}.lock`;
      await mkdir(lockPath);

      const store = createFileCredentialStore(dir);
      let settled = false;
      const write = store.setSecret('a', 'api_key', 'V').then(() => {
        settled = true;
      });

      // The lock is held, so the write is blocked before its critical section:
      // it must not steal the lock and must not have written the file yet.
      await assert.rejects(stat(path)); // file absent — proven blocked, not stolen
      assert.equal(settled, false);

      await rm(lockPath, { recursive: true, force: true }); // release
      await write;
      assert.equal(await store.getSecret('a', 'api_key'), 'V'); // proceeds only once the lock frees
    });
  });

  test('a never-released lock fails loud with the lock path and recovery hint', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'credentials.json');
      await mkdir(`${path}.lock`); // a crashed holder's lock that never releases
      // A small timeout drives the fail-loud path without the production wait.
      // The error must name the lock dir AND how to recover, so the guidance
      // can't silently regress.
      await assert.rejects(
        withCredentialFileLock(path, async () => 'unreachable', 60),
        (error: Error) =>
          error.message.includes(`${path}.lock`) &&
          /remove that directory and retry/.test(error.message),
      );
    });
  });
});

describe('FileCredentialStore compareAndSetSecret', () => {
  // Optional capability: exercise it through a guarded helper so a store that
  // does not expose CAS is a caller's own fallback problem, not a test crash.
  function cas(
    store: CredentialStore,
    slug: string,
    kind: CredentialKind,
    expected: string | null,
    value: string,
  ): Promise<CredentialCasResult> {
    assert.ok(store.compareAndSetSecret, 'file store exposes the CAS capability');
    return store.compareAndSetSecret(slug, kind, expected, value);
  }

  test('commits when the basis still matches, and the write persists', async () => {
    await withTempDir(async (dir) => {
      const store = createFileCredentialStore(dir);
      await store.setSecret('acct', 'oauth_token', 'tok-basis');

      const result = await cas(store, 'acct', 'oauth_token', 'tok-basis', 'tok-next');
      assert.deepEqual(result, { committed: true });
      assert.equal(await store.getSecret('acct', 'oauth_token'), 'tok-next');
    });
  });

  test('commits a write-if-absent (expected null) only while the entry is absent', async () => {
    await withTempDir(async (dir) => {
      // Decide "store has no token" and write in one serialized step. A value
      // written between the check and the write must make this writer lose.
      const importer = createFileCredentialStore(dir);
      const other = createFileCredentialStore(dir);

      // Someone writes a token after the importer would have read "absent".
      await other.setSecret('acct', 'oauth_token', 'tok-live');

      const blocked = await cas(importer, 'acct', 'oauth_token', null, 'tok-import');
      assert.deepEqual(blocked, { committed: false, current: 'tok-live' });
      assert.equal(await other.getSecret('acct', 'oauth_token'), 'tok-live');

      // With a genuinely absent entry the same write-if-absent commits.
      const committed = await cas(importer, 'other-acct', 'oauth_token', null, 'tok-import');
      assert.deepEqual(committed, { committed: true });
      assert.equal(await importer.getSecret('other-acct', 'oauth_token'), 'tok-import');
    });
  });

  test('two store instances racing on the same basis: loser sees the entry changed and adopts it', async () => {
    await withTempDir(async (dir) => {
      // Two separate instances share the file (a cross-process refresh). Both
      // read the same basis; only the file lock decides the winner.
      const a = createFileCredentialStore(dir);
      const b = createFileCredentialStore(dir);
      await a.setSecret('acct', 'oauth_token', 'tok-basis');

      // A commits first, then B tries with the now-stale basis.
      const winner = await cas(a, 'acct', 'oauth_token', 'tok-basis', 'tok-A');
      const loser = await cas(b, 'acct', 'oauth_token', 'tok-basis', 'tok-B');

      assert.deepEqual(winner, { committed: true });
      // Entry changed (not gone): current is a string the loser adopts.
      assert.deepEqual(loser, { committed: false, current: 'tok-A' });
      const reader = createFileCredentialStore(dir);
      assert.equal(await reader.getSecret('acct', 'oauth_token'), 'tok-A');
    });
  });

  test('a basis whose entry was deleted (logout) is distinguishable from a changed one', async () => {
    await withTempDir(async (dir) => {
      const a = createFileCredentialStore(dir);
      const b = createFileCredentialStore(dir);
      await a.setSecret('acct', 'oauth_token', 'tok-basis');

      // A terminal logout removes the entry after B read its basis.
      await a.deleteSecret('acct', 'oauth_token');

      const result = await cas(b, 'acct', 'oauth_token', 'tok-basis', 'tok-resurrect');
      // Entry gone (current === null): the caller must NOT resurrect it, and the
      // write did not commit.
      assert.deepEqual(result, { committed: false, current: null });
      const reader = createFileCredentialStore(dir);
      assert.equal(await reader.getSecret('acct', 'oauth_token'), null);
    });
  });

  test('concurrent CAS from the same basis: exactly one wins, the loser returns the winner value', async () => {
    await withTempDir(async (dir) => {
      const a = createFileCredentialStore(dir);
      const b = createFileCredentialStore(dir);
      await a.setSecret('acct', 'oauth_token', 'tok-basis');

      const [ra, rb] = await Promise.all([
        cas(a, 'acct', 'oauth_token', 'tok-basis', 'tok-A'),
        cas(b, 'acct', 'oauth_token', 'tok-basis', 'tok-B'),
      ]);

      const winners = [ra, rb].filter((r) => r.committed);
      assert.equal(winners.length, 1, 'exactly one CAS commits');
      const winnerValue = ra.committed ? 'tok-A' : 'tok-B';
      const loser = ra.committed ? rb : ra;
      assert.deepEqual(loser, { committed: false, current: winnerValue });

      const reader = createFileCredentialStore(dir);
      assert.equal(await reader.getSecret('acct', 'oauth_token'), winnerValue);
    });
  });
});
