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

/**
 * Run the Desktop Playwright e2e tier with one X server per worker, because a
 * server has one input focus and this tier is the tests that assert it.
 * `xvfb-run -a` cannot: it allocates one display for one command.
 *
 * `--workers N`: workers, and therefore servers. Defaults to 1.
 * `--display-base N`: first display number. Defaults to 90.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

export const DEFAULT_DISPLAY_BASE = 90;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_MS = 100;
const RETIREMENT_GRACE_MS = 2_000;

export function parseCliArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      workers: { type: 'string', default: '1' },
      'display-base': { type: 'string', default: String(DEFAULT_DISPLAY_BASE) },
    },
  });
  const workers = Number(values.workers);
  const displayBase = Number(values['display-base']);
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error('--workers must be a positive integer');
  }
  if (!Number.isSafeInteger(displayBase) || displayBase < 0) {
    throw new Error('--display-base must be a non-negative integer');
  }
  return { workers, displayBase };
}

export function displaysFor(workers, displayBase) {
  return Array.from({ length: workers }, (_, index) => `:${displayBase + index}`);
}

async function exitCodeOf(child) {
  try {
    const [code, signal] = await once(child, 'close');
    return signal ? 1 : (code ?? 1);
  } catch {
    return 1;
  }
}

/** Whether a server is already answering, which would let it serve two workers. */
async function accepts(display, spawn) {
  const probe = spawn('xdpyinfo', ['-display', display], { stdio: 'ignore' });
  return (await exitCodeOf(probe)) === 0;
}

async function waitUntilAccepting(display, spawn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // The socket under /tmp/.X11-unix appears before the server accepts clients,
  // so its presence is not readiness.
  while (Date.now() < deadline) {
    if (await accepts(display, spawn)) return;
    await delay(READINESS_POLL_MS);
  }
  throw new Error(`${display} never accepted clients`);
}

function closesWithin(closed, timeoutMs) {
  return Promise.race([closed.then(() => true), delay(timeoutMs, false, { ref: false })]);
}

export async function runDesktopE2eParallel(options = {}) {
  const {
    workers = 1,
    displayBase = DEFAULT_DISPLAY_BASE,
    spawn = defaultSpawn,
    // Injectable so a test need not spend the real window on a server that
    // will never answer.
    readinessTimeoutMs = READINESS_TIMEOUT_MS,
    retirementGraceMs = RETIREMENT_GRACE_MS,
  } = options;
  const displays = displaysFor(workers, displayBase);
  const servers = [];
  try {
    for (const display of displays) {
      if (await accepts(display, spawn)) throw new Error(`${display} is already in use`);
      const server = spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], {
        stdio: 'ignore',
      });
      servers.push({ process: server, closed: exitCodeOf(server) });
      await waitUntilAccepting(display, spawn, readinessTimeoutMs);
    }
    const suite = spawn(
      'npm',
      [
        'exec',
        '-w',
        '@maka/desktop',
        '--',
        'playwright',
        'test',
        '--config',
        'e2e/playwright.config.ts',
        '--workers',
        String(workers),
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          DISPLAY: displays[0],
          MAKA_E2E_DISPLAY_BASE: String(displayBase),
        },
      },
    );
    return await exitCodeOf(suite);
  } finally {
    // Awaited, not just signalled: later steps run their own xvfb-run, and a
    // leftover server would take a share of a runner this tier already saturates.
    await Promise.all(
      servers.map(async (server) => {
        server.process.kill();
        if (!(await closesWithin(server.closed, retirementGraceMs))) {
          server.process.kill('SIGKILL');
          await server.closed;
        }
      }),
    );
  }
}

if (process.argv[1] && join(process.argv[1]) === scriptPath) {
  const { workers, displayBase } = parseCliArgs(process.argv.slice(2));
  process.exitCode = await runDesktopE2eParallel({ workers, displayBase });
}
