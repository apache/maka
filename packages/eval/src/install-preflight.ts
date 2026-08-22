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

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  BUNDLED_HARNESS_RELAY_ROOT,
  createHarnessPreparationEnvironment,
  resolvePathWithinRoot,
  resolveRealPathWithinRoot,
} from './harness-environment.js';
import type { HarnessFramework, HarnessOptions } from './harness-executor.js';

const PREFLIGHT_TIMEOUT_MS = 10_000;
const PREFLIGHT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PYTHON_FRAMEWORK_PROBE = [
  'from importlib import import_module',
  'from importlib.metadata import version',
  'import sys',
  'actual = version(sys.argv[1])',
  'if actual != sys.argv[2]:',
  '    raise SystemExit(f"installed {actual}, expected {sys.argv[2]}")',
  'import_module(f"{sys.argv[3]}.models.trial.config")',
].join('\n');

export interface HarnessPreflightDependencies {
  readonly runCommand: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

interface HarnessPreflightInput {
  readonly framework: HarnessFramework;
  readonly options: HarnessOptions;
  readonly specPath: string;
  readonly subjectCredentialNames: readonly string[];
  readonly signal?: AbortSignal;
}

export async function preflightHarnessInstallation(
  input: HarnessPreflightInput,
  dependencies: Partial<HarnessPreflightDependencies> = {},
): Promise<void> {
  input.signal?.throwIfAborted();
  const { framework, options, specPath } = input;
  const pythonPath = pythonCommand(options.pythonPathEnv, specPath);
  const trialsRoot = machinePath(options.trialsRootEnv);

  if (isAbsolute(pythonPath)) {
    await requirePath(pythonPath, `machine path ${options.pythonPathEnv}`, 'file');
    await access(pythonPath, constants.X_OK).catch(() => {
      throw new Error(`machine path ${options.pythonPathEnv} is not executable: ${pythonPath}`);
    });
  }
  await requireUsableDirectory(trialsRoot, `machine path ${options.trialsRootEnv}`);

  if (options.tasksRootEnv) {
    await requirePath(
      machinePath(options.tasksRootEnv),
      `machine path ${options.tasksRootEnv}`,
      'directory',
    );
  }

  for (const mount of options.mounts) {
    await requirePath(machinePath(mount.sourceEnv), `machine path ${mount.sourceEnv}`, 'any');
  }

  let networkPolicyPath: string | undefined;
  if (options.egressProxy) {
    const source = machinePath(options.egressProxy.composeSourceEnv);
    await requirePath(source, `machine path ${options.egressProxy.composeSourceEnv}`, 'directory');
    const composeCandidate = resolvePathWithinRoot(
      source,
      options.egressProxy.composeRelativePath,
      'egress proxy compose path',
    );
    const networkPolicyCandidate = resolvePathWithinRoot(
      source,
      options.egressProxy.networkPolicyRelativePath,
      'egress network policy path',
    );
    await requirePath(composeCandidate, 'Eval egress Compose overlay', 'file');
    await requirePath(networkPolicyCandidate, 'Eval egress network policy', 'file');
    [, networkPolicyPath] = await Promise.all([
      resolveRealPathWithinRoot(
        source,
        options.egressProxy.composeRelativePath,
        'egress proxy compose path',
      ),
      resolveRealPathWithinRoot(
        source,
        options.egressProxy.networkPolicyRelativePath,
        'egress network policy path',
      ),
    ]);
  }

  for (const asset of ['eval_framework.py', 'relay_agent.py', 'run_trial.py']) {
    await requirePath(
      resolve(BUNDLED_HARNESS_RELAY_ROOT, asset),
      `bundled Eval runtime ${asset}`,
      'file',
    );
  }

  input.signal?.throwIfAborted();
  const runCommand = dependencies.runCommand ?? runCheckedCommand;
  const environment = createHarnessPreparationEnvironment({
    subjectCredentialNames: input.subjectCredentialNames,
    declared: options.preparationEnvironment,
    ...(options.egressProxy && networkPolicyPath
      ? {
          egress: {
            allowedHost: options.egressProxy.allowedHost,
            networkPolicyPath,
          },
        }
      : {}),
  });
  const workingDirectory = dirname(specPath);
  const distribution = framework === 'harbor' ? 'harbor' : 'datacurve-pier';
  try {
    await runCommand(
      pythonPath,
      ['-c', PYTHON_FRAMEWORK_PROBE, distribution, options.frameworkVersion, framework],
      environment,
      workingDirectory,
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) input.signal.throwIfAborted();
    throw new Error(
      `${framework} Python environment ${options.pythonPathEnv} is unavailable or does not provide ${distribution}@${options.frameworkVersion}: ${errorMessage(error)}`,
    );
  }

  input.signal?.throwIfAborted();
  if (options.environment.type === 'docker') {
    try {
      await runCommand(
        'docker',
        ['version', '--format', '{{.Server.Version}}'],
        environment,
        workingDirectory,
        input.signal,
      );
    } catch (error) {
      if (input.signal?.aborted) input.signal.throwIfAborted();
      throw new Error(`Docker CLI or daemon is unavailable: ${errorMessage(error)}`);
    }
  }
}

async function runCheckedCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...args],
      {
        env: environment,
        cwd,
        timeout: PREFLIGHT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: PREFLIGHT_OUTPUT_LIMIT_BYTES,
        encoding: 'utf8',
        ...(signal ? { signal } : {}),
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(stderr.trim() || error.message));
      },
    );
  });
}

async function requirePath(
  path: string,
  label: string,
  expected: 'any' | 'file' | 'directory',
): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw new Error(`${label} is inaccessible: ${path}: ${errorMessage(error)}`);
  }
  if (expected === 'file' && !metadata.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (expected === 'directory' && !metadata.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

async function requireUsableDirectory(path: string, label: string): Promise<void> {
  let candidate = path;
  while (true) {
    let metadata;
    try {
      metadata = await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`${label} is inaccessible: ${candidate}: ${errorMessage(error)}`);
      }
      let linkMetadata;
      try {
        linkMetadata = await lstat(candidate);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`${label} is inaccessible: ${candidate}: ${errorMessage(linkError)}`);
        }
      }
      if (linkMetadata?.isSymbolicLink()) {
        throw new Error(`${label} is a dangling symbolic link: ${candidate}`);
      }
      if (linkMetadata) continue;
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error(`${label} has no accessible parent directory: ${path}`);
      }
      candidate = parent;
      continue;
    }

    if (!metadata.isDirectory()) {
      const subject = candidate === path ? label : `${label} parent`;
      throw new Error(`${subject} is not a directory: ${candidate}`);
    }
    await access(candidate, constants.W_OK | constants.X_OK).catch(() => {
      const subject = candidate === path ? label : `${label} nearest existing parent`;
      throw new Error(`${subject} is not writable and searchable: ${candidate}`);
    });
    return;
  }
}

function machinePath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`machine path ${name} is unavailable`);
  return resolve(value);
}

function pythonCommand(name: string, specPath: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`machine path ${name} is unavailable`);
  if (isAbsolute(value)) return value;
  return value.includes('/') || value.includes('\\') ? resolve(dirname(specPath), value) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
