import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isLikelySandboxDenial } from '../sandbox/detect.js';

describe('isLikelySandboxDenial', () => {
  test('recognizes explicit sandbox denial evidence from either output stream', () => {
    for (const input of [
      { stdout: '', stderr: 'Operation not permitted' },
      { stdout: '', stderr: 'launching sandbox-exec profile' },
      { stdout: '', stderr: 'dyld: file system sandbox blocked mmap()' },
      { stdout: 'The operation was sandboxed and denied by policy', stderr: '' },
    ]) {
      assert.equal(isLikelySandboxDenial({ ...input, sandboxed: true }), true);
    }
  });

  test('requires an active sandbox and unambiguous denial evidence', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'Operation not permitted', sandboxed: false }),
      false,
    );
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'permission denied', sandboxed: true }),
      false,
    );
    assert.equal(
      isLikelySandboxDenial({
        stdout: 'command not found',
        stderr: 'exit code 127',
        sandboxed: true,
      }),
      false,
    );
  });
});
