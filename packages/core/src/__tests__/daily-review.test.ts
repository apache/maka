import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DAILY_REVIEW_LIST_LIMIT,
  buildDailyReviewSummary,
  dailyReviewArchiveId,
  dailyUsageQuery,
  normalizeDailyReviewArchive,
  normalizeDailyReviewConfig,
  parseDailyReviewArchiveId,
  localDayBoundsAt,
  localDayBoundsForInstant,
  pickDailyReviewSessions,
  pickDailyReviewTopEntries,
} from '../daily-review.js';
import type { SessionSummary } from '../session.js';
import type { UsageBucket, UsageSummaryV2 } from '../usage-stats/types.js';

function aSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: overrides.id ?? 's-1',
    name: overrides.name ?? 'Session 1',
    isFlagged: overrides.isFlagged ?? false,
    isArchived: overrides.isArchived ?? false,
    labels: overrides.labels ?? [],
    hasUnread: overrides.hasUnread ?? false,
    lastMessageAt: overrides.lastMessageAt,
    lastMessagePreview: overrides.lastMessagePreview,
    status: overrides.status ?? 'active',
    statusUpdatedAt: overrides.statusUpdatedAt,
    backend: overrides.backend ?? 'ai-sdk',
    llmConnectionSlug: overrides.llmConnectionSlug ?? 'fake',
    connectionLocked: overrides.connectionLocked ?? false,
    model: overrides.model ?? 'fake-model',
    permissionMode: overrides.permissionMode ?? 'ask',
  };
}

describe('localDayBoundsForInstant', () => {
  it('snaps to local midnight of the same day', () => {
    const at = new Date(2026, 4, 29, 14, 30, 0, 0).getTime();
    const bounds = localDayBoundsForInstant(at);
    assert.equal(new Date(bounds.fromMs).getHours(), 0);
    assert.equal(new Date(bounds.fromMs).getDate(), 29);
    assert.equal(bounds.toMs - bounds.fromMs, 24 * 3_600_000);
  });

  it('returns inclusive-from, exclusive-to window', () => {
    const at = new Date(2026, 4, 29, 23, 59, 59).getTime();
    const bounds = localDayBoundsForInstant(at);
    assert.ok(at >= bounds.fromMs);
    assert.ok(at < bounds.toMs);
  });
});

describe('localDayBoundsAt', () => {
  it('offset=-1 returns yesterday window', () => {
    const today = new Date(2026, 4, 29, 14, 0, 0).getTime();
    const yest = localDayBoundsAt(today, -1);
    assert.equal(new Date(yest.fromMs).getDate(), 28);
    assert.equal(yest.toMs, localDayBoundsForInstant(today).fromMs);
  });

  it('offset=+1 returns tomorrow window', () => {
    const today = new Date(2026, 4, 29, 14, 0, 0).getTime();
    const tom = localDayBoundsAt(today, 1);
    assert.equal(new Date(tom.fromMs).getDate(), 30);
    assert.equal(tom.fromMs, localDayBoundsForInstant(today).toMs);
  });
});

describe('pickDailyReviewSessions', () => {
  const day = localDayBoundsForInstant(new Date(2026, 4, 29, 12, 0).getTime());

  it('filters to lastMessageAt inside the window', () => {
    const sessions = [
      aSession({ id: 'a', lastMessageAt: day.fromMs + 60_000 }),
      aSession({ id: 'b', lastMessageAt: day.toMs + 1 }),
      aSession({ id: 'c', lastMessageAt: day.fromMs - 1 }),
      aSession({ id: 'd' }), // no ts → skipped
    ];
    const picked = pickDailyReviewSessions(sessions, day, 10);
    assert.deepEqual(
      picked.map((s) => s.id),
      ['a'],
    );
  });

  it('sorts most-recent first and caps at limit', () => {
    const sessions = [
      aSession({ id: 'a', lastMessageAt: day.fromMs + 1_000 }),
      aSession({ id: 'b', lastMessageAt: day.fromMs + 3_000 }),
      aSession({ id: 'c', lastMessageAt: day.fromMs + 2_000 }),
    ];
    const picked = pickDailyReviewSessions(sessions, day, 2);
    assert.deepEqual(
      picked.map((s) => s.id),
      ['b', 'c'],
    );
  });

  it('returns empty array when limit is 0 / negative', () => {
    const sessions = [aSession({ id: 'a', lastMessageAt: day.fromMs })];
    assert.deepEqual(pickDailyReviewSessions(sessions, day, 0), []);
    assert.deepEqual(pickDailyReviewSessions(sessions, day, -3), []);
  });
});

describe('pickDailyReviewTopEntries', () => {
  function bucket(key: string, requests: number, tokens: number, cost: number): UsageBucket {
    return {
      key,
      label: key,
      requests,
      inputTokens: 0,
      outputTokens: 0,
      cacheMissTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: tokens,
      costUsd: cost,
      avgLatencyMs: 0,
      errorRate: 0,
    };
  }

  it('sorts by request count descending and caps at limit', () => {
    const buckets = [bucket('a', 1, 10, 0.01), bucket('b', 5, 20, 0.05), bucket('c', 3, 30, 0.02)];
    const top = pickDailyReviewTopEntries(buckets, 2);
    assert.deepEqual(
      top.map((t) => t.key),
      ['b', 'c'],
    );
  });

  it('returns empty array on empty input', () => {
    assert.deepEqual(pickDailyReviewTopEntries([], 5), []);
  });
});

describe('buildDailyReviewSummary', () => {
  const day = { fromMs: 0, toMs: 24 * 3_600_000 };
  const usageSummary: UsageSummaryV2 = {
    range: { from: day.fromMs, to: day.toMs },
    totalRequests: 42,
    totalCostUsd: 1.23,
    totalTokens: {
      input: 100,
      output: 200,
      cacheMiss: 100,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 300,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 2,
  };

  it('totals.sessionCount mirrors the sessions array length', () => {
    const out = buildDailyReviewSummary({
      day,
      usageSummary,
      sessions: [
        { id: 'a', name: 'A', lastMessageAt: 1 },
        { id: 'b', name: 'B', lastMessageAt: 2 },
      ],
      topTools: [],
      topModels: [],
    });
    assert.equal(out.totals.sessionCount, 2);
    assert.equal(out.totals.requestCount, 42);
    assert.equal(out.totals.totalTokens, 300);
    assert.equal(out.totals.costUsd, 1.23);
    assert.equal(out.totals.errorCount, 2);
  });
});

describe('dailyUsageQuery', () => {
  it('produces a UsageQuery with the day range and no filters', () => {
    const q = dailyUsageQuery({ fromMs: 100, toMs: 200 });
    assert.deepEqual(q, { range: { from: 100, to: 200 } });
  });
});

describe('DAILY_REVIEW_LIST_LIMIT', () => {
  it('is a small positive integer', () => {
    assert.ok(Number.isInteger(DAILY_REVIEW_LIST_LIMIT));
    assert.ok(DAILY_REVIEW_LIST_LIMIT > 0);
    assert.ok(DAILY_REVIEW_LIST_LIMIT <= 32);
  });
});

describe('Daily Review range contract', () => {
  const day = {
    fromMs: new Date(2026, 7, 3, 0, 0, 0, 0).getTime(),
    toMs: new Date(2026, 7, 4, 0, 0, 0, 0).getTime(),
  };

  it('writes one archive identity for each supported range', () => {
    assert.equal(dailyReviewArchiveId(day, 1), '2026-08-03-1d');
    assert.equal(dailyReviewArchiveId(day, 7), '2026-08-03-7d');
    assert.equal(dailyReviewArchiveId(day, 30), '2026-08-03-30d');
  });

  it('parses canonical identities without accepting impossible calendar dates', () => {
    assert.deepEqual(parseDailyReviewArchiveId('2026-08-03-30d'), {
      localDate: '2026-08-03',
      range: 30,
    });
    assert.equal(parseDailyReviewArchiveId('2026-02-30-1d'), null);
    assert.equal(parseDailyReviewArchiveId('2026-08-03-deep'), null);
  });

  it('maps legacy modes onto the range contract when reading', () => {
    const legacy = normalizeDailyReviewArchive({
      id: '2026-08-03-deep',
      day,
      mode: 'deep',
      status: 'ok',
      generatedAt: day.toMs,
      trigger: 'manual',
      modelKey: '',
      sections: { summary: 'Seven days' },
      totals: {
        sessionCount: 1,
        requestCount: 2,
        totalTokens: 3,
        costUsd: 0.04,
        errorCount: 0,
      },
    });

    assert.equal(legacy.range, 7);
    assert.equal(legacy.id, '2026-08-03-deep');
    assert.equal(legacy.sections.summary, 'Seven days');
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

    const { range: _range, ...legacy } = valid;
    assert.throws(() =>
      normalizeDailyReviewArchive({
        ...legacy,
        id: '2026-08-03-daily',
        mode: 'deep',
      }),
    );
    assert.throws(() =>
      normalizeDailyReviewArchive({
        ...legacy,
        id: '2026-08-03-deep',
        mode: 'deep',
        sections: {},
      }),
    );
  });

  it('keeps only the three settings that control real behavior', () => {
    assert.deepEqual(
      normalizeDailyReviewConfig({
        enabled: true,
        executeTime: '09:30',
        modelKey: 'openai::gpt-5',
        sections: { summary: false, gaps: false, usage: false, code: false },
        deepEnabled: true,
        includeClaudeCode: true,
        externalNotify: { enabled: true, channelId: 'unused' },
      }),
      {
        enabled: true,
        executeTime: '09:30',
        modelKey: 'openai::gpt-5',
      },
    );
  });
});
