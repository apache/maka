import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const source = (path: string) => readFile(resolve(REPO_ROOT, path), 'utf8');

test('the desktop shell composes the official Astryx AppShell directly', async () => {
  const shell = await source('apps/desktop/src/renderer/app-shell.tsx');

  assert.match(shell, /AppShell as AstryxAppShell/);
  assert.match(shell, /<AstryxAppShell/);
  assert.match(shell, /variant="surface"/);
  assert.match(shell, /height="fill"/);
  assert.match(shell, /contentPadding=\{0\}/);
  assert.match(shell, /topNav=\{/);
  assert.match(shell, /sideNav=\{/);
  assert.doesNotMatch(shell, /maka-shell-2col/);
  assert.doesNotMatch(shell, /maka-resize-handle/);
});

test('the session sidebar delegates geometry and collapse to official SideNav', async () => {
  const panel = await source('packages/ui/src/session-list-panel.tsx');
  const navigation = await source('packages/ui/src/session-sidebar-nav.tsx');

  assert.match(panel, /@astryxdesign\/core\/SideNav/);
  assert.match(panel, /<SideNav/);
  assert.match(panel, /topContent=\{/);
  assert.match(panel, /footer=\{/);
  assert.match(panel, /collapsible=\{/);
  assert.match(panel, /resizable=\{/);
  assert.match(navigation, /SideNavItem/);
  assert.match(navigation, /size="md"/);
  assert.doesNotMatch(navigation, /BaseButton/);
  assert.doesNotMatch(navigation, /\bcva\b/);
});

test('history and workbar use Astryx navigation taxonomy without shared wrappers', async () => {
  const history = await source('packages/ui/src/session-history-list.tsx');
  const workbar = await source('apps/desktop/src/renderer/session-workbar.tsx');

  assert.match(history, /@astryxdesign\/core\/List/);
  assert.match(history, /@astryxdesign\/core\/TreeList/);
  const renameNavigationGuards = history.match(
    /\['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'\]\.includes\(event\.key\)\)\s*\{\s*event\.stopPropagation\(\);/g,
  );
  assert.equal(renameNavigationGuards?.length, 2);
  assert.match(workbar, /@astryxdesign\/core\/Toolbar/);
  assert.match(workbar, /@astryxdesign\/core\/TabList/);
  assert.match(workbar, /<Toolbar/);
  assert.match(workbar, /<TabList/);
  assert.doesNotMatch(workbar, /PrimitiveTabs/);
});
