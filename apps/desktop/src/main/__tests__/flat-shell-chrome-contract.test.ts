/**
 * Official flat AppShell chrome contract (#1312).
 *
 * The former e2e walked platform×theme combos measuring live box-shadow /
 * background-image / opacity on the shell surfaces. Those outcomes are owned
 * by source CSS: the shell must fill the window through min-width/min-height 0
 * + overflow hidden, paint a flat canvas/detail surface, and not attach a
 * product gradient or box-shadow on the shell host. Pin the declarations on
 * each rule body; keep interactive shell journeys in e2e.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, stripCssComments, cssRuleBody } from './css-test-helpers.js';

const SHELL_LAYOUT = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/shell-layout.css');
const REFERENCE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/reference-shell.css');

async function readCss(path: string): Promise<string> {
  return stripCssComments(await readFile(path, 'utf8'));
}

describe('flat shell chrome CSS contract', () => {
  it('keeps the Astryx shell a full-window constrained flat host', async () => {
    const shell = await readCss(SHELL_LAYOUT);
    const appFrame = cssRuleBody(shell, '.appFrame');
    const host = cssRuleBody(shell, '.maka-shell-astryx');
    const detail = cssRuleBody(shell, '.maka-shell-astryx .maka-panel-detail');

    assert.ok(appFrame, '.appFrame rule must exist');
    assert.match(appFrame!, /width:\s*100%/);
    assert.match(appFrame!, /background:\s*var\(--surface-canvas\)/);
    assert.doesNotMatch(appFrame!, /background-image\s*:/);
    assert.doesNotMatch(appFrame!, /box-shadow\s*:/);

    assert.ok(host, '.maka-shell-astryx rule must exist');
    assert.match(host!, /width:\s*100%/);
    assert.match(host!, /min-width:\s*0/);
    assert.match(host!, /min-height:\s*0/);
    assert.match(host!, /overflow:\s*hidden/);
    // AppShell paints the columns from its own variant materials. The host must
    // not declare a background at all: repainting it — transparent included —
    // means the product is deciding a column surface behind the shell's back.
    assert.doesNotMatch(host!, /background\s*:/);
    assert.doesNotMatch(host!, /background-image\s*:/);
    assert.doesNotMatch(host!, /box-shadow\s*:/);
    assert.doesNotMatch(host!, /filter\s*:/);
    assert.doesNotMatch(host!, /opacity\s*:/);

    assert.ok(detail, '.maka-shell-astryx .maka-panel-detail rule must exist');
    assert.match(detail!, /min-width:\s*0/);
    assert.match(detail!, /min-height:\s*0/);
    // Same rule as the host above, one level in: AppShell paints the content
    // column, so the product's box inside it declares layout and nothing else.
    // The rendered material is asserted in e2e/sidebar-geometry.spec.ts against
    // AppShell's own element, which is the only place it can be measured
    // honestly.
    assert.doesNotMatch(detail!, /background\s*:/);
    assert.match(detail!, /padding-top:\s*var\(--h-titlebar\)/);
    assert.doesNotMatch(detail!, /background-image\s*:/);
    assert.doesNotMatch(detail!, /box-shadow\s*:/);
  });

  it('keeps the reference shell flatness override present', async () => {
    const reference = await readCss(REFERENCE);
    assert.match(
      reference,
      /box-shadow:\s*none/,
      'reference shell flatness override must remain present',
    );
  });
});
