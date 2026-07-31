import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';
import { readRendererContractCss } from './contract-css-helpers.js';

describe('session workbar contract', () => {
  it('owns three stable peer tabs and disables Browser without a live view', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/session-workbar.tsx'), 'utf8');

    assert.match(source, /value="tasks"[\s\S]*?>[\s\S]*\{copy\.tasks\}/);
    assert.match(source, /value="browser"[\s\S]*disabled=\{!props\.browserLive\}[\s\S]*?>[\s\S]*\{copy\.browser\}/);
    assert.match(source, /value="files"[\s\S]*?>[\s\S]*\{copy\.files\}/);
    assert.match(source, /<TaskLedgerPanel\b/);
    assert.match(source, /<BrowserPanel\b/);
    assert.match(source, /<ArtifactPane\b/);
    assert.doesNotMatch(source, /browserLive \? 1 : 0/, 'Browser availability must not masquerade as an item count');
  });

  it('is the only shell owner of tasks, browser, and files', async () => {
    const [appShell, chatView, chatWorkbar] = await Promise.all([
      readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/app-shell.tsx'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-view.tsx'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/chat-workbar.tsx'), 'utf8'),
    ]);

    assert.match(chatWorkbar, /<SessionWorkbar\b/);
    assert.doesNotMatch(appShell, /<BrowserPanel\b/);
    assert.doesNotMatch(appShell, /<ArtifactPane\b/);
    assert.doesNotMatch(chatView, /<TaskLedgerPanel\b/);
  });

  it('loads task data only with the lazy workbar', async () => {
    const [appShell, workbar] = await Promise.all([
      readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/app-shell.tsx'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/session-workbar.tsx'), 'utf8'),
    ]);

    assert.doesNotMatch(appShell, /useSessionTasks/);
    assert.match(workbar, /useSessionTasks\(props\.sessionId\)/);
  });

  it('only renders beside an active session inside the sessions module', async () => {
    const appShell = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/app-shell.tsx'), 'utf8');

    assert.match(
      appShell,
      /navSelection\.section === 'sessions' && activeId && !workbarCollapsed/,
      'module pages must not inherit the active session workbar',
    );
  });

  // "workbar tabs must not sit underneath the top-right workspace actions" used
  // to be checked here as `padding-top: var(--h-titlebar)` on
  // `.maka-session-workbar`. The workspace actions were absolutely positioned
  // over the detail panel then, so every surface underneath had to reserve their
  // height. They are now an in-flow cluster of the shell's titlebar row and the
  // workbar is in the content row, so the two cannot overlap — the invariant
  // holds by construction and the padding it needed is gone.
  // `window-titlebar-contract.test.ts` asserts that no surface reserves the
  // titlebar height again, which is what would break this.
});
