import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { captureBoundedStream } from '../bounded-log.js';

test('bounded capture preserves small output exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bounded-log-'));
  const path = join(root, 'small.log');
  try {
    const result = await captureBoundedStream(Readable.from(['alpha', 'beta']), path, 256, 32);
    assert.deepEqual(result, { observedBytes: 9, truncatedBytes: 0 });
    assert.equal(await readFile(path, 'utf8'), 'alphabeta');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded capture retains prefix and tail with truncation evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bounded-log-'));
  const path = join(root, 'large.log');
  const contents = `${'a'.repeat(300)}${'z'.repeat(64)}`;
  try {
    const result = await captureBoundedStream(Readable.from([contents]), path, 256, 64);
    const retained = await readFile(path, 'utf8');
    assert.equal(result.observedBytes, Buffer.byteLength(contents));
    assert.ok(result.truncatedBytes > 0);
    assert.ok(Buffer.byteLength(retained) <= 256);
    assert.ok(retained.startsWith('a'));
    assert.ok(retained.includes('makaEvalTruncatedBytes'));
    assert.ok(retained.endsWith('z'.repeat(64)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
