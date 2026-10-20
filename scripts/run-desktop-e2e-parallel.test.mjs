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
import { describe, it } from 'node:test';
import { displaysFor, parseCliArgs, runDesktopE2eParallel } from './run-desktop-e2e-parallel.mjs';

/**
 * @param {{ answering?: Set<string>, stubborn?: Set<string>, suiteExitCode?: number, unspawnable?: Set<string> }} [options]
 */
function fakeSpawn(options = {}) {
  const answering = options.answering ?? new Set();
  const stubborn = options.stubborn ?? new Set();
  const unspawnable = options.unspawnable ?? new Set();
  const suiteExitCode = options.suiteExitCode ?? 0;
  const calls = [];
  const killed = [];
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const child = new EventEmitter();
    child.kill = (signal = 'SIGTERM') => {
      killed.push({ display: args[0], signal });
      if (!stubborn.has(args[0]) || signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('close', null, signal));
      }
    };
    if (command === 'xdpyinfo') {
      queueMicrotask(() => child.emit('close', answering.has(args[1]) ? 0 : 1, null));
    } else if (command === 'Xvfb') {
      if (unspawnable.has(args[0])) {
        queueMicrotask(() => child.emit('error', new Error(`spawn Xvfb ENOENT ${args[0]}`)));
      } else {
        // A started server answers from then on.
        answering.add(args[0]);
      }
    } else {
      queueMicrotask(() => child.emit('close', suiteExitCode, null));
    }
    return child;
  };
  return { spawn, calls, killed };
}

describe('parseCliArgs', () => {
  it('defaults to the serial shape', () => {
    assert.deepEqual(parseCliArgs([]), { workers: 1, displayBase: 90 });
  });

  it('accepts both argument spellings', () => {
    assert.deepEqual(parseCliArgs(['--workers=3', '--display-base=40']), {
      workers: 3,
      displayBase: 40,
    });
    assert.deepEqual(parseCliArgs(['--workers', '2', '--display-base', '7']), {
      workers: 2,
      displayBase: 7,
    });
  });

  it('rejects a worker count that would leave a server unused or unassigned', () => {
    assert.throws(() => parseCliArgs(['--workers=0']), /positive integer/u);
    assert.throws(() => parseCliArgs(['--workers=2.5']), /positive integer/u);
    assert.throws(() => parseCliArgs(['--nope']), /Unknown option/u);
  });
});

describe('displaysFor', () => {
  it('gives every worker a display of its own', () => {
    assert.deepEqual(displaysFor(3, 90), [':90', ':91', ':92']);
  });
});

describe('runDesktopE2eParallel', () => {
  it('starts one server per worker and tells the suite where they are', async () => {
    const { spawn, calls } = fakeSpawn();
    assert.equal(await runDesktopE2eParallel({ workers: 3, spawn }), 0);

    assert.deepEqual(
      calls.filter((call) => call.command === 'Xvfb').map((call) => call.args[0]),
      [':90', ':91', ':92'],
    );
    const suite = calls.find((call) => call.command === 'npm');
    assert.equal(suite.options.env.MAKA_E2E_DISPLAY_BASE, '90');
    assert.equal(suite.options.env.DISPLAY, ':90');
    assert.deepEqual(suite.args.slice(-2), ['--workers', '3']);
  });

  it('retires every server even when the suite fails', async () => {
    const { spawn, calls, killed } = fakeSpawn({ suiteExitCode: 1 });
    assert.equal(await runDesktopE2eParallel({ workers: 2, spawn }), 1);
    assert.deepEqual(killed, [
      { display: ':90', signal: 'SIGTERM' },
      { display: ':91', signal: 'SIGTERM' },
    ]);
    assert.ok(calls.some((call) => call.command === 'npm'));
  });

  it('retires the servers already started when Xvfb cannot be spawned', async () => {
    // An unhandled 'error' event throws past try/finally rather than raising,
    // so without a listener the first server would outlive this call.
    const { spawn, killed } = fakeSpawn({ unspawnable: new Set([':91']) });
    await assert.rejects(
      runDesktopE2eParallel({ workers: 2, spawn, readinessTimeoutMs: 20 }),
      /:91 never accepted clients/u,
    );
    assert.deepEqual(killed, [
      { display: ':90', signal: 'SIGTERM' },
      { display: ':91', signal: 'SIGTERM' },
    ]);
  });

  it('forces a server down when graceful retirement expires', async () => {
    const { spawn, killed } = fakeSpawn({ stubborn: new Set([':90']) });
    assert.equal(await runDesktopE2eParallel({ workers: 1, spawn, retirementGraceMs: 0 }), 0);
    assert.deepEqual(killed, [
      { display: ':90', signal: 'SIGTERM' },
      { display: ':90', signal: 'SIGKILL' },
    ]);
  });

  it('refuses a display another server already answers on', async () => {
    // Reusing it would serve two workers from one focus, which reads as flake.
    const { spawn } = fakeSpawn({ answering: new Set([':91']) });
    await assert.rejects(runDesktopE2eParallel({ workers: 3, spawn }), /:91 is already in use/u);
  });
});
