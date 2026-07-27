import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = new URL('../../../../..', import.meta.url).pathname;

describe('session startup recovery contract', () => {
  it('runtime exposes interrupted-session recovery for persisted running turns', async () => {
    const src = await readFile(join(REPO_ROOT, 'packages/runtime/src/session-manager.ts'), 'utf8');

    assert.match(src, /async recoverInterruptedSessions\(\): Promise<string\[\]>/);
    assert.match(src, /session\.status !== 'archived'/);
    assert.match(src, /latest\.status === 'running'/);
    assert.match(src, /if \(recoveries\.length === 0\) continue;/);
    assert.match(src, /errorClass: 'app_restarted'/);
    assert.match(src, /session\.status === 'running' \|\| session\.status === 'waiting_for_user'/);
    assert.match(src, /latest\.status === 'completed' && !bucket\.hasAssistant && failed/);
  });

  it('desktop runs recovery during background startup with the active-run guard in place', async () => {
    // PR #456 moved recovery OFF the createWindow critical path so the
    // first paint is not blocked by ledger repair. That is only safe
    // because recovery skips any session with live runs
    // (runtimeKernel.hasActiveRuns) and repairs target PRIOR runs'
    // ledgers, so a user racing in a new message writes a different
    // runId. This contract pins all three legs: recovery still runs at
    // startup, it runs inside runBackgroundStartup (not before the
    // window), and the kernel guard that makes that safe stays put.
    // R6: the startup/lifecycle tail (whenReady flow + runBackgroundStartup +
    // recoverInterruptedSessionsOnStartup) moved to app-lifecycle.ts. Read the
    // combined main-process source so the ordering + recovery pins follow it.
    const src = await readMainProcessCombinedSource();
    const sessionManager = await readFile(join(REPO_ROOT, 'packages/runtime/src/session-manager.ts'), 'utf8');
    const backgroundBlock = src.match(/async function runBackgroundStartup\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(src, /async function recoverInterruptedSessionsOnStartup\(\): Promise<void>/);
    assert.match(backgroundBlock, /await recoverInterruptedSessionsOnStartup\(\);/, 'recovery must run inside background startup');
    assert.match(
      src,
      /const backgroundStartup = runBackgroundStartup\(\);[\s\S]*?await mainWindowController\.createWindow\(\);[\s\S]*?await backgroundStartup;/,
      'window creation must not wait on background startup, but the process must await it before settling',
    );
    assert.match(
      sessionManager,
      /if \(this\.runtimeKernel\.hasActiveRuns\(session\.id\)\) continue;/,
      'recovery must skip sessions with live runs — this guard is what makes background recovery safe',
    );
  });

  it('runs legacy project migration after first paint and keeps startup fail-soft', async () => {
    const src = await readMainProcessCombinedSource();
    const main = await readFile(join(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const backgroundBlock =
      src.match(/async function runBackgroundStartup\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0] ??
      '';
    const migration =
      src.match(
        /async function migrateSessionProjectsOnStartup\(\): Promise<void> \{[\s\S]*?\n  \}/,
      )?.[0] ?? '';

    assert.doesNotMatch(main, /^await migrateSessionProjects\(/m);
    assert.match(backgroundBlock, /await migrateSessionProjectsOnStartup\(\);/);
    assert.match(migration, /await runProjectStartupMigration\(/);
  });
});
