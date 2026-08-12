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
        '--tls-url',
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
        tlsUrl: 'wss://runtime.example.com',
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

  test('passes the credential to the catalog without writing it to command output', async () => {
    const state = createProfileCatalogCapture();
    const output: string[] = [];
    assert.equal(
      await runRuntimeHostProfileCommand(
        {
          kind: 'set',
          id: 'office',
          name: 'Office',
          tlsUrl: 'wss://runtime.example.com',
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
    assert.equal(state.saved[0]?.credential, 'opaque-token');
    assert.equal(output.join('').includes('opaque-token'), false);
    assert.equal(JSON.stringify(state.saved[0]?.profile).includes('opaque-token'), false);

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

function createProfileCatalogCapture(): {
  document: RuntimeHostProfileDocument;
  catalog: RuntimeHostProfileCatalog;
  saved: Array<{ profile: RemoteRuntimeHostProfile; credential?: string }>;
} {
  const state = {
    document: { schemaVersion: 1, profiles: [] } as RuntimeHostProfileDocument,
  };
  const saved: Array<{ profile: RemoteRuntimeHostProfile; credential?: string }> = [];
  const catalog: RuntimeHostProfileCatalog = {
    read: async () => state.document,
    resolve: async () => assert.fail('unexpected profile resolution'),
    create: async () => assert.fail('unexpected profile creation'),
    save: async (profile: RemoteRuntimeHostProfile, credential?: string) => {
      saved.push({ profile, credential });
      state.document = {
        schemaVersion: 1,
        profiles: [
          ...state.document.profiles.filter((candidate) => candidate.id !== profile.id),
          profile,
        ],
      };
      return state.document;
    },
    remove: async () => assert.fail('unexpected profile removal'),
    removeIfCurrent: async () => assert.fail('unexpected conditional profile removal'),
    commitIfCurrentTarget: async () => assert.fail('unexpected conditional profile commit'),
  };
  return {
    get document() {
      return state.document;
    },
    catalog,
    saved,
  };
}
