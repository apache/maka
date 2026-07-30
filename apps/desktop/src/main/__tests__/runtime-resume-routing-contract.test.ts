import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('runtime resume desktop routing contract', () => {
  it('renderer routes interrupted-banner resume and reports parked diagnostics', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    // R2: the resume cluster (state + resumeInterruptedSession handler) moved out of
    // app-shell.tsx into use-shell-resume.ts (use-shell-connections house style). The
    // handler-shape assertions read the hook file; app-shell keeps the sendWithAttachments
    // guard and the banner `safeResumeAction=` wiring.
    const resume = await readRendererShellSource('use-shell-resume.ts');
    const send = shell.match(/async function sendWithAttachments\(text: string\): Promise<boolean \| void> \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.doesNotMatch(send, /text\.trim\(\) === '\/resume'/);
    assert.match(resume, /async function resumeInterruptedSession\(\)/);
    assert.match(resume, /window\.maka\.sessions\.resumeLatest\(sessionId\)/);
    assert.match(resume, /resumeParkToastCopy\(result\.rejectionReasons\)/);
    assert.doesNotMatch(resume, /result\.rejectionReasons\.join/);
    assert.match(shell, /safeResumeAction=/);

    const turn = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-turn.tsx'), 'utf8');
    assert.match(turn, /safeResumeAction/);
    assert.match(turn, /maka-turn-failed-resume/);
    assert.match(turn, /copy\.safeResumePending/);
    assert.match(turn, /copy\.safeResume/);
  });

  it('main plans from authoritative state and streams only an approved latest continuation', async () => {
    const main = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/main/session-execution-ipc-main.ts'),
      'utf8',
    );
    const handler =
      main.match(/deps\.ipcMain\.handle\('sessions:resumeLatest'[\s\S]*?\n  \}\);/)?.[0] ?? '';

    assert.match(
      handler,
      /deps\.runtime\.planLatestAuthoritativeSafeBoundaryContinuation\(sessionId\)/,
    );
    assert.match(handler, /if \(!plan\.continuation\)/);
    assert.match(handler, /deps\.runtime\.resumeSafeBoundaryContinuation\(plan\.continuation\)/);
    assert.match(handler, /deps\.streamEvents\(sessionId, iterator, \{/);
    assert.match(handler, /turnId: plan\.continuation\.turnId/);
  });

  it('preload exposes resumeLatest without accepting renderer safety facts', async () => {
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const resume = preload.match(/resumeLatest\(sessionId: string\)[\s\S]*?\n    \}/)?.[0] ?? '';

    assert.match(resume, /ipcRenderer\.invoke\('sessions:resumeLatest', sessionId\)/);
    assert.doesNotMatch(resume, /workspace|tool|background|checkpoint/i);
  });

  it('startup recovery auto-continues only behind the safe-boundary feature flag', async () => {
    // R6: recoverInterruptedSessionsOnStartup moved to app-lifecycle.ts (nested
    // in wireAppLifecycle), so read the combined source and tolerate the now
    // in-function indented block closer.
    const main = await readMainProcessCombinedSource();
    const recovery = main.match(/async function recoverInterruptedSessionsOnStartup\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(recovery, /MAKA_RUNTIME_SAFE_BOUNDARY_RESUME !== '1'/);
    assert.match(
      recovery,
      /resumeSafeBoundaryContinuationsOnStartup\(runtime, streamEvents, console\.error\)/,
    );
  });
});
