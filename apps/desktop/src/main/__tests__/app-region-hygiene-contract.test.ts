/**
 * App-region hygiene for the frameless Electron shell.
 *
 * `.maka-window-titlebar` is the only `-webkit-app-region: drag` surface — a
 * transparent absolute overlay so column surfaces paint to the window top;
 * action clusters carve themselves out with `no-drag`. Live rendered-geometry
 * checks stay in e2e/window-titlebar.spec.ts (Playwright cannot exercise the OS
 * hit test). These contracts pin the declarations that used to be only assumed
 * by comments in main-window.ts — scoped to each rule body, not a cross-`}` scan.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  readAllRendererCss,
  stripCssComments,
  assertCssRuleDecls,
} from './css-test-helpers.js';

const SHELL_LAYOUT = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/shell-layout.css');
const WINDOW_STATE = resolve(REPO_ROOT, 'apps/desktop/src/main/window-state.ts');
const MAIN_WINDOW = resolve(REPO_ROOT, 'apps/desktop/src/main/main-window.ts');

describe('app-region hygiene', () => {
  it('keeps drag exclusive to the window titlebar and carves action clusters with no-drag', async () => {
    const allCss = stripCssComments(await readAllRendererCss());
    const dragMatches = [...allCss.matchAll(/-webkit-app-region:\s*drag/g)];
    assert.equal(
      dragMatches.length,
      1,
      `exactly one -webkit-app-region: drag declaration expected; found ${dragMatches.length}`,
    );

    const shell = stripCssComments(await readFile(SHELL_LAYOUT, 'utf8'));
    assertCssRuleDecls(
      shell,
      '.maka-window-titlebar',
      [
        /-webkit-app-region:\s*drag/,
        /position:\s*absolute/,
        /background:\s*transparent/,
        /height:\s*calc\(\s*var\(--h-titlebar\)\s*-\s*var\(--maka-window-resize-edge\)\s*\)/,
        /top:\s*var\(--maka-window-resize-edge\)/,
        /left:\s*var\(--maka-window-resize-edge\)/,
        /right:\s*var\(--maka-window-resize-edge\)/,
      ],
      'titlebar must be a transparent absolute drag overlay with resize-edge insets',
    );
    assertCssRuleDecls(
      shell,
      '.maka-shell-topbar-rail',
      [/-webkit-app-region:\s*no-drag/],
      'left titlebar rail must carve no-drag',
    );
    assertCssRuleDecls(
      shell,
      '.maka-workspace-top-actions',
      [/-webkit-app-region:\s*no-drag/],
      'workspace action cluster must carve no-drag',
    );
  });

  it('keeps sanitizeBounds floors and BrowserWindow minHeight aligned', async () => {
    // Product truth today: SAFE_MIN_WIDTH is a restore/fixture floor in
    // window-state.ts; BrowserWindow only sets minHeight (not minWidth).
    // Do not claim a runtime width floor that is not wired.
    const windowState = await readFile(WINDOW_STATE, 'utf8');
    const mainWindow = await readFile(MAIN_WINDOW, 'utf8');
    assert.match(windowState, /export const SAFE_MIN_WIDTH = 480;/);
    assert.match(windowState, /export const SAFE_MIN_HEIGHT = 320;/);
    assert.match(
      mainWindow,
      /minHeight:\s*SAFE_MIN_HEIGHT/,
      'BrowserWindow minHeight must share SAFE_MIN_HEIGHT with sanitizeBounds',
    );
    assert.doesNotMatch(
      mainWindow,
      /minWidth:\s*SAFE_MIN_WIDTH/,
      'runtime minWidth is intentionally unset; restore floor is SAFE_MIN_WIDTH only',
    );
    assert.match(mainWindow, /resizable:\s*true/, 'window must stay explicitly resizable');
  });

  it('keeps native titleBarOverlay height aligned with --h-titlebar', async () => {
    const tokens = stripCssComments(
      await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/maka-tokens.css'), 'utf8'),
    );
    const mainWindow = await readFile(MAIN_WINDOW, 'utf8');
    assert.match(tokens, /--h-titlebar:\s*36px;/);
    assert.match(
      mainWindow,
      /const TITLEBAR_OVERLAY_HEIGHT = 36;/,
      'titleBarOverlay height must match --h-titlebar: 36px',
    );
  });
});
