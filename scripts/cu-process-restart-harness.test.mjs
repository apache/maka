// The real-machine soak harness calls methods on the executor backend, and it
// needs a signed maka-cu and a live desktop to run at all — so nothing checked
// that the methods it calls exist.
//
// They did not. `backend.serviceState()` was cua-driver's two-role snapshot;
// maka-cu has one child and exposes `executorState()`. The call threw a
// TypeError on round 1, inside the try, AFTER the round's real work had
// succeeded — so the harness caught it and wrote an `ok: false` report. A
// passing run on a real machine was reported as a failure, and the only way to
// find out was to have the machine.
//
// This reads the harness's own source for the calls it makes and asks a real
// backend whether it has them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('every backend method the process-restart soak calls exists on the backend', async () => {
  const source = await readFile(new URL('cu-process-restart-e2e.mjs', import.meta.url), 'utf8');
  // Comment lines are dropped first: the harness explains in prose which call
  // it replaced, and matching that would report the bug as still present.
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const called = [...code.matchAll(/\bbackend\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
  assert.ok(called.length > 0, 'the harness calls nothing on the backend, so this test is inert');

  const { createMakaCuBackend } = await import(
    new URL('../packages/computer-use/dist/index.js', import.meta.url)
  );
  // Never started: constructing does not spawn, and every method below is only
  // asked for by name.
  const backend = createMakaCuBackend({
    binaryPath: '/nonexistent/maka-cu',
    imageDir: '/tmp',
  });
  try {
    for (const method of new Set(called)) {
      assert.equal(
        typeof backend[method],
        'function',
        `the soak harness calls backend.${method}(), which the backend does not have`,
      );
    }
  } finally {
    backend.dispose();
  }
});

test('the soak harness reads the executor snapshot maka-cu actually returns', async () => {
  // One child, one generation. The two-role read it replaced would have found
  // `undefined.restartAttempts` even if `serviceState` had existed.
  const { createMakaCuBackend } = await import(
    new URL('../packages/computer-use/dist/index.js', import.meta.url)
  );
  const backend = createMakaCuBackend({
    binaryPath: '/nonexistent/maka-cu',
    imageDir: '/tmp',
  });
  try {
    const snapshot = backend.executorState();
    assert.equal(typeof snapshot.generation, 'number');
    assert.equal(typeof snapshot.restartAttempts, 'number');
    assert.ok(!('action' in snapshot), 'maka-cu has no action role to read');
    assert.ok(!('capture' in snapshot), 'maka-cu has no capture role to read');
  } finally {
    backend.dispose();
  }
});
