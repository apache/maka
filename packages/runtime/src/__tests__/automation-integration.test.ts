import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationManager } from '../automation-state.js';
import { AutomationScheduler } from '../automation-scheduler.js';
import { buildAutomationTool } from '../automation-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

const SESSION_ID = 'integration-sess-1';

function createContext(sessionId = SESSION_ID): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn-1',
    cwd: '/tmp/test',
    toolCallId: 'tc-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function createIntegrationSetup() {
  let idCounter = 0;
  let time = 1700000000000;
  const timers: Array<{ fn: () => void; id: number }> = [];
  let timerId = 0;
  const injectedTurns: Array<{ sessionId: string; prompt: string; automationId: string }> = [];
  const freshRuns: Array<{ prompt: string; automationId: string }> = [];
  let canFireResult = true;
  const changes: number[] = [];

  const manager = new AutomationManager({
    generateId: () => `auto-${++idCounter}`,
    now: () => time,
    random: () => 0, // deterministic: no schedule jitter in timing tests
  });

  const scheduler = new AutomationScheduler({
    automationManager: manager,
    canFire: async () => canFireResult,
    injectTurn: async (sessionId, prompt, automationId) => {
      injectedTurns.push({ sessionId, prompt, automationId });
      return { runId: `run-${automationId}`, ok: true };
    },
    createFreshRun: async (prompt, automationId) => {
      freshRuns.push({ prompt, automationId });
      return { runId: `fresh-${automationId}`, ok: true };
    },
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.push({ fn, id });
      return id;
    },
    clearTimeout: (timer) => {
      const idx = timers.findIndex((t) => t.id === timer);
      if (idx >= 0) timers.splice(idx, 1);
    },
    now: () => time,
    onStateChange: () => {
      changes.push(time);
    },
  });

  const tool = buildAutomationTool({
    automationManager: manager,
    onAutomationChange: () => {
      changes.push(time);
    },
    cronEnabled: true,
  });

  function advanceTime(ms: number) {
    time += ms;
  }
  async function runTick() {
    const timer = timers.shift();
    if (timer) timer.fn();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    manager,
    scheduler,
    tool,
    injectedTurns,
    freshRuns,
    timers,
    changes,
    advanceTime,
    runTick,
    setCanFire: (v: boolean) => {
      canFireResult = v;
    },
    ctx: createContext,
  };
}

describe('Automation integration: heartbeat fires on schedule', () => {
  test('create heartbeat via tool, scheduler fires it', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    // Create via tool
    const result = (await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'deploy check',
        prompt: 'check deploy status',
        schedule: { type: 'interval', seconds: 30 },
      },
      ctx,
    )) as string;

    assert.ok(result.includes('Automation created'));
    assert.ok(result.includes('deploy check'));

    // Advance past fire time
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();

    // Should have injected a turn
    assert.equal(t.injectedTurns.length, 1);
    assert.ok(t.injectedTurns[0].prompt.includes('check deploy status'));
    assert.ok(t.injectedTurns[0].prompt.includes('[Automation: deploy check]'));
  });
});

describe('Automation integration: durable flag', () => {
  test('cron is durable; a durable heartbeat is coerced to session-bound', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    // Cron is durable by default (app-global, survives restart).
    const cron = (await t.tool.impl(
      {
        mode: 'create',
        kind: 'cron',
        name: 'persistent check',
        prompt: 'check it',
        schedule: { type: 'cron', expression: '*/5 * * * *' },
      },
      ctx,
    )) as string;
    assert.ok(cron.includes('durable'));
    assert.equal(
      t.manager.listForSession(SESSION_ID).find((a) => a.name === 'persistent check')?.durable,
      true,
    );

    // durable is a cron-only concept: a heartbeat stays session-bound even when
    // durable:true is requested (a durable heartbeat would be a post-restart zombie).
    (await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'session poll',
        prompt: 'poll',
        schedule: { type: 'interval', seconds: 60 },
        durable: true,
      },
      ctx,
    )) as string;
    assert.ok(
      !t.manager.listForSession(SESSION_ID).find((a) => a.name === 'session poll')?.durable,
    );
  });

  test('onAutomationChange fires on create/delete', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'a',
        prompt: 'p',
        schedule: { type: 'interval', seconds: 60 },
      },
      ctx,
    );
    assert.equal(t.changes.length, 1);

    const automations = t.manager.listForSession(SESSION_ID);
    await t.tool.impl({ mode: 'delete', id: automations[0].id }, ctx);
    assert.equal(t.changes.length, 2);
  });
});

describe('Automation integration: pause/resume/delete via tool', () => {
  test('full lifecycle: create → pause → resume → delete', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    // Create
    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'lifecycle test',
        prompt: 'p',
        schedule: { type: 'interval', seconds: 60 },
      },
      ctx,
    );

    const auto = t.manager.listForSession(SESSION_ID)[0];
    assert.equal(auto.status, 'active');

    // Pause
    const pauseResult = (await t.tool.impl({ mode: 'pause', id: auto.id }, ctx)) as string;
    assert.ok(pauseResult.includes('paused'));
    assert.equal(t.manager.get(auto.id)?.status, 'paused');

    // Paused automation should not fire
    t.advanceTime(61000);
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.injectedTurns.length, 0);

    // Resume
    const resumeResult = (await t.tool.impl({ mode: 'resume', id: auto.id }, ctx)) as string;
    assert.ok(resumeResult.includes('resumed'));
    assert.equal(t.manager.get(auto.id)?.status, 'active');

    // Delete
    const deleteResult = (await t.tool.impl({ mode: 'delete', id: auto.id }, ctx)) as string;
    assert.ok(deleteResult.includes('deleted'));
    assert.equal(t.manager.get(auto.id), undefined);
  });
});

describe('Automation integration: turn-tail shows active automations', () => {
  test('list mode returns active automations', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'monitor deploy',
        prompt: 'check',
        schedule: { type: 'interval', seconds: 30 },
      },
      ctx,
    );
    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'monitor ci',
        prompt: 'check ci',
        schedule: { type: 'cron', expression: '*/5 * * * *' },
      },
      ctx,
    );

    const listResult = (await t.tool.impl({ mode: 'list' }, ctx)) as string;
    assert.ok(listResult.includes('monitor deploy'));
    assert.ok(listResult.includes('monitor ci'));
    assert.ok(listResult.includes('ACTIVE'));
  });

  test('list mode bounds app-global durable Automation output', async () => {
    const t = createIntegrationSetup();
    t.manager.hydrate(
      Array.from({ length: 101 }, (_, index) => ({
        id: `durable-${index}`,
        kind: 'cron' as const,
        name: `durable automation ${index}`,
        status: 'paused' as const,
        prompt: 'check',
        sessionId: `other-session-${index}`,
        schedule: { type: 'interval' as const, seconds: 60 },
        createdAt: index,
        updatedAt: index,
        nextFireAt: null,
        lastFireAt: null,
        lastRunId: null,
        fireCount: 0,
        maxFires: null,
        expiresAt: null,
        lastError: null,
        consecutiveFailures: 0,
        durable: true,
      })),
    );

    const result = (await t.tool.impl({ mode: 'list' }, t.ctx())) as string;
    assert.match(result, /durable automation 99/);
    assert.doesNotMatch(result, /durable automation 100/);
    assert.match(result, /1 additional automations omitted\./);
  });
});

describe('Automation integration: expired automations do not fire', () => {
  test('automation past expiresAt is swept and does not fire', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'short-lived',
        prompt: 'p',
        schedule: { type: 'interval', seconds: 3600 },
      },
      ctx,
    );

    const auto = t.manager.listForSession(SESSION_ID)[0];
    // Manually set expiry to 10s from now for testing
    auto.expiresAt = 1700000000000 + 10000;

    // Advance past expiry but before next fire
    t.advanceTime(11000);
    t.scheduler.start();
    await t.runTick();

    assert.equal(t.injectedTurns.length, 0);
    assert.equal(t.manager.get(auto.id)?.status, 'expired');
  });
});

describe('Automation integration: max_fires cap', () => {
  test('automation completes after reaching max_fires', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'limited',
        prompt: 'p',
        schedule: { type: 'interval', seconds: 10 },
        max_fires: 3,
      },
      ctx,
    );

    const auto = t.manager.listForSession(SESSION_ID)[0];
    t.scheduler.start();

    // Fire 1
    t.advanceTime(11000);
    await t.runTick();
    assert.equal(t.injectedTurns.length, 1);

    // Fire 2
    t.advanceTime(11000);
    await t.runTick();
    assert.equal(t.injectedTurns.length, 2);

    // Fire 3 (should complete)
    t.advanceTime(11000);
    await t.runTick();
    assert.equal(t.injectedTurns.length, 3);
    assert.equal(t.manager.get(auto.id)?.status, 'completed');

    // Fire 4 should NOT happen
    t.advanceTime(11000);
    await t.runTick();
    assert.equal(t.injectedTurns.length, 3);
  });
});

describe('Automation integration: consecutive failure auto-pause', () => {
  test('5 consecutive failures pauses the automation', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    await t.tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'fragile',
        prompt: 'p',
        schedule: { type: 'interval', seconds: 10 },
      },
      ctx,
    );

    const auto = t.manager.listForSession(SESSION_ID)[0];

    // Simulate 5 failed fires (started then failed).
    for (let i = 0; i < 5; i++) {
      t.manager.attemptStarted(auto.id);
      t.manager.attemptFailed(auto.id, `error ${i + 1}`);
    }

    assert.equal(t.manager.get(auto.id)?.status, 'paused');
    assert.equal(t.manager.get(auto.id)?.consecutiveFailures, 5);
    assert.equal(t.manager.get(auto.id)?.lastError, 'error 5');

    // Paused automation should not fire via scheduler
    t.advanceTime(11000);
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.injectedTurns.length, 0);
  });
});

describe('Automation integration: cron kind fires via createFreshRun', () => {
  test('cron automation calls createFreshRun, not injectTurn', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();

    await t.tool.impl(
      {
        mode: 'create',
        kind: 'cron',
        name: 'daily review',
        prompt: 'review PRs',
        schedule: { type: 'interval', seconds: 30 },
      },
      ctx,
    );

    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();

    assert.equal(t.injectedTurns.length, 0);
    assert.equal(t.freshRuns.length, 1);
    assert.equal(t.freshRuns[0].prompt, 'review PRs');
  });

  test('cron fire records lastRunId and stays active for a recurring schedule', async () => {
    const t = createIntegrationSetup();
    const ctx = t.ctx();
    await t.tool.impl(
      {
        mode: 'create',
        kind: 'cron',
        name: 'hourly',
        prompt: 'audit',
        schedule: { type: 'interval', seconds: 30 },
      },
      ctx,
    );
    const auto = t.manager.listForSession(SESSION_ID)[0];

    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();

    // createFreshRun mock returns { runId: `fresh-<id>`, ok: true }.
    assert.equal(t.manager.get(auto.id)?.lastRunId, `fresh-${auto.id}`);
    assert.equal(t.manager.get(auto.id)?.status, 'active'); // recurring, keeps going
    assert.equal(t.manager.get(auto.id)?.consecutiveFailures, 0);
  });
});

describe('Automation integration: cron gating by host capability', () => {
  test('cronEnabled:false rejects the cron kind at the schema', () => {
    const mgr = new AutomationManager({ generateId: () => 'g', now: () => 1 });
    const heartbeatOnly = buildAutomationTool({ automationManager: mgr, cronEnabled: false });
    const parsed = (
      heartbeatOnly.parameters as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      mode: 'create',
      kind: 'cron',
      name: 'x',
      prompt: 'p',
      schedule: { type: 'interval', seconds: 30 },
    });
    assert.equal(parsed.success, false); // cron not offered on this host
  });

  test('cronEnabled:true accepts the cron kind', () => {
    const mgr = new AutomationManager({ generateId: () => 'g', now: () => 1 });
    const withCron = buildAutomationTool({ automationManager: mgr, cronEnabled: true });
    const parsed = (
      withCron.parameters as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      mode: 'create',
      kind: 'cron',
      name: 'x',
      prompt: 'p',
      schedule: { type: 'interval', seconds: 30 },
    });
    assert.equal(parsed.success, true);
  });

  test('heartbeat is accepted regardless of cronEnabled', () => {
    const mgr = new AutomationManager({ generateId: () => 'g', now: () => 1 });
    const heartbeatOnly = buildAutomationTool({ automationManager: mgr, cronEnabled: false });
    const parsed = (
      heartbeatOnly.parameters as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      mode: 'create',
      kind: 'heartbeat',
      name: 'x',
      prompt: 'p',
      schedule: { type: 'interval', seconds: 30 },
    });
    assert.equal(parsed.success, true);
  });

  test('model schema accepts the legacy Unicode boundary and rejects larger text', () => {
    const mgr = new AutomationManager({ generateId: () => 'g', now: () => 1 });
    const tool = buildAutomationTool({ automationManager: mgr, cronEnabled: true });
    const schema = tool.parameters as { safeParse: (value: unknown) => { success: boolean } };
    const input = {
      mode: 'create',
      kind: 'heartbeat',
      name: '名'.repeat(100),
      prompt: '提'.repeat(2_000),
      schedule: { type: 'interval', seconds: 30 },
    };
    assert.equal(schema.safeParse(input).success, true);
    assert.equal(schema.safeParse({ ...input, name: '名'.repeat(101) }).success, false);
    assert.equal(schema.safeParse({ ...input, prompt: '提'.repeat(2_001) }).success, false);
  });
});
