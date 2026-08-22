import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ELECTION_DEADLINE_MS_ENV_VAR,
  connectOrSpawnRuntimeHostWithDependencies,
  electionDeadlineMsFromEnvironment,
} from '../client/connect-or-spawn.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';

test('treats an unset or blank override as unconfigured', () => {
  assert.equal(electionDeadlineMsFromEnvironment(undefined), undefined);
  assert.equal(electionDeadlineMsFromEnvironment(''), undefined);
  assert.equal(electionDeadlineMsFromEnvironment('   '), undefined);
});

test('parses a valid millisecond override', () => {
  assert.equal(electionDeadlineMsFromEnvironment('90000'), 90_000);
  assert.equal(electionDeadlineMsFromEnvironment(' 5000 '), 5_000);
});

test('fails closed on an invalid override instead of silently ignoring it', () => {
  for (const invalid of ['abc', '0', '-100', '120001', '1.5']) {
    assert.throws(() => electionDeadlineMsFromEnvironment(invalid), RangeError);
  }
  assert.throws(
    () => electionDeadlineMsFromEnvironment('abc'),
    new RegExp(`${ELECTION_DEADLINE_MS_ENV_VAR} must be an integer`, 'u'),
  );
});

test('an invalid environment override fails the election before touching storage', async () => {
  await assert.rejects(
    connectOrSpawnRuntimeHostWithDependencies(
      {
        rootPath: '/nonexistent-maka-3474-root',
        protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        candidateEntrypoint: 'candidate-entry.js',
      },
      {
        launchCandidate: () => ({ spawned: Promise.reject(new Error('must not spawn')) }),
        random: Math.random,
        env: { [ELECTION_DEADLINE_MS_ENV_VAR]: 'not-a-number' },
      },
    ),
    (error: unknown) =>
      error instanceof RangeError && /MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS/u.test(error.message),
  );
});
