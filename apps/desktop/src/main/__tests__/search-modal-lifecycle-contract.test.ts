import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { renderSessionListPanel } from './session-list-render-helpers.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const searchModalPath = resolve(
  repoRoot,
  'packages',
  'ui',
  'src',
  'search-modal.tsx',
);

describe('SearchModal lifecycle and interaction contract', () => {
  it('uses conditional mounting instead of an open compatibility prop', async () => {
    const [searchModal, renderer] = await Promise.all([
      readFile(searchModalPath, 'utf8'),
      readRendererShellCombinedSource(),
    ]);

    assert.match(searchModal, /export function SearchModal\(props: \{/);
    assert.match(
      searchModal,
      /onClose\(options\?: \{ restoreFocus\?: boolean \}\): void/,
    );
    assert.doesNotMatch(searchModal, /\bopen\s*:/);
    assert.doesNotMatch(searchModal, /if\s*\(\s*!props\.open\s*\)/);
    assert.match(
      renderer,
      /\{searchModalOpen\s*&&\s*\(?\s*<SearchModal\s+onClose=\{closeSearchModal\}/,
    );
    assert.doesNotMatch(renderer, /<SearchModal\s+open=/);
  });

  it('delegates dialog, input, keyboard, focus, and selection to Astryx', async () => {
    const source = await readFile(searchModalPath, 'utf8');

    assert.match(source, /CommandPalette as AstryxCommandPalette/);
    assert.match(
      source,
      /<AstryxCommandPalette[\s\S]*searchSource=\{searchSource\}/,
    );
    assert.match(source, /<CommandPaletteInput[\s\S]*label=\{copy\.conversationsLabel\}/);
    assert.match(source, /<CommandPaletteFooter>/);
    assert.doesNotMatch(source, /@base-ui\/react\/autocomplete/);
    assert.doesNotMatch(
      source,
      /<input\b|<button\b|onKeyDown=|querySelector\(|requestAnimationFrame/,
    );
  });

  it('adapts only the product search boundary to Astryx SearchSource', async () => {
    const source = await readFile(searchModalPath, 'utf8');

    assert.match(source, /const searchSource = useMemo<SearchSource<SearchItem>>/);
    assert.match(source, /bootstrap: \(\) => \[\]/);
    assert.match(source, /search: async \(query\) =>/);
    assert.match(
      source,
      /input\.searchThread\(\{[\s\S]*source: 'thread',[\s\S]*query: trimmed,[\s\S]*limit: 10/,
    );
    assert.match(source, /if \(!Array\.isArray\(response\)\)/);
    assert.match(source, /catch \(caught\)/);
    assert.match(source, /searchModalThrownErrorMessage/);
    assert.doesNotMatch(source, /setTimeout|debounce|AbortController/);
  });

  it('navigates to the exact session turn selected by Astryx', async () => {
    const [searchModal, renderer] = await Promise.all([
      readFile(searchModalPath, 'utf8'),
      readRendererShellCombinedSource(),
    ]);

    assert.match(
      searchModal,
      /props\.onNavigateToSession\?\.\(\s*result\.target\.sessionId,\s*result\.target\.turnId,\s*\)/,
    );
    assert.match(
      renderer,
      /openSessionInChatRef\.current\(sessionId, turnId\)/,
    );
  });

  it('renders snippets as React text and localizes public states', async () => {
    const [searchModal, copy] = await Promise.all([
      readFile(searchModalPath, 'utf8'),
      readFile(
        resolve(repoRoot, 'packages/ui/src/shell-controls-copy.ts'),
        'utf8',
      ),
    ]);

    assert.match(searchModal, /<mark[\s\S]*className="maka-search-modal-snippet-hit"/);
    assert.doesNotMatch(searchModal, /dangerouslySetInnerHTML/);
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
      assert.match(searchModal, new RegExp(`copy\\.${key}`));
    }
    assert.match(copy, /errorFallback: '搜索服务需要刷新，请重试。'/);
    assert.match(
      copy,
      /errorFallback: 'Search needs to be refreshed. Try again.'/,
    );
  });

  it('returns focus to the search trigger after dismissal', async () => {
    const renderer = await readRendererShellCombinedSource();

    assert.match(
      renderer,
      /function closeSearchModal\(options\?: \{ restoreFocus\?: boolean \}\) \{[\s\S]*setSearchModalOpen\(false\);[\s\S]*options\?\.restoreFocus === false[\s\S]*requestAnimationFrame/,
    );
    assert.match(
      renderer,
      /querySelector<HTMLButtonElement>\('\[data-maka-search-trigger="true"\]'\)[\s\S]*focus\(\{ preventScroll: true \}\)/,
    );
  });

  it('leaves destination focus ownership to the selected search result', async () => {
    const source = await readFile(searchModalPath, 'utf8');

    assert.match(
      source,
      /restoreFocusOnCloseRef\.current = false;[\s\S]*props\.onNavigateToSession/,
    );
    assert.match(
      source,
      /props\.onClose\(\{[\s\S]*restoreFocus: restoreFocusOnCloseRef\.current/,
    );
  });

  it('keeps sessions without messages in the flat conversation list', () => {
    const markup = renderSessionListPanel({
      session: { lastMessageAt: undefined },
    });

    assert.match(markup, />测试会话</);
    assert.doesNotMatch(markup, /maka-list-group-label/);
    assert.doesNotMatch(markup, /待发送|尚未发送/);
  });
});
