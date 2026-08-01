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
  const chrome = await source('apps/desktop/src/renderer/app-shell-chrome-actions.tsx');
  const shellCss = await source('apps/desktop/src/renderer/styles/shell-layout.css');

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
  assert.doesNotMatch(navigation, /className="maka-nav-row/);
  assert.doesNotMatch(chrome, /<SideNavCollapseButton[^>]*\bsize=/);
  assert.equal(chrome.match(/size(?::|=)\s*(?:"md"|'md')/g)?.length, 4);
  assert.doesNotMatch(shellCss, /maka-shell-2col|maka-resize-handle|isResizingColumns/);
});

test('history and workbar use Astryx navigation taxonomy without shared wrappers', async () => {
  const history = await source('packages/ui/src/session-history-list.tsx');
  const workbar = await source('apps/desktop/src/renderer/session-workbar.tsx');

  assert.match(history, /@astryxdesign\/core\/List/);
  assert.match(history, /@astryxdesign\/core\/TreeList/);
  assert.doesNotMatch(history, /@base-ui\/react\/button/);
  assert.doesNotMatch(history, /querySelectorAll<HTMLButtonElement>\('\.maka-list-row-main'\)/);
  assert.match(history, /<ListItem[\s\S]*?onClick=\{isEditing \? undefined/);
  assert.match(history, /startContent=\{/);
  assert.match(history, /endContent=\{/);
  assert.match(history, /function sessionItem\(session: SessionSummary\): TreeListItemData/);
  assert.match(history, /onClick: isEditing[\s\S]*?props\.onSelectSession\(session\.id\)/);
  assert.doesNotMatch(history, /function ProjectSessionGroup/);
  assert.match(history, /const projectItem[\s\S]*?startContent:[\s\S]*?endContent:/);
  const renameExclusiveKeyHandlers = history.match(
    /onKeyDown=\{\(event\) => \{\s*event\.stopPropagation\(\);/g,
  );
  assert.equal(renameExclusiveKeyHandlers?.length, 2);
  assert.doesNotMatch(history, /onDoubleClick=/);
  assert.match(workbar, /@astryxdesign\/core\/Toolbar/);
  assert.match(workbar, /@astryxdesign\/core\/TabList/);
  assert.match(workbar, /<Toolbar/);
  assert.match(workbar, /<TabList/);
  assert.doesNotMatch(workbar, /PrimitiveTabs/);
});
