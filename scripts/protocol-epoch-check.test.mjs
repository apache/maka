import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EPOCH_FILE,
  evaluateEpochCheck,
  extractCompatibilityEpoch,
} from './protocol-epoch-check.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('extracts the epoch from the declaration line', () => {
  assert.equal(
    extractCompatibilityEpoch('export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n'),
    27,
  );
});

test('refuses a source with no epoch declaration or more than one', () => {
  assert.throws(() => extractCompatibilityEpoch('export const OTHER = 1 as const;\n'), /found 0/);
  assert.throws(
    () =>
      extractCompatibilityEpoch(
        'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n' +
          'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 28 as const;\n',
      ),
    /found 2/,
  );
});

test('parses the real protocol index, so the pattern cannot silently rot', () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = readFileSync(join(repoRoot, EPOCH_FILE), 'utf8');
  assert.equal(Number.isInteger(extractCompatibilityEpoch(source)), true);
});

test('fails a protocol change whose epoch equals the merge base', () => {
  const verdict = evaluateEpochCheck({
    baseEpoch: 27,
    headEpoch: 27,
    changedProtocolFiles: ['packages/runtime-host/src/protocol/operations.ts'],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still 27/);
  assert.match(verdict.reason, /operations\.ts/);
});

test('fails any epoch decrease, protocol change or not', () => {
  for (const changedProtocolFiles of [[], ['packages/runtime-host/src/protocol/index.ts']]) {
    const verdict = evaluateEpochCheck({ baseEpoch: 28, headEpoch: 27, changedProtocolFiles });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /went backward/);
  }
});

test('passes a protocol change that moves the epoch forward', () => {
  const verdict = evaluateEpochCheck({
    baseEpoch: 27,
    headEpoch: 28,
    changedProtocolFiles: ['packages/runtime-host/src/protocol/index.ts'],
  });
  assert.equal(verdict.ok, true);
});

test('passes when nothing under the protocol directory changed', () => {
  for (const headEpoch of [27, 28]) {
    const verdict = evaluateEpochCheck({ baseEpoch: 27, headEpoch, changedProtocolFiles: [] });
    assert.equal(verdict.ok, true);
  }
});
