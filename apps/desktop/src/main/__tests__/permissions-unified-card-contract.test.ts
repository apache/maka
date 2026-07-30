import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

function ruleBody(css: string, selector: string): string {
  // Match the rule body for an exact selector. Anchored via `\n` so e.g.
  // `.settingsOsPermissionRow` does not also match `.settingsOsPermissionRowFoo`.
  const escaped = selector.replace(/[.[\]/+*]/g, (ch) => `\\${ch}`);
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(re);
  return match ? match[1]! : '';
}

describe('PR-PERMISSIONS-UNIFIED-CARD-0 contract (#309)', () => {
  it('.settingsOsPermissionList renders as a single grouped card', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.settingsOsPermissionList');
    assert.ok(body, '.settingsOsPermissionList rule must exist');

    // Grouped card chrome lives on the outer container.
    assert.match(body, /\bborder:\s*var\(--border-width-hairline\)\s+solid\s+var\(--border\)/, 'list must own the outer border');
    assert.match(body, /\bborder-radius:\s*var\(--radius-surface\)/, 'list must own the 8px outer radius (surface tier)');
    assert.match(body, /\bbackground:\s*var\(--background\)/, 'list must own the outer background');
    assert.match(body, /\boverflow:\s*hidden\b/, 'list must clip rows so divider corners stay clean');

    // It must be a vertical stack (not a grid with gap that re-introduces
    // the floating-card look).
    assert.match(body, /\bdisplay:\s*flex\b/, 'list must use flex layout');
    assert.match(body, /\bflex-direction:\s*column\b/, 'list must stack rows vertically');
    assert.doesNotMatch(body, /\bgap:\s*[1-9]/, 'list must not put a gap between rows (use hairline divider instead)');
  });

  it('.settingsOsPermissionRow drops per-row card chrome in favor of a hairline divider', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.settingsOsPermissionRow');
    assert.ok(body, '.settingsOsPermissionRow rule must exist');

    // The grouped card pattern owns its chrome on the outer list. Each
    // row must not re-introduce its own border / radius / shadow.
    assert.doesNotMatch(body, /\bborder:\s*1px\b/, 'row must not own a per-row border');
    assert.doesNotMatch(body, /\bborder-radius:\s*[0-9]/, 'row must not own a per-row border-radius');
    assert.doesNotMatch(body, /\bbox-shadow:\s*[^;]+;/, 'row must not own a per-row box-shadow');

    // Adjacency selector provides a 6% foreground hairline between rows.
    assert.match(
      css,
      /\.settingsOsPermissionRow\s*\+\s*\.settingsOsPermissionRow\s*\{[^}]*border-top:\s*var\(--border-width-hairline\) solid oklch\(from var\(--foreground\) l c h \/ 0\.06\)/,
      'adjacent rows must share a 6% foreground hairline divider',
    );
  });

  it('.settingsOsPermissionActions lays out buttons horizontally + right-aligned', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.settingsOsPermissionActions');
    assert.ok(body, '.settingsOsPermissionActions rule must exist');

    assert.match(body, /\bdisplay:\s*flex\b/, 'actions must use flex layout');
    assert.match(body, /\bflex-direction:\s*row\b/, 'actions must be a row, not a column');
    assert.match(body, /\bjustify-content:\s*flex-end\b/, 'actions must be right-aligned');
    assert.doesNotMatch(body, /\bflex-direction:\s*column\b/, 'actions must not stack vertically');
  });

  it('OsPermissionRow JSX renders open-settings before request, ghost when both, primary when alone', async () => {
    const src = await readSettingsCombinedSource();
    // Scope to the actions block (delimited by `<div className="settingsOsPermissionActions">` …
    // `</div>`). The non-greedy `[\s\S]*?` plus the `</div>` close avoid
    // accidentally swallowing the surrounding `</li>` boundary.
    const actionsBlock = src.match(
      /className="settingsOsPermissionActions"[\s\S]*?<\/div>/,
    )?.[0] ?? '';
    assert.ok(actionsBlock, 'settingsOsPermissionActions JSX block must exist');

    const showOpenIdx = actionsBlock.indexOf('showOpenSettings');
    const showRequestIdx = actionsBlock.indexOf('showRequest');
    assert.ok(showOpenIdx > -1 && showRequestIdx > -1, 'both gates must exist in the actions block');
    assert.ok(
      showOpenIdx < showRequestIdx,
      'open-settings button must render before request button so primary anchors the right edge',
    );

    // Affordance honesty (round 8, maintainer report): ghost beside the
    // primary read as a plain text label. When paired with ANY primary,
    // open-settings is a BORDERED secondary; when alone it returns to
    // variant=default so the row still has a primary CTA. Never ghost.
    //
    // The drag-to-grant flow added a second possible primary, so the
    // condition covers both — otherwise a row showing 引导授权 would put
    // two default-variant buttons side by side with no visual hierarchy.
    assert.match(
      actionsBlock,
      /variant=\{showRequest \|\| showDragGrant \? 'secondary' : 'default'\}/,
      'open-settings button must be bordered secondary whenever a primary action is present, default when alone',
    );
    // The guided flow is a primary CTA — it must not be quietly demoted.
    const dragGrantButton = actionsBlock.match(/showDragGrant && \(\s*<Button[\s\S]*?<\/Button>\s*\)/)?.[0] ?? '';
    assert.ok(dragGrantButton, 'showDragGrant && Button JSX must be findable');
    assert.doesNotMatch(
      dragGrantButton,
      /variant=("|\{')(ghost|secondary|outline|link)/,
      'drag-to-grant button must remain a primary CTA',
    );
    assert.doesNotMatch(
      actionsBlock,
      /'ghost'/,
      'no ghost variant in the OS-permission actions row — a clickable beside a real button needs a visible edge',
    );

    // Request button does not pass a `variant` prop — it defaults to the
    // primary `default` variant. Make sure no future edit silently
    // demotes it to ghost.
    const requestButton = actionsBlock.match(/showRequest && \(\s*<Button[\s\S]*?<\/Button>\s*\)/)?.[0] ?? '';
    assert.ok(requestButton, 'showRequest && Button JSX must be findable');
    assert.doesNotMatch(
      requestButton,
      /variant=("|\{')(ghost|secondary|outline|link)/,
      'request-permission button must remain the primary CTA',
    );
  });
});
