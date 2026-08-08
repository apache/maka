import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveMakaWorkspaceRoot } from '../workspace-root.js';

describe('Maka workspace root resolver', () => {
  test('resolves each platform under its canonical application-data root', () => {
    const cases = [
      [
        { platform: 'darwin', homeDir: '/Users/ada', env: {} },
        '/Users/ada/Library/Application Support/Maka/workspaces/default',
      ],
      [
        { platform: 'linux', homeDir: '/home/ada', env: {} },
        '/home/ada/.config/Maka/workspaces/default',
      ],
      [
        {
          platform: 'win32',
          homeDir: 'C:\\Users\\Ada',
          env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
        },
        'C:\\Users\\Ada\\AppData\\Roaming\\Maka\\workspaces\\default',
      ],
    ] as const;

    for (const [options, expected] of cases) {
      assert.equal(resolveMakaWorkspaceRoot(options), expected, options.platform);
    }
  });
});
