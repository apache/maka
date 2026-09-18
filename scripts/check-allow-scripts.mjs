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

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmSpawnOptions } from './npm-spawn.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pruneArgs = ['install-scripts', 'prune', '--dry-run', '--json'];

/**
 * Resolve the npm CLI that launched this script so the check uses the exact
 * packageManager version selected by the caller. Direct `node` invocations
 * fall back to the npm executable on PATH.
 */
export function npmInvocation({ npmExecPath, execPath = process.execPath } = {}) {
  if (npmExecPath) {
    return { command: execPath, args: [npmExecPath, ...pruneArgs] };
  }
  return { command: 'npm', args: pruneArgs };
}

/** Parse npm 11.19's stable JSON result and reject incomplete output. */
export function parsePruneReport(stdout) {
  let document;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    throw new Error('npm install-scripts prune did not return valid JSON.', { cause: error });
  }

  const report = document?.allowScripts;
  if (!report || !Array.isArray(report.removed) || report.dryRun !== true) {
    throw new Error('npm install-scripts prune returned an unexpected JSON shape.');
  }

  for (const entry of report.removed) {
    if (
      !entry ||
      typeof entry.key !== 'string' ||
      typeof entry.value !== 'boolean' ||
      !['not-installed', 'no-scripts'].includes(entry.reason)
    ) {
      throw new Error('npm install-scripts prune returned an invalid removed entry.');
    }
  }
  return report;
}

/** Run npm's own policy matcher against the installed dependency tree. */
export function inspectAllowScripts({
  cwd = root,
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  const invocation = npmInvocation({
    npmExecPath: env.npm_execpath,
    execPath,
  });
  const options = {
    cwd,
    encoding: 'utf8',
    env: { ...env, npm_config_update_notifier: 'false' },
  };
  const result = spawn(
    invocation.command,
    invocation.args,
    env.npm_execpath ? options : npmSpawnOptions(options, platform),
  );

  if (result.error) {
    throw new Error(`Could not start npm install-scripts prune: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim())
      .join('\n');
    throw new Error(
      ['npm install-scripts prune failed. Use the npm version declared in package.json.', details]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return parsePruneReport(result.stdout);
}

/** Fail CI when npm says any approval or denial no longer applies. */
export function assertNoUnusedEntries(report) {
  if (report.removed.length === 0) return;

  const descriptions = report.removed.map(({ key, reason }) => {
    const detail =
      reason === 'no-scripts' ? 'package has no install scripts' : 'package not installed';
    return `  ${key} (${detail})`;
  });
  throw new Error(
    [
      `${report.removed.length} unused allowScripts entr${report.removed.length === 1 ? 'y' : 'ies'}:`,
      ...descriptions,
      'Review the dependency scripts, then update or remove these policy entries.',
    ].join('\n'),
  );
}

export function checkAllowScripts(options) {
  const report = inspectAllowScripts(options);
  assertNoUnusedEntries(report);
  return report;
}

function main() {
  try {
    checkAllowScripts();
    console.log('All allowScripts entries match installed packages with install scripts.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
