import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  RemoteRuntimeHostProfile,
  RuntimeHostProfileCatalog,
  RuntimeHostProfileDocument,
} from '@maka/runtime-host/client';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { runRuntimeHostProfileCommand } from '../runtime-host-profile-command.js';

const ROOT_ID = 'a'.repeat(64);

describe('Runtime Host profile CLI', () => {
  test('parses profile management without accepting credential material on argv', () => {
    assert.deepEqual(parseRuntimeHostCommand(['profile', 'list']), {
      kind: 'runtime-host-profile-list',
    });
    assert.deepEqual(
      parseRuntimeHostCommand([
        'profile',
        'set',
        '--id',
        'office',
        '--name',
        'Office',
        '--url',
        'wss://runtime.example.com',
        '--expected-root',
        ROOT_ID,
        '--credential-env',
        'OFFICE_HOST_TOKEN',
      ]),
      {
        kind: 'runtime-host-profile-set',
        id: 'office',
        name: 'Office',
        url: 'wss://runtime.example.com',
        expectedRootId: ROOT_ID,
        credentialEnv: 'OFFICE_HOST_TOKEN',
      },
    );
    assert.deepEqual(parseRuntimeHostCommand(['profile', 'remove', '--id', 'office']), {
      kind: 'runtime-host-profile-remove',
      id: 'office',
    });
    assert.equal(
      parseRuntimeHostCommand(['profile', 'set', '--credential', 'secret']).kind,
      'error',
    );
  });

  test('stores credential separately and never writes it to command output', async () => {
    const state = createProfileState();
    const output: string[] = [];
    assert.equal(
      await runRuntimeHostProfileCommand(
        {
          kind: 'set',
          id: 'office',
          name: 'Office',
          url: 'wss://runtime.example.com',
          expectedRootId: ROOT_ID,
          credentialEnv: 'OFFICE_HOST_TOKEN',
        },
        {
          catalog: state.catalog,
          env: { OFFICE_HOST_TOKEN: 'opaque-token' },
          write: (value) => output.push(value),
        },
      ),
      0,
    );
    assert.equal(state.secrets.get('office'), 'opaque-token');
    assert.equal(output.join('').includes('opaque-token'), false);
    assert.equal(JSON.stringify(state.document).includes('opaque-token'), false);

    output.length = 0;
    await runRuntimeHostProfileCommand(
      { kind: 'list' },
      {
        catalog: state.catalog,
        env: {},
        write: (value) => output.push(value),
      },
    );
    assert.deepEqual(
      (JSON.parse(output.join('')) as Array<{ id: string }>).map((profile) => profile.id),
      ['local', 'office'],
    );
  });
});

function createProfileState(): {
  document: RuntimeHostProfileDocument;
  catalog: RuntimeHostProfileCatalog;
  secrets: Map<string, string>;
} {
  const state = {
    document: { schemaVersion: 1, profiles: [] } as RuntimeHostProfileDocument,
  };
  const secrets = new Map<string, string>();
  const catalog: RuntimeHostProfileCatalog = {
    read: async () => state.document,
    resolve: async (profileId) => {
      if (!profileId || profileId === 'local') {
        return { profile: { id: 'local', name: 'Local', kind: 'local' } };
      }
      const profile = state.document.profiles.find((candidate) => candidate.id === profileId);
      if (!profile) throw new Error(`Unknown Runtime Host profile: ${profileId}`);
      const credential = secrets.get(profile.id);
      if (!credential) throw new Error(`Runtime Host profile ${profile.id} has no credential`);
      return { profile, credential };
    },
    save: async (profile: RemoteRuntimeHostProfile, credential?: string) => {
      if (credential) secrets.set(profile.id, credential);
      if (!secrets.has(profile.id)) throw new Error('credential required');
      state.document = {
        schemaVersion: 1,
        profiles: [
          ...state.document.profiles.filter((candidate) => candidate.id !== profile.id),
          profile,
        ],
      };
      return state.document;
    },
    remove: async (profileId) => {
      state.document = {
        schemaVersion: 1,
        profiles: state.document.profiles.filter((profile) => profile.id !== profileId),
      };
      secrets.delete(profileId);
      return state.document;
    },
  };
  return {
    get document() {
      return state.document;
    },
    catalog,
    secrets,
  };
}
