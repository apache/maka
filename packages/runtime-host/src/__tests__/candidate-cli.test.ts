import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInteractiveRuntimeHostCandidateArguments } from '../candidate-cli.js';

const ROOT_ID = 'a'.repeat(64);
const STARTUP_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';

test('parses the production candidate flags without a desktop E2E override', () => {
  const parsed = parseInteractiveRuntimeHostCandidateArguments([
    '--root',
    '/tmp/workspace',
    '--expected-root-id',
    ROOT_ID,
    '--startup-attempt-id',
    STARTUP_ATTEMPT_ID,
    '--idle-grace-ms',
    '10000',
  ]);
  assert.equal(parsed.rootPath, '/tmp/workspace');
  assert.equal(parsed.expectedRootId, ROOT_ID);
  assert.equal(parsed.startupAttemptId, STARTUP_ATTEMPT_ID);
  assert.equal(parsed.idleGraceMs, 10_000);
  assert.equal(parsed.desktopE2e, undefined);
});

test('parses the desktop E2E composition flag', () => {
  const parsed = parseInteractiveRuntimeHostCandidateArguments([
    '--root',
    '/tmp/workspace',
    '--expected-root-id',
    ROOT_ID,
    '--startup-attempt-id',
    STARTUP_ATTEMPT_ID,
    '--desktop-e2e',
    '1',
  ]);
  assert.equal(parsed.desktopE2e, true);
});

test('rejects an unknown desktop E2E flag value', () => {
  assert.throws(
    () =>
      parseInteractiveRuntimeHostCandidateArguments([
        '--root',
        '/tmp/workspace',
        '--expected-root-id',
        ROOT_ID,
        '--startup-attempt-id',
        STARTUP_ATTEMPT_ID,
        '--desktop-e2e',
        'true',
      ]),
    /Invalid --desktop-e2e/,
  );
});
