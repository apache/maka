import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createFileCredentialStore } from '@maka/storage';
import {
  LOCAL_RUNTIME_HOST_PROFILE,
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
    assert.deepEqual(LOCAL_RUNTIME_HOST_PROFILE, {
      id: 'local',
      name: 'Local',
      kind: 'local',
    });

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
          url: 'wss://runtime.example.com',
          rootId: ROOT_A,
        },
        'office-token',
      ),
      catalog.save(
        {
          id: 'loopback',
          name: 'Loopback',
          kind: 'remote',
          url: 'ws://127.0.0.1:4000/runtime-host',
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
        url: 'wss://new.example.com/runtime-host',
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
          url: 'wss://new.example.com/runtime-host',
          rootId: ROOT_A,
        },
        {
          id: 'loopback',
          name: 'Loopback',
          kind: 'remote',
          url: 'ws://127.0.0.1:4000/runtime-host',
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
          id: 'loopback',
          name: 'Loopback',
          kind: 'remote',
          url: 'ws://127.0.0.1:4000/runtime-host',
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
          url: 'wss://first.example.com',
          rootId: ROOT_A,
        },
        'first-token',
      ),
      second.save(
        {
          id: 'second',
          name: 'Second',
          kind: 'remote',
          url: 'wss://second.example.com',
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

  test('rejects malformed, secret-bearing, or insecure profile documents', async () => {
    const valid = {
      schemaVersion: 1,
      profiles: [
        {
          id: 'office',
          name: 'Office',
          kind: 'remote',
          url: 'wss://runtime.example.com/runtime-host',
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
          profiles: [{ ...valid.profiles[0], url: 'ws://runtime.example.com/runtime-host' }],
        }),
      /must use loopback/,
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

  test('keeps credential material behind the credential port', async () => {
    const values = new Map<string, string>();
    const credentials = createRuntimeHostProfileCredentialStore({
      getSecret: async (slug, kind) => values.get(`${slug}:${kind}`) ?? null,
      setSecret: async (slug, kind, value) => {
        values.set(`${slug}:${kind}`, value);
      },
      deleteSecret: async (slug, kind) => {
        values.delete(`${slug}:${kind}`);
      },
    });
    const profile = remoteProfile('office', 'wss://runtime.example.com', ROOT_A);
    await credentials.set(profile, 'opaque-token');
    assert.equal(await credentials.get(profile), 'opaque-token');
    assert.equal([...values.keys()][0]?.startsWith('runtime-host-profile:office:'), true);
    assert.equal([...values.keys()][0]?.endsWith(':runtime_host_access'), true);
    await credentials.delete(profile);
    assert.equal(await credentials.get(profile), null);
    await assert.rejects(() => credentials.set(profile, 'not a token'), /credential is invalid/);
  });

  test('keeps a credential bound to its exact profile target', async () => {
    const path = await profilePath();
    const credentialRoot = join(dirname(path), 'credentials');
    const first = createFileRuntimeHostProfileCatalog(
      path,
      createRuntimeHostProfileCredentialStore(createFileCredentialStore(credentialRoot)),
    );
    const second = createFileRuntimeHostProfileCatalog(
      path,
      createRuntimeHostProfileCredentialStore(createFileCredentialStore(credentialRoot)),
    );
    const targetA = remoteProfile('office', 'wss://a.example.com', ROOT_A);
    const targetB = remoteProfile('office', 'wss://b.example.com', ROOT_B);

    await first.save(targetA, 'token-a');
    await assert.rejects(() => first.save(targetB), /new.*credential.*target changes/i);
    await Promise.all([first.save(targetA, 'token-a'), second.save(targetB, 'token-b')]);

    const resolved = await first.resolve('office');
    assert.equal(resolved.profile.kind, 'remote');
    assert.equal(
      [`wss://a.example.com/|token-a`, `wss://b.example.com/|token-b`].includes(
        `${resolved.profile.kind === 'remote' ? resolved.profile.url : ''}|${resolved.credential}`,
      ),
      true,
    );
  });

  test('commits profile removal before best-effort credential cleanup', async () => {
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

    assert.deepEqual(await catalog.remove('office'), { schemaVersion: 1, profiles: [] });
    assert.deepEqual(await catalog.read(), { schemaVersion: 1, profiles: [] });
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
            url: 'wss://runtime.example.com/',
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
              url: 'wss://runtime.example.com/',
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
});

async function profilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-profiles-'));
  temporaryDirectories.push(directory);
  return join(directory, 'profiles.json');
}

function remoteProfile(id: string, url: string, rootId: string): RemoteRuntimeHostProfile {
  return { id, name: id, kind: 'remote', url, rootId };
}

function memoryCredentials(): RuntimeHostProfileCredentialStore {
  const values = new Map<string, string>();
  const key = (profile: RemoteRuntimeHostProfile) =>
    `${profile.id}\0${profile.url}\0${profile.rootId}`;
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
