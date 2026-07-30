import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');
const APP_SHELL_PATH = resolve(RENDERER_ROOT, 'app-shell.tsx');
const APP_SHELL_OVERLAYS_PATH = resolve(RENDERER_ROOT, 'app-shell-overlays.tsx');
const MODULE_PAGES_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'module-pages.tsx');

describe('renderer lazy fallback contract', () => {
  it('keeps visible shell lazy chunks on compact non-null fallbacks', async () => {
    const appShell = await readFile(APP_SHELL_PATH, 'utf8');
    const overlays = await readFile(APP_SHELL_OVERLAYS_PATH, 'utf8');
    const chatWorkbar = await readFile(resolve(RENDERER_ROOT, 'chat-workbar.tsx'), 'utf8');

    assert.match(overlays, /function SettingsModalFallback/, 'Settings modal must reserve a loading shell');
    assert.match(overlays, /<Suspense fallback=\{<SettingsModalFallback \/>\}>/);
    assert.doesNotMatch(overlays, /settingsOpen[\s\S]{0,120}<Suspense fallback=\{null\}>/);

    assert.match(chatWorkbar, /function SessionWorkbarFallback/, 'Session workbar must reserve a loading shell');
    assert.match(
      appShell,
      /navSelection\.section === 'sessions' && activeId && !workbarCollapsed && \([\s\S]*?<ChatWorkbar/,
      'The persisted shell-owned workbar state makes its visible fallback deterministic',
    );
    assert.match(
      chatWorkbar,
      /<Suspense fallback=\{<SessionWorkbarFallback \/>\}>[\s\S]*?<SessionWorkbar[\s\S]*?<\/Suspense>/,
      'The persisted shell-owned workbar state makes its visible fallback deterministic',
    );
    assert.match(chatWorkbar, /<Suspense fallback=\{<SessionWorkbarFallback \/>\}>/);
  });

  it('keeps module lazy chunks on compact non-null fallbacks', async () => {
    const modulePages = await readFile(MODULE_PAGES_PATH, 'utf8');

    assert.match(modulePages, /function ModulePageFallback/, 'whole-page modules must reserve a module loading shell');
    assert.match(modulePages, /function ModulePanelFallback/, 'daily review content must reserve a panel loading shell');
    assert.match(modulePages, /<Suspense fallback=\{<ModulePageFallback label=\{props\.hubHeader\?\.title \?\? copy\.skills\} message=\{copy\.loadingSkills\} \/>\}>/);
    assert.match(modulePages, /<Suspense fallback=\{<ModulePageFallback label=\{props\.hubHeader\?\.title \?\? copy\.automations\} message=\{copy\.loadingAutomations\} \/>\}>/);
    assert.match(modulePages, /<Suspense fallback=\{<ModulePanelFallback message=\{copy\.loadingDailyReview\} \/>\}>/);
    assert.doesNotMatch(modulePages, /<Suspense fallback=\{null\}>/);
  });
});
