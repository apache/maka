/**
 * PR-CONTROL-HEIGHT-CONVERGE-0 (issue #520 PR4 item 15, 2026-07-05):
 * lock the control-height vocabulary so the sidebar / 会话 / 设置 rows,
 * triggers, and icon buttons can't drift back to off-ruler bare px.
 *
 * The historic "碍眼" was that interactive control heights were scattered
 * across off-ruler px (22 / 26 / 30 / 34 / 38) while the TSX side used the
 * 4px spacing ruler via Tailwind h-N (h-7=28, h-8=32, h-9=36). The two
 * scales never aligned, so a sidebar nav row at 34px next to a session row
 * at 30px next to a settings nav at 38px read as three different systems.
 *
 * Three invariants:
 *
 * 1. The --h-control-* scale lives on the 4px spacing ruler (var(--space-N))
 *    so CSS var(--h-control-*) and Tailwind h-N share ONE scale. The six
 *    tiers (xs/sm/md/lg/xl/2xl = 20/24/28/32/36/40) are pinned exactly-once;
 *    a rename or value drift gets flagged here before any site follows.
 *
 * 2. A curated set of control-row / trigger / square-button selectors must
 *    reference their expected --h-control-* tier for height (and width on
 *    square icon controls). This is the radius-contract SELECTOR_TIER
 *    pattern: height has no single anchor the way border-radius does
 *    (content heights, icon sizes, and chrome bars are all legitimate bare
 *    px), so the contract scopes to control selectors, not every height.
 *    App-chrome bars (--h-titlebar / --h-toolbar / --h-composer-min /
 *    --h-list-header) and content min/max heights stay bare — they are
 *    structure / content, not controls.
 *
 * 3. TSX has no arbitrary h-[Npx] / min-h-[Npx] / max-h-[Npx] utilities —
 *    use the Tailwind ruler scale (h-N / min-h-N / max-h-N, which compile
 *    to calc(var(--spacing) * N)) so TSX and CSS share the same 4px ruler.
 *    A tiny whitelist covers genuinely non-ruler heights that are not
 *    control heights: the 6px / 8px decorator dots, the 18px count badge,
 *    and one off-ruler 110px content scroll limit.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
  assertCustomPropPinnedOnce,
  assertCustomPropRefsDefined,
} from './css-test-helpers.js';

// --- token whitelist --------------------------------------------------------

const CONTROL_HEIGHT_TOKENS = new Set([
  '--h-control-xs',
  '--h-control-sm',
  '--h-control-md',
  '--h-control-lg',
  '--h-control-xl',
  '--h-control-2xl',
]);

/** Expected var(--h-control-*) pin value per token (the spacing-ruler tier).
 *  md (28) and xl (36) use calc(var(--spacing) * 7/9) directly — maka's
 *  discrete --space-* scale skips 7 and 9, and control-only tiers must not
 *  expand it (that would invite p-7 / gap-7 drift). */
const CONTROL_HEIGHT_PIN: Array<[string, string]> = [
  ['--h-control-xs', 'var(--space-5)'],
  ['--h-control-sm', 'var(--space-6)'],
  ['--h-control-md', 'calc(var(--spacing) * 7)'],
  ['--h-control-lg', 'var(--space-8)'],
  ['--h-control-xl', 'calc(var(--spacing) * 9)'],
  ['--h-control-2xl', 'var(--space-10)'],
];

// --- curated control selectors → expected tier ------------------------------

interface ControlHeightCheck {
  selector: string;
  /** Properties the contract verifies against the expected token. Height +
   *  min-height for row/trigger controls; also width for square controls
   *  whose footprint equals the control size. */
  props: ('height' | 'min-height' | 'width')[];
  token: string;
}

/** Each entry maps a control selector to the --h-control-* tier its height
 *  (and width, for square icon controls) must reference. Add new control
 *  rows here as they land on the scale. */
const CONTROL_HEIGHT: ControlHeightCheck[] = [
  // sidebar / 会话 rows
  { selector: '.maka-list-row', props: ['min-height'], token: '--h-control-lg' },
  { selector: '.maka-list-row-menu-trigger', props: ['width', 'height'], token: '--h-control-lg' },
  // Search close and clear actions are shared quiet icon-sm Buttons, sized by
  // the shared control primitive rather than search-modal-specific CSS.
  // 设置 nav / triggers — same lg tier as the session-list rows so the two
  // sidebars share one row rhythm (PR settings-rows-convergence).
  { selector: '.settingsBackButton', props: ['height', 'min-height'], token: '--h-control-lg' },
  { selector: '.settingsNavItem', props: ['height', 'min-height'], token: '--h-control-lg' },
  // Astryx Selector owns model/thinking control and option geometry.
  // chat controls
  { selector: '.maka-chat-jump-bottom', props: ['width', 'height'], token: '--h-control-md' },
];

/** Values that are always allowed (not a control-height beat). `100%`
 *  is the common "fill parent" height on control wrappers. */
const LITERAL_OK = /^(?:0(?:px|%)?|100%|auto|inherit|initial|unset|revert|none)$/;

function extractControlToken(expr: string): string | null {
  const m = expr.trim().match(/^var\(\s*(--h-control-[\w-]+)\s*\)$/);
  return m ? m[1] : null;
}

/** A mapped control selector's height / min-height / width must reference its
 *  EXPECTED --h-control-* tier (or a neutral literal like 0 / auto / 100%).
 *  Direct var(--space-N), calc(var(--spacing) * N), and layout-chrome tokens
 *  (--h-titlebar / --maka-sidebar-topbar-button-size / …) are REJECTED —
 *  they bypass the semantic scale, and a mapped control reaching for a
 *  chrome token is a semantic mismatch, not height convergence. Unmapped
 *  controls are added to CONTROL_HEIGHT rather than allowed to slip via a
 *  space token. */
function isAllowedControlHeight(expr: string, expected: string): boolean {
  const v = expr.trim().replace(/!\s*important$/, '').trim();
  if (LITERAL_OK.test(v)) return true;
  const tok = extractControlToken(v);
  return tok === expected;
}

// --- CSS scanning ----------------------------------------------------------

function checkSelectorTier(css: string, check: ControlHeightCheck): string[] {
  const offenders: string[] = [];
  const escaped = check.selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\s/g, '\\s+');
  // Normalize: insert newlines after `{` and before `}` so a selector block
  // can be matched even when several rules share one line.
  const normalized = css.replace(/\{/g, '{\n').replace(/\}/g, '\n}');
  const blockRe = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const blocks = [...normalized.matchAll(blockRe)];
  if (blocks.length === 0) {
    offenders.push(`${check.selector} not found in CSS — stale contract entry or renamed selector`);
    return offenders;
  }
  // Each prop in check.props is a REQUIRED size on this control (a square
  // control needs both width AND height; a settings row needs height AND
  // min-height). Track which props appeared across ALL matched blocks (a
  // selector may have a base rule plus @media / :state variants); a missing
  // required prop is a regression. Every declaration that DOES appear must
  // still reference the expected tier — including overrides inside @media.
  const seenProps = new Set<string>();
  for (const block of blocks) {
    const body = block[1];
    for (const prop of check.props) {
      const propRe = new RegExp(`(?:^|\\n)\\s*${prop}\\s*:\\s*([^;}\\n]+)`, 'g');
      for (const m of body.matchAll(propRe)) {
        seenProps.add(prop);
        const raw = m[1].trim();
        if (!isAllowedControlHeight(raw, check.token)) {
          offenders.push(`${check.selector} ${prop}: ${raw} [must use ${check.token}]`);
        }
      }
    }
  }
  for (const prop of check.props) {
    if (!seenProps.has(prop)) {
      offenders.push(`${check.selector} is missing required ${prop} declaration (expected ${check.token})`);
    }
  }
  return offenders;
}

// --- TSX scanning ----------------------------------------------------------

/** Arbitrary h-[Npx] / min-h-[Npx] / max-h-[Npx] with a BARE numeric value —
 *  banned except a small whitelist. Computed/token/viewport forms
 *  (h-[calc(...)], h-[var(...)], max-h-[85dvh]) are NOT drift: they reference
 *  a token or the viewport, so this regex only matches bare Npx. Widths
 *  (w-/min-w-/max-w-) are out of scope — width is governed by the
 *  responsive / measure track, not control height. */
const TSX_ARBITRARY_HEIGHT_RE = /\b(min-h|max-h|h)-\[-?\d+(?:\.\d+)?px\]/g;

/** Exact arbitrary-height strings that are NOT control heights and stay as
 *  arbitrary values. The 6px / 8px decorator dots and the 18px count badge
 *  are not control sizes; max-h-[110px] is one off-ruler content scroll cap.
 *  min-h-[28px] and max-h-[180px] are pinned as arbitrary literals by the
 *  #332 chat-marker / preview cascade contracts (a deliberate "literalize
 *  vehicle" immune to scale re-tuning) — those contracts govern them, so
 *  this contract defers and whitelists them here. */
const TSX_HEIGHT_WHITELIST = new Set([
  'h-[6px]',
  'h-[8px]',
  'h-[18px]',
  'max-h-[110px]',
  'min-h-[28px]',
  'max-h-[180px]',
]);

async function collectTsxHeightOffenders(): Promise<string[]> {
  const offenders: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(entry.name)) continue;
      const src = await readFile(full, 'utf8');
      const label = full.replace(REPO_ROOT + '/', '');
      for (const m of src.matchAll(TSX_ARBITRARY_HEIGHT_RE)) {
        const whole = m[0];
        if (TSX_HEIGHT_WHITELIST.has(whole)) continue;
        offenders.push(`${label}: ${whole}`);
      }
    }
  }
  await walk(resolve(REPO_ROOT, 'packages/ui/src'));
  await walk(resolve(REPO_ROOT, 'apps/desktop/src/renderer'));
  return offenders;
}

// === tests =================================================================

describe('PR-CONTROL-HEIGHT-CONVERGE-0 contract', () => {
  it('--h-control-* tokens are pinned exactly-once to their spacing-ruler tier', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const [prop, expected] of CONTROL_HEIGHT_PIN) {
      assertCustomPropPinnedOnce(tokens, prop, expected, 'maka-tokens.css');
    }
  });

  it('--h-control-* reference chain is closed — every var(--xxx) in a tier value is a defined custom prop (guards the --space-7/--space-9 collapse bug)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const [prop] of CONTROL_HEIGHT_PIN) {
      assertCustomPropRefsDefined(tokens, prop, 'maka-tokens.css');
    }
  });

  it('control selectors reference their expected --h-control-* tier (no bare px height/min-height)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const offenders: string[] = [];
    for (const check of CONTROL_HEIGHT) {
      offenders.push(...checkSelectorTier(css, check));
    }
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('TSX has no arbitrary h-[Npx] / min-h-[Npx] / max-h-[Npx] (use the ruler h-N / min-h-N / max-h-N)', async () => {
    const offenders = await collectTsxHeightOffenders();
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });
});
