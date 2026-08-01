import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
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
    test('rejects when max automations reached', () => {
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
    });

    test('different sessions have independent limits', () => {
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
        name: 'another session',
        prompt: 'test',
        sessionId: 'sess-2',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in result));
    });

    test('cron defaults to durable (survives restart without an explicit flag)', () => {
      const mgr = createManager();
      const result = mgr.create({
        kind: 'cron',
        name: 'daily',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'cron', expression: '0 9 * * *' },
      });
      assert.ok(!('error' in result));
      assert.equal(result.durable, true);
    });

    test('heartbeat defaults to non-durable (bound to its session)', () => {
      const mgr = createManager();
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'poll',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in result));
      assert.ok(!result.durable);
    });

    test('explicit durable refines cron; heartbeat is always session-bound', () => {
      const mgr = createManager();
      const cron = mgr.create({
        kind: 'cron',
        name: 'ephemeral-cron',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'cron', expression: '0 9 * * *' },
        durable: false,
      });
      assert.ok(!('error' in cron));
      assert.ok(!cron.durable);
      // durable is a cron-only concept — a heartbeat cannot opt into it.
      const beat = mgr.create({
        kind: 'heartbeat',
        name: 'durable-beat',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
        durable: true,
      });
      assert.ok(!('error' in beat));
      assert.ok(!beat.durable);
    });
  });

  describe('delete', () => {
    test('cannot delete another sessions automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat',
        name: 'test',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      assert.equal(mgr.delete(auto.id, 'sess-2'), false);
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

    test('listVisibleForSession surfaces durable automations owned by another session', () => {
      const mgr = createManager();
      makeDurableCron(mgr, 'creator-sess');
      // A brand-new session (as after a restart) sees the persisted cron.
      const visible = mgr.listVisibleForSession('fresh-sess');
      assert.equal(visible.length, 1);
      assert.equal(visible[0].name, 'nightly backup');
    });

    test('a non-durable heartbeat stays private to its session', () => {
      const mgr = createManager();
      const beat = mgr.create({
        kind: 'heartbeat',
        name: 'poll',
        prompt: 'p',
        sessionId: 'creator-sess',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in beat));
      assert.equal(mgr.listVisibleForSession('other-sess').length, 0);
      // …and cannot be managed from another session.
      assert.equal(mgr.pause((beat as { id: string }).id, 'other-sess'), undefined);
    });

    test('pause / resume / delete a durable cron from a different session', () => {
      const mgr = createManager();
      const cron = makeDurableCron(mgr, 'creator-sess');
      // Pause from a fresh session.
      assert.equal(mgr.pause(cron.id, 'fresh-sess')?.status, 'paused');
      // Resume from yet another session.
      assert.equal(mgr.resume(cron.id, 'another-sess')?.status, 'active');
      // Delete from a fresh session.
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
    test('cannot pause already paused', () => {
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
      assert.equal(mgr.pause(auto.id, 'sess-1'), undefined);
    });

    test('resume refuses to re-arm a maxFires-exhausted automation (no fire beyond the hard cap)', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'cron',
        name: 'capped',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'cron', expression: '* * * * *' },
        maxFires: 1,
      });
      assert.ok(!('error' in auto));
      // The single allowed fire starts (fireCount=1, cap nulls nextFireAt)…
      const started = mgr.attemptStarted(auto.id);
      assert.equal(started?.fireCount, 1);
      assert.equal(started?.nextFireAt, null);
      // …then FAILS, settling to paused (the resumable-but-spent trap).
      mgr.attemptFailed(auto.id, 'boom');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
      // resume must NOT revive the spent budget.
      const resumed = mgr.resume(auto.id, 'sess-1');
      assert.equal(resumed, undefined);
      assert.equal(mgr.get(auto.id)?.status, 'paused');
      assert.equal(mgr.get(auto.id)?.nextFireAt, null);
    });

    test('resume refuses to re-fire a one-shot that already fired', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'cron',
        name: 'once',
        prompt: 'p',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptFailed(auto.id, 'boom');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
      assert.equal(mgr.resume(auto.id, 'sess-1'), undefined);
      assert.equal(mgr.get(auto.id)?.nextFireAt, null);
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

    test('settles a spent-maxFires interrupted fire to completed (at-most-once, no re-run)', () => {
      const settled = load(createManager(), {
        status: 'active',
        nextFireAt: null,
        fireCount: 3,
        maxFires: 3,
      });
      assert.equal(settled?.status, 'completed');
      assert.equal(settled?.nextFireAt, null);
      // Surfaces the uncertainty rather than asserting a clean success.
      assert.ok(
        settled?.lastError,
        'an interrupted-then-settled fire must record its unknown outcome',
      );
    });

    test('settles an interrupted once fire to completed (no drift, no re-run)', () => {
      const settled = load(createManager(), {
        status: 'active',
        nextFireAt: null,
        fireCount: 1,
        schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.equal(settled?.status, 'completed');
      assert.equal(settled?.nextFireAt, null);
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
    test('advances a recurring automation to its next slot', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'cron',
        name: 'daily',
        prompt: 'p',
        sessionId: 's1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      const id = (auto as { id: string }).id;
      const before = mgr.get(id)?.nextFireAt;
      mgr.skipFire(id);
      const after = mgr.get(id);
      assert.equal(after?.status, 'active');
      assert.ok(after?.nextFireAt && before && after.nextFireAt >= before);
    });

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
  describe('validation + named tokens (O(1), no multi-second scan)', () => {
    test('named weekday MON resolves to Monday', () => {
      const base = new Date('2026-07-06T08:00:00').getTime(); // 2026-07-06 is a Monday
      const named = computeNextCronFire('0 9 * * MON', base);
      const numeric = computeNextCronFire('0 9 * * 1', base);
      assert.ok(named);
      assert.equal(named, numeric, 'MON must resolve identically to 1');
      assert.equal(new Date(named!).getDay(), 1);
    });

    test('named month JAN resolves to January; case-insensitive', () => {
      const base = new Date('2026-07-06T00:00:00').getTime();
      const next = computeNextCronFire('0 0 1 jan *', base);
      assert.ok(next);
      assert.equal(new Date(next!).getMonth(), 0); // January
      assert.equal(new Date(next!).getDate(), 1);
    });

    test('named weekday range MON-FRI fires on a weekday', () => {
      const base = new Date('2026-07-06T00:00:00').getTime();
      const next = computeNextCronFire('0 9 * * mon-fri', base);
      assert.ok(next);
      const dow = new Date(next!).getDay();
      assert.ok(dow >= 1 && dow <= 5);
    });

    test('out-of-range fields are rejected in O(1)', () => {
      const base = Date.now();
      const start = Date.now();
      assert.equal(computeNextCronFire('0 9 32 * *', base), null); // day 32
      assert.equal(computeNextCronFire('0 25 * * *', base), null); // hour 25
      assert.equal(computeNextCronFire('0 9 * 13 *', base), null); // month 13
      assert.equal(computeNextCronFire('0 9 * * BADTOKEN', base), null);
      assert.ok(Date.now() - start < 100, 'invalid expressions must fail fast, not scan');
    });

    test('impossible calendar dates fail fast (no 8-year scan)', () => {
      const base = Date.now();
      const start = Date.now();
      assert.equal(computeNextCronFire('0 0 30 2 *', base), null); // Feb 30
      assert.equal(computeNextCronFire('0 0 31 4 *', base), null); // Apr 31
      assert.ok(Date.now() - start < 100, 'impossible dates must fail fast');
    });

    test('impossible dom is NOT rejected when dow is also restricted (Vixie OR)', () => {
      // `0 0 30 2 5` = Feb 30 (impossible) OR any Friday in Feb (valid) → fires.
      const base = new Date('2026-01-01T00:00:00').getTime();
      const next = computeNextCronFire('0 0 30 2 5', base);
      assert.ok(next, 'must still fire on Fridays in February');
      const d = new Date(next!);
      assert.equal(d.getMonth(), 1); // February
      assert.equal(d.getDay(), 5); // Friday
    });

    test('DST fall-back: next fire is strictly after fromTime (regression: no re-fire storm)', () => {
      // Under America/New_York, 2026-11-01T06:30Z is inside the REPEATED (fall-back)
      // local hour. A local wall-clock round-trip would shift the scan start ~59min
      // before fromTime, returning a candidate <= fromTime → the scheduler would
      // re-fire every tick for the whole hour. Run in a child with TZ set; the
      // snippet exits non-zero (→ execFileSync throws) if strictly-after is violated.
      const modUrl = pathToFileURL(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'automation-state.js'),
      ).href;
      const snippet =
        `import(${JSON.stringify(modUrl)}).then(m => {` +
        `const from = Date.parse('2026-11-01T06:30:00Z');` +
        `const next = m.computeNextCronFire('30 1 * * *', from);` +
        `process.exit(typeof next === 'number' && next > from ? 0 : 1);` +
        `}).catch(() => process.exit(2));`;
      assert.doesNotThrow(() =>
        execFileSync(process.execPath, ['--input-type=module', '-e', snippet], {
          env: { ...process.env, TZ: 'America/New_York' },
          stdio: 'pipe',
        }),
      );
    });
  });

  test('range/step 5-15/3 does not match 18,21,24...', () => {
    // Verify values outside the range don't match
    assert.equal(matchesCronField('5-15/3', 18, 0, 59), false);
    assert.equal(matchesCronField('5-15/3', 21, 0, 59), false);
    assert.equal(matchesCronField('5-15/3', 5, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 8, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 11, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 14, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 15, 0, 59), false); // 15-5=10, 10%3≠0
  });

  // --- Bug 1: sparse annual crons must resolve within a bounded window ---

  test('sparse annual cron 0 0 29 2 * resolves to Feb 29 in a leap year (not null)', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    const next = computeNextCronFire('0 0 29 2 *', base);
    assert.ok(next, 'Feb 29 cron should resolve within the extended search window');
    const d = new Date(next!);
    assert.equal(d.getMonth(), 1, 'month should be February (0-indexed 1)');
    assert.equal(d.getDate(), 29, 'day should be the 29th');
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    const y = d.getFullYear();
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    assert.ok(isLeap, `${y} should be a leap year`);
    assert.ok(next! > base);
  });

  test('impossible cron 0 0 30 2 * returns null (bounded, no infinite loop)', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    const next = computeNextCronFire('0 0 30 2 *', base);
    assert.equal(next, null, 'Feb 30 never occurs, must return null after bounded search');
  });

  // --- Bug 2: dom + dow are OR (not AND) when BOTH fields are restricted ---

  test('dom+dow OR: 0 0 13 * 5 matches the 13th OR any Friday (not Friday-the-13th)', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    const fires: Date[] = [];
    let cursor = base;
    for (let i = 0; i < 8; i++) {
      const next = computeNextCronFire('0 0 13 * 5', cursor);
      assert.ok(next);
      fires.push(new Date(next!));
      cursor = next!;
    }
    // Every fire is at midnight and is either the 13th OR a Friday (dow 5).
    for (const d of fires) {
      assert.equal(d.getHours(), 0);
      assert.equal(d.getMinutes(), 0);
      assert.ok(
        d.getDate() === 13 || d.getDay() === 5,
        `${d.toISOString()} should be the 13th or a Friday`,
      );
    }
    // Proves OR (not AND): a Friday that is NOT the 13th must appear ...
    assert.ok(
      fires.some((d) => d.getDay() === 5 && d.getDate() !== 13),
      'expected at least one Friday that is not the 13th',
    );
    // ... and a 13th that is NOT a Friday must appear.
    assert.ok(
      fires.some((d) => d.getDate() === 13 && d.getDay() !== 5),
      'expected at least one 13th that is not a Friday',
    );
  });

  test('dom-only 0 0 13 * * matches only the 13th (dow unrestricted → AND)', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    let cursor = base;
    for (let i = 0; i < 4; i++) {
      const next = computeNextCronFire('0 0 13 * *', cursor);
      assert.ok(next);
      const d = new Date(next!);
      assert.equal(d.getDate(), 13, `${d.toISOString()} should be the 13th`);
      assert.equal(d.getHours(), 0);
      assert.equal(d.getMinutes(), 0);
      cursor = next!;
    }
  });

  test('dow-only 0 0 * * 5 matches only Fridays (dom unrestricted → AND)', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    let cursor = base;
    for (let i = 0; i < 4; i++) {
      const next = computeNextCronFire('0 0 * * 5', cursor);
      assert.ok(next);
      const d = new Date(next!);
      assert.equal(d.getDay(), 5, `${d.toISOString()} should be a Friday`);
      assert.equal(d.getHours(), 0);
      assert.equal(d.getMinutes(), 0);
      cursor = next!;
    }
  });

  test('dow=7 matches Sundays (cron allows 0 OR 7 for Sunday)', () => {
    const base = new Date('2026-07-06T10:00:00').getTime(); // Monday
    for (const field of ['0 0 * * 7', '0 0 * * 0', '0 0 * * 5-7', '0 0 * * 0,3']) {
      const next = computeNextCronFire(field, base);
      assert.ok(next, `${field} should resolve`);
    }
    // "* * * * 7" must actually land on a Sunday.
    const sun = computeNextCronFire('0 0 * * 7', base);
    assert.equal(new Date(sun!).getDay(), 0, 'dow=7 lands on Sunday (getDay()===0)');
    // "5-7" (Fri/Sat/Sun) includes Sunday.
    let cursor = base;
    let sawSunday = false;
    for (let i = 0; i < 6; i++) {
      const n = computeNextCronFire('0 0 * * 5-7', cursor);
      if (n && new Date(n).getDay() === 0) sawSunday = true;
      cursor = n ?? cursor;
    }
    assert.ok(sawSunday, '5-7 range includes Sunday');
  });

  // --- Regression: common crons keep working after the OR/window changes ---

  test('regression: */5 * * * * still fires every 5 minutes', () => {
    const base = new Date('2026-07-06T10:02:00').getTime();
    const next = computeNextCronFire('*/5 * * * *', base);
    assert.ok(next);
    const d = new Date(next!);
    assert.equal(d.getMinutes() % 5, 0);
    assert.equal(d.getMinutes(), 5);
  });

  test('regression: 0 9 * * 1-5 still fires 09:00 on weekdays only', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    let cursor = base;
    for (let i = 0; i < 6; i++) {
      const next = computeNextCronFire('0 9 * * 1-5', cursor);
      assert.ok(next);
      const d = new Date(next!);
      assert.equal(d.getHours(), 9);
      assert.equal(d.getMinutes(), 0);
      const dow = d.getDay();
      assert.ok(dow >= 1 && dow <= 5, `${d.toISOString()} should be Mon-Fri`);
      cursor = next!;
    }
  });

  test('regression: 10-30/5 * * * * only matches 10,15,20,25,30', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    let cursor = base;
    for (let i = 0; i < 12; i++) {
      const next = computeNextCronFire('10-30/5 * * * *', cursor);
      assert.ok(next);
      const min = new Date(next!).getMinutes();
      assert.ok(min >= 10 && min <= 30, `minute ${min} should be in range 10-30`);
      assert.equal((min - 10) % 5, 0, `minute ${min} should be step of 5 from 10`);
      cursor = next!;
    }
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
  test('for recurring returns a value within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const delayMs = 600_000; // 10 minutes
      const jitter = computeJitter(delayMs, true);
      // 10% of 600000 = 60000, which is < the 15-minute cap (900000)
      assert.ok(jitter >= 0, 'recurring jitter should be non-negative');
      assert.ok(jitter <= 60_000, 'recurring jitter should be <= 10% of delay');
    }
  });

  test('for recurring caps at 15 minutes for long delays', () => {
    for (let i = 0; i < 50; i++) {
      const delayMs = 24 * 60 * 60 * 1000; // 24h → 10% = 2.4h, capped at 15min
      const jitter = computeJitter(delayMs, true);
      assert.ok(jitter >= 0);
      assert.ok(jitter <= 15 * 60 * 1000, `recurring jitter should cap at 15min, got ${jitter}`);
    }
  });

  test('for one-shot returns 0 when the fire time is off the round mark', () => {
    // The round-mark property belongs to the fire TIMESTAMP, not the delay:
    // 10:07 + 30min = 10:37 → no early jitter.
    const firesAt = new Date(2026, 0, 1, 10, 37, 0, 0).getTime();
    const jitter = computeJitter(30 * 60 * 1000, false, Math.random, firesAt);
    assert.equal(jitter, 0);
    // Without a timestamp there is no round-mark evidence → no jitter.
    assert.equal(computeJitter(60_000, false), 0);
  });

  test('for one-shot firing on a :00/:30 minute returns negative value in bounds', () => {
    for (let i = 0; i < 50; i++) {
      const firesAt = new Date(2026, 0, 1, 11, i % 2 === 0 ? 0 : 30, 0, 0).getTime();
      const jitter = computeJitter(17 * 60 * 1000, false, Math.random, firesAt);
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
