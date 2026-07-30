import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  showSkillInvocationFeedback,
  skillInvocationDisplayText,
} from '../../renderer/skill-invocation-feedback.js';

describe('Desktop Skill invocation display text', () => {
  it('preserves user text when the send also loaded Skills', () => {
    assert.equal(
      skillInvocationDisplayText('  keep spacing  ', {
        loaded: [{ id: 'alpha', name: 'Alpha' }],
        failed: [],
        receipts: [],
      }),
      '  keep spacing  ',
    );
  });

  it('renders loaded ids for a chip-only optimistic message', () => {
    assert.equal(
      skillInvocationDisplayText('', {
        loaded: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: 'Beta' },
        ],
        failed: [],
        receipts: [],
      }),
      '/skill:alpha /skill:beta',
    );
  });

  it('renders request overflow as an aggregate failure without a synthetic Skill id', () => {
    const errors: Array<{ title: string; description?: string }> = [];
    showSkillInvocationFeedback(
      'en',
      {
        error: (title, description) => errors.push({ title, description }),
        info: () => {
          throw new Error('overflow must block rather than report partial success');
        },
      },
      {
        loaded: [],
        failed: [{ reason: 'too_many_requests', requestLimit: 50 }],
        receipts: [
          {
            invocation: 'explicit',
            success: false,
            reason: 'too_many_requests',
            requestLimit: 50,
          },
        ],
      },
    );

    assert.deepEqual(errors, [
      {
        title: 'Skill invocation failed; message not sent',
        description:
          'more than 50 distinct Skill invocation requests. Adjust the selection and try again.',
      },
    ]);
    assert.doesNotMatch(errors[0]?.description ?? '', /\/skill:/);
  });
});
