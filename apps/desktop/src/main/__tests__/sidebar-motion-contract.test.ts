import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_RENDERER_ROOT,
  readRendererContractCss,
} from './contract-css-helpers.js';

describe('sidebar structural motion contract', () => {
  it('moves the layout with the drawer tokens while the sidebar content keeps its expanded geometry', async () => {
    const [css, appShell] = await Promise.all([
      readRendererContractCss(),
      readFile(resolve(CONTRACT_RENDERER_ROOT, 'app-shell.tsx'), 'utf8'),
    ]);

    const shellRule = ruleBody(css, '.maka-shell-2col');
    assert.match(
      shellRule,
      /transition:\s*grid-template-columns var\(--duration-large\) var\(--ease-drawer\)/,
      'sidebar layout changes should use the shared structural-motion tokens',
    );
    const expandedShellRule = ruleBody(css, '.app.maka-shell-2col');
    assert.match(
      expandedShellRule,
      /grid-template-columns:\s*var\(--maka-session-list-expanded-width\)\s+var\(--maka-resize-handle-width,\s*0px\)\s+minmax\(0,\s*1fr\)/,
      'the expanded target should read from the single authoritative remembered-width variable',
    );

    const sidebarPanelRule = ruleBody(
      css,
      '.maka-shell-2col .maka-panel-list > .maka-session-panel',
    );
    assert.match(
      sidebarPanelRule,
      /width:\s*var\(--maka-session-list-expanded-width\)/,
      'the sidebar content should keep its expanded width while the grid track clips it',
    );

    const collapsedPanelRule = ruleBody(
      css,
      '.maka-shell-2col[data-sidebar-state="collapsed"] .maka-panel-list.maka-floating-panel',
    );
    assert.match(collapsedPanelRule, /opacity:\s*0/, 'collapsed sidebar content should fade out');
    assert.match(
      collapsedPanelRule,
      /transform:\s*translateX\(var\(--maka-sidebar-exit-offset\)\)/,
      'collapsed sidebar content should move slightly toward its exit edge',
    );

    assert.match(
      appShell,
      /'--maka-session-list-expanded-width':\s*`\$\{sessionListWidth\}px`/,
      'the shell should expose the remembered expanded width independently from the animated track width',
    );
    assert.doesNotMatch(
      appShell,
      /<SessionListPanel[\s\S]*?sidebarCollapsed=\{sessionListCollapsed\}[\s\S]*?\/>/,
      'the inner panel must not switch to its compact rail geometry before the outer track finishes closing',
    );
  });

  it('keeps the chat header avoidance geometry synchronized with the drawer', async () => {
    const css = await readRendererContractCss();
    const chatHeaderRule = ruleBody(css, '.maka-chat-header');

    assert.match(
      chatHeaderRule,
      /transition:\s*margin-left var\(--duration-large\) var\(--ease-drawer\)/,
      'the chat header hit-area inset should move with the surrounding layout',
    );
  });

  it('gives both sidebar states the same explicit three-track shape', async () => {
    const css = await readRendererContractCss();
    const collapsedShellRule = ruleBody(
      css,
      '.app.maka-shell-2col[data-sidebar-state="collapsed"]',
    );

    assert.match(
      collapsedShellRule,
      /grid-template-columns:\s*0px\s+var\(--maka-resize-handle-width,\s*0px\)\s+minmax\(0,\s*1fr\)/,
      'the collapsed target must preserve all three explicit tracks so Chromium can interpolate the grid instead of falling back to one implicit column',
    );
  });
});

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1];
  assert.ok(body, `${selector} rule must exist`);
  return body;
}
