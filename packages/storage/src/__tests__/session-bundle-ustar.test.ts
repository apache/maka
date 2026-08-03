import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  decodeSessionBundleUstarHeaderV1,
  encodeSessionBundleUstarHeaderV1,
  SessionBundleFileError,
} from '../index.js';

test('pins the exact canonical USTAR V1 header', () => {
  const header = Buffer.from(
    encodeSessionBundleUstarHeaderV1({
      kind: 'file',
      path: 'workspace/run.sh',
      mode: 0o755,
      size: 18,
    }),
  );

  assert.equal(header.byteLength, 512);
  assert.equal(header.subarray(0, 16).toString('utf8'), 'workspace/run.sh');
  assert.equal(header.subarray(100, 108).toString('ascii'), '0000755\0');
  assert.equal(header.subarray(124, 136).toString('ascii'), '00000000022\0');
  assert.equal(header.subarray(257, 265).toString('hex'), '7573746172003030');
  assert.equal(
    createHash('sha256').update(header).digest('hex'),
    '1d69bf3bf7dcb40b103d0d405c1d21ebc49a22c0ae3771b07dfd17eeeb4b6c4d',
  );
  assert.deepEqual(decodeSessionBundleUstarHeaderV1(header), {
    kind: 'file',
    path: 'workspace/run.sh',
    mode: 0o755,
    size: 18,
  });
});

test('uses the rightmost representable USTAR prefix split', () => {
  const path = `workspace/${'a'.repeat(90)}/${'b'.repeat(90)}`;
  const header = Buffer.from(
    encodeSessionBundleUstarHeaderV1({ kind: 'file', path, mode: 0o644, size: 0 }),
  );
  assert.equal(header.subarray(0, 100).toString('utf8').replaceAll('\0', ''), 'b'.repeat(90));
  assert.equal(
    header.subarray(345, 500).toString('utf8').replaceAll('\0', ''),
    `workspace/${'a'.repeat(90)}`,
  );
  assert.equal(decodeSessionBundleUstarHeaderV1(header).path, path);
});

test('rejects noncanonical metadata and unrepresentable paths', () => {
  for (const path of ['/absolute', '../outside', 'state//file', 'C:/drive']) {
    assertBundleError(
      () => encodeSessionBundleUstarHeaderV1({ kind: 'file', path, mode: 0o644, size: 0 }),
      'unsafe_path',
    );
  }
  assertBundleError(
    () =>
      encodeSessionBundleUstarHeaderV1({
        kind: 'file',
        path: `${'a'.repeat(101)}`,
        mode: 0o644,
        size: 0,
      }),
    'unsafe_path',
  );

  const header = Buffer.from(
    encodeSessionBundleUstarHeaderV1({
      kind: 'directory',
      path: 'state/',
      mode: 0o755,
      size: 0,
    }),
  );
  header[135] = '1'.charCodeAt(0);
  assertBundleError(() => decodeSessionBundleUstarHeaderV1(header), 'integrity_mismatch');
});

function assertBundleError(action: () => unknown, code: SessionBundleFileError['code']): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof SessionBundleFileError);
    assert.equal(error.code, code);
    return true;
  });
}
