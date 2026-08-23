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

import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const harnessPath = join(here, 'real-ax-harness.mjs');
const monitorPath = join(here, 'real-e2e-monitor.swift');
const inputAgeSource = join(here, 'physical-input-age.swift');
const labRoot = process.env.MAKA_CU_AX_MODEL_LAB_ROOT;
if (!labRoot) {
  throw new Error(
    'MAKA_CU_AX_MODEL_LAB_ROOT is required: point it at a local checkout of the Codex CUA Lab fixture',
  );
}
const statePath = join(labRoot, 'test-app/runtime/state.json');
const fixtureBundleId = 'com.openai.codex.cualab';
const expectedAppPath = join(labRoot, 'test-app/build/Codex CUA Lab.app');
const scenario = process.env.MAKA_CU_AX_MODEL_SCENARIO ?? 'set-value';
const reportPath =
  process.env.MAKA_CU_AX_MODEL_REPORT ??
  join(repoRoot, '.agents-workspace-data', 'cu-real-ax-model', `report-${Date.now()}.json`);
const driverOverride = process.env.MAKA_CU_AX_MODEL_DRIVER_OVERRIDE;
const overrideSha256 = process.env.MAKA_CU_AX_MODEL_EXPECTED_SHA256;
const overrideVersion = process.env.MAKA_CU_AX_MODEL_EXPECTED_VERSION;
const overrideConfigured = [driverOverride, overrideSha256, overrideVersion].filter(Boolean).length;
if (overrideConfigured !== 0 && overrideConfigured !== 3) {
  throw new Error(
    'candidate driver qualification requires override path, expected SHA-256, and expected version',
  );
}
if (overrideSha256 && !/^[a-f0-9]{64}$/.test(overrideSha256)) {
  throw new Error('candidate driver expected SHA-256 is invalid');
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} failed (${signal ?? code})`));
    });
  });
}

async function terminateChild(child, label, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)])) return;
  child.kill('SIGKILL');
  if (!(await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]))) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

async function runFixtureScript(name, options = {}) {
  await runChild(join(labRoot, 'test-app', name), [], options);
}

async function waitForFixture(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (
        state.synthetic === true &&
        state.bundleIdentifier === fixtureBundleId &&
        state.appPath === expectedAppPath &&
        Number.isInteger(state.oop?.hostPID) &&
        state.oop.hostPID > 0
      ) {
        process.kill(state.oop.hostPID, 0);
        return state;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH' && !(error instanceof SyntaxError))
        throw error;
    }
    await delay(50);
  }
  throw new Error('synthetic fixture did not publish a live identity');
}

async function waitForRestartedFixture(oldPID, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await waitForFixture(1_000);
      if (state.oop.hostPID !== oldPID) return state;
    } catch (error) {
      if (!/did not publish/.test(String(error))) throw error;
    }
    await delay(50);
  }
  throw new Error(`synthetic fixture PID did not advance from ${oldPID}`);
}

async function waitForJson(path, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${label} timeout`);
}

function startMonitor(fixturePID) {
  const child = spawn(
    'swift',
    [
      monitorPath,
      '--concurrent-user',
      String(fixturePID),
      // The fixture must stay in the background for the whole run. `--concurrent-user`
      // only catches the OOP host PID; denying the bundle covers every process the
      // fixture owns, so a UI process stealing focus mid-run also fails the scenario.
      '--deny-frontmost-bundle',
      fixtureBundleId,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let buffer = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  let failureResolve;
  let readySettled = false;
  let failureSettled = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failure = new Promise((resolve) => {
    failureResolve = resolve;
  });
  const fail = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!readySettled) {
      readySettled = true;
      readyReject(normalized);
    }
    if (!failureSettled) {
      failureSettled = true;
      failureResolve(normalized);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      const [kind, ...fields] = line.split('\t');
      if (kind === 'READY') {
        readySettled = true;
        readyResolve({
          mode: fields[0],
          frontmostPID: Number(fields[1]),
          pointer: { x: Number(fields[2]), y: Number(fields[3]) },
          physicalInputAge: Number(fields[4]),
          bundleIdentifier: fields[5],
          canonicalAppPath: fields[6],
        });
      } else if (kind === 'CHANGE' || kind === 'ERROR') {
        fail(new Error(fields.join('\t') || line));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    if (!failureSettled && code !== 0 && signal !== 'SIGTERM') {
      fail(
        new Error(
          `monitor exited (${signal ?? code})` + `${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ),
      );
    }
  });
  return {
    child,
    ready,
    failure,
    stop: () => terminateChild(child, 'AX model safety monitor'),
  };
}

function validateMonitorBaseline(baseline, fixturePID, label) {
  if (baseline.mode !== 'concurrent_user') {
    throw new Error(`${label} reported unexpected mode '${String(baseline.mode)}'`);
  }
  if (!Number.isFinite(baseline.physicalInputAge) || baseline.physicalInputAge < 0) {
    throw new Error(`${label} reported invalid physical input age`);
  }
  // The fixture is launched with `open -n -g` precisely so that it never owns the
  // foreground. Asserting that it stays in the background is what makes this an
  // honest test of background execution: requiring the fixture to be frontmost
  // would both contradict the launch mode and make the run depend on whatever
  // else happens to be on the desktop.
  if (baseline.bundleIdentifier === fixtureBundleId) {
    throw new Error(`${label} fixture unexpectedly owns the frontmost application`);
  }
  if (baseline.canonicalAppPath === expectedAppPath) {
    throw new Error(`${label} fixture app path unexpectedly owns the frontmost application`);
  }
  if (baseline.frontmostPID === fixturePID) {
    throw new Error(`${label} synthetic fixture became frontmost`);
  }
}

async function run() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'maka-cu-real-ax-model-'));
  const inputAgePath = join(temporaryDirectory, 'cu-physical-input-age');
  let fixtureTouched = false;
  let caffeinate;
  let monitor;
  let harness;
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    caffeinate = spawn('/usr/bin/caffeinate', ['-dimsu'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (const workspace of [
      '@maka/core',
      '@maka/storage',
      '@maka/runtime',
      '@maka/computer-use',
    ]) {
      await runChild('npm', ['--workspace', workspace, 'run', 'build'], {
        cwd: repoRoot,
      });
    }
    await runChild(process.execPath, ['scripts/computer-use.mjs', 'prepare'], { cwd: repoRoot });
    if (driverOverride) {
      await copyFile(driverOverride, join(repoRoot, 'apps/desktop/resources/bin/maka-cu'));
    }
    await runChild('swiftc', [inputAgeSource, '-o', inputAgePath], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    fixtureTouched = true;
    await runFixtureScript('stop.sh');
    await runFixtureScript('reset.sh');
    await runFixtureScript('launch.sh', {
      env: { ...process.env, CUA_LAB_BACKGROUND: '1' },
    });
    const fixture = await waitForFixture();
    monitor = startMonitor(fixture.oop.hostPID);
    const baseline = await Promise.race([
      monitor.ready,
      delay(10_000).then(() => {
        throw new Error('AX model safety monitor startup timeout');
      }),
    ]);
    validateMonitorBaseline(baseline, fixture.oop.hostPID, 'AX model safety monitor');
    harness = spawn(process.execPath, [harnessPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_AX_MODEL_FIXTURE_PID: String(fixture.oop.hostPID),
        MAKA_CU_AX_MODEL_INPUT_AGE_PROBE: inputAgePath,
        MAKA_CU_AX_MODEL_LAB_ROOT: labRoot,
        MAKA_CU_AX_MODEL_TEMP_DIR: temporaryDirectory,
        MAKA_CU_AX_MODEL_SCENARIO: scenario,
        MAKA_CU_AX_MODEL_REPORT: reportPath,
        ...(overrideSha256 ? { MAKA_CU_AX_MODEL_EXPECTED_SHA256: overrideSha256 } : {}),
        ...(overrideVersion ? { MAKA_CU_AX_MODEL_EXPECTED_VERSION: overrideVersion } : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exit = new Promise((resolve, reject) => {
      harness.once('error', reject);
      harness.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (scenario === 'restart-recovery') {
      const request = await Promise.race([
        waitForJson(join(temporaryDirectory, 'restart-request.json'), 'AX model restart request'),
        exit.then((result) => {
          throw new Error(
            `AX model harness exited before restart request (${result.signal ?? result.code})`,
          );
        }),
        monitor.failure.then((error) => {
          throw error;
        }),
      ]);
      if (request.oldPID !== fixture.oop.hostPID) {
        throw new Error('AX model restart request PID mismatch');
      }
      await monitor.stop();
      monitor = undefined;
      await runFixtureScript('stop.sh');
      await runFixtureScript('launch.sh', {
        env: { ...process.env, CUA_LAB_BACKGROUND: '1' },
      });
      const restarted = await waitForRestartedFixture(request.oldPID);
      monitor = startMonitor(restarted.oop.hostPID);
      const restartedBaseline = await Promise.race([
        monitor.ready,
        delay(10_000).then(() => {
          throw new Error('restarted AX model safety monitor timeout');
        }),
      ]);
      validateMonitorBaseline(
        restartedBaseline,
        restarted.oop.hostPID,
        'restarted AX model safety monitor',
      );
      await runChild(
        process.execPath,
        [
          '-e',
          "require('fs').writeFileSync(process.argv[1], process.argv[2], {flag:'wx',mode:0o600})",
          join(temporaryDirectory, 'restart-complete.json'),
          JSON.stringify({
            oldPID: request.oldPID,
            newPID: restarted.oop.hostPID,
          }),
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
    }
    const first = await Promise.race([
      exit.then((result) => ({ type: 'exit', result })),
      monitor.failure.then((error) => ({ type: 'safety', error })),
    ]);
    if (first.type === 'safety') {
      await terminateChild(harness, 'AX model harness');
      throw first.error;
    }
    if (first.result.code !== 0) {
      throw new Error(`AX model E2E failed (${first.result.signal ?? first.result.code})`);
    }
    await readFile(reportPath, 'utf8');
    process.stdout.write(`Real AX model Computer Use report: ${reportPath}\n`);
  } finally {
    await terminateChild(harness, 'AX model harness').catch(() => {});
    await monitor?.stop().catch(() => {});
    if (fixtureTouched) await runFixtureScript('stop.sh').catch(() => {});
    await terminateChild(caffeinate, 'AX model caffeinate').catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Computer Use real AX model E2E failed:', error);
  process.exitCode = 1;
});
