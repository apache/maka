import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRuntimeHostCandidateArguments } from '../candidate-cli.js';

test('parses packaged Git and npm authorities for the detached execution candidate', () => {
  assert.deepEqual(
    parseRuntimeHostCandidateArguments([
      '--root',
      '/storage',
      '--expected-root-id',
      'a'.repeat(64),
      '--bundled-git-resources-root',
      '/resources',
      '--bundled-npm-resources-root',
      '/resources',
      '--dependency-node-executable-path',
      '/app/Maka',
    ]),
    {
      rootPath: '/storage',
      expectedRootId: 'a'.repeat(64),
      idleGraceMs: undefined,
      handshakeTimeoutMs: undefined,
      bundledGitResourcesRoot: '/resources',
      bundledNpmResourcesRoot: '/resources',
      dependencyNodeExecutablePath: '/app/Maka',
    },
  );
});

test('rejects duplicate packaged authority arguments', () => {
  assert.throws(
    () =>
      parseRuntimeHostCandidateArguments([
        '--root',
        '/storage',
        '--expected-root-id',
        'a'.repeat(64),
        '--bundled-npm-resources-root',
        '/one',
        '--bundled-npm-resources-root',
        '/two',
      ]),
    /Invalid Runtime Host candidate argument/u,
  );
});
