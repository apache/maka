import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatCompactTimestamp,
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from '../relative-time.js';

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);

describe('relative timestamp labels', () => {
  it('holds a just-now label for the whole first minute instead of counting seconds', () => {
    resetRelativeTimeFormatters();

    for (const ageMs of [0, 1_000, 30_000, 59_999]) {
      assert.equal(formatRelativeTimestamp(NOW - ageMs, NOW, 'zh'), '刚刚');
      assert.equal(formatRelativeTimestamp(NOW - ageMs, NOW, 'en'), 'just now');
      assert.equal(formatCompactTimestamp(NOW - ageMs, NOW, 'zh'), '刚刚');
    }

    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'zh'), '1分钟前');
    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'en'), '1 minute ago');
  });

  it('waits until the just-now window ends instead of ticking every second', () => {
    assert.equal(nextRelativeRefreshDelay(NOW, NOW), 60_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 30_000, NOW), 30_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 59_999, NOW), 1);
    assert.equal(nextRelativeRefreshDelay(NOW + 5_000, NOW), 65_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 60_000, NOW), 60_000);
  });
});
