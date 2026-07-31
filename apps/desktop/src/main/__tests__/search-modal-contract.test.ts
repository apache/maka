import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { renderSessionListPanel } from './session-list-render-helpers.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const searchModalPath = resolve(repoRoot, 'packages/ui/src/search-modal.tsx');

describe('SearchModal product contract', () => {
  it('delegates dialog, search input, keyboard, focus, and selection to Astryx', async () => {
    const [source, renderer] = await Promise.all([
      readFile(searchModalPath, 'utf8'),
      readRendererShellCombinedSource(),
    ]);

    assert.match(source, /CommandPalette as AstryxCommandPalette/);
    assert.match(source, /isOpen: boolean;/);
    assert.match(source, /onOpenChange\(isOpen: boolean\): void/);
    assert.match(source, /<AstryxCommandPalette[\s\S]*isOpen=\{props\.isOpen\}[\s\S]*onOpenChange=\{props\.onOpenChange\}[\s\S]*searchSource=\{searchSource\}/);
    assert.match(source, /<CommandPaletteInput[\s\S]*label=\{copy\.conversationsLabel\}/);
    assert.match(source, /<CommandPaletteFooter>/);
    assert.match(
      renderer,
      /<SearchModal[\s\S]*isOpen=\{searchModalOpen\}[\s\S]*onOpenChange=\{\(open\) => \{[\s\S]*if \(!open\) closeSearchModal\(\);/,
    );
    assert.doesNotMatch(source, /@base-ui\/react\/autocomplete/);
    assert.doesNotMatch(source, /<input\b|<button\b|onKeyDown=|querySelector\(/);
  });

  it('adapts only the product search boundary to Astryx SearchSource', async () => {
    const source = await readFile(searchModalPath, 'utf8');

    assert.match(source, /createThreadSearchSource/);
    assert.match(source, /bootstrap: \(\) => \[\]/);
    assert.match(source, /search: async \(query\) =>/);
    assert.match(source, /input\.searchThread\(\{[\s\S]*source: 'thread',[\s\S]*query: trimmed,[\s\S]*limit: 10/);
    assert.match(source, /cancel: \(\) => \{\s*generation \+= 1;/);
    assert.match(source, /if \(generation !== requestGeneration\) return \[\];/);
    assert.doesNotMatch(source, /setTimeout|debounce|AbortController/);
  });

  it('lets Astryx close before navigating to the exact selected turn', async () => {
    const [source, renderer] = await Promise.all([
      readFile(searchModalPath, 'utf8'),
      readRendererShellCombinedSource(),
    ]);

    assert.match(
      source,
      /onValueChange=\{\(itemId\) => \{[\s\S]*pendingNavigationRef\.current = \{[\s\S]*sessionId: result\.target\.sessionId,[\s\S]*turnId: result\.target\.turnId/,
    );
    assert.match(
      source,
      /if \(props\.isOpen\) return;[\s\S]*const navigation = pendingNavigationRef\.current;[\s\S]*pendingNavigationRef\.current = null;[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*props\.onNavigateToSession\?\.\(navigation\.sessionId, navigation\.turnId\)/,
    );
    assert.match(renderer, /openSessionInChatRef\.current\(sessionId, turnId\)/);
  });

  it('renders snippets as React text and localizes public states', async () => {
    const [source, copy] = await Promise.all([
      readFile(searchModalPath, 'utf8'),
      readFile(resolve(repoRoot, 'packages/ui/src/shell-controls-copy.ts'), 'utf8'),
    ]);

    assert.match(source, /<mark[\s\S]*className="maka-search-modal-snippet-hit"/);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
    for (const key of [
      'title',
      'placeholder',
      'conversationsLabel',
      'resultsLabel',
      'introduction',
      'unavailable',
      'empty',
      'privacyDetail',
      'errorFallback',
    ]) {
      assert.match(source, new RegExp(`copy\\.${key}`));
    }
    assert.match(copy, /errorFallback: '搜索服务需要刷新，请重试。'/);
    assert.match(copy, /errorFallback: 'Search needs to be refreshed. Try again.'/);
  });

  it('keeps sessions without messages in the flat conversation list', () => {
    const markup = renderSessionListPanel({ session: { lastMessageAt: undefined } });

    assert.match(markup, />测试会话</);
    assert.doesNotMatch(markup, /maka-list-group-label/);
    assert.doesNotMatch(markup, /待发送|尚未发送/);
  });
});
