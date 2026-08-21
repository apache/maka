import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const defaults = {
  iterations: 20,
  parallel: 4,
  electionDeadlineMs: 45_000,
  settleTimeoutMs: 10_000,
};

export function parseWindowsRuntimeHostStartupStressOptions(argv) {
  if (argv[0] !== undefined && !argv[0].startsWith('--')) {
    if (argv.length > 5) throw new Error('Too many positional stress options');
    if (argv[4] !== undefined && argv[4] !== 'keep-failures') {
      throw new Error('The fifth positional option must be keep-failures');
    }
    return {
      iterations: boundedInteger(argv[0], 'iterations', 1, 1_000),
      parallel:
        argv[1] === undefined ? defaults.parallel : boundedInteger(argv[1], 'parallel', 1, 64),
      electionDeadlineMs:
        argv[2] === undefined
          ? defaults.electionDeadlineMs
          : boundedInteger(argv[2], 'electionDeadlineMs', 1, 120_000),
      settleTimeoutMs:
        argv[3] === undefined
          ? defaults.settleTimeoutMs
          : boundedInteger(argv[3], 'settleTimeoutMs', 1, 120_000),
      keepFailures: argv[4] === 'keep-failures',
    };
  }
  const options = { ...defaults, keepFailures: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep-failures') {
      options.keepFailures = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    index += 1;
    switch (argument) {
      case '--iterations':
        options.iterations = boundedInteger(value, argument, 1, 1_000);
        break;
      case '--parallel':
        options.parallel = boundedInteger(value, argument, 1, 64);
        break;
      case '--election-deadline-ms':
        options.electionDeadlineMs = boundedInteger(value, argument, 1, 120_000);
        break;
      case '--settle-timeout-ms':
        options.settleTimeoutMs = boundedInteger(value, argument, 1, 120_000);
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export async function stressWindowsRuntimeHostStartup(
  options,
  {
    runIteration = runWindowsRuntimeHostStartupIteration,
    write = (record) => console.log(JSON.stringify(record)),
  } = {},
) {
  const results = new Array(options.iterations);
  let nextIteration = 0;
  const workerCount = Math.min(options.parallel, options.iterations);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const iteration = nextIteration;
        nextIteration += 1;
        if (iteration >= options.iterations) return;
        const result = await runIteration(iteration + 1, options);
        results[iteration] = result;
        write(result);
      }
    }),
  );
  const failures = results.filter((result) => result.kind !== 'connected');
  const summary = {
    kind: 'summary',
    iterations: results.length,
    connected: results.length - failures.length,
    failed: failures.length,
  };
  write(summary);
  return { results, summary };
}

export async function runWindowsRuntimeHostStartupIteration(
  iteration,
  options,
  { loadModules = loadRuntimeHostModules } = {},
) {
  const {
    connectOrSpawnRuntimeHostWithDependencies,
    interactiveCompositionId,
    launchOwnedRuntimeHostCandidate,
    protocolVersion,
  } = await loadModules();
  const rootPath = await mkdtemp(join(tmpdir(), `maka-runtime-host-startup-${iteration}-`));
  const startedAt = performance.now();
  const launches = [];
  let launch;
  let keepRoot = false;
  try {
    const result = await connectOrSpawnRuntimeHostWithDependencies(
      {
        rootPath,
        protocol: {
          min: protocolVersion,
          max: protocolVersion,
        },
        compositionId: interactiveCompositionId,
        candidateEntrypoint: new URL(
          '../packages/runtime-host/dist/execution-candidate-main.js',
          import.meta.url,
        ),
        electionDeadlineMs: options.electionDeadlineMs,
      },
      {
        launchCandidate(input) {
          if (launch) return launch;
          launch = launchOwnedRuntimeHostCandidate({ ...input, idleGraceMs: 0 });
          launches.push(launch);
          return launch;
        },
        random: Math.random,
      },
    );
    if (result.kind !== 'connected') {
      keepRoot = options.keepFailures;
      return {
        iteration,
        kind: 'failed',
        reason: 'reason' in result ? result.reason : result.kind,
        durationMs: elapsed(startedAt),
        rootPath: keepRoot ? rootPath : undefined,
        ...('diagnostic' in result && result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      };
    }
    const attempt = await within(launch?.spawned, 1_000);
    if (!attempt) throw new Error('Connected Host has no retained Candidate attempt');
    const exit = attempt.exited;
    await result.connection.close();
    const settled = await attempt.settle(options.settleTimeoutMs);
    const processExit = await exit;
    if (!settled) {
      keepRoot = options.keepFailures;
      return {
        iteration,
        kind: 'settlement_failed',
        durationMs: elapsed(startedAt),
        pid: attempt.pid,
        startupAttemptId: attempt.startupAttemptId,
        processExit,
        rootPath: keepRoot ? rootPath : undefined,
      };
    }
    return {
      iteration,
      kind: 'connected',
      durationMs: elapsed(startedAt),
      pid: attempt.pid,
      startupAttemptId: attempt.startupAttemptId,
      processExit,
    };
  } catch (error) {
    keepRoot = options.keepFailures;
    return {
      iteration,
      kind: 'exception',
      durationMs: elapsed(startedAt),
      message: error instanceof Error ? error.message : String(error),
      rootPath: keepRoot ? rootPath : undefined,
    };
  } finally {
    await Promise.all(
      launches.map(async (launch) => {
        const attempt = await within(
          launch.spawned.catch(() => undefined),
          options.settleTimeoutMs,
        );
        if (attempt) await attempt.settle(options.settleTimeoutMs);
      }),
    );
    if (!keepRoot) await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

let runtimeHostModules;

async function loadRuntimeHostModules() {
  runtimeHostModules ??= Promise.all([
    import('../packages/runtime-host/dist/client/connect-or-spawn.js'),
    import('../packages/runtime-host/dist/client/launcher.js'),
    import('../packages/runtime-host/dist/protocol/index.js'),
  ]).then(([client, launcher, protocol]) => ({
    connectOrSpawnRuntimeHostWithDependencies: client.connectOrSpawnRuntimeHostWithDependencies,
    interactiveCompositionId: protocol.INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    launchOwnedRuntimeHostCandidate: launcher.launchOwnedRuntimeHostCandidate,
    protocolVersion: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
  }));
  return runtimeHostModules;
}

function boundedInteger(raw, label, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function within(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'win32') {
    throw new Error('Runtime Host startup stress requires Windows.');
  }
  const options = parseWindowsRuntimeHostStartupStressOptions(process.argv.slice(2));
  const { summary } = await stressWindowsRuntimeHostStartup(options);
  if (summary.failed > 0) process.exitCode = 1;
}
