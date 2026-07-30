/**
 * The recent Sidebar work exposed failures that screenshot capture and
 * grep-style CSS tests could not prove: real macOS edge/corner resize,
 * titlebar drag, modal focus cycle, and renderer ErrorBoundary state.
 * This test pins the human-in-the-loop real Electron smoke gate so it
 * cannot silently disappear from package scripts or lose the checks that
 * WAWQAQ had to catch manually.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const DESKTOP_PACKAGE_JSON = join(process.cwd(), 'package.json');
const ROOT_PACKAGE_JSON = join(process.cwd(), '..', '..', 'package.json');
const REAL_WINDOW_SMOKE_SCRIPT = join(process.cwd(), '..', '..', 'scripts', 'desktop-real-window-smoke.mjs');
const SMOKE_DOC = join(process.cwd(), 'tests', 'smoke.md');

/**
 * The accessibility-independent layer. These were unpinned while the OS
 * hit-test ids below were pinned, so any of them could be deleted with the
 * suite staying green — including `programmatic-dock-visible`, which is the
 * only check anywhere that exercises the dock rule against a real launch.
 */
const REQUIRED_PROGRAMMATIC_CHECK_IDS = [
  'programmatic-window-visible',
  'programmatic-window-flags',
  'programmatic-renderer-mounted',
  'programmatic-search-modal-open',
  'programmatic-focus-target',
  'programmatic-no-error-boundary',
  'programmatic-dock-visible',
];

const REQUIRED_CHECK_IDS = [
  'launch-clean-window',
  'resize-left-edge',
  'resize-right-edge',
  'resize-top-edge',
  'resize-bottom-edge',
  'resize-corners',
  'titlebar-drag',
  'controls-no-drag',
  'search-modal-cycle',
  'keyboard-path',
  'modal-resize-hit-area',
  'renderer-health',
];

describe('real Electron window smoke gate', () => {
  it('desktop package exposes `smoke:real-window` and builds core/ui/desktop first', async () => {
    const pkg = JSON.parse(await readFile(DESKTOP_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    // One place defines what a launch builds; every launcher points at it.
    // Asserting the chain here and the reference below keeps this a contract
    // about what gets built without re-stating the chain per launcher — which
    // is what let `e2e` drift into repeating it verbatim.
    const chain = scripts['build:with-deps'] ?? '';
    assert.match(chain, /npm --workspace @maka\/core run build/);
    assert.match(chain, /npm --workspace @maka\/storage run build/);
    assert.match(chain, /npm --workspace @maka\/runtime run build/);
    assert.match(chain, /npm --workspace @maka\/ui run build/);
    assert.match(chain, /&& npm run build$/, 'the chain must end by building the desktop app itself');
    for (const launcher of ['smoke:real-window', 'smoke:programmatic-window', 'launch:fixture', 'e2e']) {
      assert.match(
        scripts[launcher] ?? '',
        /npm run build:with-deps &&/,
        `${launcher} must build through the shared chain, so a reviewer can never smoke a stale dist`,
      );
    }
    assert.match(scripts['smoke:real-window'] ?? '', /desktop-real-window-smoke\.mjs/);
    assert.match(
      scripts['smoke:programmatic-window'] ?? '',
      /desktop-real-window-smoke\.mjs --programmatic-only/,
    );
    assert.match(scripts['launch:fixture'] ?? '', /desktop-real-window-smoke\.mjs --manual/);
  });

  it('root dev scripts keep fast HMR and full build launch paths explicit', async () => {
    const pkg = JSON.parse(await readFile(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.match(
      pkg.scripts?.dev ?? '',
      /npm --workspace @maka\/desktop run dev:hmr --/,
      'root dev should keep the fast HMR path explicit',
    );
    assert.match(
      pkg.scripts?.['dev:full'] ?? '',
      /npm run build && npm --workspace @maka\/desktop run start/,
      'root dev:full must build workspaces before starting Electron so reviewers do not smoke stale dist',
    );
  });

  it('real-window smoke script contains the required native-window checks', async () => {
    const src = await readFile(REAL_WINDOW_SMOKE_SCRIPT, 'utf8');
    for (const id of [...REQUIRED_CHECK_IDS, ...REQUIRED_PROGRAMMATIC_CHECK_IDS]) {
      assert.match(src, new RegExp(`id:\\s*['"]${escapeRegExp(id)}['"]`));
    }
    assert.match(
      src,
      /showWindow:\s*true/,
      'the programmatic layer must launch a window it can actually see; without this the visibility and focus checks assert against a window that was never mapped',
    );
    assert.match(
      src,
      /buildFixtureEnv\(/,
      'the smoke gate launches through the shared environment builder, so it cannot inherit VITE_DEV_SERVER_URL or the real $HOME',
    );
    assert.match(src, /--user-data-dir=/, 'real-window smoke must isolate Electron user data');
    assert.match(src, /MAKA_E2E_FIXTURE/, 'real-window smoke must launch a deterministic fixture');
    assert.match(src, /cleanupStaleElectronProcesses/, 'real-window smoke must clean/report stale Electron smoke processes');
    assert.match(src, /electronPid/, 'real-window smoke report must record the launched Electron pid');
    assert.match(src, /Launch command/, 'real-window smoke report must record the launch command');
    assert.match(src, /UNVERIFIED/, 'real-window smoke must distinguish environment/accessibility unverifiable runs from product failures');
    assert.match(src, /--fail-note/, 'real-window smoke must support durable fail reports when the live window cannot be verified');
    assert.match(src, /--diagnostic-wait-ms/, 'real-window smoke must wait briefly for settled BrowserWindow diagnostics');
    assert.match(
      src,
      /DEFAULT_DIAGNOSTIC_WAIT_MS\s*=\s*3500/,
      'programmatic smoke must wait long enough to capture the settled renderer diagnostic, not only after-load',
    );
    assert.match(
      src,
      /activeElementInSearchModal/,
      'programmatic focus check must verify focus is trapped structurally inside the search modal (any interactive control), not by a brittle class on the focused element',
    );
    assert.match(src, /Window diagnostics/, 'real-window smoke report must include BrowserWindow/renderer diagnostics when available');
    assert.match(src, /PROGRAMMATIC_SMOKE_CHECKS/, 'real-window smoke must include an accessibility-independent programmatic BrowserWindow/renderer layer');
    assert.match(src, /os-hit-test/, 'real-window smoke must keep OS hit-test checks distinct from programmatic checks');
    assert.match(src, /Layer Summary/, 'real-window smoke report must summarize programmatic and OS hit-test layers separately');
    assert.match(src, /apps\/desktop\/tests\/real-window-smoke/, 'real-window smoke must write durable reports');
  });

  it('smoke.md documents that real-window smoke is required for shell/modal PRs', async () => {
    const doc = await readFile(SMOKE_DOC, 'utf8');
    assert.match(doc, /Real Electron window smoke/);
    assert.match(doc, /npm --workspace @maka\/desktop run smoke:real-window/);
    assert.match(doc, /four corners resizes diagonally/);
    assert.match(doc, /Search modal opens and closes/);
    assert.match(doc, /UI-shell PR.*not ready\s+to merge/s);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
