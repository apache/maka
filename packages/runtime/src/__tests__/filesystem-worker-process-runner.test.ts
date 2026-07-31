import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runFilesystemWorkerProcess } from '../filesystem-worker/process-runner.js';

test('filesystem worker process receives inherited fd inputs alongside request stdin', async () => {
  const fdPayload = Uint8Array.from([1, 2, 3, 4]);
  const script = [
    "const fs = require('node:fs');",
    'const fd = [...fs.readFileSync(3)];',
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { stdin += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ fd, stdin })));",
  ].join('');
  const input = {
    argv: [process.execPath, '-e', script],
    cwd: tmpdir(),
    env: process.env,
    stdin: '{"request":true}',
    fdInputs: [{ fd: 3, data: fdPayload }],
  };

  const result = await runFilesystemWorkerProcess(input);

  assert.equal(result.exitCode, 0, result.stderrTail);
  assert.deepEqual(JSON.parse(result.stdout), {
    fd: [...fdPayload],
    stdin: input.stdin,
  });
});

test('filesystem worker does not spawn for an already-aborted request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-worker-pre-abort-'));
  const marker = join(root, 'spawned');
  const abort = new AbortController();
  abort.abort();
  try {
    const result = await runFilesystemWorkerProcess({
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
      ],
      cwd: root,
      env: process.env,
      stdin: '',
      abortSignal: abort.signal,
    });

    assert.equal(result.aborted, true);
    await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem worker rejects boundedly when a detached descendant retains stdout', {
  skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-worker-drain-'));
  const pidFile = join(root, 'child.pid');
  let childPid: number | undefined;
  try {
    const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});child.unref();writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.stdout.write('{}')`;
    const startedAt = Date.now();
    await assert.rejects(
      runFilesystemWorkerProcess({
        argv: [process.execPath, '-e', script],
        cwd: root,
        env: process.env,
        stdin: '',
        ioDrainTimeoutMs: 100,
      }),
      /output did not drain before lifecycle deadline/,
    );
    childPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    if (childPid) {
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          /* descendant already exited */
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
