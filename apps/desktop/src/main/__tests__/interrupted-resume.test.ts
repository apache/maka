import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latestInterruptedResumeTurnId } from '../../renderer/interrupted-resume.js';

describe('latest interrupted resume candidate', () => {
  it('recognizes a timeout after a completed tool result', () => {
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'completed' }],
        },
      ]),
      'turn-1',
    );
  });

  it('does not offer continuation for an incomplete or errored tool', () => {
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'running' }],
        },
      ]),
      undefined,
    );
    assert.equal(
      latestInterruptedResumeTurnId([
        {
          turnId: 'turn-1',
          status: 'failed',
          errorClass: 'timeout',
          tools: [{ status: 'errored' }],
        },
      ]),
      undefined,
    );
  });
});
