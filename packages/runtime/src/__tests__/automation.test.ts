import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomationManager,
  computeJitter,
  computeNextCronFire,
  matchesCronField,
} from '../automation-state.js';
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
          kind: 'heartbeat',
          name: `auto-${i}`,
          prompt: 'test',
          sessionId: 'sess-1',
          schedule: { type: 'interval', seconds: 60 },
        });
      }
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'overflow',
        prompt: 'test',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok('error' in result);
      assert.ok(result.error.includes('Maximum'));
      const otherSession = mgr.create({
        kind: 'heartbeat',
        name: 'another session',
        prompt: 'test',
        sessionId: 'sess-2',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in otherSession));
    });

    test('durability is a cron-only policy with a durable default', () => {
      const mgr = createManager();
      const durableCron = mgr.create({
        kind: 'cron',
        name: 'daily',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'cron', expression: '0 9 * * *' },
      });
      const ephemeralCron = mgr.create({
        kind: 'cron',
        name: 'ephemeral-cron',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'cron', expression: '0 9 * * *' },
        durable: false,
      });
      const heartbeat = mgr.create({
        kind: 'heartbeat',
        name: 'durable-beat',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
        durable: true,
      });
      assert.ok(!('error' in durableCron));
      assert.equal(durableCron.durable, true);
      assert.ok(!('error' in ephemeralCron));
      assert.equal(Boolean(ephemeralCron.durable), false);
      assert.ok(!('error' in heartbeat));
      assert.equal(Boolean(heartbeat.durable), false);
    });
  });

  describe('durable automations are app-global (queryable + manageable across sessions)', () => {
    // A durable cron persisted from one session must remain visible and
    // manageable from a *different* session after a restart re-homes it under
    // its original sessionId. Non-durable heartbeats stay session-private.
    function makeDurableCron(mgr: ReturnType<typeof createManager>, sessionId = 'creator-sess') {
      const auto = mgr.create({
        kind: 'cron',
        name: 'nightly backup',
        prompt: 'back up',
        sessionId,
        schedule: { type: 'cron', expression: '0 3 * * *' },
      });
      assert.ok(!('error' in auto));
      return auto as Extract<typeof auto, { id: string }>;
    }

    test('durable crons are globally visible and manageable; heartbeats stay private', () => {
      const mgr = createManager();
      const cron = makeDurableCron(mgr, 'creator-sess');
      const beat = mgr.create({
        kind: 'heartbeat',
        name: 'poll',
        prompt: 'p',
        sessionId: 'creator-sess',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in beat));
      const visible = mgr.listVisibleForSession('fresh-sess');
      assert.equal(visible.length, 1);
      assert.equal(visible[0].name, 'nightly backup');
      assert.equal(mgr.pause(beat.id, 'other-sess'), undefined);
      assert.equal(mgr.delete(beat.id, 'other-sess'), false);
      assert.equal(mgr.pause(cron.id, 'fresh-sess')?.status, 'paused');
      assert.equal(mgr.resume(cron.id, 'another-sess')?.status, 'active');
      assert.equal(mgr.delete(cron.id, 'fresh-sess'), true);
      assert.equal(mgr.get(cron.id), undefined);
    });

    test('global durables do not count against a new session create limit', () => {
      const mgr = createManager();
      // Fill the store with durable crons owned by an old session.
      for (let i = 0; i < 20; i++) {
        const a = mgr.create({
          kind: 'cron',
          name: `c${i}`,
          prompt: 'p',
          sessionId: 'old-sess',
          schedule: { type: 'cron', expression: '0 3 * * *' },
        });
        assert.ok(!('error' in a));
      }
      // A fresh session can still create its own — the per-session cap counts
      // only session-owned automations, not the global durable ones it can see.
      const mine = mgr.create({
        kind: 'heartbeat',
        name: 'mine',
        prompt: 'p',
        sessionId: 'fresh-sess',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in mine));
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
          kind: 'cron',
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
    test('one-shot completes after a successful fire', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat',
        name: 'once',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.ok(!('error' in auto));
      // Started nulls nextFireAt but stays active until the outcome is known.
      const started = mgr.attemptStarted(auto.id);
      assert.equal(started?.status, 'active');
      assert.equal(started?.nextFireAt, null);
      mgr.attemptSucceeded(auto.id, 'run-1');
      assert.equal(mgr.get(auto.id)?.status, 'completed');
      assert.equal(mgr.get(auto.id)?.lastRunId, 'run-1');
    });

    test('maxFires completes on the successful fire that reaches the cap', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat',
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
        kind: 'heartbeat',
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
        kind: 'heartbeat',
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
        kind: 'heartbeat',
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
        kind: 'heartbeat',
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
        kind: 'heartbeat',
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
        kind: 'heartbeat',
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

    test('attemptSucceeded resets failure count', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat',
        name: 'test',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptFailed(auto.id, 'fail');
      mgr.attemptFailed(auto.id, 'fail');
      mgr.attemptSucceeded(auto.id);
      assert.equal(mgr.get(auto.id)?.consecutiveFailures, 0);
      assert.equal(mgr.get(auto.id)?.lastError, null);
    });
  });

  describe('removeAllForSession', () => {
    test('removes heartbeat automations only', () => {
      const mgr = createManager();
      mgr.create({
        kind: 'heartbeat',
        name: 'h1',
        prompt: 'p',
        sessionId: 's1',
        schedule: { type: 'interval', seconds: 60 },
      });
      mgr.create({
        kind: 'cron',
        name: 'c1',
        prompt: 'p',
        sessionId: 's1',
        schedule: { type: 'cron', expression: '0 9 * * *' },
      });
      const removed = mgr.removeAllForSession('s1');
      assert.equal(removed, 1);
      assert.equal(mgr.listForSession('s1').length, 1);
      assert.equal(mgr.listForSession('s1')[0].kind, 'cron');
    });
  });

  describe('registerAll — restart recovery', () => {
    function load(mgr: ReturnType<typeof createManager>, over: Partial<Record<string, unknown>>) {
      const base = {
        id: 'loaded',
        kind: 'cron',
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
        durable: true,
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
        kind: 'cron',
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
        kind: 'cron',
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
  test('keeps Runtime return and compatibility-export contracts', () => {
    const base = new Date('2026-07-06T08:00:00').getTime();

    assert.equal(computeNextCronFire('0 9 * * MON', base), computeNextCronFire('0 9 * * 1', base));
    assert.equal(computeNextCronFire('not valid', base), null);
    assert.equal(matchesCronField('5-15/3', 14, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 18, 0, 59), false);
  });
});

describe('AutomationManager edge cases', () => {
  test('create rejects invalid cron expression', () => {
    const mgr = createManager();
    const result = mgr.create({
      kind: 'heartbeat',
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
        kind: 'heartbeat',
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
      kind: 'heartbeat',
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
      kind: 'heartbeat',
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
      kind: 'heartbeat',
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

  test('one-shot jitter is zero off round marks and negative within bounds on them', () => {
    const firesAt = new Date(2026, 0, 1, 10, 37, 0, 0).getTime();
    assert.equal(computeJitter(30 * 60 * 1000, false, Math.random, firesAt), 0);
    assert.equal(computeJitter(60_000, false), 0);
    for (let i = 0; i < 50; i++) {
      const roundMark = new Date(2026, 0, 1, 11, i % 2 === 0 ? 0 : 30, 0, 0).getTime();
      const jitter = computeJitter(17 * 60 * 1000, false, Math.random, roundMark);
      assert.ok(jitter <= 0, `one-shot jitter should be <= 0, got ${jitter}`);
      assert.ok(jitter >= -90_000, `one-shot jitter should be >= -90000, got ${jitter}`);
    }
  });
});

describe('schedule jitter wiring (AutomationManager.computeNextFire)', () => {
  const NOW = 1700000000000;

  function managerWithRandom(random: () => number) {
    let idc = 0;
    return new AutomationManager({ generateId: () => `j-${++idc}`, now: () => NOW, random });
  }

  test('interval schedules get positive recurring jitter', () => {
    const mgr = managerWithRandom(() => 0.5);
    const auto = mgr.create({
      kind: 'heartbeat',
      name: 'poll',
      prompt: 'p',
      sessionId: 's1',
      schedule: { type: 'interval', seconds: 600 },
    });
    assert.ok(!('error' in auto));
    // 600s interval → 10% max = 60s; random 0.5 → +30s jitter.
    assert.equal(auto.nextFireAt, NOW + 600_000 + 30_000);
  });

  test('cron schedules get positive recurring jitter (never fire before the mark)', () => {
    const zero = managerWithRandom(() => 0);
    const base = zero.create({
      kind: 'cron',
      name: 'nightly',
      prompt: 'p',
      sessionId: 's1',
      schedule: { type: 'cron', expression: '*/5 * * * *' },
    });
    assert.ok(!('error' in base));
    const jittered = managerWithRandom(() => 0.999).create({
      kind: 'cron',
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
      kind: 'heartbeat',
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
