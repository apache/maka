import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { isCuaDriverLifecycleError, type CuaDriverReleaseEvent } from '../cua-driver-release.js';
import { CuaDriverService } from '../cua-driver-service.js';

const MOCK = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const LOG = process.env.CUA_SERVICE_LOG;
const MODE = process.env.CUA_SERVICE_MODE || '';
function log(value) { fs.appendFileSync(LOG, JSON.stringify(value) + '\n'); }
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
// cua-driver >= 0.12 hosts embedded callers as two processes: a "serve"
// daemon owning the runtime plus an "mcp" stdio proxy. The daemon only has to
// publish its socket for the service under test to proceed, so the mock binds
// the path and idles.
if (process.argv[2] === 'serve') {
  const socketIndex = process.argv.indexOf('--socket');
  const socketPath = socketIndex >= 0 ? process.argv[socketIndex + 1] : undefined;
  log({ kind: 'serve_start', pid: process.pid, socketPath });
  if (MODE === 'daemon_fail') process.exit(1);
  const net = require('net');
  const server = net.createServer(() => {});
  server.listen(socketPath, () => log({ kind: 'serve_listening', socketPath }));
  // The proxy exits on stdin EOF; the daemon's stdin is 'ignore', so it watches
  // its parent instead. Without this a daemon that outlives a disposed service
  // holds its stdio pipes open and the test runner never exits.
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) process.exit(0);
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 100);
  return;
}
log({ kind: 'start', pid: process.pid });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    log({ kind: 'request', method: message.method, name: message.params?.name });
    if (message.method === 'initialize') {
      if (MODE === 'hang_start') continue;
      reply(message.id, {
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: MODE === 'wrong_identity' ? 'wrong-server' : 'mock-cua-driver',
          version: '0.7.1-test',
        },
      });
      continue;
    }
    if (message.method !== 'tools/call') continue;
    const name = message.params.name;
    if (name === 'start_session') {
      reply(message.id, MODE === 'config_error' ? { isError: true } : {});
      continue;
    }
    if (name === 'exit_busy') {
      process.exit(19);
    }
    if (name === 'hang_busy') continue;
    reply(message.id, { structuredContent: { ok: true } });
  }
});
`;

let directory = '';
let binaryPath = '';
const liveServices = new Set<CuaDriverService>();

function trackService(instance: CuaDriverService): CuaDriverService {
  liveServices.add(instance);
  return instance;
}

async function records(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForRecord(
  path: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await records(path)).some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for mock request');
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cua-service-test-'));
  binaryPath = join(directory, 'mock.cjs');
  await writeFile(binaryPath, MOCK);
  chmodSync(binaryPath, 0o755);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  for (const instance of liveServices) instance.dispose();
  liveServices.clear();
});

function service(
  mode = '',
  options: {
    timeoutMs?: number;
    handshakeTimeoutMs?: number;
    maxRestartAttempts?: number;
    restartBackoffMs?: number;
    onRelease?: (event: CuaDriverReleaseEvent) => void;
  } = {},
) {
  const logPath = join(directory, `log-${crypto.randomUUID()}.ndjson`);
  const instance = trackService(
    new CuaDriverService({
      role: 'action',
      binaryPath,
      hostBundleId: 'ai.maka.test',
      captureScope: 'window',
      homeDir: join(directory, `home-${crypto.randomUUID()}`),
      timeoutMs: options.timeoutMs ?? 200,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      maxRestartAttempts: options.maxRestartAttempts ?? 2,
      restartBackoffMs: options.restartBackoffMs ?? 1,
      childEnv: {
        ...process.env,
        CUA_SERVICE_LOG: logPath,
        CUA_SERVICE_MODE: mode,
      },
      ...(options.onRelease ? { onRelease: options.onRelease } : {}),
    }),
  );
  return { instance, logPath };
}

describe('cua-driver service lifecycle', () => {
  it('tracks explicit role state and generation across dead-child recovery', async () => {
    const { instance } = service();
    assert.deepEqual(instance.snapshot(), {
      role: 'action',
      state: 'idle',
      generation: 0,
      restartAttempts: 0,
    });

    await instance.callTool('ok', {});
    assert.equal(instance.snapshot().state, 'ready');
    assert.equal(instance.snapshot().generation, 1);

    await assert.rejects(instance.callTool('exit_busy', {}), (error) =>
      isCuaDriverLifecycleError(error, 'outcome_unknown'),
    );
    assert.equal(instance.snapshot().state, 'idle');

    await instance.callTool('ok', {});
    assert.equal(instance.snapshot().state, 'ready');
    assert.equal(instance.snapshot().generation, 2);
  });

  it('never replays a delivered request after busy exit', async () => {
    const { instance, logPath } = service();
    await assert.rejects(
      instance.withSession('session-a', () => instance.callTool('exit_busy', {})),
      (error) => isCuaDriverLifecycleError(error, 'outcome_unknown'),
    );
    await instance.callTool('ok', {});

    const calls = (await records(logPath)).filter(
      (record) => record.kind === 'request' && record.name === 'exit_busy',
    );
    assert.equal(calls.length, 1);
  });

  it('resets the consecutive restart budget after every successful recovery', async () => {
    const { instance } = service('', {
      maxRestartAttempts: 2,
    });
    for (let generation = 1; generation <= 4; generation += 1) {
      await instance.callTool('ok', {});
      assert.equal(instance.snapshot().state, 'ready');
      assert.equal(instance.snapshot().generation, generation);
      assert.equal(instance.snapshot().restartAttempts, 0);
      await assert.rejects(instance.callTool('exit_busy', {}), (error) =>
        isCuaDriverLifecycleError(error, 'outcome_unknown'),
      );
    }
    await instance.callTool('ok', {});
    assert.equal(instance.snapshot().generation, 5);
    assert.equal(instance.snapshot().restartAttempts, 0);
  });

  it('maps delivered timeout to outcome_unknown and releases its session', async () => {
    const releases: CuaDriverReleaseEvent[] = [];
    const { instance, logPath } = service('', {
      timeoutMs: 30,
      onRelease: (event) => releases.push(event),
    });
    await assert.rejects(
      instance.withSession('session-timeout', () => instance.callTool('hang_busy', {})),
      (error) => isCuaDriverLifecycleError(error, 'outcome_unknown'),
    );
    assert.equal(
      (await records(logPath)).filter((record) => record.name === 'hang_busy').length,
      1,
    );
    assert.ok(
      releases.some(
        (event) =>
          event.reason === 'request_timeout' &&
          event.outcomeUnknown &&
          event.sessionIds.includes('session-timeout'),
      ),
    );
  });

  it('clearSession kills a pending owner request and clears transport state', async () => {
    const releases: CuaDriverReleaseEvent[] = [];
    const { instance, logPath } = service('', {
      timeoutMs: 1_000,
      onRelease: (event) => releases.push(event),
    });
    const pending = instance.withSession('session-clear', () => instance.callTool('hang_busy', {}));
    await waitForRecord(logPath, (record) => record.name === 'hang_busy');
    instance.clearSession('session-clear');

    await assert.rejects(pending, (error) => isCuaDriverLifecycleError(error, 'outcome_unknown'));
    assert.equal(instance.snapshot().state, 'idle');
    assert.ok(
      releases.some(
        (event) =>
          event.reason === 'session_cleared' &&
          event.generationReleased &&
          event.sessionIds.includes('session-clear'),
      ),
    );
  });

  it('clearSession without a pending request keeps the child generation alive', async () => {
    const releases: CuaDriverReleaseEvent[] = [];
    const { instance } = service('', {
      onRelease: (event) => releases.push(event),
    });
    await instance.callTool('ok', {});
    const generation = instance.snapshot().generation;

    instance.clearSession('session-idle');

    assert.equal(instance.snapshot().generation, generation);
    assert.ok(
      releases.some(
        (event) =>
          event.reason === 'session_cleared' &&
          !event.generationReleased &&
          event.sessionIds.includes('session-idle'),
      ),
    );
  });

  it('exhausts a bounded restart budget and becomes unavailable', async () => {
    const { instance } = service('hang_start', {
      handshakeTimeoutMs: 20,
      maxRestartAttempts: 2,
    });
    await assert.rejects(instance.callTool('ok', {}), (error) =>
      isCuaDriverLifecycleError(error, 'service_unavailable'),
    );
    assert.equal(instance.snapshot().state, 'unavailable');
    assert.equal(instance.snapshot().generation, 2);
  });

  it('fails closed before spawn when the executable hash mismatches', async () => {
    const logPath = join(directory, `log-${crypto.randomUUID()}.ndjson`);
    const mismatched = trackService(
      new CuaDriverService({
        role: 'action',
        binaryPath,
        hostBundleId: 'ai.maka.test',
        captureScope: 'window',
        homeDir: join(directory, `home-${crypto.randomUUID()}`),
        expectedBinarySha256: createHash('sha256').update('not the mock binary').digest('hex'),
        childEnv: {
          ...process.env,
          CUA_SERVICE_LOG: logPath,
        },
      }),
    );
    await assert.rejects(mismatched.callTool('ok', {}), (error) =>
      isCuaDriverLifecycleError(error, 'service_mismatch'),
    );
    assert.equal((await records(logPath)).length, 0);
  });

  it('rejects an unexpected initialized server identity', async () => {
    const strict = trackService(
      new CuaDriverService({
        role: 'action',
        binaryPath,
        hostBundleId: 'ai.maka.test',
        captureScope: 'window',
        homeDir: join(directory, `home-${crypto.randomUUID()}`),
        expectedServerName: 'mock-cua-driver',
        childEnv: {
          ...process.env,
          CUA_SERVICE_LOG: join(directory, `log-${crypto.randomUUID()}.ndjson`),
          CUA_SERVICE_MODE: 'wrong_identity',
        },
      }),
    );
    await assert.rejects(strict.callTool('ok', {}), (error) =>
      isCuaDriverLifecycleError(error, 'service_mismatch'),
    );
  });

  it('rejects start_session tool errors instead of entering ready state', async () => {
    const { instance } = service('config_error');
    await assert.rejects(instance.callTool('ok', {}), /start_session/i);
    assert.notEqual(instance.snapshot().state, 'ready');
  });
});
