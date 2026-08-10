import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('harness spawn failure releases its relay listener and process', async () => {
  const child = spawn(
    process.execPath,
    [new URL('./fixtures/harness-preparation-worker.js', import.meta.url).pathname],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const exited = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), 1_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (!exited) child.kill('SIGKILL');

  assert.equal(exited, true);
  assert.equal(output, 'SETTLED\n');
});
