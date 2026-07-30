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
    // Follow one level of `npm run <name>` so this stays a contract about what
    // the gate builds, not about whether the chain is spelled out inline. The
    // launch scripts share it through `build:with-deps` rather than repeating
    // it verbatim three times.
    const expand = (script: string) =>
      script.replace(/npm run ([\w:-]+)/g, (match, name: string) => scripts[name] ?? match);
    const script = expand(scripts['smoke:real-window'] ?? '');
    assert.match(script, /npm --workspace @maka\/core run build/);
    assert.match(script, /npm --workspace @maka\/storage run build/);
    assert.match(script, /npm --workspace @maka\/runtime run build/);
    assert.match(script, /npm --workspace @maka\/ui run build/);
    assert.match(script, /npm run build/);
    assert.match(script, /desktop-real-window-smoke\.mjs/);
    const programmaticScript = expand(scripts['smoke:programmatic-window'] ?? '');
    assert.match(programmaticScript, /desktop-real-window-smoke\.mjs --programmatic-only/);
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
    for (const id of REQUIRED_CHECK_IDS) {
      assert.match(src, new RegExp(`id:\\s*['"]${escapeRegExp(id)}['"]`));
    }
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
