import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { normalizeDailyReviewArchive, parseDailyReviewArchiveId } from '../daily-review.js';

describe('Daily Review archive boundary', () => {
  const day = {
    fromMs: new Date(2026, 7, 3, 0, 0, 0, 0).getTime(),
    toMs: new Date(2026, 7, 4, 0, 0, 0, 0).getTime(),
  };

  it('parses canonical identities without accepting impossible calendar dates', () => {
    assert.deepEqual(parseDailyReviewArchiveId('2026-08-03-30d'), {
      localDate: '2026-08-03',
      range: 30,
    });
    assert.equal(parseDailyReviewArchiveId('2026-02-30-1d'), null);
    assert.equal(parseDailyReviewArchiveId('2026-08-03-deep'), null);
  });

  it('rejects structurally invalid canonical archives', () => {
    const valid = {
      id: '2026-08-03-1d',
      day,
      range: 1,
      status: 'ok',
      generatedAt: day.toMs,
      trigger: 'manual',
      modelKey: '',
      sections: { summary: 'Today' },
      totals: {
        sessionCount: 1,
        requestCount: 2,
        totalTokens: 3,
        costUsd: 0.04,
        errorCount: 0,
      },
    };
    const invalid = [
      { ...valid, day: undefined },
      { ...valid, status: 'unknown' },
      { ...valid, generatedAt: Number.NaN },
      { ...valid, trigger: 'unknown' },
      { ...valid, modelKey: 42 },
      { ...valid, sections: { summary: 42 } },
      { ...valid, sections: {} },
      { ...valid, sections: { summary: '   ' } },
      { ...valid, totals: { requestCount: 2 } },
      { ...valid, range: 7 },
      { ...valid, id: '2026-02-30-1d' },
    ];

    for (const archive of invalid) {
      assert.throws(() => normalizeDailyReviewArchive(archive));
    }
  });
});
