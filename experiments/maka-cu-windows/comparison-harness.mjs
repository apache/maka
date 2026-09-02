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

// Language-blind #4318 comparison entry point.
//
// Usage:
//   node comparison-harness.mjs <helper-1.exe> <helper-2.exe> <fixture.exe>
//       [--out comparison-results.json]
//
// The helper paths are opaque. The exact same fixture executable, drivers,
// deadlines and assertions are used for each subject in sequence.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform, release, version } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const startedAt = new Date().toISOString();
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
if (outIndex >= 0 && !argv[outIndex + 1]) {
  console.error('--out requires a path');
  process.exit(2);
}
const outputPath = outIndex >= 0 ? resolve(argv[outIndex + 1]) : resolve('comparison-results.json');
if (outIndex >= 0) argv.splice(outIndex, 2);
const [firstHelper, secondHelper, fixture] = argv;
if (!firstHelper || !secondHelper || !fixture) {
  console.error(
    'usage: node comparison-harness.mjs <helper-1.exe> <helper-2.exe> <fixture.exe> [--out results.json]',
  );
  process.exit(2);
}

const root = dirname(fileURLToPath(import.meta.url));
const harnessPath = fileURLToPath(import.meta.url);
const lifecycleDriver = resolve(root, 'lifecycle-driver.mjs');
const protocolDriver = resolve(root, 'protocol-regression.mjs');
const contractPath = resolve(root, 'protocol-contract.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const DEADLINE_MS = 180_000;

const driverPaths = { lifecycle: lifecycleDriver, protocol: protocolDriver };
const driverSpecs = contract.comparisonDrivers.map((driver) => ({
  ...driver,
  path: driverPaths[driver.name],
  needsFixture: driver.name === 'lifecycle',
  sentinel: driver.summarySentinel,
}));

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function artifact(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    return { path: absolutePath, exists: false, sizeBytes: null, sha256: null, lastWrite: null };
  }
  const stats = statSync(absolutePath);
  const dependencyFiles = readdirSync(dirname(absolutePath), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (/\.(?:exe|dll)$/i.test(entry.name) || /(?:runtimeconfig|deps)\.json$/i.test(entry.name)),
    )
    .map((entry) => resolve(dirname(absolutePath), entry.name))
    .sort((a, b) => a.localeCompare(b));
  const dependencyClosureFiles = dependencyFiles.map((file) => ({
    path: file,
    sizeBytes: statSync(file).size,
    sha256: sha256File(file),
  }));
  const dependencyClosureSha256 = createHash('sha256')
    .update(
      dependencyClosureFiles
        .map((item) => `${item.path}\0${item.sizeBytes}\0${item.sha256}\n`)
        .join(''),
    )
    .digest('hex')
    .toUpperCase();
  return {
    path: absolutePath,
    exists: true,
    sizeBytes: stats.size,
    sha256: sha256File(absolutePath),
    sha256Meaning: 'entrypoint file only; dependencyClosure describes same-directory runtime files',
    lastWrite: stats.mtime.toISOString(),
    dependencyClosure: {
      files: dependencyClosureFiles,
      totalSizeBytes: dependencyClosureFiles.reduce((total, item) => total + item.sizeBytes, 0),
      closureSha256: dependencyClosureSha256,
    },
  };
}

function parseChecks(stdout, driverName) {
  const checks = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (driverName === 'protocol') {
      const protocol = line.match(/^(PASS|FAIL)\s+(.+?)\s+(\{.*\})$/);
      if (protocol) {
        checks.push({ status: protocol[1].toLowerCase(), name: protocol[2], raw: protocol[3] });
        continue;
      }
      const summary = line.match(/^(PASS|FAIL)\s+(.+?)$/);
      if (summary) {
        checks.push({ status: summary[1].toLowerCase(), name: summary[2], raw: '' });
        continue;
      }
    }
    const lifecycle = line.match(/^(PASS|FAIL)\s+(.+?)(?:\s+—\s+(.*))?$/);
    if (lifecycle) {
      checks.push({
        status: lifecycle[1].toLowerCase(),
        name: lifecycle[2],
        note: lifecycle[3] ?? '',
      });
      continue;
    }
    const protocol = line.match(/^(PASS|FAIL)\s+(.+?)(?:\s+(\{.*\}))?$/);
    if (protocol)
      checks.push({ status: protocol[1].toLowerCase(), name: protocol[2], raw: protocol[3] ?? '' });
  }
  return checks;
}

function runNode(subjectLabel, helper, spec, fixtureArg) {
  const command = process.execPath;
  const args = spec.needsFixture ? [spec.path, helper, fixtureArg] : [spec.path, helper];
  return new Promise((resolveResult) => {
    const started = Date.now();
    if (!existsSync(helper) || !existsSync(fixtureArg ?? helper)) {
      const missing = !existsSync(helper) ? helper : fixtureArg;
      resolveResult({
        subject: subjectLabel,
        driver: { name: spec.name, path: spec.path },
        command,
        args,
        cwd: process.cwd(),
        timeoutMs: DEADLINE_MS,
        state: 'blocked',
        exit: { code: null, signal: null },
        durationMs: 0,
        error: `missing executable: ${missing}`,
        checks: [
          { status: 'blocked', name: 'harness_execution', note: `missing executable: ${missing}` },
        ],
        raw: { stdout: '', stderr: '' },
        expectedChecks: spec.expectedChecks,
        sentinel: spec.sentinel,
      });
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (state, code = null, signal = null, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const checks = parseChecks(stdout, spec.name);
      const validation = [];
      if (checks.length !== spec.expectedChecks) {
        validation.push({
          status: 'fail',
          name: 'harness_check_count',
          note: `expected=${spec.expectedChecks} actual=${checks.length}`,
        });
      }
      if (!stdout.includes(spec.sentinel)) {
        validation.push({
          status: 'fail',
          name: 'harness_summary_sentinel',
          note: `missing ${spec.sentinel}`,
        });
      }
      if (checks.some((check) => check.status === 'fail')) {
        validation.push({
          status: 'fail',
          name: 'harness_reported_failure',
          note: 'driver emitted FAIL',
        });
      }
      const allChecks = [...checks, ...validation];
      let finalState = state;
      if (state === 'pass' && (code !== 0 || validation.length > 0)) finalState = 'fail';
      resolveResult({
        subject: subjectLabel,
        driver: { name: spec.name, path: spec.path },
        command,
        args,
        cwd: process.cwd(),
        timeoutMs: DEADLINE_MS,
        state: finalState,
        exit: { code, signal },
        durationMs: Date.now() - started,
        error,
        checks: allChecks,
        expectedChecks: spec.expectedChecks,
        sentinel: spec.sentinel,
        raw: { stdout, stderr },
      });
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) =>
      finish(error.code === 'ENOENT' ? 'blocked' : 'fail', null, null, error.code ?? error.message),
    );
    child.once('exit', (code, signal) => finish(code === 0 ? 'pass' : 'fail', code, signal));
    timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        finish('blocked', null, 'timeout', `driver timeout after ${DEADLINE_MS}ms`);
      }
    }, DEADLINE_MS);
  });
}

function counts(items) {
  return {
    pass: items.filter((item) => item.status === 'pass' || item.state === 'pass').length,
    fail: items.filter((item) => item.status === 'fail' || item.state === 'fail').length,
    blocked: items.filter((item) => item.status === 'blocked' || item.state === 'blocked').length,
    total: items.length,
  };
}

function subjectState(runs) {
  if (runs.some((run) => run.state === 'fail')) return 'fail';
  if (runs.some((run) => run.state === 'blocked')) return 'blocked';
  return 'pass';
}

const fixtureArtifact = artifact(fixture);
const subjects = [];
for (const [index, path] of [firstHelper, secondHelper].entries()) {
  const helperArtifact = artifact(path);
  const label = `subject-${index + 1}`;
  const runs = [];
  for (const spec of driverSpecs) {
    runs.push(await runNode(label, resolve(path), spec, resolve(fixture)));
  }
  subjects.push({ label, artifact: helperArtifact, state: subjectState(runs), runs });
}

const allRuns = subjects.flatMap((subject) => subject.runs);
const allChecks = allRuns.flatMap((run) => run.checks);
const driverSummary = Object.fromEntries(
  driverSpecs.map((spec) => {
    const runs = allRuns.filter((run) => run.driver.name === spec.name);
    return [spec.name, { ...counts(runs), checks: counts(runs.flatMap((run) => run.checks)) }];
  }),
);
const checkByName = {};
for (const check of allChecks) {
  checkByName[check.name] ??= { pass: 0, fail: 0, blocked: 0, total: 0 };
  checkByName[check.name][check.status]++;
  checkByName[check.name].total++;
}

const finishedAt = new Date().toISOString();
const result = {
  schema: 'maka.cu.windows/comparison-results/1',
  contract: {
    path: contractPath,
    sha256: sha256File(contractPath),
    version: contract.contractVersion,
  },
  harness: { path: harnessPath, sha256: sha256File(harnessPath) },
  startedAt,
  finishedAt,
  host: {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    windowsBuild: version(),
    node: process.version,
  },
  fixture: fixtureArtifact,
  deadlinesMs: contract.deadlinesMs,
  subjects,
  summary: {
    subjects: counts(subjects),
    drivers: driverSummary,
    checks: { ...counts(allChecks), byName: checkByName },
  },
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
for (const subject of subjects) {
  for (const run of subject.runs) {
    const checks = run.checks.filter((check) => check.status === 'pass').length;
    console.log(
      `${run.state.toUpperCase()} ${subject.label} ${run.driver.name} checks=${checks}/${run.expectedChecks}`,
    );
  }
}
console.log(`RESULTS ${outputPath}`);
process.exitCode =
  result.summary.subjects.fail === 0 && result.summary.subjects.blocked === 0 ? 0 : 1;
