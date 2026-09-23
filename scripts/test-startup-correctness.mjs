#!/usr/bin/env node
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

import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    output: { type: 'string', default: 'artifacts/startup-correctness/latest' },
    'skip-build': { type: 'boolean', default: false },
  },
});
const output = resolve(root, values.output);
await mkdir(output, { recursive: true });
// Reuse the tests that own these contracts. New mixed-state checks complement
// them; copying their implementation into a benchmark would weaken the oracle.
const tests = (pkg, names) => names.map((name) => `packages/${pkg}/dist/__tests__/${name}.test.js`);
const groups = [
  {
    id: 'storage-authority',
    files: tests('storage', [
      'sqlite-runtime-store',
      'sqlite-recovery-concurrency',
      'recovery-persistence-authority',
    ]),
  },
  {
    id: 'tool-execution',
    files: tests('runtime', [
      'tool-runtime-durable-boundary',
      'tool-runtime-sqlite-boundary',
      'tool-runtime-progress',
      'tool-runtime-settlement',
      'tool-runtime-form-interaction',
      'tool-runtime-sandbox-boundary',
      'tool-runtime-argument-ownership',
      'tool-runtime-turn-close-outcome',
    ]),
  },
  {
    id: 'steering-and-recovery',
    files: tests('runtime', [
      'agent-run-steering-recovery',
      'agent-run-recovery',
      'recovery-authority-equivalence',
      'recovery-resolver',
      'sandbox-boundary-restart-recovery',
    ]),
  },
  {
    id: 'host-process-and-queue',
    files: tests('runtime-host', [
      'startup-state-matrix',
      'root-turn-coordinator',
      'message-coordinator',
      'execution-host-recovery',
      'execution-host-message',
      'execution-host-queue',
      'execution-host-continuation',
      'client-capability-recovery',
      'interaction-coordinator',
    ]),
  },
  {
    id: 'background-authorities',
    files: tests('runtime-host', [
      'scheduled-task-coordinator-recovery',
      'goal-coordinator',
      'agent-graph-coordinator',
      'workhub-assignment-crash-recovery',
    ]),
  },
  {
    id: 'desktop-readiness',
    files: [
      'runtime-host-desktop-manager',
      'bootstrap-invoke-preload',
      'use-shell-connections',
      'runtime-host-memory-ipc-main',
      'runtime-host-new-task-preload',
      'message-queue-ui-state',
    ].map((name) => `apps/desktop/dist/main/__tests__/${name}.test.js`),
  },
  {
    id: 'mixed-state-100k',
    files: tests('runtime-host', ['startup-state-matrix']),
    env: { MAKA_STARTUP_MATRIX_HISTORY_EVENTS: '100000' },
  },
];
const result = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version,
  startedAt: new Date().toISOString(),
  buildSkipped: values['skip-build'],
  groups: [],
  note: 'Deterministic FakeBackend; real SQLite and owned Host child processes. Durations are test costs, not startup performance measurements.',
};
await writeFile(join(output, 'working-tree.patch'), execFileSync('git', ['diff'], { cwd: root }));
if (!values['skip-build']) {
  const build = await run('build', 'npm', [
    '--workspace',
    '@maka/desktop',
    'run',
    'build:with-deps',
  ]);
  if (build.exitCode !== 0) throw new Error(`Build failed: ${build.log}`);
}
for (const group of groups) {
  console.log(`START ${group.id}`);
  const execution = await run(
    group.id,
    process.execPath,
    ['--test', '--test-reporter=tap', ...group.files],
    group.env,
  );
  const tap = await readFile(execution.log, 'utf8');
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped'].map((key) => [
      key,
      Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? 0),
    ]),
  );
  const entry = {
    ...execution,
    files: group.files,
    counts,
    ok: execution.exitCode === 0 && counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0,
  };
  result.groups.push(entry);
  await writeFile(join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({ id: group.id, ok: entry.ok, seconds: execution.seconds, ...counts }),
  );
}
result.completedAt = new Date().toISOString();
result.ok = result.groups.every((group) => group.ok);
await writeFile(join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.ok ? 0 : 1;

async function run(id, command, args, env = {}) {
  const started = performance.now();
  const chunks = [];
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
  const log = join(output, `${id}.log`);
  await writeFile(log, Buffer.concat(chunks));
  return {
    id,
    command: [command, ...args],
    env,
    exitCode,
    seconds: Math.round((performance.now() - started) / 10) / 100,
    log,
  };
}
