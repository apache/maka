import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRendererContractCss } from './contract-css-helpers.js';

/**
 * Geometry and content-avoidance contract for the titlebar band.
 *
 * Window-drag ownership is NOT checked here — it belongs to
 * `app-region-hygiene-contract.test.ts`, which pins the single
 * `.maka-titlebar-drag-layer` authority and its document-order requirement.
 * What survives here are the layout invariants: the rail stays visually in the
 * titlebar, and the header insets keep CONTENT (not hit regions) clear of the
 * absolutely-positioned titlebar controls.
 */
describe('sidebar topbar rail geometry contract', () => {
  it('keeps the rail in the titlebar and header content clear of the titlebar controls', async () => {
    const css = await readRendererContractCss();

    const tokenRule = ruleBody(css, '.maka-shell-2col');
    assert.match(
      tokenRule,
      /--maka-sidebar-collapsed-topbar-inset\s*:/,
      'collapsed chat header content must have a left inset clearing the titlebar actions',
    );
    assert.match(
      tokenRule,
      /--maka-titlebar-drag-band-height\s*:\s*calc\(\s*var\(--maka-sidebar-topbar-offset-y\)/,
      'the drag band height must be derived from the rail offset so moving the rail moves the band with it, instead of leaving a hand-tuned literal behind',
    );
    assert.doesNotMatch(
      css,
      /--maka-sidebar-collapsed-topbar-offset-y/,
      'do not fix collapsed hit testing by moving the titlebar actions below the titlebar',
    );

    const collapsedRail = optionalRuleBody(css, '.maka-shell-topbar-rail.is-collapsed');
    if (collapsedRail) {
      assert.doesNotMatch(
        collapsedRail,
        /top\s*:/,
        'collapsed shell controls must not get a special vertical offset; keep the rail visually in the titlebar and let the drag band sit underneath it',
      );
    }

    const chatHeader = ruleBody(css, '.maka-chat-header');
    assert.match(
      chatHeader,
      /margin-right:\s*var\(--maka-workspace-top-actions-inset\)/,
      'right-aligned chat header content must stay clear of the workspace top actions toolbar',
    );
    const collapsedChatHeader = ruleBody(
      css,
      '.maka-shell-2col[data-sidebar-state="collapsed"] .maka-chat-header',
    );
    assert.match(
      collapsedChatHeader,
      /margin-left:\s*var\(--maka-sidebar-collapsed-topbar-inset\)/,
      'when the sidebar is collapsed, chat header content must start after the left titlebar buttons',
    );
  });

  it('clears the titlebar band on the sidebar panel itself, with no placeholder element', async () => {
    const css = await readRendererContractCss();
    const sidebarPanel = exactRuleBody(css, '.maka-session-panel');
    assert.match(
      sidebarPanel,
      /padding-top:\s*calc\(\s*var\(--maka-titlebar-drag-band-height\)/,
      'the sidebar must clear the titlebar band from its own padding, derived from the band height rather than restating a literal (the clearance used to come from an empty `<header>` holding a blank drag strip, and a bare 34px replacement silently collapsed under border-box and lifted the whole nav by 8px)',
    );
    assert.doesNotMatch(
      css,
      /\.maka-session-panel-header\s*[,{]/,
      'the blank `.maka-session-panel-header` placeholder is retired; the sidebar panel owns its own titlebar clearance',
    );
  });
});

function ruleBody(css: string, selector: string): string {
  const body = optionalRuleBody(css, selector);
  assert.ok(body, `${selector} rule must exist`);
  return body;
}

function optionalRuleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1];
}

/**
 * Body of the rule whose selector is EXACTLY `selector`.
 *
 * `optionalRuleBody` matches the selector as a substring, so asking it for
 * `.maka-session-panel` returns whichever rule mentions it first — including
 * `.maka-shell-2col .maka-panel-list > .maka-session-panel`. That is fine for
 * selectors that appear once, but not for one that also exists as a descendant
 * in another rule.
 */
function exactRuleBody(css: string, selector: string): string {
  const pattern = new RegExp(
    `(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`,
    'm',
  );
  const body = pattern.exec(css)?.[1];
  assert.ok(body, `a rule with the exact selector '${selector}' must exist`);
  return body;
}
