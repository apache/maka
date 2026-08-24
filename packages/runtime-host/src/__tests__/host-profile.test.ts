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

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createFileCredentialStore } from '@maka/storage';
import {
  RUNTIME_HOST_REMOTE_INCOMPATIBLE_CODE,
  RuntimeHostRemoteCompatibilityError,
} from '../client/index.js';
import {
  connectRemoteRuntimeHostProfile,
  createFileRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
  decodeRuntimeHostProfileDocument,
  RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT,
  type RemoteRuntimeHostProfile,
  type RuntimeHostProfileCredentialStore,
} from '../client/host-profile.js';
import { RuntimeHostPermanentReconnectError } from '../client/reconnect-lifecycle.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostIncompatible,
} from '../protocol/index.js';

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

  test('conditionally removes only the exact profile target it created', async () => {
    const path = await profilePath();
    const credentials = memoryCredentials();
    const desktop = createFileRuntimeHostProfileCatalog(path, credentials);
    const cli = createFileRuntimeHostProfileCatalog(path, credentials);
    const profile = remoteProfile('office', 'wss://runtime.example.com', ROOT_A);

    await desktop.create(profile, 'desktop-token');
    const created = await desktop.resolve(profile.id);
    await assert.rejects(() => cli.create(profile, 'duplicate-token'), /new profile id/u);
    await cli.save({ ...profile, name: 'Rotated' }, 'rotated-token');

    assert.deepEqual(await desktop.removeIfCurrent(created), {
      removed: false,
      document: {
        schemaVersion: 1,
        profiles: [
          {
            ...profile,
            name: 'Rotated',
            transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
          },
        ],
      },
    });
    const rotated = await desktop.resolve(profile.id);
    assert.equal(rotated.credential, 'rotated-token');
    assert.equal((await desktop.removeIfCurrent(rotated)).removed, true);
    assert.deepEqual(await desktop.read(), { schemaVersion: 1, profiles: [] });
  });

  test('conditionally updates one Host connection and credential', async () => {
    const path = await profilePath();
    const credentials = memoryCredentials();
    const desktop = createFileRuntimeHostProfileCatalog(path, credentials);
    const external = createFileRuntimeHostProfileCatalog(path, credentials);
    const original = remoteProfile('office', 'wss://runtime.example.com', ROOT_A);
    const replacement = { ...original, name: 'Renamed office' };

    await desktop.create(original, 'old-token');
    const expected = await desktop.resolve(original.id);
    assert.equal((await desktop.rebindIfCurrent(expected, replacement, 'new-token')).rebound, true);
    assert.deepEqual(await desktop.resolve(original.id), {
      profile: {
        ...replacement,
        transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
      },
      credential: 'new-token',
    });

    await external.save({ ...replacement, name: 'Externally updated' }, 'external-token');
    assert.equal((await desktop.rebindIfCurrent(expected, original, 'stale-token')).rebound, false);
    assert.equal((await desktop.resolve(original.id)).credential, 'external-token');
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
          profiles: [
            {
              ...valid.profiles[0],
              transport: {
                kind: 'plaintext',
                url: 'ws://runtime.example.com/runtime-host',
                acknowledgement: 'missing',
              },
            },
          ],
        }),
      /requires explicit acknowledgement/,
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

  test('connects plaintext only from a persistently acknowledged profile', async () => {
    const connection = { close: async () => undefined } as never;
    await connectRemoteRuntimeHostProfile(
      {
        profile: {
          id: 'lab',
          name: 'Lab',
          kind: 'remote',
          transport: {
            kind: 'plaintext',
            url: 'ws://192.0.2.10:7443/runtime-host',
            acknowledgement: RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT,
          },
          rootId: ROOT_A,
        },
        credential: 'opaque-token',
        clientInstanceId: 'client-1',
      },
      {
        connect: async (input) => {
          assert.equal(input.url, 'ws://192.0.2.10:7443/runtime-host');
          assert.equal(input.allowInsecureRemote, true);
          return { kind: 'connected', connection };
        },
        waitForReady: async () => undefined,
      },
    );
  });

  test('binds one SSH tunnel resource to the remote connection attempt', async () => {
    let tunnelClosed = false;
    const resource = {
      closed: new Promise<void>(() => undefined),
      close: async () => {
        tunnelClosed = true;
      },
    };
    const connection = { close: async () => undefined } as never;
    await connectRemoteRuntimeHostProfile(
      {
        profile: {
          id: 'ssh-lab',
          name: 'SSH Lab',
          kind: 'remote',
          transport: {
            kind: 'ssh',
            destination: 'operator@example.com',
            sshPort: 2222,
            remotePort: 7443,
            websocketPath: '/runtime-host',
          },
          rootId: ROOT_A,
        },
        credential: 'opaque-token',
        clientInstanceId: 'client-1',
        sshInteraction: 'inherit',
      },
      {
        openSshTunnel: async (input) => {
          assert.equal(input.destination, 'operator@example.com');
          assert.equal(input.interaction, 'inherit');
          return { url: 'ws://127.0.0.1:43210/runtime-host', resource };
        },
        connect: async (input) => {
          assert.equal(input.url, 'ws://127.0.0.1:43210/runtime-host');
          assert.equal(input.connectionResource, resource);
          return { kind: 'connected', connection };
        },
        waitForReady: async () => undefined,
      },
    );
    assert.equal(tunnelClosed, false);
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
            clientInstanceId: 'client-1',
          },
          {
            connect: async () => ({ kind: 'unavailable', reason: 'root_mismatch' }),
          },
        ),
      RuntimeHostPermanentReconnectError,
    );
  });

  test('reports an incompatible remote Host with redacted compatibility details before readiness', async () => {
    const credential = 'credential-secret';
    const endpoint = 'wss://endpoint-secret.example.com/runtime-host';
    const rootId = 'state-root-secret';
    const handshake = incompatibleHandshake({
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 2,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 3,
      compositionId: 'maka.different-composition',
      compositionRevision: 'composition-revision-secret',
    });
    let attempts = 0;
    let enteredReadiness = false;

    await assert.rejects(
      () =>
        connectRemoteRuntimeHostProfile(
          {
            profile: remoteProfile('office', endpoint, rootId),
            credential,
            clientInstanceId: 'client-1',
          },
          {
            connect: async () => {
              attempts += 1;
              return { kind: 'incompatible', handshake };
            },
            waitForReady: async () => {
              enteredReadiness = true;
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeHostRemoteCompatibilityError);
        assert.ok(error instanceof RuntimeHostPermanentReconnectError);
        assert.equal(error.code, RUNTIME_HOST_REMOTE_INCOMPATIBLE_CODE);
        assert.deepEqual(error.details, {
          profileId: 'office',
          client: {
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
            protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
            compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
          },
          host: {
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
            protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 2,
            protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 3,
            compositionId: 'maka.different-composition',
            compositionRevision: 'composition-revision-secret',
          },
        });
        assert.deepEqual(Object.keys(error.details), ['profileId', 'client', 'host']);
        assert.match(error.message, /RUNTIME_HOST_REMOTE_INCOMPATIBLE/u);
        assert.match(error.message, /office/u);
        assert.match(
          error.message,
          new RegExp(`Client compatibility epoch ${RUNTIME_HOST_COMPATIBILITY_EPOCH}`, 'u'),
        );
        assert.match(
          error.message,
          new RegExp(`Host compatibility epoch ${RUNTIME_HOST_COMPATIBILITY_EPOCH - 1}`, 'u'),
        );
        assert.match(
          error.message,
          new RegExp(
            `Client protocol range ${RUNTIME_HOST_PROTOCOL_VERSION}-${RUNTIME_HOST_PROTOCOL_VERSION}`,
            'u',
          ),
        );
        assert.match(
          error.message,
          new RegExp(
            `Host protocol range ${RUNTIME_HOST_PROTOCOL_VERSION + 2}-${RUNTIME_HOST_PROTOCOL_VERSION + 3}`,
            'u',
          ),
        );
        assert.match(error.message, /maka\.interactive/u);
        assert.match(error.message, /maka\.different-composition/u);
        assert.match(error.message, /composition-revision-secret/u);
        assert.match(error.message, /compatible Client and Host builds/u);
        assert.match(
          error.message,
          /restart the remote Runtime Host service after updating the Host/u,
        );
        assert.match(error.message, /retry/u);
        for (const secret of [
          credential,
          endpoint,
          rootId,
          handshake.hostEpoch,
          handshake.generation!,
          handshake.state,
          handshake.replacement,
          'activity-secret',
        ]) {
          assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
          assert.equal(JSON.stringify(error.details).includes(secret), false);
        }
        return true;
      },
    );

    assert.equal(attempts, 1);
    assert.equal(enteredReadiness, false);
  });

  test('includes protocol ranges only when Client and Host ranges do not overlap', async () => {
    const overlapping = new RuntimeHostRemoteCompatibilityError(
      'office',
      incompatibleHandshake({ protocolMin: RUNTIME_HOST_PROTOCOL_VERSION }),
    );
    const disjoint = new RuntimeHostRemoteCompatibilityError(
      'office',
      incompatibleHandshake({
        protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 1,
        protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 2,
      }),
    );

    assert.doesNotMatch(overlapping.message, /protocol range/u);
    assert.match(disjoint.message, /Client protocol range 0-0/u);
    assert.match(disjoint.message, /Host protocol range 1-2/u);
  });

  test('includes composition fields only when the Client and Host composition ids differ', async () => {
    const matching = new RuntimeHostRemoteCompatibilityError(
      'office',
      incompatibleHandshake({ compositionRevision: 'other-revision' }),
    );
    const different = new RuntimeHostRemoteCompatibilityError(
      'office',
      incompatibleHandshake({
        compositionId: 'maka.different-composition',
        compositionRevision: 'other-revision',
      }),
    );

    assert.doesNotMatch(matching.message, /composition id/u);
    assert.doesNotMatch(matching.message, /other-revision/u);
    assert.match(different.message, /Client composition id maka\.interactive/u);
    assert.match(different.message, /Host composition id maka\.different-composition/u);
    assert.match(different.message, /Host composition revision other-revision/u);
  });

  test('sanitizes Host composition identity only in the human-readable message', () => {
    const compositionId = 'maka.different\u001b[31m\u202eline\u2066isolate';
    const compositionRevision =
      'stable\u0085forged\u2028line\u2029paragraph\u202eoverride\u2066isolate\u00adsoft';
    const error = new RuntimeHostRemoteCompatibilityError(
      'office',
      incompatibleHandshake({
        compositionId,
        compositionRevision,
      }),
    );

    assert.equal(error.details.host.compositionId, compositionId);
    assert.equal(error.details.host.compositionRevision, compositionRevision);
    assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu);
    assert.match(error.message, /Host composition id maka\.different�\[31m�line�isolate/u);
    assert.match(
      error.message,
      /Host composition revision stable�forged�line�paragraph�override�isolate�soft/u,
    );
  });

  test('treats rejected remote credentials as a terminal profile failure', async () => {
    await assert.rejects(
      () =>
        connectRemoteRuntimeHostProfile(
          {
            profile: remoteProfile('office', 'wss://runtime.example.com/', ROOT_A),
            credential: 'revoked-token',
            clientInstanceId: 'client-1',
          },
          { connect: async () => ({ kind: 'unavailable', reason: 'authentication_failed' }) },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeHostPermanentReconnectError);
        assert.match(error.message, /rejected its access credential/u);
        return true;
      },
    );
  });

  test('reports retryable remote connection failure categories', async () => {
    const reasons = [
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
              clientInstanceId: 'client-1',
            },
            { connect: async () => ({ kind: 'unavailable', reason }) },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error instanceof RuntimeHostPermanentReconnectError, false);
          assert.match(error.message, expected);
          return true;
        },
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
    `${profile.id}\0${JSON.stringify(profile.transport)}\0${profile.rootId}`;
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

function incompatibleHandshake(overrides: Partial<HostIncompatible> = {}): HostIncompatible {
  return {
    kind: 'incompatible',
    hostEpoch: 'host-epoch-secret',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'host-composition-revision',
    generation: 'generation-secret',
    state: 'ready',
    replacement: 'blocked_by_residency',
    activity: {
      connections: 1,
      activeOperations: 1,
      processUptimeSeconds: 1,
      residencies: [{ label: 'activity-secret', count: 1 }],
    },
    ...overrides,
  };
}
