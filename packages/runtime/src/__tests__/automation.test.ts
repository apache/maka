import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationManager, computeJitter, computeNextCronFire } from '../automation-state.js';
import type { AutomationSchedule } from '../automation-state.js';

let idCounter = 0;
function createManager() {
  idCounter = 0;
  return new AutomationManager({
    generateId: () => `auto-${++idCounter}`,
    now: () => 1700000000000,
    // Deterministic: no schedule jitter in tests that assert exact timings.
    random: () => 0,
  });
}

describe('AutomationManager', () => {
  describe('create', () => {
    test('enforces the automation limit per session', () => {
      const mgr = createManager();
      for (let i = 0; i < 20; i++) {
        mgr.create({
          name: `auto-${i}`,
          prompt: 'test',
          sessionId: 'sess-1',
          schedule: { type: 'interval', seconds: 60 },
        });
      }
      const result = mgr.create({
        name: 'overflow',
        prompt: 'test',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok('error' in result);
      assert.ok(result.error.includes('Maximum'));
      const otherSession = mgr.create({
        name: 'another session',
        prompt: 'test',
        sessionId: 'sess-2',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in otherSession));
    });
  });

  describe('pause and resume', () => {
    test('resume refuses to re-arm exhausted maxFires and one-shot automations', () => {
      const mgr = createManager();
      const cases: Array<[string, AutomationSchedule, number | undefined]> = [
        ['capped', { type: 'cron', expression: '* * * * *' }, 1],
        ['once', { type: 'once', delaySeconds: 30 }, undefined],
      ];
      for (const [name, schedule, maxFires] of cases) {
        const auto = mgr.create({
          name,
          prompt: 'p',
          sessionId: 'sess-1',
          schedule,
          maxFires,
        });
        assert.ok(!('error' in auto));
        mgr.attemptStarted(auto.id);
        mgr.attemptFailed(auto.id, 'boom');
        assert.equal(mgr.get(auto.id)?.status, 'paused', name);
        assert.equal(mgr.resume(auto.id, 'sess-1'), undefined, name);
        assert.equal(mgr.get(auto.id)?.nextFireAt, null, name);
      }
    });
  });

  describe('markFired', () => {
    test('maxFires completes on the successful fire that reaches the cap', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'limited',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
        maxFires: 2,
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptSucceeded(auto.id);
      assert.equal(mgr.get(auto.id)?.status, 'active'); // 1/2
      mgr.attemptStarted(auto.id);
      mgr.attemptSucceeded(auto.id);
      assert.equal(mgr.get(auto.id)?.status, 'completed'); // 2/2
    });

    test('an accepted attempt still records its outcome when paused in flight', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'in flight',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.pause(auto.id, 'sess-1');
      mgr.attemptSucceeded(auto.id, 'run-in-flight');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
      assert.equal(mgr.get(auto.id)?.lastRunId, 'run-in-flight');
      assert.equal(mgr.get(auto.id)?.lastError, null);
    });

    test('a failed fire does NOT complete (even at maxFires)', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'limited',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
        maxFires: 1,
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptFailed(auto.id, 'boom');
      // Not 'completed' — a failure never masquerades as success.
      assert.notEqual(mgr.get(auto.id)?.status, 'completed');
    });

    test('does not fire paused automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'test',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.pause(auto.id, 'sess-1');
      assert.equal(mgr.attemptStarted(auto.id), undefined);
    });
  });

  describe('attemptFailed', () => {
    test('auto-pauses after MAX_CONSECUTIVE_FAILURES', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'test',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      for (let i = 0; i < 5; i++) mgr.attemptFailed(auto.id, 'fail');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
    });

    test('a one-shot failure pauses (visible, not a silent zombie)', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'once',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 10 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id); // nextFireAt → null
      mgr.attemptFailed(auto.id, 'boom');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
    });

    test('an empty accepted failure gets a stable diagnostic', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'empty failure',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 10 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptFailed(auto.id, '');
      assert.equal(mgr.get(auto.id)?.lastError, 'Automation run failed');
    });
  });

  describe('removeAllForSession', () => {});

  describe('registerAll — restart recovery', () => {
    function load(mgr: ReturnType<typeof createManager>, over: Partial<Record<string, unknown>>) {
      const base = {
        id: 'loaded',
        name: 'c',
        status: 'active',
        prompt: 'p',
        sessionId: 's1',
        schedule: { type: 'cron', expression: '0 9 * * *' },
        createdAt: 0,
        updatedAt: 0,
        nextFireAt: null,
        lastFireAt: null,
        lastRunId: null,
        fireCount: 0,
        maxFires: null,
        expiresAt: null,
        lastError: null,
        consecutiveFailures: 0,
      };
      mgr.registerAll([{ ...base, ...over }] as never);
      return mgr.get('loaded');
    }

    test('re-arms a corrupt recurring automation (active + nextFireAt=null, budget not spent)', () => {
      // A recurring automation should always carry a future fire time; a null
      // one is a corrupt/interrupted state → re-arm rather than leave a zombie.
      const healed = load(createManager(), { status: 'active', nextFireAt: null, fireCount: 1 });
      assert.ok(healed?.nextFireAt, 'corrupt recurring automation should be re-armed on load');
      assert.equal(healed?.status, 'active');
    });

    test('settles interrupted exhausted schedules without re-running them', () => {
      for (const [label, state, recordsUncertainty] of [
        ['maxFires', { fireCount: 3, maxFires: 3 }, true],
        ['once', { fireCount: 1, schedule: { type: 'once', delaySeconds: 30 } }, false],
      ] as const) {
        const settled = load(createManager(), {
          status: 'active',
          nextFireAt: null,
          ...state,
        });
        assert.equal(settled?.status, 'completed', label);
        assert.equal(settled?.nextFireAt, null, label);
        if (recordsUncertainty) assert.ok(settled?.lastError);
      }
    });
  });

  describe('resume — streak reset', () => {
    test('resume clears consecutiveFailures so one later failure does not re-pause', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'flaky',
        prompt: 'p',
        sessionId: 's1',
        schedule: { type: 'cron', expression: '* * * * *' },
      });
      assert.ok(!('error' in auto));
      const id = (auto as { id: string }).id;
      // Accumulate failures short of the pause threshold, then pause + resume.
      mgr.attemptStarted(id);
      mgr.attemptFailed(id, 'boom');
      mgr.attemptStarted(id);
      mgr.attemptFailed(id, 'boom');
      assert.equal(mgr.get(id)?.consecutiveFailures, 2);
      mgr.pause(id, 's1');
      const resumed = mgr.resume(id, 's1');
      assert.equal(resumed?.consecutiveFailures, 0, 'resume must reset the failure streak');
      assert.equal(resumed?.lastError, null);
    });
  });

  describe('skipFire', () => {
    test('a skipped once is settled terminally (no drift, not re-armed)', () => {
      const mgr = createManager();
      const auto = mgr.create({
        name: 'remind',
        prompt: 'p',
        sessionId: 's1',
        schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.ok(!('error' in auto));
      const id = (auto as { id: string }).id;
      mgr.skipFire(id);
      const after = mgr.get(id);
      assert.equal(after?.status, 'expired', 'a skipped one-shot must not drift forward');
      assert.equal(after?.nextFireAt, null);
      // Idempotent: skipping again does nothing (already terminal).
      mgr.skipFire(id);
      assert.equal(mgr.get(id)?.status, 'expired');
    });
  });
});

describe('computeNextCronFire', () => {
  test('uses the canonical strict cron grammar', () => {
    const base = new Date('2026-07-06T08:00:00').getTime();

    assert.equal(computeNextCronFire('0 9 * * 1', base), new Date('2026-07-06T09:00:00').getTime());
    assert.equal(computeNextCronFire('0 9 * * MON', base), null);
    assert.equal(computeNextCronFire('not valid', base), null);
  });
});

describe('AutomationManager edge cases', () => {
  test('create rejects invalid cron expression', () => {
    const mgr = createManager();
    const result = mgr.create({
      name: 'bad cron',
      prompt: 'p',
      sessionId: 'sess-1',
      schedule: { type: 'cron', expression: 'not valid' },
    });
    assert.ok('error' in result);
    assert.ok(result.error.includes('Invalid cron'));
  });

  test('pruneTerminal keeps up to 50 terminal records (old wakeup history cap), then prunes', () => {
    const mgr = createManager();
    // Create and complete 60 automations — more than the 50-record history cap.
    for (let i = 0; i < 60; i++) {
      const auto = mgr.create({
        name: `auto-${i}`,
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 10 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptSucceeded(auto.id);
    }
    // Pruning is triggered on next create
    mgr.create({
      name: 'trigger-prune',
      prompt: 'p',
      sessionId: 'sess-1',
      schedule: { type: 'interval', seconds: 60 },
    });
    const all = mgr.listForSession('sess-1');
    const completed = all.filter((a) => a.status === 'completed');
    assert.ok(completed.length <= 50, `Expected <=50 completed, got ${completed.length}`);
    // Review fix (LOW): the cap is 50 (not the old 5) so recent history stays
    // observable via list — well more than 5 terminal records must survive.
    assert.ok(
      completed.length >= 49,
      `Expected ~50 kept for observability, got ${completed.length}`,
    );
  });

  test('skipFire advances nextFireAt without incrementing fireCount', () => {
    let time = 1700000000000;
    const mgr = new AutomationManager({
      generateId: () => 'skip-test',
      now: () => time,
      random: () => 0,
    });
    const auto = mgr.create({
      name: 'skip test',
      prompt: 'p',
      sessionId: 'sess-1',
      schedule: { type: 'interval', seconds: 60 },
    });
    assert.ok(!('error' in auto));
    const originalNext = auto.nextFireAt!;
    // Advance time so skipFire computes a different nextFireAt
    time += 30000;
    mgr.skipFire(auto.id);
    const updated = mgr.get(auto.id)!;
    assert.ok(
      updated.nextFireAt! > originalNext,
      `expected ${updated.nextFireAt} > ${originalNext}`,
    );
    assert.equal(updated.fireCount, 0);
  });

  test('attemptFailed does not overwrite completed status', () => {
    const mgr = createManager();
    const auto = mgr.create({
      name: 'terminal',
      prompt: 'p',
      sessionId: 'sess-1',
      schedule: { type: 'once', delaySeconds: 10 },
    });
    assert.ok(!('error' in auto));
    mgr.attemptStarted(auto.id);
    mgr.attemptSucceeded(auto.id); // completes (one-shot)
    mgr.attemptFailed(auto.id, 'should not change status');
    assert.equal(mgr.get(auto.id)?.status, 'completed');
  });
});

// ─── Thundering-herd jitter (ported from the old wakeup-scheduler) ───────────

describe('computeJitter', () => {
  test('recurring jitter stays positive and bounded by 10% or 15 minutes', () => {
    for (const [delayMs, maximum] of [
      [600_000, 60_000],
      [24 * 60 * 60 * 1000, 15 * 60 * 1000],
    ]) {
      for (let i = 0; i < 50; i++) {
        const jitter = computeJitter(delayMs, true);
        assert.ok(jitter >= 0);
        assert.ok(jitter <= maximum, `expected <= ${maximum}, got ${jitter}`);
      }
    }
  });
});

describe('schedule jitter wiring (AutomationManager.computeNextFire)', () => {
  const NOW = 1700000000000;

  function managerWithRandom(random: () => number) {
    let idc = 0;
    return new AutomationManager({ generateId: () => `j-${++idc}`, now: () => NOW, random });
  }

  test('cron schedules get positive recurring jitter (never fire before the mark)', () => {
    const zero = managerWithRandom(() => 0);
    const base = zero.create({
      name: 'nightly',
      prompt: 'p',
      sessionId: 's1',
      schedule: { type: 'cron', expression: '*/5 * * * *' },
    });
    assert.ok(!('error' in base));
    const jittered = managerWithRandom(() => 0.999).create({
      name: 'nightly',
      prompt: 'p',
      sessionId: 's1',
      schedule: { type: 'cron', expression: '*/5 * * * *' },
    });
    assert.ok(!('error' in jittered));
    // Jitter pushes the fire AFTER the cron mark (an early fire would recompute
    // the same mark next time and double-fire), bounded by 10% of the delay.
    assert.ok(jittered.nextFireAt! >= base.nextFireAt!, 'cron jitter must be non-negative');
    const delayMs = base.nextFireAt! - NOW;
    assert.ok(
      jittered.nextFireAt! - base.nextFireAt! <= delayMs * 0.1,
      'cron jitter bounded at 10% of delay',
    );
  });

  test('a once schedule landing on a :00/:30 minute is pulled up to 90s early', () => {
    // Pick a NOW so that now + delay lands exactly on a :30 wall-clock minute.
    const fireBase = new Date(2026, 0, 1, 11, 30, 0, 0).getTime();
    const delaySeconds = 600;
    const now = fireBase - delaySeconds * 1000;
    let idc = 0;
    const mgr = new AutomationManager({
      generateId: () => `o-${++idc}`,
      now: () => now,
      random: () => 0.5,
    });
    const auto = mgr.create({
      name: 'remind',
      prompt: 'p',
      sessionId: 's1',
      schedule: { type: 'once', delaySeconds },
    });
    assert.ok(!('error' in auto));
    // random 0.5 → 45s early.
    assert.equal(auto.nextFireAt, fireBase - 45_000);
  });
});
