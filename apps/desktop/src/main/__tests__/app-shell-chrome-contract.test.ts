import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');
const SESSION_LIST_PANEL_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'session-list-panel.tsx');

describe('app shell chrome contract', () => {
  it('keeps shell chrome and workspace actions split out of app-shell', async () => {
    const appShell = await readFile(resolve(RENDERER_ROOT, 'app-shell.tsx'), 'utf8');
    const chromeActions = await readFile(resolve(RENDERER_ROOT, 'app-shell-chrome-actions.tsx'), 'utf8');
    const combined = await readRendererShellCombinedSource();

    assert.match(appShell, /from '\.\/app-shell-chrome-actions'/, 'app-shell.tsx must import shell chrome actions');
    assert.match(appShell, /<AppShellTopbarActions\b/, 'app-shell.tsx must render shell-level chrome through AppShellTopbarActions');
    assert.match(appShell, /<AppShellWorkspaceTopActions\b/, 'app-shell.tsx must render workspace chrome through AppShellWorkspaceTopActions');

    assert.doesNotMatch(appShell, /className="maka-shell-topbar-rail"/, 'app-shell.tsx should not own shell chrome DOM details');
    assert.doesNotMatch(appShell, /className="maka-workspace-top-actions"/, 'app-shell.tsx should not own workspace chrome DOM details');

    assert.match(chromeActions, /export function AppShellTopbarActions/, 'chrome actions source must define shell topbar chrome');
    assert.match(chromeActions, /export function AppShellWorkspaceTopActions/, 'chrome actions source must define workspace actions chrome');
    assert.match(combined, /maka-shell-topbar-rail/, 'renderer shell sources must still define shell topbar chrome');
    assert.match(combined, /className="maka-workspace-top-actions"/, 'renderer shell sources must still define workspace actions chrome');
  });

  it('keeps sidebar expand and collapse actions in the same shell rail', async () => {
    const combined = await readRendererShellCombinedSource();
    const sessionListPanel = await readFile(SESSION_LIST_PANEL_PATH, 'utf8');

    // `is-collapsed` / `is-expanded` used to be asserted here. They were written
    // into the DOM but no CSS ever read them once the rail stopped being
    // absolutely positioned, so the assertion pinned a dead string. The three
    // checks below cover what this test is actually about.
    assert.match(combined, /PanelLeftClose/, 'expanded shell rail must expose collapse action');
    assert.match(combined, /PanelLeftOpen/, 'collapsed shell rail must expose expand action');
    assert.match(combined, /\{props\.sidebarCollapsed && \(/, 'new-session action should stay collapsed-only');

    assert.doesNotMatch(
      sessionListPanel,
      /className="maka-sidebar-search-button"/,
      'sidebar should not own a separate search button with different geometry',
    );
    assert.doesNotMatch(
      sessionListPanel,
      /className="maka-sidebar-toggle"/,
      'sidebar should not own a separate collapse button with different geometry',
    );
  });

  it('exposes the session workbar toggle in the top-right workspace actions', async () => {
    const combined = await readRendererShellCombinedSource();
    const catalog = await readFile(resolve(RENDERER_ROOT, 'locales', 'shell-copy.ts'), 'utf8');

    assert.match(combined, /PanelRightClose/, 'expanded workbar must expose its collapse action');
    assert.match(combined, /PanelRightOpen/, 'collapsed workbar must expose its expand action');
    assert.match(combined, /copy\.expandWorkbar/);
    assert.match(combined, /copy\.collapseWorkbar/);
    assert.match(catalog, /expandWorkbar: '展开会话工作栏'/);
    assert.match(catalog, /expandWorkbar: 'Expand conversation workbar'/);
    assert.match(combined, /label=\{workbarLabel\}/);
  });

  it('renders the workbar toggle only when a session is active', async () => {
    const combined = await readRendererShellCombinedSource();

    // The toggle used to render disabled on module pages (MCP / skills / …)
    // where no workbar exists — a dead button in the topbar. It now
    // unmounts entirely when unavailable.
    assert.match(combined, /workbarAvailable: boolean/);
    assert.match(combined, /\{props\.workbarAvailable && \([\s\S]*?onClick=\{props\.onToggleWorkbar\}/);
    assert.doesNotMatch(combined, /disabled=\{!props\.workbarAvailable\}/);
    assert.match(combined, /aria-expanded=\{!props\.workbarCollapsed\}/);
  });
});
