/**
 * End-to-end: durable cron persistence + cross-session query/management.
 *
 * Exercises the real host wiring against the operational SQLite authority,
 * simulating an app restart:
 *
 *   session A creates a durable cron ──sync──► runtime.sqlite
 *   (restart: a fresh wiring loads it) ◄──loadAll───────┘
 *   session B (never saw it) lists / pauses / resumes / deletes it
 *
 * This is the query-and-persistence loop the reviewer asked for: a persisted
 * cron is not just fireable after restart, it stays visible and manageable
 * from a brand-new session. Nothing here is mocked except the fire executors
 * (we assert on persisted state, not on runs).
 */

import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MakaToolContext, MakaTool } from '@maka/runtime';
import { createAutomationStore } from '@maka/storage';
import { createMainAutomationWiring } from '../automation-wiring.js';

function ctx(sessionId: string): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tc-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function makeWiring(workspaceRoot: string) {
  return createMainAutomationWiring({
    workspaceRoot,
    canFire: async () => true,
    injectTurn: async () => ({ runId: 'run', ok: true }),
    // Presence of createFreshRun is what advertises the cron kind to the tool.
    createFreshRun: async () => ({ runId: 'run', ok: true }),
  });
}

/** A cron-DISABLED host (heartbeat-only), like the `maka` CLI — no createFreshRun. */
function makeCronDisabledWiring(workspaceRoot: string) {
  return createMainAutomationWiring({
    workspaceRoot,
    canFire: async () => true,
    injectTurn: async () => ({ runId: 'run', ok: true }),
    // createFreshRun omitted → cron disabled → must not persist/adopt durable state.
  });
}

function automationTool(wiring: ReturnType<typeof makeWiring>): MakaTool {
  return wiring.tools[0];
}

async function readStore(workspaceRoot: string): Promise<Array<{ id: string; name: string }>> {
  return (await createAutomationStore(workspaceRoot).loadAll()).map(({ id, name }) => ({
    id,
    name,
  }));
}

/** Store sync is fire-and-forget; poll the authority until it settles. */
async function waitForStore(
  workspaceRoot: string,
  predicate: (rows: Array<{ id: string; name: string }>) => boolean,
  timeoutMs = 2000,
): Promise<Array<{ id: string; name: string }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readStore(workspaceRoot);
    if (predicate(rows)) return rows;
    if (Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('E2E: durable cron persistence + cross-session query/management', () => {
  let workspaceRoot: string;

  before(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-automation-e2e-'));
  });
  after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('a durable cron created in one session is queryable and manageable from a fresh session after restart', async () => {
    const SESSION_A = 'session-A-original';
    const SESSION_B = 'session-B-after-restart';

    // ── session A: create a durable cron via the real Automation tool ──────
    const wiring1 = makeWiring(workspaceRoot);
    const created = await automationTool(wiring1).impl({
      mode: 'create',
      kind: 'cron',
      name: 'nightly backup',
      prompt: 'run the nightly backup',
      schedule: { type: 'cron', expression: '0 3 * * *' },
    }, ctx(SESSION_A)) as string;
    assert.ok(created.includes('Automation created'), created);
    // cron defaults to durable, so it must be advertised as such.
    assert.ok(created.includes('durable'), created);

    // ── it reaches disk (persistence) ─────────────────────────────────────
    const persisted = await waitForStore(workspaceRoot, (rows) => rows.some((r) => r.name === 'nightly backup'));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].name, 'nightly backup');
    const cronId = persisted[0].id;

    // ── restart: a fresh wiring loads the persisted cron from disk ─────────
    const wiring2 = makeWiring(workspaceRoot);
    await wiring2.loadDurableAutomations();

    // ── session B (never saw the cron): query it ──────────────────────────
    const listed = await automationTool(wiring2).impl({ mode: 'list' }, ctx(SESSION_B)) as string;
    assert.ok(listed.includes('nightly backup'), `session B should see the persisted cron:\n${listed}`);
    assert.ok(listed.includes(cronId), listed);

    // ── session B: manage it (pause → resume → delete) ────────────────────
    const paused = await automationTool(wiring2).impl({ mode: 'pause', id: cronId }, ctx(SESSION_B)) as string;
    assert.ok(paused.includes('paused'), paused);
    assert.equal(wiring2.manager.get(cronId)?.status, 'paused');

    const resumed = await automationTool(wiring2).impl({ mode: 'resume', id: cronId }, ctx(SESSION_B)) as string;
    assert.ok(resumed.includes('resumed'), resumed);
    assert.equal(wiring2.manager.get(cronId)?.status, 'active');

    const deleted = await automationTool(wiring2).impl({ mode: 'delete', id: cronId }, ctx(SESSION_B)) as string;
    assert.ok(deleted.toLowerCase().includes('delet'), deleted);
    assert.equal(wiring2.manager.get(cronId), undefined);

    // ── the deletion is durable too: disk no longer holds it ──────────────
    const afterDelete = await waitForStore(workspaceRoot, (rows) => rows.every((r) => r.id !== cronId));
    assert.ok(afterDelete.every((r) => r.id !== cronId), 'deleted cron must be gone from disk');

    wiring1.scheduler.dispose();
    wiring2.scheduler.dispose();
  });

  it('a non-durable heartbeat does NOT leak into another session and is not persisted', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'maka-automation-e2e-hb-'));
    try {
      const wiring = makeWiring(ws);
      const created = await automationTool(wiring).impl({
        mode: 'create',
        kind: 'heartbeat',
        name: 'poll status',
        prompt: 'check status',
        schedule: { type: 'interval', seconds: 60 },
      }, ctx('owner-session')) as string;
      assert.ok(created.includes('Automation created'), created);

      // A different session cannot see or manage the session-private heartbeat.
      const listedElsewhere = await automationTool(wiring).impl({ mode: 'list' }, ctx('stranger-session')) as string;
      assert.ok(listedElsewhere.includes('No automations'), listedElsewhere);

      // And it never hits disk (non-durable).
      const rows = await waitForStore(ws, () => false, 300); // give sync a chance, expect empty
      assert.equal(rows.length, 0, 'a non-durable heartbeat must not be persisted');

      wiring.scheduler.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('E2E: a cron-disabled host (CLI) sharing the workspace never clobbers durable crons', () => {
  it('a heartbeat-only wiring neither loads nor overwrites durable Automations', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'maka-automation-clobber-'));
    try {
      // ── owner (cron-enabled, desktop) creates a durable cron ──────────────
      const owner = makeWiring(ws);
      await automationTool(owner).impl({
        mode: 'create', kind: 'cron', name: 'daily backup', prompt: 'back up',
        schedule: { type: 'cron', expression: '0 3 * * *' },
      }, ctx('desktop-session')) as string;
      const persisted = await waitForStore(ws, (rows) => rows.some(r => r.name === 'daily backup'));
      assert.equal(persisted.length, 1);
      owner.scheduler.dispose();

      // ── a cron-disabled host (CLI) boots on the SAME workspace ────────────
      const cli = makeCronDisabledWiring(ws);
      // It must not adopt the cron it cannot run.
      await cli.loadDurableAutomations();
      assert.equal(cli.manager.listAll().length, 0, 'cron-disabled host must not load crons it cannot run');

      // It creates a heartbeat and manages it — all the activity that would
      // trigger a durable sync on a cron-enabled host.
      await automationTool(cli).impl({
        mode: 'create', kind: 'heartbeat', name: 'poll', prompt: 'p',
        schedule: { type: 'interval', seconds: 60 },
      }, ctx('cli-session')) as string;
      const listed = await automationTool(cli).impl({ mode: 'list' }, ctx('cli-session')) as string;
      const idMatch = listed.match(/ID: ([a-f0-9-]+)/i);
      if (idMatch) await automationTool(cli).impl({ mode: 'delete', id: idMatch[1] }, ctx('cli-session')) as string;

      // Give any (erroneous) sync a chance to land, then assert the owner's cron
      // is STILL on disk, untouched.
      await new Promise(r => setTimeout(r, 200));
      const after = await readStore(ws);
      assert.deepEqual(after.map(r => r.name), ['daily backup'], 'CLI must not overwrite/erase the desktop\'s durable cron');
      cli.scheduler.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
