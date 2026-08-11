import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeNextFireAt,
  isScheduledTaskDue,
  nextScheduledTaskStateAfterFire,
  normalizeCreateScheduledTaskInput,
  pauseScheduledTask,
  resumeScheduledTask,
  type ScheduledTask,
} from '../scheduled-task.js';

describe('scheduled-task catalog', () => {
  it('advances once schedules to completed after fire', () => {
    const task: ScheduledTask = {
      id: 't1',
      title: 'Once',
      intent: { kind: 'text', body: 'hi' },
      schedule: { kind: 'once', runAt: 1000 },
      effect: { kind: 'notify', channel: 'local' },
      status: 'active',
      nextFireAt: 1000,
      lastFireAt: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      createdBy: { kind: 'user' },
      createdAt: 0,
      updatedAt: 0,
      runs: [],
      lastError: null,
    };
    const next = nextScheduledTaskStateAfterFire(task, {
      id: 'r1',
      at: 1000,
      outcome: 'ok',
      message: 'done',
    });
    assert.equal(next.status, 'completed');
    assert.equal(next.nextFireAt, null);
    assert.equal(next.fireCount, 1);
  });

  it('pause and resume restore nextFireAt', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const next = computeNextFireAt({ kind: 'interval', everySeconds: 3600, startAt: now }, now);
    assert.ok(next);
    const task: ScheduledTask = {
      id: 't2',
      title: 'Hourly',
      intent: { kind: 'text', body: 'tick' },
      schedule: { kind: 'interval', everySeconds: 3600, startAt: now },
      effect: { kind: 'notify', channel: 'local' },
      status: 'active',
      nextFireAt: next,
      lastFireAt: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      createdBy: { kind: 'user' },
      createdAt: now,
      updatedAt: now,
      runs: [],
      lastError: null,
    };
    assert.equal(isScheduledTaskDue(task, next), true);
    const paused = pauseScheduledTask(task, now + 1);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.nextFireAt, null);
    const resumed = resumeScheduledTask(paused, now + 2);
    assert.ok(!('error' in resumed));
    if ('error' in resumed) return;
    assert.equal(resumed.status, 'active');
    assert.ok(typeof resumed.nextFireAt === 'number');
  });

  it('does not resume a task whose fire budget is already spent', () => {
    const task: ScheduledTask = {
      id: 'spent',
      title: 'Spent',
      intent: { kind: 'text', body: '' },
      schedule: { kind: 'interval', everySeconds: 60, startAt: 0 },
      effect: { kind: 'notify', channel: 'local' },
      status: 'paused',
      nextFireAt: null,
      lastFireAt: 60_000,
      fireCount: 1,
      maxFires: 1,
      expiresAt: null,
      createdBy: { kind: 'user' },
      createdAt: 0,
      updatedAt: 60_000,
      runs: [],
      lastError: null,
    };
    assert.deepEqual(resumeScheduledTask(task, 120_000), {
      error: 'Scheduled task fire budget is exhausted',
    });
  });

  it('rejects numeric-string coercion and non-canonical cron spacing', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    for (const schedule of [
      { kind: 'once', runAt: String(now + 60_000) },
      { kind: 'interval', everySeconds: '60', startAt: now },
      { kind: 'interval', everySeconds: 60.5, startAt: now },
      { kind: 'interval', everySeconds: 60, startAt: String(now) },
      { kind: 'cron', expression: '0 9 * * *', startAt: String(now) },
      { kind: 'cron', expression: ' 0 9 * * *', startAt: now },
    ]) {
      assert.equal(
        normalizeCreateScheduledTaskInput(
          {
            title: 'Strict boundary',
            intentBody: '',
            schedule,
            effect: { kind: 'notify', channel: 'local' },
            createdBy: { kind: 'user' },
          },
          now,
        ).ok,
        false,
      );
    }
  });

  it('clamps monthly recurrence to the last calendar day', () => {
    const runAt = new Date(2026, 0, 31, 9, 30).getTime();
    const monthly = { kind: 'calendar' as const, recurrence: 'monthly' as const, anchorAt: runAt };
    const february = computeNextFireAt(monthly, runAt);
    assert.equal(new Date(february!).getDate(), 28);
  });

  it('rejects tasks whose first fire is not before expiration', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const result = normalizeCreateScheduledTaskInput(
      {
        title: 'Already expired before fire',
        intentBody: '',
        schedule: { kind: 'once', runAt: now + 60_000 },
        effect: { kind: 'notify', channel: 'local' },
        createdBy: { kind: 'user' },
        expiresAt: now + 30_000,
      },
      now,
    );
    assert.deepEqual(result, { ok: false, message: 'Schedule must fire before expiresAt' });
  });

  it('rejects future recurrence anchors outside the scheduling horizon', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    for (const schedule of [
      { kind: 'interval', everySeconds: 60, startAt: now + 367 * 86_400_000 },
      { kind: 'calendar', recurrence: 'monthly', anchorAt: now + 367 * 86_400_000 },
    ]) {
      const result = normalizeCreateScheduledTaskInput(
        {
          title: 'Too far away',
          intentBody: '',
          schedule,
          effect: { kind: 'notify', channel: 'local' },
          createdBy: { kind: 'user' },
        },
        now,
      );
      assert.deepEqual(result, {
        ok: false,
        message: 'Schedule has no fire within one year from now',
      });
    }
  });
});
