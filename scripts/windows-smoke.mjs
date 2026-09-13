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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const CLI_PATH = join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const DESKTOP_MAIN = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'main.js');
const DESKTOP_PRELOAD = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'preload', 'preload.cjs');
const DESKTOP_RENDERER = join(REPO_ROOT, 'apps', 'desktop', 'dist-renderer', 'index.html');
const DESKTOP_RUNTIME_WORKER = join(
  REPO_ROOT,
  'apps',
  'desktop',
  'resources',
  'workers',
  'filesystem-worker.js',
);
const DESKTOP_SMOKE = join(REPO_ROOT, 'scripts', 'desktop-real-window-smoke.mjs');
const CLI_TIMEOUT_MS = 15_000;
const DESKTOP_TIMEOUT_MS = 45_000;

export function runWindowsSmoke(options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawnSync ?? spawnSync;
  const exists = options.existsSync ?? existsSync;
  if (platform !== 'win32') throw new Error('Windows smoke must run on Windows');

  for (const artifact of [
    CLI_PATH,
    DESKTOP_MAIN,
    DESKTOP_PRELOAD,
    DESKTOP_RENDERER,
    DESKTOP_RUNTIME_WORKER,
  ]) {
    if (!exists(artifact)) {
      throw new Error(`Missing build artifact: ${artifact}. Run npm run build first.`);
    }
  }

  const isolatedHome = mkdtempSync(join(tmpdir(), 'maka-windows-smoke-'));
  try {
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
      MAKA_SKIP_SHELL_ENV: '1',
    };
    runChecked(spawn, process.execPath, [CLI_PATH, '--version'], {
      cwd: REPO_ROOT,
      env,
      timeout: CLI_TIMEOUT_MS,
    });
    runChecked(spawn, process.execPath, [CLI_PATH, '--help'], {
      cwd: REPO_ROOT,
      env,
      timeout: CLI_TIMEOUT_MS,
    });
    const desktop = runChecked(
      spawn,
      process.execPath,
      [DESKTOP_SMOKE, '--startup-only', '--diagnostic-wait-ms', '30000'],
      { cwd: REPO_ROOT, env, timeout: DESKTOP_TIMEOUT_MS },
    );
    if (!desktop.stdout?.includes('[real-window-smoke] report:')) {
      throw new Error('Electron startup smoke exited without producing a report');
    }
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

function runChecked(spawn, command, args, options) {
  const result = spawn(command, args, { ...options, encoding: 'utf8', stdio: 'pipe' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runWindowsSmoke();
    console.log('Windows CLI and Electron startup smoke passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
