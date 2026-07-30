/**
 * Static-analysis contract test for ALL renderer modals
 * (PR-MODAL-LIFECYCLE-0, kenji boundary 2 from
 * the modal lifecycle audit).
 *
 * Background: WAWQAQ hit React #310 (rules-of-hooks) in
 * SearchModal because hooks sat BEFORE an `if (!open) return null`
 * early return. The fixup matched KeyboardHelpModal's
 * conditional-mount pattern: parent mounts via
 * `{open && <Modal onClose={...} />}` and the modal itself takes
 * `onClose` (no `open` prop, no internal early return).
 *
 * This file extends the SearchModal-specific gate to ALL modals so
 * the same foot-gun cannot re-introduce itself in SettingsModal,
 * CommandPalette, or KeyboardHelpModal. In-flow composer interactions are not
 * modals. If a new modal lands, add it to MODAL_DECLS below.
 *
 * Grep-style gate; no React mount required.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

interface ModalDecl {
  /** Component name as it appears in JSX (`<Foo>`). */
  name: string;
  /** Path to the file that exports the component. */
  source: string;
  /** Regex matching the parent-side `{flag && <Name ...>}` mount in the renderer shell. */
  parentMountPattern: RegExp;
}

const MODAL_DECLS: readonly ModalDecl[] = [
  {
    name: 'SearchModal',
    source: join(REPO_ROOT, 'packages', 'ui', 'src', 'search-modal.tsx'),
    parentMountPattern: /\{searchModalOpen\s*&&\s*\(?\s*<SearchModal\s+on[A-Z]/,
  },
  {
    name: 'KeyboardHelpModal',
    source: join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'keyboard-help.tsx'),
    parentMountPattern: /\{helpOpen\s*&&\s*<KeyboardHelpModal\s+onClose=/,
  },
  {
    name: 'SettingsModal',
    source: join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings', 'SettingsModal.tsx'),
    // The renderer wraps the lazy-loaded SettingsModal in <Suspense> so the
    // settings chunk stays out of the initial bundle. The lifecycle contract
    // (parent owns the mount via `{settingsOpen && ...}`, no `open=` prop)
    // is unchanged, so the pattern tolerates an optional Suspense boundary.
    parentMountPattern: /\{settingsOpen\s*&&\s*\(?\s*<Suspense\b[\s\S]*?<SettingsModal[\s\S]*?<\/Suspense>/,
  },
  {
    name: 'CommandPalette',
    source: join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'command-palette.tsx'),
    parentMountPattern: /\{paletteOpen\s*&&\s*\(?\s*<CommandPalette/,
  },
];

describe('modal lifecycle contract (PR-MODAL-LIFECYCLE-0)', () => {
  for (const modal of MODAL_DECLS) {
    describe(modal.name, () => {
      it('signature takes no `open` prop (parent owns lifecycle)', async () => {
        const src = await readFile(modal.source, 'utf8');
        const match = src.match(
          new RegExp(`export function ${modal.name}\\s*\\(\\s*props\\s*:\\s*\\{([^}]+)\\}`),
        );
        assert.ok(match, `${modal.name} export must exist with destructured props`);
        const propBlock = match[1]!;
        assert.doesNotMatch(
          propBlock,
          /\bopen\s*:/,
          `${modal.name} must NOT take an \`open\` prop — parent uses conditional mount`,
        );
      });

      it('body has NO `if (!props.open) return null` early return', async () => {
        const src = await readFile(modal.source, 'utf8');
        const startIdx = src.indexOf(`export function ${modal.name}`);
        assert.notEqual(startIdx, -1);
        const bodyStart = src.indexOf('{', startIdx);
        const after = src.slice(bodyStart);
        // Find the next top-level `\n}` that ends the function. Naive
        // but sufficient for the flat top-level functions we audit.
        const closingIdx = after.search(/\n\}\n/);
        assert.notEqual(closingIdx, -1);
        const body = after.slice(0, closingIdx);
        assert.doesNotMatch(
          body,
          /if\s*\(\s*!props\.open\s*\)\s*return\s*null/,
          `${modal.name} body must NOT contain \`if (!props.open) return null\` — that re-introduces the hooks-before-early-return foot-gun`,
        );
      });

      it('renderer shell mounts via the canonical conditional-mount pattern', async () => {
        const src = await readRendererShellCombinedSource();
        assert.match(
          src,
          modal.parentMountPattern,
          `renderer shell must mount ${modal.name} via the {<flag> && <${modal.name} .../>} pattern (parent owns lifecycle)`,
        );
        assert.doesNotMatch(
          src,
          new RegExp(`<${modal.name}\\s+open=`),
          `renderer shell must NOT pass \`open=\` to ${modal.name} — use conditional mount instead`,
        );
      });
    });
  }
});
