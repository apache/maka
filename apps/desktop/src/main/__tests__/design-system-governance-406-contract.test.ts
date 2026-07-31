import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, basename, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, RENDERER_STYLES_DIR, readCssTree, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

async function readUiSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'packages/ui/src/ui.tsx'), 'utf8');
}

async function readSourceTree(dir: string): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        return [];
      }
      return readSourceTree(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) {
      return [];
    }
    return [{ path, source: await readFile(path, 'utf8') }];
  }));
  return files.flat();
}

function readCssToken(source: string, selector: ':root' | '.dark', token: string): string {
  const block = source.match(new RegExp(`${selector.replace('.', '\\.')}(?:\\s*,\\s*[^{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return block.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1].trim() ?? '';
}

function parseOklch(value: string): [number, number, number] {
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(match, `${value} must be a literal oklch() color`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * PALETTE-LEAK-0: --action/--control tokens derive hue + chroma from
 * --accent (with a min() chroma cap) while keeping their WCAG-tuned
 * lightness anchors literal. Resolve the derived form against the block's
 * literal --accent so the contrast gates below keep checking real colors
 * for the default palette.
 */
function resolveAccentDerived(value: string, accent: [number, number, number]): [number, number, number] {
  const match = value.match(/^oklch\(from var\(--accent\) ([\d.]+) min\(c, ([\d.]+)\) h\)$/);
  assert.ok(match, `${value} must be the accent-derived form oklch(from var(--accent) <l> min(c, <cap>) h)`);
  return [Number(match[1]), Math.min(accent[1], Number(match[2])), accent[2]];
}

function oklchToSrgb([l, c, h]: [number, number, number]): [number, number, number] {
  const hue = h * Math.PI / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.2914855480 * b;
  const lCube = lPrime ** 3;
  const mCube = mPrime ** 3;
  const sCube = sPrime ** 3;
  const linear = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.7076147010 * sCube,
  ];
  return linear.map((channel) => {
    const srgb = channel <= 0.0031308 ? 12.92 * channel : 1.055 * (channel ** (1 / 2.4)) - 0.055;
    return Math.min(1, Math.max(0, srgb));
  }) as [number, number, number];
}

function relativeLuminance(rgb: [number, number, number]): number {
  return rgb
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const high = Math.max(relativeLuminance(a), relativeLuminance(b));
  const low = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (high + 0.05) / (low + 0.05);
}

// color-mix(in oklab, c1 p%, c2 (1-p)%) → sRGB. Used to test the *-text token
// variants (--info-text / --destructive-text = <tone> 50% + --foreground 50%).
function mixOklchToSrgb(c1: [number, number, number], c2: [number, number, number], p: number): [number, number, number] {
  const a1 = c1[1] * Math.cos((c1[2] * Math.PI) / 180);
  const b1 = c1[1] * Math.sin((c1[2] * Math.PI) / 180);
  const a2 = c2[1] * Math.cos((c2[2] * Math.PI) / 180);
  const b2 = c2[1] * Math.sin((c2[2] * Math.PI) / 180);
  const L = p * c1[0] + (1 - p) * c2[0];
  const a = p * a1 + (1 - p) * a2;
  const b = p * b1 + (1 - p) * b2;
  return oklchToSrgb([L, Math.sqrt(a * a + b * b), (Math.atan2(b, a) * 180) / Math.PI]);
}

describe('issue #406 design-system governance contract', () => {
  it('uses IconButton instead of repeating icon-only semantics on Button', async () => {
    const sources = (
      await Promise.all([
        readSourceTree(resolve(REPO_ROOT, 'packages/ui/src')),
        readSourceTree(resolve(REPO_ROOT, 'apps/desktop/src/renderer')),
      ])
    ).flat();
    const violations = sources
      .filter(({ source }) =>
        /<(?:Button|UiButton)\b[^>]*\bisIconOnly\b/s.test(source),
      )
      .map(({ path }) => relative(REPO_ROOT, path));

    assert.deepEqual(
      violations,
      [],
      'production icon-only actions must use IconButton, which makes the required icon and forbidden visible children part of the type contract',
    );
  });

  it('keeps featured skill banners neutral instead of using blue as decorative texture', async () => {
    const source = stripCssComments(await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/module-pages/skills.css'), 'utf8'));
    const block = source.match(/\.maka-skill-featured-banner\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.ok(block, 'featured skill banner rule must exist');
    assert.doesNotMatch(block, /gradient\(/, 'featured banner must not use decorative gradients');
    assert.doesNotMatch(block, /background[^;]*--brand-deep/s, 'blue may not become the banner background fill');
  });

  it('does not ship decorative enter/exit motion by default', async () => {
    const rendererCss = stripCssComments(await readAllRendererCss());
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const uiSources = await readSourceTree(resolve(REPO_ROOT, 'packages/ui/src'));
    const functionalMotion = new Set([
      'animate-spin',
      'maka-composer-permission-pulse',
      'maka-composer-stream-bounce',
      // Composer streaming top sweep is visible "working" status.
      'maka-processing-sweep',
      'maka-list-row-streaming-pulse',
      // Streaming UI rework: the "深度思考" disclosure title + a working trow's
      // active-tool summary sweep light across the label (functional "still
      // working" signal), driven by the TextShimmer primitive. The retired ▎
      // caret's `maka-cursor` is replaced by `maka-stream-fade-in`, the
      // per-word entrance that signals freshly streamed text.
      'maka-text-shimmer',
      'maka-stream-fade-in',
      // #642: the `maka-footer-fade-in` settle-entrance keyframe was retired.
      // The footer no longer appears on settle — it is hidden by default and
      // revealed on hover / focus-within of the answer block, so there is no
      // live mount transition to animate.
      'maka-shimmer',
      'maka-status-spin',
      'maka-tool-pulse',
    ]);
    const motionRe = /@keyframes\s+([-\w]+)|(?:^|[{\s])animation:\s*([^;]+);|\[animation:([^\]]+)\]|(?<![\w-])(animate-[\w-]+)/g;
    const violations: string[] = [];

    assert.equal((rendererCss.match(/@starting-style/g) ?? []).length, 0);
    assert.equal((tokens.match(/@starting-style/g) ?? []).length, 0);
    for (const { path, source } of uiSources) {
      const stripped = stripCssComments(source).replace(/\/\/.*$/gm, '');
      assert.equal((stripped.match(/data-(?:starting|ending)-style/g) ?? []).length, 0, path);
      assert.equal((stripped.match(/maka-tool-card-enter/g) ?? []).length, 0, path);
    }

    for (const [name, source] of [
      ['renderer CSS', rendererCss],
      ...uiSources.map(({ path, source }) => [path, stripCssComments(source).replace(/\/\/.*$/gm, '')] as const),
    ] as const) {
      for (const match of source.matchAll(motionRe)) {
        const raw = match[0].trim();
        if (raw.includes('animation: none') || raw.includes('[animation:none]')) continue;
        const captured = match.slice(1).find(Boolean) ?? raw;
        // Extract the first identifier (the animation-name) from the captured
        // string. CSS form: "maka-tool-pulse 1.5s ease-in-out infinite".
        // Tailwind arbitrary: "maka-tool-pulse_1.5s_ease-in-out_infinite".
        const animName = captured.replace(/[_\s].*$/, '').replace(/^@keyframes\s+/, '');
        if (functionalMotion.has(animName)) continue;
        violations.push(`${name}: ${raw}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('splits action and control semantics without foreground-as-primary', async () => {
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const emphasisTokens = ['link', 'focus-ring', 'status-running', 'nav-active', 'toast-accent'];
    for (const selector of [':root', '.dark'] as const) {
      const accent = parseOklch(readCssToken(tokens, selector, 'accent'));
      const action = readCssToken(tokens, selector, 'action');
      const actionForeground = readCssToken(tokens, selector, 'action-foreground');
      const control = readCssToken(tokens, selector, 'control');
      const controlForeground = readCssToken(tokens, selector, 'control-foreground');

      assert.notEqual(action, 'var(--accent)', `${selector} action must be independently tunable`);
      assert.notEqual(control, 'var(--accent)', `${selector} control must be independently tunable`);
      // PALETTE-LEAK-0: the CTA family keeps its tuned lightness anchors but
      // derives hue/chroma from --accent so palette switches reach the send
      // button and checked controls (they used to stay hardcoded-blue). The
      // anchors stay pinned inside the derived form.
      assert.match(actionForeground, /^oklch\(from var\(--accent\) 0\.30 min\(c, 0\.06\) h\)$/);
      assert.match(controlForeground, /^oklch\(from var\(--accent\) 0\.985 min\(c, 0\.003\) h\)$/);
      assert.ok(
        contrastRatio(
          oklchToSrgb(resolveAccentDerived(action, accent)),
          oklchToSrgb(resolveAccentDerived(actionForeground, accent)),
        ) >= 4.5,
        `${selector} action/action-foreground contrast must clear 4.5:1`,
      );
      // control/foreground paints graphical objects (checkbox check, switch
      // knob, radio dot, progress fill), not text — so the WCAG 2.1 SC 1.4.11
      // non-text contrast bar (3:1) applies, not the 4.5:1 text bar used for
      // action above. --control is tuned (L0.65) to clear 3:1 with a small margin.
      assert.ok(
        contrastRatio(
          oklchToSrgb(resolveAccentDerived(control, accent)),
          oklchToSrgb(resolveAccentDerived(controlForeground, accent)),
        ) >= 3.0,
        `${selector} control/control-foreground contrast must clear 3:1 (WCAG 1.4.11 non-text)`,
      );
      for (const token of emphasisTokens) {
        assert.equal(readCssToken(tokens, selector, token), 'var(--accent)', `${selector} ${token} must start as a thin accent alias`);
      }
    }
    assert.match(styles, /--color-primary:\s*var\(--action\);/);
    assert.match(styles, /--color-primary-foreground:\s*var\(--action-foreground\);/);
    assert.match(styles, /--color-control:\s*var\(--control\);/);
    assert.match(styles, /--color-control-foreground:\s*var\(--control-foreground\);/);
    assert.doesNotMatch(styles, /--color-primary:\s*var\(--accent\);/);
    assert.doesNotMatch(styles, /--color-primary:\s*var\(--foreground\);/);
    for (const token of emphasisTokens) {
      assert.match(styles, new RegExp(`--color-${token}:\\s*var\\(--${token}\\);`));
    }

    const ui = await readUiSource();
    assert.match(ui, /default:\s*'bg-primary text-primary-foreground/);
    const appearance = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/appearance-settings-page.tsx'), 'utf8');
    assert.match(appearance, /<RadioList[\s\S]*<RadioListItem/);
    assert.doesNotMatch(appearance, /\bChoiceCard/);
    assert.match(ui, /<BaseProgress\.Indicator className="[^"]*bg-control/);

    const menu = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/menu.tsx'), 'utf8');
    const tabs = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx'), 'utf8');
    assert.match(menu, /from '@astryxdesign\/core\/DropdownMenu'/);
    assert.match(tabs, /from "@base-ui\/react\/tabs"/);
    assert.doesNotMatch(menu, /data-checked:bg-(?:control|primary)/);
    assert.match(tabs, /bg-foreground data-\[orientation=horizontal\]:h-0\.5/);
    assert.doesNotMatch(tabs, /bg-(?:control|primary) data-\[orientation=horizontal\]:h-0\.5/);
  });

  it('permission-mode chip text is readable across all tones (>=4.5:1)', async () => {
    // Review fixes: raw --info (L0.75) as the "自动执行" chip text was 2.29:1
    // on white, and raw --nav-active (= --accent, L0.70) as the default "询问"
    // chip text was 2.66:1 — both fail WCAG AA text (4.5:1). Chip text now uses
    // readable variants: info/destructive use the *-text color-mix (50% with
    // --foreground, 7.25:1 / 10.83:1); accent (the default mode) uses
    // --foreground-secondary (color-mix foreground 80% + background 20%,
    // ~8:1 light / ~7.5:1 dark). Raw tones stay on borders only.
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    // --foreground-secondary ratio is defined once in :root and inherited by
    // .dark via re-resolved var() refs. Parse it so a ratio tweak flows through.
    const fgSecDef = readCssToken(tokens, ':root', 'foreground-secondary');
    const fgSecPct = Number(fgSecDef.match(/var\(--foreground\)\s+(\d+)%/)?.[1] ?? 80) / 100;
    // Lock the *-text token definitions to the readable formula (tone 50% +
    // foreground 50%). If a token is deleted or rewired (e.g. --info-text ->
    // var(--info)), this fails before the contrast check — closing the gap
    // where the test computed a theoretical readable color while the chip
    // silently used something else. .dark inherits these from :root (the
    // color-mix re-resolves with dark's tone/foreground), so also assert no
    // .dark override sneaks in.
    assert.match(readCssToken(tokens, ':root', 'info-text'), /^color-mix\(in oklab,\s*var\(--info\)\s+50%,\s*var\(--foreground\)\)$/, ':root --info-text must be color-mix(info 50%, foreground)');
    assert.match(readCssToken(tokens, ':root', 'destructive-text'), /^color-mix\(in oklab,\s*var\(--destructive\)\s+50%,\s*var\(--foreground\)\)$/, ':root --destructive-text must be color-mix(destructive 50%, foreground)');
    assert.equal(readCssToken(tokens, '.dark', 'info-text'), '', '.dark must not override --info-text (inherit :root formula)');
    assert.equal(readCssToken(tokens, '.dark', 'destructive-text'), '', '.dark must not override --destructive-text (inherit :root formula)');
    for (const selector of [':root', '.dark'] as const) {
      const info = parseOklch(readCssToken(tokens, selector, 'info'));
      const destr = parseOklch(readCssToken(tokens, selector, 'destructive'));
      const fg = parseOklch(readCssToken(tokens, selector, 'foreground'));
      const bgOklch = parseOklch(readCssToken(tokens, selector, 'background'));
      const bg = oklchToSrgb(bgOklch);
      const infoText = mixOklchToSrgb(info, fg, 0.5);
      const destrText = mixOklchToSrgb(destr, fg, 0.5);
      const accentText = mixOklchToSrgb(fg, bgOklch, fgSecPct);
      assert.ok(contrastRatio(infoText, bg) >= 4.5, `${selector} --info-text contrast < 4.5:1`);
      assert.ok(contrastRatio(destrText, bg) >= 4.5, `${selector} --destructive-text contrast < 4.5:1`);
      assert.ok(contrastRatio(accentText, bg) >= 4.5, `${selector} accent chip (foreground-secondary) contrast < 4.5:1`);
    }
  });

  it('uses radius tokens for preview card surfaces', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const token of ['--radius-control: 6px', '--radius-surface: 8px', '--radius-modal: 12px', '--radius-pill: 999px']) {
      assert.ok(tokens.includes(token), `${token} must be defined in maka-tokens.css`);
    }

    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    assert.match(styles, /--radius-sm:\s*var\(--radius-control\);/);
    assert.match(styles, /--radius-md:\s*var\(--radius-surface\);/);
    assert.match(styles, /--radius-lg:\s*var\(--radius-surface\);/);
    assert.match(styles, /--radius-xl:\s*var\(--radius-modal\);/);

    const chat = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/chat.tsx'), 'utf8');
    const previewBlock = chat.slice(
      chat.indexOf('const previewVariants'),
      chat.indexOf('export { previewVariants }'),
    );
    assert.match(previewBlock, /diff:\s*"[^"]*rounded-\[var\(--radius-surface\)\]/);
    assert.match(previewBlock, /terminal:\s*"[^"]*rounded-\[var\(--radius-surface\)\]/);
    assert.match(previewBlock, /"load-tool":\s*"[^"]*rounded-\[var\(--radius-control\)\]/);
    assert.doesNotMatch(previewBlock, /diff:\s*"[^"]*rounded-\[(?:8|6)px\]/);
    assert.doesNotMatch(previewBlock, /terminal:\s*"[^"]*rounded-\[(?:8|6)px\]/);
    assert.doesNotMatch(previewBlock, /"load-tool":\s*"[^"]*rounded-\[(?:8|6)px\]/);
  });

  it('keeps core visual surfaces on shadow rings instead of hard borders', async () => {
    const ui = await readUiSource();
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const panelShadow = styles.match(/--shadow-maka-panel:\s*([^;]+);/)?.[1] ?? '';

    assert.match(panelShadow, /0\s+0\s+0\s+1px\s+var\(--border\)/);
    const dialogBlock = ui.slice(
      ui.indexOf('interface DialogContextValue'),
      ui.indexOf('// Astryx owns tab navigation'),
    );
    assert.match(ui, /Dialog as AstryxDialog[\s\S]*from '@astryxdesign\/core\/Dialog'/);
    assert.doesNotMatch(
      dialogBlock,
      /shadow-maka-panel|border-border|MODAL_POPUP_CLASS/,
      'Maka must not apply a second dialog surface over Astryx chrome',
    );

    const chat = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/chat.tsx'), 'utf8');
    assert.ok(chat.includes('[box-shadow:var(--shadow-minimal-flat)]'));
    assert.ok(!chat.includes('[animation:maka-tool-card-enter_350ms_var(--ease-out-strong)_both]'));
  });

  it('bans raw var(--accent) outside token definition blocks and palette preview', async () => {
    // Rule: var(--accent) may only appear in:
    //   1. maka-tokens.css — ONLY inside token definition blocks (:root,
    //      [data-maka-theme=*], .dark) on `--xxx: ...var(--accent)...` lines,
    //      plus the single .pill[data-tone="accent"] rule (literal accent tone).
    //   2. styles.css — ONLY inside @theme inline on `--color-accent:` bridge lines.
    //   3. theme-preview.css — palette swatch display (whole file allowed).
    //   Anywhere else (component CSS rules, renderer TSX, @maka/ui TSX,
    //   test fixtures) it is a bug: the call site must use a semantic alias.

    // Whole-file allowlist (palette swatch display).
    const fileAllowlist = new Set(['theme-preview.css']);
    // Files checked with block-aware token-definition logic.
    const blockAwareFiles = new Set(['maka-tokens.css', 'styles.css']);

    // Selectors that establish a token-definition block.
    const tokenBlockSelectors = new Set([
      ':root', '.dark',
      '@theme inline', '@theme',
    ]);
    const isTokenBlock = (selector: string): boolean =>
      tokenBlockSelectors.has(selector.trim()) ||
      /^\[data-maka-theme=/.test(selector.trim()) ||
      /^:root\b/.test(selector.trim()) ||
      /^\.dark\b/.test(selector.trim());

    // Token names that are allowed to reference --accent in their definition.
    // Adding a new name here is a deliberate governance decision; unknown
    // names (`--foo: var(--accent)`) fail even inside a token block.
    const allowedAccentTokenNames = new Set([
      '--link', '--focus-ring', '--status-running', '--nav-active',
      '--toast-accent',
      '--brand-deep', '--brand-deep-hover', '--bot-brand-default',
      '--selection',
      '--accent',
      '--color-accent',
      // PALETTE-LEAK-0: the CTA family derives hue/chroma from --accent
      // (lightness anchors stay literal) so palette switches reach the send
      // button and checked controls; --color-accent-foreground follows the
      // same derivation in styles.css @theme; --system-alert-accent is the
      // semantic alias component CSS (plan-reminders banner) consumes.
      '--action', '--action-foreground', '--control', '--control-foreground',
      '--color-accent-foreground',
      '--system-alert-accent',
    ]);

    // Walk CSS source line-by-line, tracking the current selector stack via
    // `{` / `}` nesting. For each line containing var(--accent), decide whether
    // it is inside a token definition block, looks like a `--xxx:` def, AND
    // the token name is in the allowlist. The .pill[data-tone="accent"] rule
    // is allowlisted as the one component exception (it IS the accent tone).
    function checkDefinitionFile(source: string, rel: string): string[] {
      const lines = source.split('\n');
      const stack: string[] = [];
      const violations: string[] = [];
      for (const line of lines) {
        for (const ch of line) {
          if (ch === '{') {
            const beforeBrace = line.slice(0, line.indexOf('{')).trim();
            stack.push(beforeBrace || (stack[stack.length - 1] ?? ''));
            break;
          }
          if (ch === '}') {
            stack.pop();
            break;
          }
        }
        if (!line.includes('var(--accent)')) continue;
        const trimmed = line.trim();

        // .pill[data-tone="accent"] — the literal accent tone pill (component exception)
        if (/^\.pill\[data-tone="accent"\]/.test(trimmed)) continue;

        // Must look like a token definition: `--xxx: ...;`
        const nameMatch = trimmed.match(/^--([\w-]+):/);
        if (!nameMatch) {
          violations.push(`${rel}: ${trimmed}`);
          continue;
        }

        // Token name must be in the allowlist
        const tokenName = `--${nameMatch[1]}`;
        if (!allowedAccentTokenNames.has(tokenName)) {
          violations.push(`${rel}: ${trimmed}  [unknown token name: ${tokenName}]`);
          continue;
        }

        // Must be inside a token definition block
        const innerSelector = stack[stack.length - 1] ?? '';
        if (!isTokenBlock(innerSelector)) {
          violations.push(`${rel}: ${trimmed}  [in block: ${innerSelector || '<root-level>'}]`);
        }
      }
      return violations;
    }

    const cssFiles = await readCssTree(RENDERER_STYLES_DIR);
    const allCss = [
      TOKENS_FILE,
      ...cssFiles,
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'),
    ];
    const violations: string[] = [];
    for (const file of allCss) {
      const base = basename(file);
      const rel = relative(REPO_ROOT, file).split(sep).join('/');

      // Whole-file allowlist (palette swatch display)
      if (fileAllowlist.has(base)) continue;

      const source = stripCssComments(await readFile(file, 'utf8'));
      if (!source.includes('var(--accent)')) continue;

      // Block-aware files: check line-by-line inside token blocks
      if (blockAwareFiles.has(base)) {
        violations.push(...checkDefinitionFile(source, rel));
        continue;
      }

      // Any other CSS file: any var(--accent) is a violation
      violations.push(rel);
    }

    // TSX/TS in @maka/ui AND apps/desktop/src/renderer (excluding __tests__)
    const tsDirs = [
      resolve(REPO_ROOT, 'packages/ui/src'),
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
    ];
    for (const dir of tsDirs) {
      const uiSources = await readSourceTree(dir);
      for (const { path, source } of uiSources) {
        if (source.includes('var(--accent)')) {
          violations.push(relative(REPO_ROOT, path).split(sep).join('/'));
        }
      }
    }

    // Anti-regression: --accent-rgb was removed (unused, and the values were
    // wrong). Fail loudly if it creeps back into maka-tokens.css.
    const tokensSource = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(!tokensSource.includes('--accent-rgb'), 'maka-tokens.css must not re-introduce --accent-rgb (deleted as unused)');

    assert.deepEqual(violations, [], `raw var(--accent) must only appear inside token definition blocks (maka-tokens.css :root/.dark/[data-maka-theme], styles.css @theme) or palette display (theme-preview.css). Component call sites must use semantic aliases. Found:\n${violations.join('\n')}`);
  });
});
