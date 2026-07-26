/**
 * Radius governance contract (#406 gap 4).
 *
 * Radius vocabulary contract:
 *   - control  6px  — button / input / chip / kbd / inline code / tab trigger / nav row
 *   - surface  8px  — card / popover / menu popup / alert / toolbar / tab list / select popup
 *   - modal   12px — Settings / Confirm / Permission modal / floating card
 *   - pill    999px — pill / badge / round dot / switch / checkbox / radio / progress
 *
 * Tailwind alias map (styles.css):
 *   rounded-sm → --radius-control (6px)
 *   rounded-md → --radius-surface (8px)
 *   rounded-lg → --radius-surface (8px)  [deprecated, kept for compat]
 *   rounded-xl → --radius-modal (12px)
 *   rounded-full → --radius-pill (999px)
 *
 * Contract rules:
 *   1. CSS `border-radius` (shorthand + physical + logical longhand) must
 *      reference a whitelisted `--radius-*` token, or be 0 / 50% / inherit / initial.
 *   2. TSX `rounded-[...]`, `rounded-(...)`, directional/logical variants, and
 *      `rounded-{2-9}xl` must likewise reference a whitelisted token or be banned.
 *   3. `calc(var(--radius-*))` may only *shrink* (subtract Npx); `+Npx` is banned.
 *   4. `rounded-2xl`+ (≥16px) are banned.
 *   5. Components must use the correct tier: control→rounded-sm, surface→rounded-md,
 *      modal→rounded-xl, pill→rounded-full/rounded-[var(--radius-pill)].
 *      Every --radius-* reference inside a component block must belong to the
 *      expected tier's alias set. A component that legitimately serves more
 *      than one tier declares `alsoTiers` (e.g. buttonVariants is a control
 *      that also offers the governed pill shape via shape="pill"); every
 *      declared tier must then be present, and other tiers stay forbidden.
 *   6. Token values are pinned: control=6px, surface=8px, modal=12px, pill=999px.
 *   7. `--radius-button` is deleted; no stale references may remain.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, STYLES_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

// --- token whitelist (single source of truth for all paths) -----------------

const RADIUS_TOKEN_WHITELIST = new Set([
  '--radius-control',
  '--radius-surface',
  '--radius-modal',
  '--radius-pill',
  '--radius-sm', // tailwind alias → control
  '--radius-md', // tailwind alias → surface
  '--radius-lg', // tailwind alias → surface
  '--radius-xl', // tailwind alias → modal
]);

function extractRadiusToken(expr: string): string | null {
  const m = expr.trim().match(/^var\(\s*(--radius-[\w-]+)\s*\)$/);
  return m ? m[1] : null;
}

function isWhitelistedVar(expr: string): boolean {
  const tok = extractRadiusToken(expr);
  return tok !== null && RADIUS_TOKEN_WHITELIST.has(tok);
}

/**
 * calc() must be exactly `calc(var(--radius-whitelisted) - <positive>px)`.
 * Positive allowlist — any other calc form (addition, multiplication,
 * division, double-negative, no token, non-whitelisted token) fails.
 * Tolerates whitespace inside var() and around operators.
 */
const CALC_ALLOW_RE = /^calc\(\s*var\(\s*(--radius-[\w-]+)\s*\)\s*-\s*([1-9]\d*(?:\.\d+)?|0?\.\d*[1-9])px\s*\)$/;

function isWhitelistedCalc(expr: string): boolean {
  const m = expr.match(CALC_ALLOW_RE);
  if (!m) return false;
  return RADIUS_TOKEN_WHITELIST.has(m[1]);
}

const LITERAL_OK = /^(?:0+(?:px|%)?|50%|inherit|initial)$/;

function isAllowedCorner(corner: string): boolean {
  if (LITERAL_OK.test(corner)) return true;
  return isWhitelistedVar(corner) || isWhitelistedCalc(corner);
}

// --- CSS scanning (single entry: readAllRendererCss unfolds all imports) -----

const RADIUS_DECL_RE = /border-radius\s*:\s*([^;}\n]+)\s*[;}]/gi;
const RADIUS_LONGHAND_RE = /border-(?:top-left|top-right|bottom-left|bottom-right|start-start|start-end|end-start|end-end)-radius\s*:\s*([^;}\n]+)\s*[;}]/gi;

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const re of [RADIUS_DECL_RE, RADIUS_LONGHAND_RE]) {
    for (const m of stripped.matchAll(re)) {
      const raw = m[1].trim();
      const cleaned = raw.replace(/!\s*important$/, '').trim();
      if (cleaned.split(/\s+/).every(isAllowedCorner)) continue;
      offenders.push(`${label}: ${m[0].replace(/\s+/g, ' ').trim()}`);
    }
  }
  return offenders;
}

// --- TSX/TS scanning --------------------------------------------------------

const ROUNDED_RE = /rounded-(?:\[(?<arb>[^\]]+)\]|\((?<paren>[^)]+)\)|(?<tw>[2-9]xl)\b|(?:t|tr|tl|b|br|bl|l|r|s|e|ss|se|es|ee)-(?:\[(?<dir>[^\]]+)\]|\((?<dirpar>[^)]+)\)|(?<dirtw>[2-9]xl)\b))/g;

async function collectTsxOffenders(): Promise<string[]> {
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
      for (const m of src.matchAll(ROUNDED_RE)) {
        const groups = m.groups as { arb?: string; paren?: string; tw?: string; dir?: string; dirpar?: string; dirtw?: string } | undefined;
        if (groups?.tw || groups?.dirtw) {
          const tw = groups.tw ?? groups.dirtw!;
          offenders.push(`${label}: rounded-${tw} (≥16px, exceeds 12px cap)`);
          continue;
        }
        const val = (groups?.arb ?? groups?.dir ?? groups?.paren ?? groups?.dirpar ?? '').trim();
        if (LITERAL_OK.test(val)) continue;
        if (isWhitelistedVar(val) || isWhitelistedCalc(val)) continue;
        offenders.push(`${label}: rounded-[${val}]`);
      }
    }
  }
  await walk(resolve(REPO_ROOT, 'packages/ui/src'));
  await walk(resolve(REPO_ROOT, 'apps/desktop/src/renderer'));
  return offenders;
}

// --- component → expected radius tier contract ------------------------------

type Tier = 'control' | 'surface' | 'modal' | 'pill';

interface ComponentRadiusCheck {
  file: string;
  name: string;
  tier: Tier;
  /** Additional tiers the component legitimately serves (see rule 5). */
  alsoTiers?: Tier[];
}

/** The expected radius class for each tier. */
const TIER_CLASS: Record<Tier, string[]> = {
  control: ['rounded-sm'],
  surface: ['rounded-md'],
  modal: ['rounded-xl'],
  pill: ['rounded-[var(--radius-pill)]', 'rounded-full'],
};

/** Token aliases that belong to each tier. A component block must only
 *  reference tokens from its expected tier's alias set. */
const TIER_TOKENS: Record<Tier, Set<string>> = {
  control: new Set(['--radius-control', '--radius-sm']),
  surface: new Set(['--radius-surface', '--radius-md', '--radius-lg']),
  modal: new Set(['--radius-modal', '--radius-xl']),
  pill: new Set(['--radius-pill']),
};

/** Every tier-attributed class — a component block must only contain classes
 *  from its declared tier(s); anything else from this list is forbidden. */
const ALL_TIER_CLASSES = ['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-full', 'rounded-[var(--radius-pill)]', 'rounded-[var(--radius-control)]', 'rounded-[var(--radius-surface)]', 'rounded-[var(--radius-modal)]'];

const COMPONENT_RADIUS: ComponentRadiusCheck[] = [
  // shape="pill" (the composer "+" / send affordance) is a governed pill-tier
  // shape on the control-tier Button — both tiers must stay present.
  { file: 'packages/ui/src/ui.tsx', name: 'buttonVariants', tier: 'control', alsoTiers: ['pill'] },
  { file: 'packages/ui/src/primitives/input.tsx', name: 'inputClasses', tier: 'control' },
  { file: 'packages/ui/src/ui.tsx', name: 'SelectItem', tier: 'control' },
  { file: 'packages/ui/src/ui.tsx', name: 'Toggle', tier: 'control' },
  // #520 PR9: legacy ui.tsx badgeVariants retired onto primitives/badge.tsx.
  // DialogPopup/AlertDialogPopup were merged into createModalContent (PR6
  // review P3.1); the modal popup class now lives in MODAL_POPUP_CLASS.
  { file: 'packages/ui/src/ui.tsx', name: 'MODAL_POPUP_CLASS', tier: 'modal' },
  { file: 'packages/ui/src/ui.tsx', name: 'SelectPopup', tier: 'surface' },
  // TabsTrigger/TabsList used to be declared in ui.tsx with --radius-* tokens;
  // #499 P0-3 re-exports them from primitives/tabs.tsx, which uses Tailwind
  // rounded-md/rounded-sm (governed by primitives-design-contract escape
  // hatches, not the radius-token convergence contract).
  { file: 'packages/ui/src/ui.tsx', name: 'ToggleGroup', tier: 'surface' },
  { file: 'packages/ui/src/primitives/input-group.tsx', name: 'InputGroup', tier: 'control' },
  { file: 'packages/ui/src/primitives/badge.tsx', name: 'badgeVariants', tier: 'pill' },
  { file: 'packages/ui/src/primitives/item.tsx', name: 'itemVariants', tier: 'surface' },
  { file: 'packages/ui/src/primitives/menu.tsx', name: 'MenuPopup', tier: 'surface' },
  { file: 'packages/ui/src/primitives/alert.tsx', name: 'alertVariants', tier: 'surface' },
  { file: 'packages/ui/src/primitives/toolbar.tsx', name: 'Toolbar', tier: 'surface' },
  { file: 'packages/ui/src/session-sidebar-nav.tsx', name: 'navRowVariants', tier: 'control' },
  { file: 'packages/ui/src/session-sidebar-nav.tsx', name: 'settingsButtonClass', tier: 'control' },
];

/** Extract the body of a component declaration by brace-matching from the
 *  point where `name` is declared.
 *
 *  - `const X = cva(...)` / `const X = forwardRef<...>(...)`: match the
 *    outermost `(...)` call, tracking nested parens, skipping string
 *    literals so `var(--foreground-60)` inside a string-concat constant
 *    is not mistaken for a function call.
 *  - `const X = '...' + ...;` (string-concat constant): no real `(` is
 *    found before the terminating `;`, so the entire declaration up to
 *    `;` is returned.
 *  - `function X(...) { ... }`: skip the parameter `(...)`, then match
 *    the function body `{ ... }`.
 *
 *  This avoids relying on `\nexport` lookahead which is fragile when
 *  multiple exports share a line or when no export follows. */
function extractComponentBlock(src: string, name: string): string | null {
  const re = new RegExp(
    `(?:const\\s+${name}\\s*=|export\\s+const\\s+${name}\\s*=|function\\s+${name}\\b)`,
  );
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  const isFunction = /function\s/.test(m[0]);

  if (!isFunction) {
    // For const declarations, scan for the first real `(` outside of
    // string literals. If we hit `;` first, it's a string-concat constant
    // or array — return up to `;`.
    i = skipStringsToChar(src, i, '(');
    if (i < 0 || src[i] === ';') {
      // No function call found — return up to the terminating `;` (or EOF).
      const semi = src.indexOf(';', m.index + m[0].length);
      return semi >= 0 ? src.slice(m.index, semi + 1) : src.slice(m.index);
    }
  } else {
    // For function declarations, skip to the parameter `(`.
    while (i < src.length && src[i] !== '(') i++;
    if (i >= src.length) return src.slice(m.index);
  }

  // Match the (...) pair.
  i = matchPair(src, i, '(', ')');
  if (i < 0) return src.slice(m.index);

  if (isFunction) {
    // For function declarations, the body is the next `{ ... }`.
    while (i < src.length && src[i] !== '{') i++;
    if (i >= src.length) return src.slice(m.index);
    i = matchPair(src, i, '{', '}');
    if (i < 0) return src.slice(m.index);
  }
  return src.slice(m.index, i);
}

/** Scan from `start`, skipping single/double/backtick string literals,
 *  and return the index of the first occurrence of `char` that is NOT
 *  inside a string. Returns -1 if not found. */
function skipStringsToChar(src: string, start: number, char: string): number {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      // Skip string literal
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === char) return i;
    if (c === ';') return i; // stop at semicolon for const declarations
    i++;
  }
  return -1;
}

/** Match a balanced pair starting at `src[start]` (which must be `open`).
 *  Returns the index *after* the closing `close`, or -1 if unbalanced. */
function matchPair(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function checkComponentTier(src: string, check: ComponentRadiusCheck): string[] {
  const offenders: string[] = [];
  const block = extractComponentBlock(src, check.name);
  if (!block) {
    offenders.push(`${check.file}: ${check.name} not found in source — stale contract entry or renamed component`);
    return offenders;
  }
  const tiers: Tier[] = [check.tier, ...(check.alsoTiers ?? [])];
  for (const tier of tiers) {
    const expected = TIER_CLASS[tier];
    if (!expected.some((c) => block.includes(c))) {
      offenders.push(`${check.file}: ${check.name} must use ${expected.join(' or ')} (${tier}), found none`);
    }
  }
  const forbidden = ALL_TIER_CLASSES.filter((c) => !tiers.some((tier) => TIER_CLASS[tier].includes(c)));
  for (const bad of forbidden) {
    if (block.includes(bad)) {
      offenders.push(`${check.file}: ${check.name} must not use ${bad} (wrong tier for ${tiers.join(' + ')})`);
    }
  }
  // Extract every --radius-* reference in the block and verify it belongs
  // to the expected tier. Catches calc() and arbitrary value paths that
  // the class-based check misses.
  const expectedTokens = new Set(tiers.flatMap((tier) => [...TIER_TOKENS[tier]]));
  const blockTokens = [...block.matchAll(/--radius-[\w-]+/g)].map((t) => t[0]);
  for (const tok of blockTokens) {
    if (!expectedTokens.has(tok)) {
      offenders.push(`${check.file}: ${check.name} references ${tok} which is not a ${tiers.join(' + ')} tier token`);
    }
  }
  return offenders;
}

// --- token value pinning ----------------------------------------------------

async function parseRadiusTokenValues(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const tokens = await readFile(TOKENS_FILE, 'utf8');
  for (const m of tokens.matchAll(/^\s*(--radius-[\w-]+):\s*([^;]+);/gm)) {
    map.set(m[1], m[2].trim());
  }
  const styles = await readFile(STYLES_FILE, 'utf8');
  for (const m of styles.matchAll(/^\s*(--radius-[\w-]+):\s*([^;]+);/gm)) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

// === tests ==================================================================

describe('radius token governance (#406 gap 4)', () => {
  it('CSS uses only whitelisted --radius-* tokens (no bare Npx, no longhand, no logical, no private tokens)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('TSX uses no hardcoded rounded-[Npx], no directional/logical rounded-*-[Npx], no rounded-2xl/3xl', async () => {
    const offenders = await collectTsxOffenders();
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('components use the correct radius tier (control/surface/pill)', async () => {
    const offenders: string[] = [];
    for (const check of COMPONENT_RADIUS) {
      const src = await readFile(resolve(REPO_ROOT, check.file), 'utf8');
      offenders.push(...checkComponentTier(src, check));
    }
    assert.deepEqual(offenders, [], `Component tier violations:\n  ${offenders.join('\n  ')}`);
  });

  it('CSS class selectors use the correct radius tier', async () => {
    const css = await readAllRendererCss();
    const stripped = stripCssComments(css);
    // Normalize: insert newlines after `{` and before `}` so selector
    // matching does not depend on whether the selector follows a `{`
    // on the same line (e.g. `@layer components { .selector {`).
    const normalized = stripped.replace(/\{/g, '{\n').replace(/\}/g, '\n}');
    // Each entry: selector → expected tier token.
    // Every border-radius in every matching block must use this token.
    // If a selector is not found at all, that's also a failure (stale entry).
    const SELECTOR_TIER: Record<string, string> = {
      '.maka-code': '--radius-surface',
      '.maka-skeleton-card': '--radius-surface',
      '.composer .maka-composer-inner': '--radius-modal',
      '.settingsCapabilityGuidanceActions code': '--radius-surface',
      '.settingsModal': '--radius-modal',
      '.maka-palette-modal': '--radius-modal',
      '.maka-palette-input-wrap': '--radius-control',
      // .settingsPermissionIntro / .settingsHealthIntro retired (polish wave
      // Item 5): the second gray-banner PageHeader on each page was converged
      // onto the SectionHeader primitive, which carries no page-level radius.
      '.settingsPermissionError': '--radius-surface',
      // .settingsCapabilityRow radius retired (polish wave Item 3): the
      // per-capability bordered blocks were converged onto the shared dense
      // row language — the LIST is now the one hairline card, rows carry no
      // per-row border/radius. Same shape as the OS permission list.
      '.settingsCapabilityList': '--radius-surface',
      '.settingsOsPermissionList': '--radius-surface',
      // .settingsHealthSignalList is the health-page twin of the capability
      // list card (polish wave Item 2).
      '.settingsHealthSignalList': '--radius-surface',
      '.settingsBotRuntime': '--radius-surface',
      // .settingsNotice retired: last consumer (account page) removed in the
      // UI-quality campaign; notices now ride the Alert primitive.
      '.settingsAboutLogo': '--radius-surface',
      // .settingsAboutPrivacy retired (polish wave): the brand-blue section
      // dialect used by 关于's privacy card + 数据's 配置导入导出 header was
      // converged onto SectionHeader + Alert; its neutral replacements
      // (.settingsPrivacyBlock / .settingsConfigSection) carry no radius.
      '.settingsWechatQrFrame': '--radius-surface',
      '.settingsWechatQrState': '--radius-surface',
      '.enabledEmptyChip': '--radius-control',
      '.maka-firstrun-list': '--radius-surface',
      '.providerLogo': '--radius-surface',
      '.maka-browser-address': '--radius-control',
      // .maka-plan-shell dropped: unboxed to a plain layout container
      // (the MCP page set the no-outer-frame precedent) — no card chrome,
      // no radius.
      // .maka-plan-card dropped its per-item card chrome when Plan reminders
      // converged on one divided management list; rows carry no radius.
      // .maka-plan-template-card retired with the redundant template strip.
      // .maka-skill-library dropped: unboxed to a plain layout container
      // (the MCP page set the no-outer-frame precedent) — no card chrome,
      // no radius.
      // .maka-module-main .maka-daily-review-panel dropped: unboxed to a
      // plain layout container alongside the skills / plan module unbox
      // (the MCP page set the no-outer-frame precedent) — no card chrome,
      // no radius.
      // .maka-daily-review-info dropped: unboxed to a plain hint line in
      // the daily-review IA restructure — no card chrome, no radius.
      // Daily-review IA redesign: the master-detail archive body card became
      // the stacked report surface (.maka-daily-review-report). The surface
      // owns the radius now; the expanded body (.maka-daily-review-report-body)
      // divides with a hairline and carries no radius of its own.
      '.maka-daily-review-report': '--radius-surface',
    };
    const offenders: string[] = [];
    for (const [sel, token] of Object.entries(SELECTOR_TIER)) {
      const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\s/g, '\\s+');
      // Find every block for this exact selector (not :hover/:disabled variants)
      const blockRe = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
      const blocks = [...normalized.matchAll(blockRe)];
      if (blocks.length === 0) {
        offenders.push(`${sel} not found in CSS — stale contract entry`);
        continue;
      }
      // Every border-radius in every block must match expected token.
      // Skip blocks that have no border-radius (e.g. :hover/:disabled variants
      // matched by substring — but the exact-selector anchor above should
      // prevent that. If a block has no border-radius at all, it's not a
      // tier concern.)
      let checkedAny = false;
      for (const block of blocks) {
        const body = block[1];
        const radiusMatches = [...body.matchAll(/border-radius:\s*var\((--radius-[\w-]+)\)/g)];
        for (const rm of radiusMatches) {
          checkedAny = true;
          if (rm[1] !== token) {
            offenders.push(`${sel} uses ${rm[1]}, must use ${token}`);
          }
        }
      }
      if (!checkedAny) {
        offenders.push(`${sel} has no border-radius declaration`);
      }
    }
    assert.deepEqual(offenders, [], `Selector tier violations:\n  ${offenders.join('\n  ')}`);
  });

  it('radius token values are pinned to 6/8/12/999px', async () => {
    const tokens = await parseRadiusTokenValues();
    const expected: Record<string, string> = {
      '--radius-control': '6px',
      '--radius-surface': '8px',
      '--radius-modal': '12px',
      '--radius-pill': '999px',
    };
    for (const [tok, val] of Object.entries(expected)) {
      assert.equal(tokens.get(tok), val, `${tok} must be ${val}. Update the token source and this contract together.`);
    }
    const aliases: Record<string, string> = {
      '--radius-sm': 'var(--radius-control)',
      '--radius-md': 'var(--radius-surface)',
      '--radius-lg': 'var(--radius-surface)',
      '--radius-xl': 'var(--radius-modal)',
    };
    for (const [tok, val] of Object.entries(aliases)) {
      assert.equal(tokens.get(tok), val, `${tok} must be ${val}.`);
    }
  });

  it('--radius-button alias is fully deleted (no stale references)', async () => {
    const css = await readAllRendererCss();
    const stripped = stripCssComments(css);
    assert.equal(
      stripped.includes('--radius-button'),
      false,
      '--radius-button must not appear anywhere in renderer CSS (alias deleted).',
    );
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.equal(
      tokens.includes('--radius-button'),
      false,
      '--radius-button must not appear in maka-tokens.css (alias deleted).',
    );
  });
});

describe('radius whitelist negative cases', () => {
  it('rejects typos and private tokens in var()', () => {
    assert.equal(isWhitelistedVar('var(--radius-modla)'), false, 'typo must fail');
    assert.equal(isWhitelistedVar('var(--radius-private)'), false, 'private token must fail');
    assert.equal(isWhitelistedVar('var(--radius-control)'), true, 'valid token must pass');
  });

  it('rejects calc() with non-whitelisted tokens', () => {
    assert.equal(isWhitelistedCalc('calc(var(--radius-private) + 1px)'), false, 'private token must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modla) - 1px)'), false, 'typo must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-control) - 1px)'), true, 'valid token subtraction must pass');
  });

  it('calc() allowlist: only var(--radius-*) - <positive>px passes', () => {
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) + 20px)'), false, 'addition must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-surface) + 8px)'), false, 'addition must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) * 1.5)'), false, 'multiplication must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) / 0.5)'), false, 'division must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) - -1px)'), false, 'double-negative must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) - 0px)'), false, 'zero subtraction must fail');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) - 1px)'), true, 'subtraction must pass');
    assert.equal(isWhitelistedCalc('calc(var(--radius-xl) - 1px)'), true, 'subtraction with alias must pass');
    assert.equal(isWhitelistedCalc('calc(var(--radius-sm) - 1.5px)'), true, 'fractional subtraction must pass');
  });

  it('TSX scanner catches rounded-(--private-radius), rounded-4xl, and directional scale classes', async () => {
    const badCases = [
      'rounded-(--private-radius)',
      'rounded-se-(--private-radius)',
      'rounded-4xl',
      'rounded-9xl',
      'rounded-s-2xl',
      'rounded-t-3xl',
      'rounded-se-4xl',
    ];
    for (const bad of badCases) {
      const m = [...bad.matchAll(ROUNDED_RE)];
      assert.ok(m.length > 0, `${bad} must be caught by ROUNDED_RE`);
    }
    assert.equal(isWhitelistedVar('var(--radius-pill)'), true, 'valid pill token must pass');
  });

  it('CSS scanner is case-insensitive and tolerates whitespace around colons', () => {
    // Bare px must be caught regardless of case or spacing
    const badSnippets = [
      'border-radius : 10px;',
      'BORDER-RADIUS: 10px;',
      'Border-Radius: 10px;',
      'border-radius:10px;',
    ];
    for (const css of badSnippets) {
      RADIUS_DECL_RE.lastIndex = 0;
      RADIUS_LONGHAND_RE.lastIndex = 0;
      const offenders = findCssOffenders(css, 'test');
      assert.ok(offenders.length > 0, `${JSON.stringify(css)} must be flagged as bare px`);
    }
  });

  it('calc() with internal whitespace still passes for valid tokens', () => {
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal) - 1px)'), true, 'standard calc must pass');
    assert.equal(isWhitelistedCalc('calc( var(--radius-modal) - 1px )'), true, 'calc with spaces inside parens must pass');
    assert.equal(isWhitelistedCalc('calc(var(--radius-modal)  -  1px)'), true, 'calc with multiple spaces around minus must pass');
    assert.equal(isWhitelistedCalc('calc(var( --radius-modal ) - 1px)'), true, 'calc with spaces inside var() must pass');
  });

  it('var() with internal whitespace still passes for valid tokens', () => {
    assert.equal(isWhitelistedVar('var(--radius-surface)'), true, 'standard var must pass');
    assert.equal(isWhitelistedVar('var( --radius-surface )'), true, 'var with spaces inside parens must pass');
    assert.equal(isWhitelistedVar('var( --radius-control )'), true, 'var with spaces and control token must pass');
  });
});
