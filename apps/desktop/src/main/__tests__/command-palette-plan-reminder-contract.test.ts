import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('command palette plan reminder contract', () => {
  it('exposes a direct action for starting a new plan reminder', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette-commands.ts'), 'utf8');
    const catalog = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/locales/shell-copy.ts'), 'utf8');

    assert.match(src, /onStartPlanReminder\?\(\): void/);
    assert.match(src, /id:\s*'action:new-plan-reminder'/);
    assert.match(src, /staticCopy\('action:new-plan-reminder'\)/);
    assert.match(catalog, /label: '新建计划提醒'/);
    assert.match(catalog, /label: 'New plan reminder'/);
    assert.match(src, /run:\s*args\.onStartPlanReminder/);
  });

  it('routes a create request into the shipped dialog and focuses the title field', async () => {
    const main = await readRendererShellCombinedSource();
    // Issue #1044: the form (and its title input) lives in the extracted
    // PlanReminderFormDialog; the focus hook marker moved with it.
    const dialog = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-form-dialog.tsx'), 'utf8');

    assert.match(main, /function\s+openPlanReminderForm\(\)/);
    assert.match(main, /setNavSelection\(\{\s*section:\s*'automations',\s*module:\s*'plan-reminders'\s*\}\)/);
    assert.match(main, /setPlanReminderCreateRequestNonce\(\(nonce\) => nonce \+ 1\)/);
    assert.match(main, /createRequestNonce=\{planReminderCreateRequestNonce\}/);
    // #1045: run() reads openPlanReminderForm from the live options ref.
    assert.match(main, /onStartPlanReminder:\s*\(\)\s*=>\s*optionsRef\.current\.openPlanReminderForm\(\)/);
    assert.match(dialog, /data-maka-plan-title-input="true"/);
    assert.match(dialog, /autoFocus/);
  });
});
