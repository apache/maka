import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertMachOHeader,
  assertSafeTarEntries,
  assertSafeTarListing,
  downloadFileWithSha256,
  verifyBinaryMetadata,
  verifyBinaryVersion,
} from './prepare-cua-driver.mjs';

test('download streams to disk with a hard byte ceiling and incremental SHA-256', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-download-test-'));
  try {
    const destination = join(directory, 'archive.tar.gz');
    const chunks = [Buffer.from('abc'), Buffer.from('def')];
    const result = await downloadFileWithSha256('https://example.test/cua-driver', destination, {
      maxBytes: 6,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    });
    assert.deepEqual(result, {
      bytes: 6,
      sha256: sha256(Buffer.concat(chunks)),
    });
    assert.equal((await readFile(destination)).toString(), 'abcdef');

    const oversized = join(directory, 'oversized.tar.gz');
    await assert.rejects(
      downloadFileWithSha256('https://example.test/oversized', oversized, {
        maxBytes: 5,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('abc'));
                controller.enqueue(Buffer.from('def'));
                controller.close();
              },
            }),
          ),
      }),
      /received more than 5 bytes/,
    );
    await assert.rejects(access(oversized));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mach-O, architecture, and signature gates run before the binary version', async () => {
  assert.doesNotThrow(() => assertMachOHeader(Buffer.from('cafebabe', 'hex')));
  assert.throws(() => assertMachOHeader(Buffer.from('#!/b')));

  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-binary-gate-test-'));
  try {
    const binaryPath = join(directory, 'cua-driver');
    await writeFile(binaryPath, Buffer.concat([Buffer.from('cafebabe', 'hex'), Buffer.alloc(4)]));
    const entry = {
      binarySizeBytes: 8,
      architectures: ['arm64', 'x86_64'],
      signature: 'adhoc',
      expectedVersion: '0.7.1',
    };
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'codesign' && args[0] === '--display') {
        return { stdout: '', stderr: 'Signature=adhoc\n' };
      }
      if (command === binaryPath) {
        return { stdout: 'cua-driver 0.7.1\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await verifyBinaryMetadata(binaryPath, entry, runCommand);
    await verifyBinaryVersion(binaryPath, entry, runCommand);
    assert.deepEqual(calls, [
      ['lipo', binaryPath, '-verify_arch', 'arm64', 'x86_64'],
      ['codesign', '--verify', '--strict', '--verbose=2', binaryPath],
      ['codesign', '--display', '--verbose=4', binaryPath],
      [binaryPath, '--version'],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tar entry validation rejects path traversal before extraction', () => {
  assertSafeTarEntries(['bundle/cua-driver', 'bundle/LICENSE.md']);
  assert.throws(() => assertSafeTarEntries(['../../tmp/escape']));
  assert.throws(() => assertSafeTarEntries(['/absolute/path']));
  assert.throws(() => assertSafeTarEntries(['windows\\escape']));
  assertSafeTarListing([
    'drwxr-xr-x user/group 0 2026-01-01 00:00 bundle/',
    '-rwxr-xr-x user/group 1 2026-01-01 00:00 bundle/cua-driver',
  ]);
  assert.throws(() =>
    assertSafeTarListing(['lrwxr-xr-x user/group 0 2026-01-01 00:00 bundle/link -> /tmp/escape']),
  );
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
