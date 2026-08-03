import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { dailyReviewExportDefaultName } from '../../renderer/daily-review-actions.js';

describe('Daily Review export naming', () => {
  it('uses the archive identity instead of guessing from localized text', () => {
    assert.equal(
      dailyReviewExportDefaultName({
        range: 7,
        day: {
          fromMs: new Date(2026, 6, 30, 12).getTime(),
          toMs: new Date(2026, 7, 5, 12).getTime(),
        },
      }),
      'maka-daily-review-2026-07-30-7d.md',
    );
  });
});
