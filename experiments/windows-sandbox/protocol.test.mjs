import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLaunchRequest } from './protocol.mjs';

const root = process.platform === 'win32' ? 'C:\\sandbox\\workspace' : '/sandbox/workspace';
const executable =
  process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node';

function validRequest() {
  return {
    version: 1,
    requestId: 'probe-1',
    executable,
    arguments: ['probe.mjs'],
    cwd: root,
    readRoots: [root],
    writeRoots: [],
    network: 'restricted',
    environment: { PATH: '' },
  };
}

test('accepts the closed version 1 request', () => {
  assert.equal(parseLaunchRequest(validRequest()).requestId, 'probe-1');
});

test('rejects unknown fields', () => {
  assert.throws(() => parseLaunchRequest({ ...validRequest(), elevated: true }), /unknown fields/u);
});

test('rejects unknown versions', () => {
  assert.throws(() => parseLaunchRequest({ ...validRequest(), version: 2 }), /unsupported/u);
});

test('rejects relative and non-canonical paths', () => {
  assert.throws(() => parseLaunchRequest({ ...validRequest(), cwd: 'workspace' }), /absolute/u);
  if (process.platform === 'win32') {
    assert.throws(() => parseLaunchRequest({ ...validRequest(), cwd: 'C:/sandbox/workspace' }), /canonical/u);
    assert.throws(() => parseLaunchRequest({ ...validRequest(), cwd: 'C:\\sandbox\\workspace\\' }), /canonical/u);
  }
  assert.throws(
    () =>
      parseLaunchRequest({
        ...validRequest(),
        cwd: `${root}${process.platform === 'win32' ? '\\..\\workspace' : '/../workspace'}`,
      }),
    /canonical/u,
  );
});

test('rejects duplicate roots case-insensitively', () => {
  assert.throws(
    () => parseLaunchRequest({ ...validRequest(), readRoots: [root, root.toUpperCase()] }),
    /duplicate/u,
  );
});
