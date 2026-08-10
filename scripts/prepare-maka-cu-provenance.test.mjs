import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveMakaCuSourceBranch } from './prepare-maka-cu-provenance.mjs';

test('an attached source branch is recorded directly', () => {
  assert.equal(
    resolveMakaCuSourceBranch({
      currentBranch: 'codex/webcontent-native-actions',
      remoteBranches: ['origin/maka/base'],
    }),
    'codex/webcontent-native-actions',
  );
});

test('a detached source commit records its one matching remote branch', () => {
  assert.equal(
    resolveMakaCuSourceBranch({
      currentBranch: 'HEAD',
      remoteBranches: ['origin', 'origin/HEAD', 'origin/maka/base'],
    }),
    'maka/base',
  );
});

test('an explicit source branch overrides detached ambiguity', () => {
  assert.equal(
    resolveMakaCuSourceBranch({
      currentBranch: 'HEAD',
      remoteBranches: ['origin/maka/base', 'fork/release'],
      explicitBranch: 'maka/base',
    }),
    'maka/base',
  );
});

test('a detached source commit fails closed without a unique branch', () => {
  assert.throws(
    () =>
      resolveMakaCuSourceBranch({
        currentBranch: 'HEAD',
        remoteBranches: [],
      }),
    /no matching remote branch/,
  );
  assert.throws(
    () =>
      resolveMakaCuSourceBranch({
        currentBranch: 'HEAD',
        remoteBranches: ['origin/maka/base', 'fork/release'],
      }),
    /multiple remote branches/,
  );
});
