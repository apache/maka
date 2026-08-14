import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatMakaResumeCommand, formatMakaResumeHint } from '../cli-invocation.js';

describe('Maka CLI invocation copy', () => {
  test('keeps release resume instructions on the release launcher', () => {
    assert.equal(
      formatMakaResumeHint('maka', 'session-1'),
      'Resume this session with:\n  maka --resume session-1',
    );
  });

  test('keeps development remote and cwd retries on the development launcher', () => {
    assert.equal(
      formatMakaResumeHint('npm run cli:dev --', 'session-2', { hostProfileId: 'office' }),
      'Resume this session with:\n  npm run cli:dev -- --resume session-2 --host office',
    );
    assert.equal(
      formatMakaResumeCommand('npm run cli:dev --', 'session-2', { cwd: '<new-path>' }),
      'npm run cli:dev -- --resume session-2 --cwd <new-path>',
    );
  });
});
