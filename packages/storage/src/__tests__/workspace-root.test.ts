import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deriveMakaDataRoots,
  resolveMakaClientDataRoot,
  resolveMakaWorkspaceRoot,
} from '../workspace-root.js';

describe('Maka workspace root resolver', () => {
  test('resolves Client-owned data outside every Host State Root', () => {
    assert.equal(
      resolveMakaClientDataRoot({ platform: 'linux', homeDir: '/home/ada', env: {} }),
      '/home/ada/.config/Maka',
    );
  });

  test('resolves release and development profiles under each platform application-data root', () => {
    const cases = [
      [
        { platform: 'darwin', homeDir: '/Users/ada', env: {} },
        '/Users/ada/Library/Application Support',
      ],
      [{ platform: 'linux', homeDir: '/home/ada', env: {} }, '/home/ada/.config'],
      [
        {
          platform: 'win32',
          homeDir: 'C:\\Users\\Ada',
          env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
        },
        'C:\\Users\\Ada\\AppData\\Roaming',
      ],
    ] as const;

    for (const [options, base] of cases) {
      const separator = options.platform === 'win32' ? '\\' : '/';
      for (const profileName of ['Maka', 'Maka Dev']) {
        const clientDataRoot = `${base}${separator}${profileName}`;
        assert.equal(
          resolveMakaClientDataRoot({ ...options, profileName }),
          clientDataRoot,
          `${options.platform} ${profileName} Client Data Root`,
        );
        assert.equal(
          resolveMakaWorkspaceRoot({ ...options, profileName }),
          `${clientDataRoot}${separator}workspaces${separator}default`,
          `${options.platform} ${profileName} Workspace Root`,
        );
      }
    }
  });

  test('derives all subordinate roots from an exact Client Data Root', () => {
    assert.deepEqual(deriveMakaDataRoots('/custom/maka-profile', { platform: 'linux' }), {
      clientDataRoot: '/custom/maka-profile',
      workspaceRoot: '/custom/maka-profile/workspaces/default',
    });
  });

  test('honors Linux XDG_CONFIG_HOME and falls back from Windows APPDATA', () => {
    assert.equal(
      resolveMakaClientDataRoot({
        platform: 'linux',
        homeDir: '/home/ada',
        env: { XDG_CONFIG_HOME: '/var/config/ada' },
        profileName: 'Maka Dev',
      }),
      '/var/config/ada/Maka Dev',
    );
    assert.equal(
      resolveMakaClientDataRoot({
        platform: 'win32',
        homeDir: 'C:\\Users\\Ada',
        env: {},
        profileName: 'Maka Dev',
      }),
      'C:\\Users\\Ada\\AppData\\Roaming\\Maka Dev',
    );
  });

  test('rejects a profile name that can escape its application-data root', () => {
    for (const profileName of ['', '.', '..', 'Maka/Dev', 'Maka\\Dev', 'Maka\0Dev']) {
      assert.throws(
        () =>
          resolveMakaClientDataRoot({
            platform: 'linux',
            homeDir: '/home/ada',
            env: {},
            profileName,
          }),
        /non-empty path segment/,
        JSON.stringify(profileName),
      );
    }
  });
});
