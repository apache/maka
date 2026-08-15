import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeLegacyPlanReminderCronExpression } from '../legacy-cron-expression.js';

test('converts released single-value steps without changing wildcard steps', () => {
  assert.equal(canonicalizeLegacyPlanReminderCronExpression('5/10 * * * *'), '5 * * * *');
  assert.equal(canonicalizeLegacyPlanReminderCronExpression('*/5 * * * *'), '*/5 * * * *');
});

test('rejects a source expression outside the released grammar', () => {
  assert.throws(() => canonicalizeLegacyPlanReminderCronExpression('0 0 30 2 *'));
});
