/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a launcher signal cancels preparation before Electron can spawn', async () => {
  const { createDevelopmentLaunchSession } = await import('./dev-app-runtime.mjs');
  const signals = new EventEmitter();
  let finishPreparation;
  const preparation = new Promise((resolve) => { finishPreparation = resolve; });
  let finishStopping;
  const stopped = new Promise((resolve) => { finishStopping = resolve; });
  const spawns = [];
  const exits = [];
  let closes = 0;
  const session = createDevelopmentLaunchSession({
    signals,
    close: async () => { closes += 1; },
    exit: (code) => {
      exits.push(code);
      finishStopping();
    },
  });
  const launching = session.start({
    prepareMacosDevelopmentLaunch: () => preparation,
    createDevelopmentLaunchFiles: () => {
      throw new Error('cancelled launch must not create files');
    },
    spawn: (...args) => spawns.push(args),
  });

  signals.emit('SIGINT');
  finishPreparation({ appPath: '/tmp/Maka Dev.app', resultFileArgPrefix: '--result=' });

  assert.equal(await launching, null);
  await stopped;
  assert.deepEqual(spawns, []);
  assert.equal(closes, 1);
  assert.deepEqual(exits, [0]);
});

test('a launcher signal adopts and stops a delayed launch handle exactly once', async () => {
  const { createDevelopmentLaunchSession } = await import('./dev-app-runtime.mjs');
  const signals = new EventEmitter();
  let publishHandle;
  const pendingHandle = new Promise((resolve) => { publishHandle = resolve; });
  let finishStopping;
  const stopped = new Promise((resolve) => { finishStopping = resolve; });
  let stops = 0;
  const session = createDevelopmentLaunchSession({
    signals,
    startDevelopmentApp: () => pendingHandle,
    close: async () => {},
    exit: finishStopping,
  });
  const launching = session.start();

  signals.emit('SIGTERM');
  signals.emit('SIGHUP');
  publishHandle({ stop: async () => { stops += 1; } });

  await launching;
  await stopped;
  assert.equal(stops, 1);
});

test('cancelling during launch preparation prevents any later process spawn', async () => {
  const { startDevelopmentApp } = await import('./dev-app-runtime.mjs');
  const controller = new AbortController();
  let finishPreparation;
  const preparation = new Promise((resolve) => { finishPreparation = resolve; });
  const launchFiles = [];
  const spawns = [];
  const launching = startDevelopmentApp({
    signal: controller.signal,
    prepareMacosDevelopmentLaunch: () => preparation,
    devSingleInstanceConstants: async () => ({}),
    createDevelopmentLaunchFiles: () => {
      launchFiles.push('created');
      return { logFile: '/tmp/log', resultFile: '/tmp/result' };
    },
    spawn: (...args) => {
      spawns.push(args);
      return { exitCode: null, killed: false, once: () => {}, kill: () => {} };
    },
  });

  controller.abort();
  finishPreparation({ appPath: '/tmp/Maka Dev.app', resultFileArgPrefix: '--result=' });

  await assert.rejects(launching, (error) => error === controller.signal.reason);
  assert.deepEqual(launchFiles, []);
  assert.deepEqual(spawns, []);
});

test('cancelling while the plain launcher loads its lock contract prevents spawn', async () => {
  const { startDevelopmentApp } = await import('./dev-app-runtime.mjs');
  const controller = new AbortController();
  let finishContractLoad;
  const contract = new Promise((resolve) => { finishContractLoad = resolve; });
  const spawns = [];
  const launching = startDevelopmentApp({
    signal: controller.signal,
    prepareMacosDevelopmentLaunch: async () => null,
    devSingleInstanceConstants: () => contract,
    spawn: (...args) => spawns.push(args),
  });

  await Promise.resolve();
  controller.abort();
  finishContractLoad({ DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG: '--handled' });

  await assert.rejects(launching, (error) => error === controller.signal.reason);
  assert.deepEqual(spawns, []);
});

test('launcher and core agree on the loser contract', async () => {
  const { devSingleInstanceConstants } = await import('./dev-app-runtime.mjs');
  const core = await import('@maka/core/dev-single-instance');
  const launcher = await devSingleInstanceConstants();
  assert.equal(launcher.DEV_LOSER_EXIT_CODE, core.DEV_LOSER_EXIT_CODE);
  assert.equal(launcher.DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG, core.DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG);
  assert.equal(launcher.DEV_LAUNCH_RESULT_FILE_ARG_PREFIX, core.DEV_LAUNCH_RESULT_FILE_ARG_PREFIX);
});

test('plainLoserExitCode matches only the contract value', async () => {
  const { plainLoserExitCode } = await import('./dev-app-runtime.mjs');
  const { DEV_LOSER_EXIT_CODE } = await import('@maka/core/dev-single-instance');
  assert.equal(await plainLoserExitCode(DEV_LOSER_EXIT_CODE), true);
  assert.equal(await plainLoserExitCode(0), false);
  assert.equal(await plainLoserExitCode(1), false);
});

test('loser contract import failure does not claim a loser', async () => {
  const { plainLoserExitCode } = await import('./dev-app-runtime.mjs');
  const failingLoader = async () => { throw new Error('dist not built'); };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    assert.equal(await plainLoserExitCode(42, failingLoader), false);
  } finally { console.warn = origWarn; }
  assert.ok(warnings.some((m) => m.includes('dev single-instance constants unavailable')));
});

async function runVerdictCase({ result, stopped = () => false, startupAttempts = 10 }) {
  const { waitForDevelopmentLaunchVerdict } = await import('./dev-app-runtime.mjs');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'maka-abs-'));
  const resultFile = join(dir, 'launch-result.json');
  try {
    if (result) writeFileSync(resultFile, `${JSON.stringify(result)}\n`);
    return await waitForDevelopmentLaunchVerdict({
      resultFile,
      pollMs: 1,
      startupAttempts,
      stopped,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('verdict wait reports only its own private loser result', async () => {
  const { waitForDevelopmentLaunchVerdict } = await import('./dev-app-runtime.mjs');
  let resultChecks = 0;
  let stopChecks = 0;
  assert.equal(
    await waitForDevelopmentLaunchVerdict({
      readLaunchResult: async () => (++resultChecks >= 2 ? { status: 'loser' } : undefined),
      delay: async () => {},
      stopped: () => ++stopChecks > 4,
    }),
    'absorbed',
  );
});

test('the TCC launcher stops supervising after Electron wins the lock', async () => {
  const { waitForDevelopmentLaunchVerdict } = await import('./dev-app-runtime.mjs');
  assert.equal(
    await waitForDevelopmentLaunchVerdict({
      readLaunchResult: () => ({ status: 'winner' }),
      isWinnerRunning: () => {
        throw new Error('the launcher must not observe Electron after the lock verdict');
      },
      delay: async () => {},
      startupAttempts: 1,
    }),
    'started',
  );
});

test('verdict wait marks a loser that never starts as absorbed', async () => {
  assert.equal(
    await runVerdictCase({ result: { status: 'loser' }, startupAttempts: 1 }),
    'absorbed',
  );
});

test('verdict wait keeps an ordinary never-started launch distinct', async () => {
  assert.equal(await runVerdictCase({ startupAttempts: 1 }), 'never-started');
});

test('verdict wait marks a stopped loser as absorbed', async () => {
  let stopChecks = 0;
  assert.equal(
    await runVerdictCase({
      result: { status: 'loser' },
      stopped: () => ++stopChecks > 1,
    }),
    'absorbed',
  );
});

test('development-app liveness probes only the TCC bundle', async () => {
  const { isDevelopmentAppRunning } = await import('./dev-app-runtime.mjs');
  const calls = [];
  assert.equal(
    isDevelopmentAppRunning({
      executable: '/wt/Maka Dev.app/Contents/MacOS/Electron',
      probe: (executable) => {
        calls.push(executable);
        return false;
      },
    }),
    false,
  );
  assert.deepEqual(calls, ['/wt/Maka Dev.app/Contents/MacOS/Electron']);
});

test('a runtime rebuild refuses to replace a running TCC bundle instead of killing it', async () => {
  const { assertDevelopmentAppNotRunning } = await import('./dev-app-runtime.mjs');
  assert.throws(
    () => assertDevelopmentAppNotRunning({ isRunning: () => true }),
    /Quit it.*retry/,
  );
  assert.doesNotThrow(() => assertDevelopmentAppNotRunning({ isRunning: () => false }));
});

test('TCC launcher cleanup removes only its own launch artifacts', async () => {
  const { cleanupDevelopmentLaunch } = await import('./dev-app-runtime.mjs');
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'maka-cleanup-'));
  const logFile = join(directory, 'app.log');
  const resultFile = join(directory, 'launch-result.json');
  let logStopped = false;
  try {
    writeFileSync(logFile, 'log output\n');
    writeFileSync(resultFile, '{"status":"winner"}\n');
    cleanupDevelopmentLaunch({
      logFile,
      resultFile,
      logStream: { kill: () => { logStopped = true; } },
    });
    assert.equal(logStopped, true);
    assert.equal(existsSync(logFile), false);
    assert.equal(existsSync(resultFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each TCC launch gets private and separate result and log files', async () => {
  const { createDevelopmentLaunchFiles } = await import('./dev-app-runtime.mjs');
  const writes = [];
  const first = createDevelopmentLaunchFiles({
    directory: '/tmp/maka-dev-launches',
    id: 'first',
    mkdir: () => {},
    write: (path) => writes.push(path),
  });
  const second = createDevelopmentLaunchFiles({
    directory: '/tmp/maka-dev-launches',
    id: 'second',
    mkdir: () => {},
    write: (path) => writes.push(path),
  });
  assert.notEqual(first.logFile, second.logFile);
  assert.notEqual(first.resultFile, second.resultFile);
  assert.deepEqual(writes, [first.logFile, second.logFile]);
});

test('other launch outcomes retain their exit codes', async () => {
  const { handleDevelopmentLaunchOutcome } = await import('./dev-app-runtime.mjs');
  for (const [outcome, expectedCode] of [['never-started', 1], ['stopped', 0], ['unexpected', 1]]) {
    let exitCode;
    handleDevelopmentLaunchOutcome(outcome, { log: () => {}, exit: (code) => { exitCode = code; } });
    assert.equal(exitCode, expectedCode, outcome);
  }
  let startedExitCode;
  handleDevelopmentLaunchOutcome('started', { exit: (code) => { startedExitCode = code; } });
  assert.equal(startedExitCode, undefined);
});

test('an absorbed launch names the holder when the conflict detail resolves', async () => {
  const { handleDevelopmentLaunchOutcome } = await import('./dev-app-runtime.mjs');
  const logs = [];
  let exitCode;
  handleDevelopmentLaunchOutcome('absorbed', {
    log: (message) => logs.push(message),
    exit: (code) => { exitCode = code; },
    conflictDetail: ' The holder appears to be PID 739 on this machine.',
  });
  assert.equal(exitCode, 1);
  assert.match(logs[0], /absorbed by another instance/);
  assert.match(logs[0], /PID 739 on this machine/);
});

test('an absorbed launch without a resolvable holder keeps the generic wording', async () => {
  const { handleDevelopmentLaunchOutcome } = await import('./dev-app-runtime.mjs');
  const logs = [];
  handleDevelopmentLaunchOutcome('absorbed', {
    log: (message) => logs.push(message),
    exit: () => {},
  });
  assert.equal(logs[0], 'Maka Dev was absorbed by another instance holding the profile lock; quitting.');
});

function makeLockDir(target) {
  const dir = mkdtempSync(join(tmpdir(), 'maka-owner-'));
  symlinkSync(target, join(dir, 'SingletonLock'));
  return dir;
}

test('conflict detail resolves the holder through the core owner module', async () => {
  const { developmentProfileConflictDetail } = await import('./dev-app-runtime.mjs');
  const dir = makeLockDir('mac.local-739');
  const seen = [];
  const detail = await developmentProfileConflictDetail({
    userDataDir: dir,
    localHostname: 'mac.local',
    loader: async () => ({
      resolveLiveDevProfileOwnerFromTarget: (target, deps) => {
        seen.push([target, deps.localHostname]);
        return deps.localHostname === 'mac.local'
          ? { hostname: 'mac.local', pid: 739, isLocalHost: true }
          : undefined;
      },
      describeDevProfileOwner: (owner) => `PID ${owner.pid} on this machine`,
    }),
  });
  assert.deepEqual(seen, [['mac.local-739', 'mac.local']]);
  assert.equal(detail, ' The holder appears to be PID 739 on this machine.');
});

test('an explicit --user-data-dir wins over the platform default', async () => {
  const { developmentProfileConflictDetail } = await import('./dev-app-runtime.mjs');
  const explicitDir = makeLockDir('explicit-box-5');
  const defaultDir = makeLockDir('default-box-9');
  const detail = await developmentProfileConflictDetail({
    argv: [`--user-data-dir=${explicitDir}`, '--other'],
    userDataDir: defaultDir,
    loader: async () => ({
      resolveLiveDevProfileOwnerFromTarget: (target, deps) =>
        target === 'explicit-box-5' ? { hostname: 'explicit-box', pid: 5, isLocalHost: false } : undefined,
      describeDevProfileOwner: (owner) => `PID ${owner.pid}`,
    }),
  });
  assert.equal(detail, ' The holder appears to be PID 5.');
});

test('the platform default is macOS and Linux capable, and Windows degrades', async () => {
  const { defaultDevUserDataDir, developmentProfileConflictDetail } = await import(
    './dev-app-runtime.mjs'
  );
  assert.equal(defaultDevUserDataDir('win32'), null);
  assert.equal(defaultDevUserDataDir('darwin'), join(homedir(), 'Library', 'Application Support', 'Maka Dev'));
  const linuxConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  assert.equal(defaultDevUserDataDir('linux'), join(linuxConfigHome, 'Maka Dev'));
  // Without an explicit dir on Windows there is no POSIX SingletonLock to
  // read, so the detail degrades before any loader runs.
  let loaded = false;
  assert.equal(
    await developmentProfileConflictDetail({
      platform: 'win32',
      loader: async () => {
        loaded = true;
        return {};
      },
    }),
    '',
  );
  assert.equal(loaded, false);
});

test('conflict detail degrades to empty on any resolution failure', async () => {
  const { developmentProfileConflictDetail } = await import('./dev-app-runtime.mjs');
  const dir = makeLockDir('mac.local-739');
  const failingLoader = async () => {
    throw new Error('not built');
  };
  assert.equal(
    await developmentProfileConflictDetail({ userDataDir: dir, loader: failingLoader }),
    '',
  );
  // A module without the expected surface degrades the same way.
  assert.equal(
    await developmentProfileConflictDetail({ userDataDir: dir, loader: async () => ({}) }),
    '',
  );
  // So does a resolver that throws.
  assert.equal(
    await developmentProfileConflictDetail({
      userDataDir: dir,
      loader: async () => ({
        resolveLiveDevProfileOwnerFromTarget: () => {
          throw new Error('boom');
        },
        describeDevProfileOwner: () => '',
      }),
    }),
    '',
  );
  // And a userData dir with no lock symlink at all.
  const empty = mkdtempSync(join(tmpdir(), 'maka-owner-'));
  assert.equal(await developmentProfileConflictDetail({ userDataDir: empty }), '');
});

test('shared-profile launches warn about legacy TCC data before choosing plain or bundle mode', async () => {
  const { DEV_USER_DATA_DIR, warnAboutLegacyTccDataRoot } = await import('./dev-app-runtime.mjs');
  const warnings = [];
  warnAboutLegacyTccDataRoot({
    platform: 'darwin',
    effectiveUserDataDir: DEV_USER_DATA_DIR,
    legacyUserDataDir: '/tmp/Maka Dev-legacy',
    exists: () => true,
    warn: (message) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Maka Dev-legacy/);
});

test('an explicit isolated profile does not warn about unrelated legacy TCC data', async () => {
  const { warnAboutLegacyTccDataRoot } = await import('./dev-app-runtime.mjs');
  const warnings = [];
  warnAboutLegacyTccDataRoot({
    platform: 'darwin',
    effectiveUserDataDir: '/tmp/isolated-profile',
    legacyUserDataDir: '/tmp/Maka Dev-legacy',
    exists: () => true,
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, []);
});

test('createMacosDevelopmentLaunch passes its private result file after --args', async () => {
  const { createMacosDevelopmentLaunch } = await import('./dev-app-runtime.mjs');
  const { DEV_LAUNCH_RESULT_FILE_ARG_PREFIX } = await import('@maka/core/dev-single-instance');
  const launch = createMacosDevelopmentLaunch(
    '/tmp/Maka Dev.app',
    '/tmp/app.log',
    '/tmp/launch-result.json',
    DEV_LAUNCH_RESULT_FILE_ARG_PREFIX,
  );
  assert.equal(launch.command, 'open');
  assert.ok(launch.args.indexOf('--stdout') < launch.args.indexOf('--args'));
  assert.equal(
    launch.args.at(-1),
    `${DEV_LAUNCH_RESULT_FILE_ARG_PREFIX}/tmp/launch-result.json`,
  );
  assert.ok(
    !createMacosDevelopmentLaunch('/tmp/Maka Dev.app', '/tmp/app.log').args.includes('--args'),
  );
});
