import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createFileCredentialStore } from '@maka/storage';
import {
  connectRemoteRuntimeHostProfile,
  createFileRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
  decodeRuntimeHostProfileDocument,
  type RemoteRuntimeHostProfile,
  type RuntimeHostProfileCredentialStore,
} from '../client/host-profile.js';
import { RuntimeHostPermanentReconnectError } from '../client/reconnect-lifecycle.js';

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Runtime Host profiles', () => {
  test('keeps the local profile built in and profile documents remote-only', async () => {
    const catalog = createFileRuntimeHostProfileCatalog(await profilePath(), memoryCredentials());
    assert.deepEqual(await catalog.read(), { schemaVersion: 1, profiles: [] });
    await assert.rejects(() => catalog.remove('local'), /cannot be removed/);
  });

  test('normalizes, serializes, updates, and removes remote profiles', async () => {
    const path = await profilePath();
    const catalog = createFileRuntimeHostProfileCatalog(path, memoryCredentials());
    await Promise.all([
      catalog.save(
        {
          id: 'office',
          name: ' Office Host ',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://runtime.example.com' },
          rootId: ROOT_A,
        },
        'office-token',
      ),
      catalog.save(
        {
          id: 'backup',
          name: 'Backup',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://backup.example.com/runtime-host' },
          rootId: ROOT_B,
        },
        'loopback-token',
      ),
    ]);
    await catalog.save(
      {
        id: 'office',
        name: 'Office',
        kind: 'remote',
        transport: { kind: 'tls', url: 'wss://runtime.example.com' },
        rootId: ROOT_A,
      },
      'new-office-token',
    );

    assert.deepEqual(await catalog.read(), {
      schemaVersion: 1,
      profiles: [
        {
          id: 'office',
          name: 'Office',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
          rootId: ROOT_A,
        },
        {
          id: 'backup',
          name: 'Backup',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://backup.example.com/runtime-host' },
          rootId: ROOT_B,
        },
      ],
    });
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(JSON.stringify(persisted).includes('credential'), false);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);

    assert.deepEqual(await catalog.remove('office'), {
      schemaVersion: 1,
      profiles: [
        {
          id: 'backup',
          name: 'Backup',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://backup.example.com/runtime-host' },
          rootId: ROOT_B,
        },
      ],
    });
  });

  test('preserves concurrent updates from independent store instances', async () => {
    const path = await profilePath();
    const credentials = memoryCredentials();
    const first = createFileRuntimeHostProfileCatalog(path, credentials);
    const second = createFileRuntimeHostProfileCatalog(path, credentials);
    await Promise.all([
      first.save(
        {
          id: 'first',
          name: 'First',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://first.example.com' },
          rootId: ROOT_A,
        },
        'first-token',
      ),
      second.save(
        {
          id: 'second',
          name: 'Second',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://second.example.com' },
          rootId: ROOT_B,
        },
        'second-token',
      ),
    ]);
    assert.deepEqual((await first.read()).profiles.map((profile) => profile.id).sort(), [
      'first',
      'second',
    ]);
  });

  test('resolves an atomic profile snapshot without waiting for the writer lock', async () => {
    const path = await profilePath();
    const catalog = createFileRuntimeHostProfileCatalog(path, memoryCredentials());
    await catalog.save(remoteProfile('office', 'wss://a.example.com', ROOT_A), 'token-a');
    await mkdir(`${path}.lock`);

    assert.equal((await catalog.resolve('office')).credential, 'token-a');
  });

  test('rejects malformed, secret-bearing, or insecure profile documents', async () => {
    const valid = {
      schemaVersion: 1,
      profiles: [
        {
          id: 'office',
          name: 'Office',
          kind: 'remote',
          transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
          rootId: ROOT_A,
        },
      ],
    };
    assert.throws(
      () =>
        decodeRuntimeHostProfileDocument({
          ...valid,
          profiles: [{ ...valid.profiles[0], credential: 'secret' }],
        }),
      /unknown fields/,
    );
    assert.throws(
      () =>
        decodeRuntimeHostProfileDocument({
          ...valid,
          profiles: [
            {
              ...valid.profiles[0],
              transport: { kind: 'tls', url: 'ws://runtime.example.com/runtime-host' },
            },
          ],
        }),
      /must use wss/,
    );
    assert.throws(
      () =>
        decodeRuntimeHostProfileDocument({
          ...valid,
          profiles: [{ ...valid.profiles[0], rootId: 'unknown' }],
        }),
      /Invalid rootId/,
    );

    const path = await profilePath();
    await writeFile(path, JSON.stringify({ ...valid, extra: true }));
    await assert.rejects(
      () => createFileRuntimeHostProfileCatalog(path, memoryCredentials()).read(),
      {
        message: 'Runtime Host profile document is invalid',
      },
    );
  });

  test('keeps a credential bound to its exact profile target', async () => {
    const path = await profilePath();
    const credentialRoot = join(dirname(path), 'credentials');
    const credentials = createRuntimeHostProfileCredentialStore(
      createFileCredentialStore(credentialRoot),
    );
    const first = createFileRuntimeHostProfileCatalog(path, credentials);
    const second = createFileRuntimeHostProfileCatalog(path, credentials);
    const targetA = remoteProfile('office', 'wss://a.example.com', ROOT_A);
    const targetB = remoteProfile('office', 'wss://b.example.com', ROOT_B);

    await assert.rejects(() => first.save(targetA, 'not a token'), /credential is invalid/);
    await first.save(targetA, 'token-a');
    await assert.rejects(() => first.save(targetB, 'token-b'), /target cannot be changed/);
    await assert.rejects(() => second.save(targetB, 'token-b'), /target cannot be changed/);

    const resolved = await first.resolve('office');
    assert.equal(resolved.credential, 'token-a');

    await credentials.set(targetB, 'token-b');
    assert.equal(await credentials.get(targetA), 'token-a');
    assert.equal(await credentials.get(targetB), 'token-b');
    await credentials.delete(targetB);
    assert.equal(await credentials.get(targetA), 'token-a');
  });

  test('keeps profile metadata when credential removal fails', async () => {
    const path = await profilePath();
    const values = new Map<string, string>();
    const credentials: RuntimeHostProfileCredentialStore = {
      get: async (profile) => values.get(profile.id) ?? null,
      set: async (profile, credential) => {
        values.set(profile.id, credential);
      },
      delete: async () => {
        throw new Error('credential store unavailable');
      },
    };
    const catalog = createFileRuntimeHostProfileCatalog(path, credentials);
    await catalog.save(remoteProfile('office', 'wss://a.example.com', ROOT_A), 'token-a');

    await assert.rejects(() => catalog.remove('office'), /credential store unavailable/);
    assert.deepEqual(
      (await catalog.read()).profiles.map(({ id }) => id),
      ['office'],
    );
  });

  test('restores the prior target when a credential update fails', async () => {
    const path = await profilePath();
    const stored = memoryCredentials();
    let rejectNextSet = false;
    const credentials: RuntimeHostProfileCredentialStore = {
      get: (profile) => stored.get(profile),
      set: async (profile, credential) => {
        if (rejectNextSet) {
          rejectNextSet = false;
          throw new Error('credential store unavailable');
        }
        await stored.set(profile, credential);
      },
      delete: (profile) => stored.delete(profile),
    };
    const catalog = createFileRuntimeHostProfileCatalog(path, credentials);
    const targetA = remoteProfile('office', 'wss://a.example.com', ROOT_A);
    const targetB = { ...targetA, name: 'updated' };
    await catalog.save(targetA, 'token-a');

    rejectNextSet = true;
    await assert.rejects(() => catalog.save(targetB, 'token-b'), /credential store unavailable/);
    assert.deepEqual(await catalog.resolve('office'), {
      profile: {
        ...targetA,
        transport: { kind: 'tls', url: 'wss://a.example.com/' },
      },
      credential: 'token-a',
    });
  });

  test('rejects profile overflow before writing its credential', async () => {
    const path = await profilePath();
    const credentials = memoryCredentials();
    const catalog = createFileRuntimeHostProfileCatalog(path, credentials);
    for (let index = 0; index < 32; index += 1) {
      await catalog.save(
        remoteProfile(`host-${index}`, `wss://host-${index}.example.com`, ROOT_A),
        `token-${index}`,
      );
    }
    const overflow = remoteProfile('overflow', 'wss://overflow.example.com', ROOT_B);

    await assert.rejects(() => catalog.save(overflow, 'overflow-token'), /invalid profile list/);
    assert.equal(await credentials.get(overflow), null);
    assert.equal((await catalog.read()).profiles.length, 32);
  });

  test('connects a remote profile through the canonical connector and readiness gate', async () => {
    let waited = false;
    const connection = { close: async () => undefined } as never;
    assert.equal(
      await connectRemoteRuntimeHostProfile(
        {
          profile: {
            id: 'office',
            name: 'Office',
            kind: 'remote',
            transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
            rootId: ROOT_A,
          },
          credential: 'opaque-token',
          surface: 'tui',
          clientInstanceId: 'client-1',
        },
        {
          connect: async (input) => {
            assert.equal(input.expectedRootId, ROOT_A);
            assert.equal(input.credential, 'opaque-token');
            return { kind: 'connected', connection };
          },
          waitForReady: async (actual) => {
            assert.equal(actual, connection);
            waited = true;
          },
        },
      ),
      connection,
    );
    assert.equal(waited, true);
  });

  test('fails permanently when a remote profile reaches the wrong root', async () => {
    await assert.rejects(
      () =>
        connectRemoteRuntimeHostProfile(
          {
            profile: {
              id: 'office',
              name: 'Office',
              kind: 'remote',
              transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
              rootId: ROOT_A,
            },
            credential: 'opaque-token',
            surface: 'run',
            clientInstanceId: 'client-1',
          },
          {
            connect: async () => ({ kind: 'unavailable', reason: 'root_mismatch' }),
          },
        ),
      RuntimeHostPermanentReconnectError,
    );
  });

  test('reports actionable remote connection failure categories', async () => {
    const reasons = [
      ['authentication_failed', /rejected its access credential/],
      ['tls_failed', /could not verify the TLS connection/],
      ['unreachable', /could not reach its endpoint/],
    ] as const;
    for (const [reason, expected] of reasons) {
      await assert.rejects(
        () =>
          connectRemoteRuntimeHostProfile(
            {
              profile: remoteProfile('office', 'wss://runtime.example.com/', ROOT_A),
              credential: 'opaque-token',
              surface: 'run',
              clientInstanceId: 'client-1',
            },
            { connect: async () => ({ kind: 'unavailable', reason }) },
          ),
        expected,
      );
    }
  });
});

async function profilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-profiles-'));
  temporaryDirectories.push(directory);
  return join(directory, 'profiles.json');
}

function remoteProfile(id: string, url: string, rootId: string): RemoteRuntimeHostProfile {
  return { id, name: id, kind: 'remote', transport: { kind: 'tls', url }, rootId };
}

function memoryCredentials(): RuntimeHostProfileCredentialStore {
  const values = new Map<string, string>();
  const key = (profile: RemoteRuntimeHostProfile) =>
    `${profile.id}\0${profile.transport.kind}\0${profile.transport.url}\0${profile.rootId}`;
  return {
    get: async (profile) => values.get(key(profile)) ?? null,
    set: async (profile, credential) => {
      values.set(key(profile), credential);
    },
    delete: async (profile) => {
      values.delete(key(profile));
    },
  };
}
