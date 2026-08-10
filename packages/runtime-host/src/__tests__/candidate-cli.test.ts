import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInteractiveRuntimeHostCandidateArguments } from '../candidate-cli.js';

test('accepts an absolute legacy configuration root for the elected Candidate', () => {
  assert.deepEqual(
    parseInteractiveRuntimeHostCandidateArguments([
      '--root',
      '/runtime-host-root',
      '--expected-root-id',
      'a'.repeat(64),
      '--legacy-configuration-root',
      '/legacy-configuration',
    ]),
    {
      rootPath: '/runtime-host-root',
      expectedRootId: 'a'.repeat(64),
      legacyConfigurationRoot: '/legacy-configuration',
      idleGraceMs: undefined,
      handshakeTimeoutMs: undefined,
    },
  );
  assert.throws(
    () =>
      parseInteractiveRuntimeHostCandidateArguments([
        '--root',
        '/runtime-host-root',
        '--expected-root-id',
        'a'.repeat(64),
        '--legacy-configuration-root',
        'relative/configuration',
      ]),
    /Invalid --legacy-configuration-root/,
  );
});
