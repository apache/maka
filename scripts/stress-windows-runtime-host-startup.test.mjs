import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWindowsRuntimeHostStartupStressOptions,
  runWindowsRuntimeHostStartupIteration,
  stressWindowsRuntimeHostStartup,
} from './stress-windows-runtime-host-startup.mjs';

test('parses bounded Runtime Host startup stress options', () => {
  assert.deepEqual(
    parseWindowsRuntimeHostStartupStressOptions([
      '--iterations',
      '12',
      '--parallel',
      '3',
      '--election-deadline-ms',
      '5000',
      '--settle-timeout-ms',
      '2000',
      '--keep-failures',
    ]),
    {
      iterations: 12,
      parallel: 3,
      electionDeadlineMs: 5_000,
      settleTimeoutMs: 2_000,
      keepFailures: true,
    },
  );
  assert.throws(
    () => parseWindowsRuntimeHostStartupStressOptions(['--parallel', '0']),
    /--parallel must be an integer between 1 and 64/u,
  );
  assert.throws(
    () => parseWindowsRuntimeHostStartupStressOptions(['--unknown', '1']),
    /Unknown option/u,
  );
  assert.deepEqual(parseWindowsRuntimeHostStartupStressOptions(['8', '2', '12000', '5000']), {
    iterations: 8,
    parallel: 2,
    electionDeadlineMs: 12_000,
    settleTimeoutMs: 5_000,
    keepFailures: false,
  });
});

test('bounds startup stress concurrency and reports every failure', async () => {
  let active = 0;
  let maximumActive = 0;
  const written = [];
  const { results, summary } = await stressWindowsRuntimeHostStartup(
    {
      iterations: 5,
      parallel: 2,
      electionDeadlineMs: 100,
      settleTimeoutMs: 100,
      keepFailures: false,
    },
    {
      async runIteration(iteration) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return iteration === 3
          ? { iteration, kind: 'failed', reason: 'host_unresponsive' }
          : { iteration, kind: 'connected' };
      },
      write: (record) => written.push(record),
    },
  );

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    results.map(({ iteration, kind }) => ({ iteration, kind })),
    [
      { iteration: 1, kind: 'connected' },
      { iteration: 2, kind: 'connected' },
      { iteration: 3, kind: 'failed' },
      { iteration: 4, kind: 'connected' },
      { iteration: 5, kind: 'connected' },
    ],
  );
  assert.deepEqual(summary, { kind: 'summary', iterations: 5, connected: 4, failed: 1 });
  assert.equal(written.length, 6);
  assert.deepEqual(written.at(-1), summary);
});

test('reports a rejected Candidate spawn without losing the stress summary', async () => {
  const written = [];
  const options = {
    iterations: 1,
    parallel: 1,
    electionDeadlineMs: 100,
    settleTimeoutMs: 100,
    keepFailures: false,
  };
  const runIteration = (iteration, iterationOptions) =>
    runWindowsRuntimeHostStartupIteration(iteration, iterationOptions, {
      loadModules: async () => ({
        connectOrSpawnRuntimeHostWithDependencies: async (_input, dependencies) => {
          const launch = dependencies.launchCandidate({});
          await launch.spawned.catch(() => undefined);
          return { kind: 'failed', reason: 'startup_timeout' };
        },
        interactiveCompositionId: 'test-composition',
        launchOwnedRuntimeHostCandidate: () => ({
          spawned: Promise.reject(new Error('spawn refused')),
        }),
        protocolVersion: 1,
      }),
    });

  const { results, summary } = await stressWindowsRuntimeHostStartup(options, {
    runIteration,
    write: (record) => written.push(record),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].iteration, 1);
  assert.equal(results[0].kind, 'failed');
  assert.equal(results[0].reason, 'startup_timeout');
  assert.equal(written[0], results[0]);
  assert.deepEqual(summary, { kind: 'summary', iterations: 1, connected: 0, failed: 1 });
  assert.equal(written.length, 2);
  assert.deepEqual(written.at(-1), summary);
});
