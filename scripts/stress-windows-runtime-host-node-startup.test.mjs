import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseWindowsRuntimeHostNodeStartupStressOptions,
  runWindowsRuntimeHostNodeStartupIteration,
  stressWindowsRuntimeHostNodeStartup,
} from './stress-windows-runtime-host-node-startup.mjs';

test('parses bounded Node Runtime Host startup stress options', () => {
  assert.deepEqual(
    parseWindowsRuntimeHostNodeStartupStressOptions([
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
    () => parseWindowsRuntimeHostNodeStartupStressOptions(['--parallel', '0']),
    /--parallel must be an integer between 1 and 64/u,
  );
  assert.throws(
    () => parseWindowsRuntimeHostNodeStartupStressOptions(['--unknown', '1']),
    /Unknown option/u,
  );
  assert.deepEqual(parseWindowsRuntimeHostNodeStartupStressOptions(['8', '2', '12000', '5000']), {
    iterations: 8,
    parallel: 2,
    electionDeadlineMs: 12_000,
    settleTimeoutMs: 5_000,
    keepFailures: false,
  });
});

test('publishes a self-contained Node stress command and an explicit dist seam', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['stress:windows-runtime-host-node-startup'],
    'npm run build && npm run stress:windows-runtime-host-node-startup:dist',
  );
  assert.equal(
    packageJson.scripts['stress:windows-runtime-host-node-startup:dist'],
    'node scripts/stress-windows-runtime-host-node-startup.mjs',
  );
  assert.equal(packageJson.scripts['stress:windows-runtime-host-startup'], undefined);
});

test('bounds Node startup stress concurrency and reports every failure', async () => {
  let active = 0;
  let maximumActive = 0;
  const written = [];
  const { results, summary } = await stressWindowsRuntimeHostNodeStartup(
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
  assert.deepEqual(summary, {
    kind: 'summary',
    candidateRuntime: 'node',
    iterations: 5,
    connected: 4,
    failed: 1,
  });
  assert.equal(written.length, 6);
  assert.deepEqual(written.at(-1), summary);
});

test('reports a rejected Node Candidate spawn without losing the stress summary', async () => {
  const written = [];
  const options = {
    iterations: 1,
    parallel: 1,
    electionDeadlineMs: 100,
    settleTimeoutMs: 100,
    keepFailures: false,
  };
  const runIteration = (iteration, iterationOptions) =>
    runWindowsRuntimeHostNodeStartupIteration(iteration, iterationOptions, {
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

  const { results, summary } = await stressWindowsRuntimeHostNodeStartup(options, {
    runIteration,
    write: (record) => written.push(record),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].iteration, 1);
  assert.equal(results[0].kind, 'failed');
  assert.equal(results[0].reason, 'startup_timeout');
  assert.equal(results[0].candidateRuntime, 'node');
  assert.equal(written[0], results[0]);
  assert.deepEqual(summary, {
    kind: 'summary',
    candidateRuntime: 'node',
    iterations: 1,
    connected: 0,
    failed: 1,
  });
  assert.equal(written.length, 2);
  assert.deepEqual(written.at(-1), summary);
});
