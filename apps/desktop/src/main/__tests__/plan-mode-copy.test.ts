import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPlanModeCopy } from '../../renderer/locales/plan-mode-copy.js';

test('localizes Plan Mode chrome and abandon confirmation without rewriting plan content', () => {
  const zh = getPlanModeCopy('zh');
  const en = getPlanModeCopy('en');

  assert.equal(zh.proposal.statuses.approved, '已批准');
  assert.equal(en.proposal.statuses.approved, 'Approved');
  assert.equal(zh.execution.stepCount(2, 3), '2/3 步');
  assert.equal(en.execution.stepCount(1, 1), '1/1 step');
  assert.deepEqual(
    {
      title: en.abandonConfirmation.title,
      description: en.abandonConfirmation.description('Release plan'),
      confirm: en.abandonConfirmation.confirm,
    },
    {
      title: 'Abandon this plan?',
      description: 'The execution record for “Release plan” will remain, but it cannot be resumed.',
      confirm: 'Abandon plan',
    },
  );
});
