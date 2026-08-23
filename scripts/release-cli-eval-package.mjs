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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  createTaskFixture,
  findEvalReleaseTarball,
  findJsonDiagnostics,
  isolatedEnvironment,
  readFrameworkOutputs,
  run,
  runAllowingFailure,
} from './release-cli-eval-support.mjs';

const HARBOR_VERSION = '0.20.0';
const PIER_VERSION = '0.3.0';
const TASK_IMAGE =
  'python:3.12-slim@sha256:dd29372629eeba2dd003fd9e9d35a5b8236c44727875a0364254b5127af88e65';
const releaseDirectory = resolve('packages/cli/release');
const tarballPath = findEvalReleaseTarball(releaseDirectory);

const root = mkdtempSync(join(tmpdir(), 'maka-cli-eval-validation-'));
let primaryError;
try {
  validateChecksum();
  const prefix = join(root, 'prefix');
  const environment = isolatedEnvironment(join(root, 'home'));
  logStep('installing the immutable tarball with an empty offline npm cache');
  run(
    'npm',
    [
      'install',
      '--global',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(root, 'npm-cache'),
      '--prefix',
      prefix,
      tarballPath,
    ],
    environment,
    root,
  );

  const maka = join(prefix, 'bin/maka');
  const packageRoot = join(prefix, 'lib/node_modules/maka-agent');
  if (!existsSync(maka) || !existsSync(join(packageRoot, 'packages/eval/harbor/run_trial.py'))) {
    throw new Error('The installed candidate is missing its CLI or bundled Eval runtime');
  }

  const fixture = createTaskFixture(join(root, 'fixture'), environment, TASK_IMAGE);
  for (const framework of ['harbor', 'pier']) {
    logStep(`running a real ${framework} Docker cell from the installed candidate`);
    validateFramework({
      environment,
      fixture,
      framework,
      maka,
      root: join(root, framework),
    });
  }
  logStep(`OK — installed ${basename(tarballPath)} completed real Harbor and Pier cells`);
} catch (error) {
  primaryError = error;
} finally {
  let cleanupError;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], 'Eval validation and cleanup failed');
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

function validateFramework({ environment, fixture, framework, maka, root: frameworkRoot }) {
  mkdirSync(frameworkRoot, { recursive: true, mode: 0o700 });
  const outputRoot = join(frameworkRoot, 'output');
  const trialsRoot = join(frameworkRoot, 'trials');
  const pythonVariable =
    framework === 'harbor' ? 'MAKA_RELEASE_HARBOR_PYTHON' : 'MAKA_RELEASE_PIER_PYTHON';
  const pythonPath = process.env[pythonVariable];
  if (!pythonPath) throw new Error(`${pythonVariable} is required`);
  const pythonPathVariable = `MAKA_RELEASE_${framework.toUpperCase()}_PYTHON_PATH`;
  const trialsVariable = `MAKA_RELEASE_${framework.toUpperCase()}_TRIALS`;
  const tasksVariable = 'MAKA_RELEASE_PIER_TASKS';
  const specPath = join(frameworkRoot, 'experiment.json');
  const spec = experimentSpec({
    fixture,
    framework,
    pythonPathVariable,
    tasksVariable,
    trialsVariable,
  });
  writeFileSync(specPath, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
  const childEnvironment = {
    ...environment,
    [pythonPathVariable]: pythonPath,
    [trialsVariable]: trialsRoot,
    ...(framework === 'pier' ? { [tasksVariable]: fixture.tasksRoot } : {}),
  };
  const invocation = runAllowingFailure(
    maka,
    ['eval', 'run', specPath, '--out', outputRoot],
    childEnvironment,
    frameworkRoot,
  );
  const { summary, attempt } = readFrameworkOutputs({
    framework,
    invocation,
    outputRoot,
    trialsRoot,
  });
  const result = attempt.result;
  if (
    summary.experimentId !== `release-${framework}` ||
    summary.cells !== 1 ||
    summary.incomplete !== 0 ||
    attempt.cellId !== 'task::1::subject' ||
    attempt.sequence !== 1 ||
    result?.status !== 'completed' ||
    result?.score !== 1 ||
    result?.usage !== null ||
    result?.costUsd !== null ||
    result?.failureReason !== null
  ) {
    throw new Error(
      `${framework} produced an invalid completed attempt: ${JSON.stringify({
        invocation,
        summary,
        attempt,
        frameworkDiagnostics: findJsonDiagnostics(trialsRoot),
      })}`,
    );
  }
  const trialArtifact = result.artifacts.find(
    (artifact) => artifact.kind === 'trial' && artifact.framework === framework,
  );
  const processArtifact = result.artifacts.find(
    (artifact) => artifact.kind === 'external_process' && artifact.exitCode === 0,
  );
  const collected = result.artifacts.filter((artifact) => artifact.kind === 'collected-artifact');
  if (!trialArtifact || !processArtifact || collected.length < 2) {
    throw new Error(`${framework} did not preserve the expected trial and subject artifacts`);
  }
  const containers = run(
    'docker',
    ['ps', '--all', '--quiet', '--filter', `name=${trialArtifact.trialName}`],
    childEnvironment,
    frameworkRoot,
  ).trim();
  if (containers) throw new Error(`${framework} left trial containers behind: ${containers}`);
}

function experimentSpec({ fixture, framework, pythonPathVariable, tasksVariable, trialsVariable }) {
  return {
    schemaVersion: 'maka.eval.v1',
    id: `release-${framework}`,
    benchmark: {
      id: 'release-validation',
      version: fixture.commit,
      config: { repository: fixture.repository },
    },
    executor: {
      kind: framework,
      config: {
        frameworkVersion: framework === 'harbor' ? HARBOR_VERSION : PIER_VERSION,
        pythonPathEnv: pythonPathVariable,
        trialsRootEnv: trialsVariable,
        ...(framework === 'pier' ? { tasksRootEnv: tasksVariable } : {}),
        environment: { type: 'docker', delete: true },
        preparationEnvironment: [],
        mounts: [],
      },
    },
    subjects: [
      {
        id: 'subject',
        kind: 'external',
        credentials: [],
        config: { command: '/bin/true', args: [], result: 'exit-code' },
      },
    ],
    tasks: [
      {
        id: 'task',
        input: 'Exit successfully without modifying the task.',
        config: framework === 'harbor' ? { harbor: { path: 'task' } } : { pier: { path: 'task' } },
      },
    ],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function validateChecksum() {
  const checksumPath = `${tarballPath}.sha256`;
  const [expected, name, extra] = readFileSync(checksumPath, 'utf8').trim().split(/\s+/u);
  if (!expected || name !== basename(tarballPath) || extra !== undefined) {
    throw new Error(`Invalid checksum file ${checksumPath}`);
  }
  const actual = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${tarballPath}`);
}

function logStep(message) {
  console.log(`[release-cli-eval-validation] ${message}`);
}
