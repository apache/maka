import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from '../relative-time.js';

const NOW = Date.parse('2026-05-29T12:00:00Z');

beforeEach(resetRelativeTimeFormatters);

describe('relative time', () => {
  it('formats locale, bucket, horizon, and clock-skew boundaries', () => {
    const cases: Array<{
      timestamp: number;
      locale?: 'zh' | 'en';
      matches: RegExp;
      excludes?: RegExp;
    }> = [
      { timestamp: NOW - 8_000, matches: /秒/, excludes: /seconds?\s+ago/i },
      { timestamp: NOW - 100, matches: /1.*second|秒|now|刚刚/i },
      { timestamp: NOW - 30_000, matches: /30.*second|秒/i },
      { timestamp: NOW - 5 * 60_000, matches: /5.*minute|分钟/i },
      { timestamp: NOW - 5 * 60_000, locale: 'en', matches: /5 minutes ago/i, excludes: /分钟/ },
      { timestamp: NOW - 5 * 60_000, locale: 'zh', matches: /5.*分钟/, excludes: /minutes ago/i },
      { timestamp: NOW - 3 * 60 * 60_000, matches: /3.*hour|小时/i },
      { timestamp: NOW - 2 * 24 * 60 * 60_000, matches: /2.*day|天/i },
      { timestamp: NOW - 30 * 24 * 60 * 60_000, matches: /2026|4月|Apr|April/ },
      {
        timestamp: NOW + 5 * 60_000,
        matches: /second|秒|now|刚刚/i,
        excludes: /in 5 minutes|5 分钟后/,
      },
    ];
    for (const { timestamp, locale, matches, excludes } of cases) {
      const output = formatRelativeTimestamp(timestamp, NOW, locale);
      assert.match(output, matches);
      if (excludes) assert.doesNotMatch(output, excludes);
    }
  });

  it('selects refresh cadence by age', () => {
    for (const [timestamp, expected] of [
      [NOW - 5_000, 1_000],
      [NOW - 10 * 60_000, 60_000],
      [NOW - 5 * 60 * 60_000, 10 * 60_000],
      [NOW - 30 * 24 * 60 * 60_000, null],
    ] as const) {
      assert.equal(nextRelativeRefreshDelay(timestamp, NOW), expected);
    }
  });
});
