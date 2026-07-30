import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isLikelySandboxDenial } from '../sandbox/detect.js';

describe('isLikelySandboxDenial regex branches', () => {
  test('matches "operation not permitted" branch', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'Operation not permitted', sandboxed: true }),
      true,
    );
  });

  test('matches "sandbox-exec" branch', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'launching sandbox-exec profile',
        sandboxed: true,
      }),
      true,
    );
  });

  test('matches macOS dyld file system sandbox failures', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'dyld: file system sandbox blocked mmap() of a dependent library',
        sandboxed: true,
      }),
      true,
    );
  });

  test('matches "sandbox...denied" branch', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'sandbox-denied: write outside',
        sandboxed: true,
      }),
      true,
    );
  });

  test('matches "sandboxed ... denied" variant', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'The operation was sandboxed and denied by policy',
        sandboxed: true,
      }),
      true,
    );
  });
});

describe('isLikelySandboxDenial stdout vs stderr', () => {
  test('detects denial message in stdout (not just stderr)', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: 'Operation not permitted', stderr: '', sandboxed: true }),
      true,
    );
  });

  test('scans the combined stderr+stdout text', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: 'sandbox denied', stderr: '', sandboxed: true }),
      true,
    );
  });
});

describe('isLikelySandboxDenial near-misses', () => {
  test('returns false when sandboxed is false, even if text matches', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'Operation not permitted', sandboxed: false }),
      false,
    );
  });

  test('returns false for "operation permitted" (missing "not")', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'operation permitted', sandboxed: true }),
      false,
    );
  });

  test('returns false for "sandbox" alone (no deny/denied)', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'running in sandbox environment',
        sandboxed: true,
      }),
      false,
    );
  });

  test('returns false for "permission denied" (no sandbox prefix)', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'permission denied', sandboxed: true }),
      false,
    );
  });

  test('returns false for "sandbox denial" (denial != deny/denied)', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'sandbox denial detected',
        sandboxed: true,
      }),
      false,
    );
  });

  test('returns false for plain text without any sandbox signal', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: 'command not found',
        stderr: 'exit code 127',
        sandboxed: true,
      }),
      false,
    );
  });

  test('returns false for denial split across stdout/stderr by a newline', () => {
    // The predicate scans `${stderr}\n${stdout}`; regex branch 3 uses [^\n]*
    // which cannot cross a newline, so "sandbox" and "denied" must be in the
    // same field to match.
    assert.equal(
      isLikelySandboxDenial({ stdout: 'then denied', stderr: 'sandbox setup', sandboxed: true }),
      false,
    );
  });
});

describe('isLikelySandboxDenial case-insensitive', () => {
  test('matches uppercase "OPERATION NOT PERMITTED"', () => {
    assert.equal(
      isLikelySandboxDenial({
        stdout: '',
        stderr: 'OPERATION NOT PERMITTED',
        sandboxed: true,
      }),
      true,
    );
  });

  test('matches mixed case "Sandbox-Denied"', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'Sandbox-Denied', sandboxed: true }),
      true,
    );
  });
});
