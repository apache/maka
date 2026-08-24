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

// Unit test for MakaCuService, the supervisor between the maka-cu backend and
// the executor child. Drives it against a MOCK executor (a small CommonJS node
// script written to a temp dir) that speaks `maka.cu/2` — the real `maka-cu`
// binary is never spawned, and does not exist as a signed artifact yet.
//
// The supervisor had no test of its own: it was exercised only through the
// backend, which cannot reach a `null` line on stdout, a handshake declaring
// `snapshotsPerSession: 0`, a file that cannot be executed, or a `$/cancel`
// that was written but never flushed. Every one of those was a live defect.
//
// Run (from repo root):
//   npm --workspace @maka/computer-use run test
import assert from 'node:assert/strict';
import { chmodSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { MakaCuProtocolViolation } from '../maka-cu-protocol.js';
import {
  isMakaCuLifecycleError,
  MakaCuService,
  type MakaCuLimits,
  type MakaCuServiceOptions,
} from '../maka-cu-service.js';

const SANE_LIMITS: MakaCuLimits = {
  snapshotsPerSession: 8,
  snapshotTtlMs: 120_000,
  maxElements: 1500,
  maxDepth: 64,
  maxTextChars: 500,
  maxResponseBytes: 1_048_576,
  settleCeilingMs: 2500,
  shutdownGraceMs: 3000,
  imageDirBudgetBytes: 268_435_456,
};

// No backticks / ${} inside → embedded via String.raw so escapes survive.
const MOCK_SRC = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
if (process.argv[2] !== 'host') {
  process.stderr.write('mock maka-cu: expected argv[2] === "host"\n');
  process.exit(64);
}
const LOG = process.env.MAKACU_SVC_LOG || '';
const LIMITS = process.env.MAKACU_SVC_LIMITS || '{}';
// Emitted verbatim after the handshake, one per line. A JSON value that is not
// a response ('null') is the case that took the host process down.
const AFTER_HELLO = process.env.MAKACU_SVC_AFTER_HELLO || '';
// Never answer these methods, so the host's deadline and $/cancel are what act.
const SILENT = (process.env.MAKACU_SVC_SILENT || '').split(',').filter(Boolean);
// Answer $/cancel with a real refusal, which is what §7.2 asks an executor to do.
const ANSWER_CANCEL = process.env.MAKACU_SVC_ANSWER_CANCEL === '1';
// Print this many bytes of a single response, to push the stdout budget.
const RESPONSE_PAD = Number(process.env.MAKACU_SVC_RESPONSE_PAD || '0');
function logRec(rec) {
  if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch (e) {} }
}
logRec({ kind: 'start', pid: process.pid });
process.on('SIGTERM', function () { logRec({ kind: 'sigterm' }); process.exit(0); });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function handle(msg) {
  if (msg.method === '$/cancel') {
    logRec({ kind: 'cancel', id: msg.params && msg.params.id });
    if (ANSWER_CANCEL) {
      send({ jsonrpc: '2.0', id: msg.params.id, result: { ok: false, error: {
        code: 'aborted', message: 'cancelled on request' } } });
    }
    return;
  }
  if (typeof msg.id !== 'number') return;
  if (msg.method === 'host.hello') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true, protocol: 'maka.cu/2',
      executor: { name: 'maka-cu-mock', version: '0.0.1' }, pid: process.pid,
      capabilities: { captureStream: false, elementActions: [], pointActions: [],
        keyActions: [], imageFormats: ['png'] },
      limits: JSON.parse(LIMITS) }});
    if (AFTER_HELLO) {
      setTimeout(function () {
        for (const line of AFTER_HELLO.split('|')) process.stdout.write(line + '\n');
        // Observable marker: the stray lines are on stdout once this lands in
        // the log, so a test can order its next round trip after them.
        logRec({ kind: 'after-hello' });
      }, 30);
    }
    return;
  }
  if (SILENT.includes(msg.method)) return;
  const pad = RESPONSE_PAD > 0 ? 'x'.repeat(RESPONSE_PAD) : undefined;
  send({ jsonrpc: '2.0', id: msg.id, result: Object.assign({ ok: true },
    pad === undefined ? {} : { pad: pad }) });
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    logRec({ kind: 'recv', method: msg.method, id: msg.id });
    handle(msg);
  }
});
`;

let workDir = '';
let mockPath = '';
const services: MakaCuService[] = [];
const imageDirs: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// The mock appends to its log from another process, so a single read races its
// scheduler: a caller settled by the host's grace timer can observe the log a
// few milliseconds before the child's `appendFileSync` lands (even a SIGKILLed
// child gets a last slice). Poll with a bounded deadline — a real regression
// (no `$/cancel` ever written) still fails, just without depending on which
// process the scheduler ran first.
async function waitForRecord(
  logPath: string,
  predicate: (record: Record<string, unknown>) => boolean,
  what: string,
  deadlineMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const records = await readRecords(logPath);
    if (records.some(predicate)) return;
    if (Date.now() - startedAt >= deadlineMs) {
      assert.fail(`${what} (log after ${deadlineMs}ms: ${JSON.stringify(records)})`);
    }
    await delay(10);
  }
}

async function waitForPathRemoval(path: string, deadlineMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (existsSync(path)) {
    if (Date.now() - startedAt >= deadlineMs) {
      assert.fail(`${path} still exists after ${deadlineMs}ms`);
    }
    await delay(10);
  }
}

function makeService(
  opts: {
    limits?: Partial<MakaCuLimits>;
    afterHello?: string;
    silent?: string[];
    answerCancel?: boolean;
    responsePad?: number;
    binaryPath?: string;
    timeoutMs?: number;
    maxRestartAttempts?: number;
  } = {},
): { service: MakaCuService; logPath: string; imageDir: string } {
  const logPath = join(workDir, `svc-${randomUUID()}.ndjson`);
  const imageDir = join(workDir, `images-${randomUUID()}`);
  const options: MakaCuServiceOptions = {
    binaryPath: opts.binaryPath ?? mockPath,
    imageDir,
    hostVersion: 'test',
    handshakeTimeoutMs: 5000,
    timeoutMs: opts.timeoutMs ?? 5000,
    maxRestartAttempts: opts.maxRestartAttempts ?? 2,
    restartBackoffMs: 5,
    childEnv: {
      ...process.env,
      MAKACU_SVC_LOG: logPath,
      MAKACU_SVC_LIMITS: JSON.stringify({ ...SANE_LIMITS, ...(opts.limits ?? {}) }),
      MAKACU_SVC_AFTER_HELLO: opts.afterHello ?? '',
      MAKACU_SVC_SILENT: (opts.silent ?? []).join(','),
      MAKACU_SVC_ANSWER_CANCEL: opts.answerCancel ? '1' : '',
      MAKACU_SVC_RESPONSE_PAD: String(opts.responsePad ?? 0),
    },
  };
  const service = new MakaCuService(options);
  services.push(service);
  imageDirs.push(imageDir);
  return { service, logPath, imageDir };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'maka-cu-service-test-'));
  mockPath = join(workDir, 'maka-cu-mock.cjs');
  await writeFile(mockPath, MOCK_SRC, 'utf8');
  chmodSync(mockPath, 0o755);
});

after(async () => {
  for (const service of services) {
    try {
      service.dispose();
    } catch {
      // A disposed service disposing again is not a test failure.
    }
  }
  // `dispose()` is deliberately fire-and-forget: it SIGTERMs the child and
  // schedules an asynchronous image-directory purge on child exit (or on the
  // shutdown-grace SIGKILL, at most `shutdownGraceMs` = 3s later). Deleting
  // `workDir` while those purges — and a child still flushing its ndjson log —
  // are in flight races `rm` against concurrent writers and fails with
  // ENOTEMPTY (issue #3290). Every `makeService` image directory is purged by
  // its `dispose()`, so waiting for them to vanish is a "children exited and
  // purges finished" barrier. The wait is tolerant rather than asserting —
  // purge failures are permitted by contract ("the next spawn purges it
  // again") and are not what this teardown tests — and the retrying `rm`
  // backstop then only absorbs stragglers, not an unbounded race.
  const purgeDeadline = Date.now() + 10_000;
  while (imageDirs.some((imageDir) => existsSync(imageDir)) && Date.now() < purgeDeadline) {
    await delay(25);
  }
  if (workDir) {
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('maka-cu supervisor: what the child may put on stdout', () => {
  it('survives a JSON value that is not a response, and does not answer for it', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      // `null`, `4` and `"x"` are all valid JSON lines and none is a response.
      // Reading `.id` off `null` threw inside the stdout `data` listener, where
      // no caller is on the stack, and took the host process down. A Rust
      // executor serialising `Option::None` on an error path emits those five
      // bytes.
      const { service, logPath } = makeService({ afterHello: 'null' });
      const handshake = await service.ensureStarted();
      assert.equal(handshake.executor.name, 'maka-cu-mock');
      // The mock emits the stray line from a timer after the handshake, so
      // first wait for its marker: once logged, `null` is on stdout ahead of
      // the next response. The round trip below is then a true causal anchor —
      // the stray line was processed (and would have thrown in the data
      // listener) before the call returned.
      await waitForRecord(
        logPath,
        (record) => record.kind === 'after-hello',
        'the mock never emitted its post-hello stray line',
      );
      // Still usable: one stray line is not a dead executor.
      const envelope = await service.call('window.list', {});
      assert.equal(envelope.ok, true);
      assert.deepEqual(uncaught, [], 'a null stdout line must not reach uncaughtException');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('tears the child down after three lines that are not protocol messages', async () => {
    const { service } = makeService({ afterHello: 'null|4|"not a message"' });
    await service.ensureStarted();
    // The junk lines stream in after the handshake settles; poll the teardown
    // fact with a bounded deadline instead of guessing scheduler timing.
    const deadline = Date.now() + 2_000;
    while (service.snapshot().state !== 'idle' && Date.now() < deadline) await delay(10);
    assert.equal(service.snapshot().state, 'idle', 'three non-messages end the generation');
  });

  it('sizes the stdout budget from the negotiated maxResponseBytes', async () => {
    // A 4 MiB fixed cap tore an executor down mid-legal-response when it had
    // declared it could send more. The declared bound is what applies.
    const { service } = makeService({
      limits: { maxResponseBytes: 8 * 1024 * 1024 },
      responsePad: 5 * 1024 * 1024,
      timeoutMs: 15_000,
    });
    await service.ensureStarted();
    const envelope = await service.call('observe', {});
    assert.equal(envelope.ok, true, 'a response inside the declared bound must arrive whole');
  });
});

describe('maka-cu supervisor: the handshake is a closed contract (§2)', () => {
  const rejected: Array<[string, Partial<MakaCuLimits>, RegExp]> = [
    // 0 is the conventional spelling of "unlimited" and a plausible executor
    // default. The host's eviction loop is `while (ids.length >= limit)`, a
    // fresh session has no ids, `0 >= 0` holds, and the forget is a no-op —
    // an infinite synchronous loop in the Electron main process, where no
    // abort, timeout or dispose can run because the event loop is blocked.
    [
      'snapshotsPerSession: 0',
      { snapshotsPerSession: 0 },
      /snapshotsPerSession must be at least 1/,
    ],
    // Expires every snapshot the moment it is stored, so the click after an
    // observe is refused with a stale_frame sentence that is false.
    ['snapshotTtlMs: -1', { snapshotTtlMs: -1 }, /snapshotTtlMs must be at least 1/],
    // SIGKILLs immediately, leaking the executor-drawn cursor and the image
    // directory that SIGTERM exists to clean up.
    ['shutdownGraceMs: 0', { shutdownGraceMs: 0 }, /shutdownGraceMs must be at least 1/],
    ['maxElements: 2.5', { maxElements: 2.5 }, /maxElements is not a whole number/],
    ['maxDepth: "64"', { maxDepth: '64' as unknown as number }, /maxDepth is not a finite number/],
  ];

  for (const [name, limits, expected] of rejected) {
    it(`refuses ${name} as a protocol violation, without respawning`, async () => {
      const { service } = makeService({ limits });
      await assert.rejects(
        () => service.ensureStarted(),
        (error: unknown) => {
          assert.ok(
            error instanceof MakaCuProtocolViolation,
            `expected MakaCuProtocolViolation, got ${(error as Error)?.constructor?.name}`,
          );
          assert.match((error as Error).message, expected);
          return true;
        },
      );
      // A structurally broken handshake is not transient. Throwing a plain
      // Error left `backendFailure` unable to classify it and the restart
      // budget respawning the same binary three times to be told the same
      // thing; one generation is the whole of what should have been spawned.
      assert.equal(service.snapshot().generation, 1);
      assert.equal(service.snapshot().state, 'unavailable');
    });
  }

  it('accepts a handshake whose limits are all whole and positive', async () => {
    const { service } = makeService();
    const handshake = await service.ensureStarted();
    assert.deepEqual(handshake.limits, SANE_LIMITS);
  });
});

describe('maka-cu supervisor: cancelling a delivered request (§7.2/§7.3)', () => {
  it('settles an aborted delivered request in the cancel grace, not the deadline', async () => {
    // Measured before the fix with a 4s deadline: abort at t=120ms, caller
    // settled at t=4022ms with outcome_unknown, and the model never saw
    // `aborted`. At the shipping default that is twenty seconds — and the
    // backend serialises every operation through one lane, so the next turn's
    // first call queues behind the abandoned request.
    const { service, logPath } = makeService({ silent: ['observe'], timeoutMs: 8000 });
    await service.ensureStarted();
    const controller = new AbortController();
    const started = Date.now();
    const call = service.call('observe', {}, controller.signal);
    // Settled later by assert.rejects; without this, a barrier failure below
    // would leave it an unhandled rejection.
    void call.catch(() => {});
    // The ordering claim holds because ensureStarted has already settled: both
    // calls then take the same synchronous write path onto one ordered pipe,
    // and the mock processes stdin lines in order. The same invariant carries
    // every barrier in this suite.
    const barrier = await service.call('window.list', {});
    assert.equal(barrier.ok, true, 'the later round trip proves observe reached the executor');
    controller.abort();
    await assert.rejects(call, (error: unknown) => {
      assert.ok(isMakaCuLifecycleError(error), 'a cancelled dispatch is a lifecycle error');
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `settled in ${elapsed}ms, which must be the grace not the deadline`);
    await waitForRecord(
      logPath,
      (record) => record.kind === 'cancel',
      'the executor must be asked to cancel',
    );
  });

  it('lets the executor answer a cancel, and reports the answer it gave', async () => {
    // §7.2: the executor answers `aborted` if it has not dispatched and the
    // real outcome if it has. Killing the child would turn every cancelled
    // pre-dispatch request into outcome_unknown and lose the action's fate.
    const { service } = makeService({
      silent: ['observe'],
      answerCancel: true,
      timeoutMs: 8000,
    });
    await service.ensureStarted();
    const controller = new AbortController();
    const call = service.call('observe', {}, controller.signal);
    void call.catch(() => {});
    const barrier = await service.call('window.list', {});
    assert.equal(barrier.ok, true, 'the later round trip proves observe reached the executor');
    controller.abort();
    const envelope = await call;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.ok === false && envelope.error.code, 'aborted');
    assert.equal(service.snapshot().state, 'ready', 'the child answered, so it stays alive');
  });

  it('asks before killing on the deadline, so $/cancel is not written into a dying pipe', async () => {
    // Before: the timeout notified `$/cancel` and called kill() in the same
    // tick, so the buffered stdin write never flushed. Verified against this
    // mock — the abort path produced a cancel in its read log and the timeout
    // path produced none — which means §7.3's graceful cancel never happened
    // and the executor never got to end sessions, remove its agent cursor or
    // clear its image directory.
    const { service, logPath } = makeService({ silent: ['observe'], timeoutMs: 300 });
    await service.ensureStarted();
    await assert.rejects(service.call('observe', {}));
    await waitForRecord(
      logPath,
      (record) => record.kind === 'cancel',
      'the deadline must ask the executor to cancel before tearing it down',
    );
  });

  it('clears one session without ending the others', async () => {
    // Before: any session with a delivered request in flight SIGKILLed the
    // child, which invalidated every other session's observations too.
    const { service, logPath } = makeService({
      silent: ['observe'],
      answerCancel: true,
      timeoutMs: 8000,
    });
    await service.ensureStarted();
    const generation = service.snapshot().generation;
    const call = service.withSession('session-a', () => service.call('observe', {}));
    void call.catch(() => {});
    const barrier = await service.call('window.list', {});
    assert.equal(barrier.ok, true, 'the later round trip proves observe reached the executor');
    service.clearSession('session-a');
    const cancelled = await call;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.ok === false && cancelled.error.code, 'aborted');
    assert.equal(service.snapshot().state, 'ready');
    assert.equal(service.snapshot().generation, generation, 'the generation must survive');
    const records = await readRecords(logPath);
    assert.ok(
      records.some((record) => record.kind === 'cancel'),
      'clearing a session asks the executor to cancel its work',
    );
  });
});

describe('maka-cu supervisor: saying what actually failed', () => {
  it('reports an exec failure as one, with the errno', async () => {
    // maka-cu is unsigned, hand-built and not distributed, so exec failure is
    // the expected case and it was the worst-reported one: `child.on('error')`
    // discarded its Error, and a 0755 file whose interpreter does not exist was
    // reported as "maka-cu exited after request delivery" — for a child that
    // never execed and to which nothing had been delivered.
    const badPath = join(workDir, `bad-interp-${randomUUID()}`);
    await writeFile(badPath, '#!/nonexistent/interpreter\n', 'utf8');
    chmodSync(badPath, 0o755);
    const { service } = makeService({ binaryPath: badPath, maxRestartAttempts: 1 });
    await assert.rejects(
      () => service.ensureStarted(),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /could not be executed/);
        assert.doesNotMatch(message, /after request delivery/);
        return true;
      },
    );
  });

  it('reports an absent binary as unavailable rather than a version skew', async () => {
    // `service_mismatch` means the two sides disagree about the protocol
    // everywhere else, and it maps to the model-facing protocol_violation
    // sentence. ENOENT is not that.
    const { service } = makeService({ binaryPath: join(workDir, 'no-such-binary') });
    await assert.rejects(
      () => service.ensureStarted(),
      (error: unknown) => {
        assert.ok(isMakaCuLifecycleError(error, 'service_unavailable'));
        assert.match((error as Error).message, /is not usable at/);
        return true;
      },
    );
    assert.equal(
      service.snapshot().generation,
      0,
      'nothing is spawned for a path that is not there',
    );
  });

  it('keeps saying why after the restart budget is spent', async () => {
    // `restartAttempts` only resets on a success, so every later call re-entered
    // the loop with it already at the maximum and read the reason out of a
    // loop-local: "maka-cu restart budget exhausted: undefined", for the rest of
    // the process lifetime.
    const brokenPath = join(workDir, `broken-${randomUUID()}.cjs`);
    await writeFile(brokenPath, '#!/usr/bin/env node\nprocess.exit(3);\n', 'utf8');
    chmodSync(brokenPath, 0o755);
    const { service } = makeService({ binaryPath: brokenPath, maxRestartAttempts: 1 });
    await assert.rejects(() => service.ensureStarted());
    await assert.rejects(
      () => service.ensureStarted(),
      (error: unknown) => {
        assert.match((error as Error).message, /restart budget exhausted/);
        assert.doesNotMatch((error as Error).message, /exhausted: undefined/);
        return true;
      },
    );
  });
});

describe('maka-cu supervisor: shutdown', () => {
  it('leaves no image directory behind when disposed during startup', async () => {
    // §8: the host owns the directory. `dispose()` purged it and then the
    // in-flight `start()` carried on to mkdir it again, so it survived for
    // good — nothing purges it later, because the next spawn purges the
    // directory of a service that no longer exists. cua-driver's supervisor
    // has this guard and maka-cu's copy dropped it.
    const { service, imageDir } = makeService();
    const starting = service.ensureStarted();
    void starting.catch(() => {});
    service.dispose();
    await starting.catch(() => {});
    await waitForPathRemoval(imageDir);
  });
});
