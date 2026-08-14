import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const CHILD_SOURCE = String.raw`
  import { spawn as spawnPty } from 'node-pty';
  import { execFileSync } from 'node:child_process';
  import {
    closeSync,
    constants,
    fstatSync,
    mkdtempSync,
    open,
    openSync,
    rmSync,
    stat,
  } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { promisify } from 'node:util';

  const delay = promisify(setTimeout);
  const root = mkdtempSync(join(tmpdir(), 'maka-node-pty-write-lifecycle-'));
  const fifo = join(root, 'worker-blocker');
  const sentinelPath = join(root, 'sentinel');
  let readerFd;
  let sentinelFd;
  let terminal;

  try {
    execFileSync('mkfifo', [fifo]);
    terminal = spawnPty(
      process.execPath,
      ['-e', 'process.stdin.pause(); setInterval(() => {}, 1000)'],
      { cols: 80, rows: 24 },
    );
    const terminalFd = terminal.fd;

    const reader = new Promise((resolve, reject) => {
      open(fifo, constants.O_RDONLY, (error, fd) => {
        if (error) reject(error);
        else {
          readerFd = fd;
          resolve();
        }
      });
    });
    let probeCompleted = false;
    const blockedPoolProbe = new Promise((resolve, reject) => {
      stat(root, (error) => {
        if (error) reject(error);
        else {
          probeCompleted = true;
          resolve();
        }
      });
    });
    await delay(50);
    if (probeCompleted) throw new Error('FIFO did not occupy the libuv worker');

    terminal.write('R'.repeat(4 * 1024 * 1024));
    setTimeout(() => terminal.kill('SIGKILL'), 5);
    await new Promise((resolve) => terminal.onExit(resolve));

    sentinelFd = openSync(
      sentinelPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
    if (sentinelFd !== terminalFd) {
      throw new Error(
        'Expected retired PTY fd ' + terminalFd + ' to be reused, received ' + sentinelFd,
      );
    }

    const writerFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    closeSync(writerFd);
    const writeCompletionBarrier = new Promise((resolve, reject) => {
      stat(root, (error) => (error ? reject(error) : resolve()));
    });
    await Promise.all([reader, blockedPoolProbe, writeCompletionBarrier]);
    closeSync(readerFd);
    readerFd = undefined;

    if (fstatSync(sentinelFd).size !== 0) {
      throw new Error('Queued PTY input reached the reused sentinel fd');
    }
    closeSync(sentinelFd);
    sentinelFd = undefined;
    console.log('sentinel-ok');
  } finally {
    try {
      terminal?.kill('SIGKILL');
    } catch {}
    if (readerFd !== undefined) closeSync(readerFd);
    if (sentinelFd !== undefined) closeSync(sentinelFd);
    rmSync(root, { recursive: true, force: true });
  }
`;

test('does not carry queued Unix PTY writes past native exit', {
  skip: process.platform === 'win32' ? 'Unix PTY file-descriptor lifecycle only' : false,
}, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
    timeout: 10_000,
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sentinel-ok');
  assert.doesNotMatch(result.stderr, /Unhandled pty write error/);
});
