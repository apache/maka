/**
 * CSS contract test for the sidebar session list scroll architecture
 * (PR-SIDEBAR-IA-0 Phase 1, xuan msg `c253abe0`).
 *
 * The scroll fix lives in plain CSS — there is no component invariant
 * a unit test can exercise. This file is a cheap grep-style regression
 * gate: if a later phase changes `.maka-session-list` or
 * `.maka-list-stack` and drops the OverlayScrollbars host /
 * viewport / content split or `min-height: 0`, the list stops scrolling and the footer
 * (Settings + Version info) gets pushed off-screen
 * again — the exact P0 WAWQAQ flagged in msg `761141c5`.
 *
 * The fixture seed (`sidebar-long-sessions`, 60 sessions) exists for
 * interactive / E2E use. The sidebar-footer-stays-visible geometry invariant
 * is NOT locked here nor by the `scroll-geometry` E2E spec (which boots the
 * `long-transcript` fixture and checks the chat viewport, not the sidebar);
 * it is tracked separately as a computed-style / E2E contract. This file is
 * the static-analysis gate for the sidebar scroll CSS.
 *
 * Pattern mirrors `stale-sessions.test.ts` "stale session CSS
 * contract" describe block.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';

// Test runs from the desktop workspace root via `node --test dist/...`,
// so `process.cwd()` is `apps/desktop`. Source styles.css lives at
// `src/renderer/styles.css` — we read the source (not a built artifact)
// because the renderer CSS isn't compiled into dist for the test build.
describe('sidebar session list CSS scroll contract (PR-SIDEBAR-IA-0 Phase 1)', () => {
  it('.maka-session-list is a grid with auto + minmax(0, 1fr) rows', async () => {
    // The grid layout is what makes `.maka-list-stack` a constrained
    // scroll body. Without `minmax(0, 1fr)` on the second row, the
    // stack grows to its content height and the overlay viewport becomes
    // a no-op (the original P0).
    const css = await readRendererContractCss();
    // Grab the .maka-session-list rule body. Permissive whitespace
    // matching so a future formatter pass doesn't break the test.
    const ruleBody = extractRuleBody(css, '.maka-session-list');
    assert.ok(ruleBody, '.maka-session-list rule must exist');
    assert.match(ruleBody, /display:\s*grid/, '.maka-session-list must declare display: grid');
    assert.match(
      ruleBody,
      /grid-template-rows:\s*auto\s+minmax\(\s*0\s*,\s*1fr\s*\)/,
      '.maka-session-list must declare grid-template-rows: auto minmax(0, 1fr)',
    );
  });

  it('.maka-session-list has min-height: 0 to allow the grid row to shrink below content', async () => {
    const css = await readRendererContractCss();
    const ruleBody = extractRuleBody(css, '.maka-session-list');
    assert.ok(ruleBody);
    assert.match(
      ruleBody,
      /min-height:\s*0/,
      '.maka-session-list must declare min-height: 0 so the parent grid row constrains its height',
    );
  });

  it('.maka-list-stack uses OverlayScrollbars host + viewport/content split so the scroll body engages', async () => {
    const css = await readRendererContractCss();
    const ruleBody = extractRuleBody(css, '.maka-list-stack');
    const viewportBody = extractRuleBody(css, '.maka-list-stackViewport');
    const contentBody = extractRuleBody(css, '.maka-list-stackContent');
    assert.ok(ruleBody, '.maka-list-stack rule must exist');
    assert.ok(viewportBody, '.maka-list-stackViewport rule must exist');
    assert.ok(contentBody, '.maka-list-stackContent rule must exist');
    assert.match(
      ruleBody,
      /min-height:\s*0/,
      '.maka-list-stack must declare min-height: 0',
    );
    assert.match(
      ruleBody,
      /overflow:\s*hidden/,
      '.maka-list-stack must be the OverlayScrollbars host, not a native overflow:auto scroller',
    );
    assert.match(
      viewportBody,
      /height:\s*100%/,
      '.maka-list-stackViewport must fill the OverlayScrollbars host',
    );
    assert.match(
      contentBody,
      /display:\s*grid/,
      '.maka-list-stackContent must keep the session groups in the compact grid stack',
    );
  });

  it('.maka-session-panel keeps grid-template-rows with minmax(0, 1fr) for the list row', async () => {
    // The outermost panel must still give .maka-session-list a
    // constrained row. This rule existed before Phase 1; the test
    // pins it so a later phase that reshuffles the panel template
    // (e.g. adding a new section) doesn't accidentally remove the
    // minmax(0, 1fr) cell.
    const css = await readRendererContractCss();
    const ruleBody = extractRuleBody(css, '.maka-session-panel');
    assert.ok(ruleBody, '.maka-session-panel rule must exist');
    assert.match(
      ruleBody,
      /grid-template-rows:[^;]*minmax\(\s*0\s*,\s*1fr\s*\)/,
      '.maka-session-panel grid-template-rows must include a minmax(0, 1fr) row',
    );
  });

  it('.maka-session-panel reserves explicit rows for header, nav, session heading, list, and footer', async () => {
    const css = await readRendererContractCss();
    const ruleBody = extractRuleBody(css, '.maka-session-panel');
    assert.ok(ruleBody, '.maka-session-panel rule must exist');
    assert.match(
      ruleBody,
      /grid-template-rows:\s*auto\s+auto\s+auto\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+auto/,
      'sidebar panel must keep the session heading in its own row above the constrained session list',
    );
  });

  it('keeps the sidebar shell flat without a shadow-like gray resize gutter', async () => {
    const css = await readRendererContractCss();
    const listPanel = extractRuleBody(css, '.maka-panel-list.maka-floating-panel');
    const sessionPanel = extractRuleBody(css, '.maka-session-panel');
    const resizeHandle = extractRuleBody(css, '.maka-resize-handle');
    assert.ok(listPanel, '.maka-panel-list.maka-floating-panel rule must exist');
    assert.ok(sessionPanel, '.maka-session-panel rule must exist');
    assert.ok(resizeHandle, '.maka-resize-handle rule must exist');

    assert.match(listPanel, /background:\s*transparent;/, 'sidebar panel must sit flat on the shell canvas, not as its own card');
    assert.match(listPanel, /border-right:\s*0;/, 'sidebar must not draw a divider; the content surface edge supplies separation');
    assert.match(sessionPanel, /background:\s*transparent;/, 'session panel content must stay on the same flat canvas as the shell');
    assert.match(resizeHandle, /background:\s*transparent;/, 'resize hitbox must not paint an 8px gray gutter between sidebar and main');
    assert.match(resizeHandle, /box-sizing:\s*content-box;/, 'zero-width resize handle must keep an overflow hitbox instead of consuming layout gutter');
    assert.match(resizeHandle, /padding-inline:\s*var\(--space-1\);/, 'resize handle should preserve an 8px transparent mouse target');
    assert.match(resizeHandle, /margin-inline:\s*calc\(var\(--space-1\)\s*\*\s*-1\);/, 'resize handle mouse target must not add visible or layout width');
    assert.doesNotMatch(listPanel + sessionPanel + resizeHandle, /box-shadow:/, 'sidebar shell and resize gutter must not add drop shadows');
    assert.doesNotMatch(listPanel + sessionPanel, /calc\(l - 0\.015\)/, 'sidebar shell must not reintroduce the darker wash');
  });
});

/**
 * Extract the body (text between `{` and matching `}`) of a CSS rule
 * by selector. Naive (does not handle nested braces — none of the
 * targeted rules contain them), but enough for top-level flat rules.
 * Returns `undefined` if the selector is not found.
 */
function extractRuleBody(css: string, selector: string): string | undefined {
  // Match `selector { ... }` ignoring extra selectors that might
  // appear on the same rule (e.g. `.a, .b { ... }`). We do an exact
  // selector match anchored at a comma or newline boundary to avoid
  // accidentally matching e.g. `.maka-session-list-title` when looking
  // for `.maka-session-list`.
  const lines = css.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (matchesSelectorLine(line, selector)) {
      // Scan forward to `{`, then collect until matching `}`.
      let braceIndex = line.indexOf('{');
      let cursor = i;
      while (braceIndex === -1 && cursor + 1 < lines.length) {
        cursor++;
        braceIndex = (lines[cursor] ?? '').indexOf('{');
      }
      if (braceIndex === -1) return undefined;
      // Collect from after `{` until closing `}`.
      const body: string[] = [];
      const startLine = lines[cursor] ?? '';
      const startTail = startLine.slice(braceIndex + 1);
      if (startTail.includes('}')) {
        return startTail.slice(0, startTail.indexOf('}'));
      }
      body.push(startTail);
      let j = cursor + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        const closingIdx = next.indexOf('}');
        if (closingIdx !== -1) {
          body.push(next.slice(0, closingIdx));
          return body.join('\n');
        }
        body.push(next);
        j++;
      }
      return undefined;
    }
    i++;
  }
  return undefined;
}

/**
 * Return true if `line` starts a CSS rule whose selector list contains
 * `selector` as an exact token (not a substring of another class).
 */
function matchesSelectorLine(line: string, selector: string): boolean {
  // The selector must appear at the START of the line (allowing only
  // whitespace before). After trimming the suffix, the remainder must
  // start a selector-list delimiter (`,`), an opening block (`{`), or
  // end immediately — descendant selectors like
  // `.maka-session-list .child` must NOT match.
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(selector)) return false;
  const rest = trimmed.slice(selector.length).trimStart();
  return rest === '' || rest.startsWith(',') || rest.startsWith('{');
}
