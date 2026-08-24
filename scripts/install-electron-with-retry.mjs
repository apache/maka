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
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const transientCodes = new Set([
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const transientHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isTransientElectronInstallFailure(contextOutput) {
  return contextOutput.split(/\r?\n/).some((line) => {
    if (!line) return false;
    try {
      const context = JSON.parse(line);
      return (
        (context.kind === 'fetch' && transientCodes.has(context.code)) ||
        (context.kind === 'http' && transientHttpStatuses.has(context.status))
      );
    } catch {
      return false;
    }
  });
}

export async function installWithRetry(
  runAttempt,
  {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    wait = sleep,
    warn = console.warn,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAttempt(attempt);
    if (
      result.status === 0 ||
      typeof result.status !== 'number' ||
      result.signal ||
      result.spawnError ||
      !isTransientElectronInstallFailure(result.context ?? '')
    ) {
      return result;
    }
    if (attempt === maxAttempts) {
      return result;
    }

    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    warn(
      `[install-electron] transient download failure on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms`,
    );
    await wait(delayMs);
  }

  throw new Error('Electron install retry loop ended unexpectedly');
}

export function electronInstallerSpawnOptions(repositoryRoot) {
  return {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'inherit', 'pipe', 'pipe'],
  };
}

async function main() {
  const require = createRequire(import.meta.url);
  const installer = require.resolve('electron/install.js');
  const launcher = fileURLToPath(new URL('./run-electron-installer.cjs', import.meta.url));
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  const result = await installWithRetry(() => {
    const child = spawnSync(
      process.execPath,
      [launcher, installer],
      electronInstallerSpawnOptions(repositoryRoot),
    );
    if (child.stderr) {
      process.stderr.write(child.stderr);
    }
    if (child.error) {
      const message = child.error.stack ?? child.error.message;
      process.stderr.write(`${message}\n`);
      return {
        status: child.status,
        signal: child.signal,
        spawnError: true,
        context: child.output?.[3] ?? '',
        stderr: `${child.stderr ?? ''}\n${message}`,
      };
    }
    return {
      status: child.status,
      signal: child.signal,
      context: child.output?.[3] ?? '',
      stderr: child.stderr ?? '',
    };
  });

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
