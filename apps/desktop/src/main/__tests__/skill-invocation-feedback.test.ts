import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  showSkillInvocationFeedback,
} from '../../renderer/skill-invocation-feedback.js';

describe('Desktop Skill invocation feedback', () => {
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
