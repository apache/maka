/**
 * Static-analysis contract test for the SearchModal lifecycle
 * (PR-SIDEBAR-IA-0 Phase 3 P0 fixup).
 *
 * Background:
 *   WAWQAQ hit a React #310 ("Rendered fewer hooks than expected")
 *   in a real-window run of the Phase 3 build (msg `d53852ac`).
 *   xuan + kenji gated the merge until the lifecycle pattern is
 *   locked (xuan `558f1356`, kenji `3ddc91fe`).
 *
 *   The original SearchModal sat hooks BEFORE an `if (!open) return
 *   null`. While React technically allows hooks-then-early-return,
 *   it's a fragile pattern: adding a new hook below the return
 *   silently violates rules-of-hooks. The fixup matches
 *   `KeyboardHelpModal`'s conditional-mount pattern instead:
 *
 *     parent: `{open && <SearchModal onClose={...} />}`
 *     child:  function SearchModal({ onClose }) { ...hooks...; return JSX }
 *
 * This file is a grep-style gate. It does NOT mount React (the
 * desktop test setup has no DOM); the runtime exercise of the
 * mount/unmount cycle is covered by:
 *   - The `sidebar-search-modal-open` e2e-fixture scenario, which
 *     forces the modal open at startup
 *     (verifies it can MOUNT cleanly).
 *   - The `sidebar-long-sessions` scenario, which renders the
 *     default state (verifies the renderer mounts cleanly WITHOUT
 *     the modal — the parent's `&&` guard skips the SearchModal
 *     subtree).
 *
 * If a future change reintroduces the `open` prop or the early
 * return inside SearchModal, this gate flips red.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { renderSessionListPanel } from './session-list-render-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const COMPONENTS_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'chat-view.tsx');
const CHAT_TURN_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'chat-turn.tsx');
const CHAT_SCROLL_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'use-chat-scroll.ts');
const SEARCH_MODAL_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'search-modal.tsx');
const SHELL_CONTROLS_COPY_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'shell-controls-copy.ts');
const COMMAND_PALETTE_CONTENT_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'command-palette-content-search.ts');

describe('SearchModal lifecycle contract (PR-SIDEBAR-IA-0 Phase 3 P0 fixup)', () => {
  it('SearchModal signature has close and navigation callbacks — NO `open` prop (conditional-mount contract)', async () => {
    // The fragile `<SearchModal open={x} ...>` API is gone. The
    // parent owns lifecycle via `{open && <SearchModal .../>}`,
    // so SearchModal never has to do an early-return-before-JSX.
    const src = await readFile(SEARCH_MODAL_PATH, 'utf8');
    // Find the `export function SearchModal(...)` declaration.
    const match = src.match(/export function SearchModal\s*\(\s*props\s*:\s*\{([^}]+)\}\s*\)/);
    assert.ok(match, 'SearchModal export must exist');
    const propBlock = match[1]!;
    assert.doesNotMatch(
      propBlock,
      /\bopen\s*:/,
      'SearchModal must NOT take an `open` prop (parent owns lifecycle via conditional mount)',
    );
    assert.match(
      propBlock,
      /onClose\(options\?: SearchModalCloseOptions\): void/,
      'SearchModal must take a close callback with optional focus-restore control',
    );
  });

  it('SearchModal body has NO `if (!props.open) return null` early return', async () => {
    // The hooks-before-early-return pattern is removed. Match the
    // SearchModal function body and confirm no `if (...) return
    // null` shows up before the final `return (`. We grep the
    // narrow block between the signature and the next `^}` line.
    const src = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const startIdx = src.indexOf('export function SearchModal');
    assert.notEqual(startIdx, -1);
    const signatureEnd = src.indexOf(') {', startIdx);
    assert.notEqual(signatureEnd, -1);
    const bodyStart = signatureEnd + 2;
    assert.notEqual(bodyStart, -1);
    const bodyEnd = findMatchingBrace(src, bodyStart);
    assert.notEqual(bodyEnd, -1);
    const body = src.slice(bodyStart, bodyEnd);
    assert.doesNotMatch(
      body,
      /if\s*\(\s*!props\.open\s*\)\s*return\s*null/,
      'SearchModal body must NOT contain `if (!props.open) return null` — conditional mount lives at the parent',
    );
  });

  it('renderer mounts SearchModal conditionally via `{searchModalOpen && ...}`', async () => {
    // The fixup pattern at the call site: parent's `&&` short-
    // circuits before SearchModal is ever rendered, so its hooks
    // run only when open=true, with a fresh fiber each time.
    const src = await readRendererShellCombinedSource();
    // PR-UX-POLISH-1 commit 5 (relax-only): allow optional `(` between
    // `&&` and `<SearchModal` so multi-line JSX with multiple props
    // (`onClose`, `deps`, `onNavigateToSession`) still satisfies the
    // contract. The semantic gate — conditional mount on
    // `searchModalOpen` — is unchanged. Also relax the prop-anchor:
    // any prop name starting with `on` (`onClose`, `onNavigateToSession`)
    // is acceptable so future prop reorders don't trip the regex.
    assert.match(
      src,
      /\{searchModalOpen\s*&&\s*\(?\s*<SearchModal\s+on[A-Z]/,
      'renderer must mount SearchModal via `{searchModalOpen && <SearchModal ... />}` with at least one `on*` prop',
    );
    assert.doesNotMatch(
      src,
      /<SearchModal\s+open=/,
      'renderer must NOT pass `open=` to SearchModal — conditional mount instead',
    );
  });

  it('returns focus to the sidebar Search trigger when the modal closes', async () => {
    const main = await readRendererShellCombinedSource();
    const shellSearchButton = main.match(/className="maka-titlebar-action"[\s\S]*?data-maka-search-trigger="true"[\s\S]*?<\/TooltipTrigger>/)?.[0] ?? '';
    const closeSearchModal = main.match(/function closeSearchModal\(options\?: \{ restoreFocus\?: boolean \}\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      shellSearchButton,
      /data-maka-search-trigger="true"[\s\S]*aria-label=\{copy\.searchConversations\}/,
      'Shell top Search trigger must be queryable for focus restoration after modal close',
    );
    assert.match(
      closeSearchModal,
      /setSearchModalOpen\(false\);[\s\S]*requestAnimationFrame/,
      'Search close handler must defer focus restoration until after React unmounts the modal',
    );
    assert.match(
      closeSearchModal,
      /if \(options\?\.restoreFocus === false\) return;/,
      'Search close handler must allow result navigation to keep focus with the destination chat content',
    );
    assert.match(
      closeSearchModal,
      /querySelector<HTMLButtonElement>\('\[data-maka-search-trigger="true"\]'\)[\s\S]*focus\(\{ preventScroll: true \}\)/,
      'Search close handler must restore keyboard focus to the Search trigger',
    );
    assert.match(
      main,
      /<SearchModal\s+onClose=\{closeSearchModal\}/,
      'SearchModal must use the focus-restoring close handler',
    );
  });

  it('KeyboardHelpModal still uses conditional mount (alignment with SearchModal pattern)', async () => {
    // Sanity gate: SearchModal's new shape matches
    // KeyboardHelpModal's existing shape. If KeyboardHelpModal
    // ever flips to always-mounted with an internal early return,
    // we want to know — that would re-introduce the same class of
    // hook-order foot-guns.
    const src = await readRendererShellCombinedSource();
    assert.match(
      src,
      /\{helpOpen\s*&&\s*<KeyboardHelpModal\s+onClose=/,
      'renderer must mount KeyboardHelpModal conditionally (same pattern as SearchModal)',
    );
  });

  it('search result navigation consumes target.turnId instead of only switching sessions', async () => {
    const searchModalSource = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const components = await readFile(COMPONENTS_PATH, 'utf8');
    const chatTurn = await readFile(CHAT_TURN_PATH, 'utf8');
    const chatScroll = await readFile(CHAT_SCROLL_PATH, 'utf8');
    const main = await readRendererShellCombinedSource();
    const contentSearch = await readFile(COMMAND_PALETTE_CONTENT_PATH, 'utf8');

    assert.match(
      searchModalSource,
      /props\.onNavigateToSession\(result\.target\.sessionId,\s*result\.target\.turnId\)/,
      'SearchModal must pass the matched turnId through to the renderer shell',
    );
    assert.match(
      searchModalSource,
      /props\.onClose\(\{ restoreFocus: false \}\)/,
      'Search result activation must not restore focus to the Search trigger after navigating to the matched chat turn',
    );
    assert.match(
      contentSearch,
      /onSelectSession\(hit\.sessionId,\s*hit\.turnId\)/,
      'Command Palette content-search hits must pass the matched turnId through too',
    );
    assert.doesNotMatch(
      main,
      /onNavigateToSession=\{\(sessionId,\s*_turnId\)/,
      'renderer must not intentionally ignore SearchResult.target.turnId',
    );
    assert.match(
      main,
      /setSearchScrollTarget\(\{\s*sessionId,\s*turnId,\s*nonce:/,
      'renderer must store a turn scroll target when search provides one',
    );
    assert.match(
      main,
      /scrollTargetTurn=\{[\s\S]*searchScrollTarget\.turnId[\s\S]*searchScrollTarget\.nonce[\s\S]*\}/,
      'renderer must pass the pending search turn target into ChatView',
    );
    assert.match(
      components,
      /scrollTargetTurn\?:\s*\{\s*turnId:\s*string;\s*nonce:\s*number\s*\}/,
      'ChatView must expose a typed scroll target prop',
    );
    assert.match(
      chatScroll,
      /scrollIntoView\(\{\s*behavior:\s*input\.behavior\s*\?\?\s*'smooth',\s*block:\s*'center'/,
      'ChatView must scroll the matched turn into view',
    );
    assert.match(
      chatScroll,
      /function scrollToBottom\(\) \{[\s\S]*scrollTo\(\{\s*top:\s*viewport\.scrollHeight,\s*behavior:\s*input\.behavior\s*\?\?\s*'smooth'\s*\}\);/,
      'ChatView jump-to-latest must honor the same reduced-motion/e2e-fixture scroll policy as search navigation',
    );
    assert.match(
      chatScroll,
      /targetElement\.setAttribute\('tabindex', '-1'\);[\s\S]*targetElement\.focus\(\{ preventScroll: true \}\);/,
      'ChatView must move keyboard focus to the matched turn after search navigation',
    );
    assert.match(
      chatTurn,
      /data-search-highlight=\{props\.searchHighlighted\s*\?\s*'true'\s*:\s*undefined\}/,
      'ChatView must visually mark the matched search turn',
    );
    assert.match(
      chatTurn,
      /tabIndex=\{props\.searchHighlighted \? -1 : undefined\}/,
      'Highlighted search turns must be programmatically focusable while the search target is active',
    );
  });

  it('search results use Base UI Autocomplete for listbox + keyboard selection (#520 PR8)', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const styles = await readRendererContractCss();

    // #520 PR8: SearchModal converges onto Base UI Autocomplete instead of a
    // hand-rolled roving-focus listbox. Autocomplete owns the listbox/option
    // ARIA + ArrowUp/Down/Enter/Escape keyboard nav (activedescendant mode:
    // input keeps focus, active item reflected via aria-activedescendant).
    assert.match(
      searchModal,
      /import \{ Autocomplete \} from '@base-ui\/react\/autocomplete'/,
      'SearchModal must consume Base UI Autocomplete for the result list',
    );
    assert.match(
      searchModal,
      /<Autocomplete\.Root[\s\S]*?inline[\s\S]*?\bopen\b[\s\S]*?mode="none"[\s\S]*?autoHighlight="always"[\s\S]*?\bkeepHighlight\b[\s\S]*?filter=\{null\}/,
      'Autocomplete.Root must render `inline open` + keepHighlight: `inline open` so the list is treated as visible (Base UI docs); keepHighlight so pointer leave preserves the hovered highlight (hover item -> leave -> Enter runs that item, not the first — #562 P2); mode="none" (server-side IPC filtering, no local filter) + autoHighlight="always" so Enter on the first result works without an extra ArrowDown',
    );
    assert.match(
      searchModal,
      /<Autocomplete\.Root[\s\S]*?itemToStringValue=\{\(result\) => result\.title/,
      'Autocomplete.Root must serialize object results via itemToStringValue — without it, item-press can write [object Object] back into the query',
    );
    assert.match(searchModal, /<Autocomplete\.Input/, 'Search input must be Autocomplete.Input');
    assert.match(searchModal, /<Autocomplete\.List/, 'Results must render as Autocomplete.List (listbox)');
    assert.match(
      searchModal,
      /<Autocomplete\.Item[\s\S]*?onClick=\{\(\) => selectResult\(result\)\}/,
      'Each result must be Autocomplete.Item with onClick firing selectResult (pointer click or Enter on highlighted)',
    );
    // selectResult navigation contract is unchanged from the roving-focus era.
    assert.match(
      searchModal,
      /props\.onNavigateToSession\(result\.target\.sessionId,\s*result\.target\.turnId\)/,
      'selectResult must still pass sessionId + turnId to the shell navigation callback',
    );
    assert.match(
      searchModal,
      /props\.onClose\(\{ restoreFocus: false \}\)/,
      'selectResult must still skip focus restore so the destination chat owns focus',
    );
    assert.match(
      searchModal,
      /className="maka-search-modal-body" role="region" aria-label=\{copy\.statusRegionLabel\} aria-live="polite"/,
      'Search modal body region must still expose an accessible name',
    );
    assert.match(
      styles,
      /\.maka-search-modal-result\[data-highlighted\]/,
      'Highlighted (active) search result must have dedicated styling (Autocomplete data-highlighted replaces the old data-active)',
    );
    // P2-c: Home/End decision — accept Base UI ComboboxInput's input-cursor
    // default. The old roving-focus jumpActiveResult (Home/End -> first/last)
    // must not return.
    assert.doesNotMatch(
      searchModal,
      /\bjumpActive\w*\(/,
      'Home/End must NOT jump highlight — Base UI input-cursor default is the decided behavior (#562 P2-c)',
    );
  });

  it('search input keeps focus after results load until the user navigates results', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');

    assert.match(
      searchModal,
      /initialFocus=\{inputRef\}/,
      'SearchModal must give initial modal focus to the search input, not the close button',
    );
    assert.match(
      searchModal,
      /finalFocus=\{\(\) => \(suppressFocusRestoreRef\.current \? false : true\)\}/,
      'SearchModal must skip Base UI focus restore when navigating to a result so the destination owns focus',
    );
    // #520 PR8: activedescendant mode keeps focus in the input; the active
    // item is reflected via aria-activedescendant managed by Autocomplete.
    // The old activeResultIndex / moveActiveResult / jumpActiveResult
    // roving-focus machinery is gone.
  });

  it('search query has an explicit clear button because the native search cancel is hidden', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const styles = await readRendererContractCss();

    assert.match(styles, /\.maka-search-modal-input::-webkit-search-cancel-button\s*\{\s*display:\s*none;/, 'Native search cancel is intentionally hidden for visual consistency');
    assert.match(searchModal, /query\.length > 0 && \(/, 'Clear button should appear only when the query has content');
    assert.match(searchModal, /<UiButton\s+variant="quiet"\s+size="icon-sm"\s+type="button"\s+aria-label=\{copy\.clearLabel\}/, 'Search modal must provide a governed compact clear button');
    assert.match(searchModal, /onClick=\{clearSearchQuery\}/, 'Clear search button must use the shared clear helper');
    assert.match(searchModal, /function clearSearchQuery\(\) \{[\s\S]*setQuery\(''\);[\s\S]*clearSearchState\(\);[\s\S]*inputRef\.current\?\.focus\(\);[\s\S]*\}/, 'Clear search helper must clear the query, invalidate search state, and return focus to input');
    assert.doesNotMatch(styles, /\.maka-search-modal-clear/, 'Clear search button styling belongs to the shared Button primitive');
  });

  it('search input shell uses shared primitive InputGroup instead of a hand-rolled grid wrapper', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const styles = await readRendererContractCss();
    const inputRowStyle = styles.match(/\.maka-search-modal-input-row\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(
      searchModal,
      /import \{ InputGroup, InputGroupAddon, InputGroupInput \} from '\.\/primitives\/input-group\.js';/,
      'SearchModal must consume the vendored shared primitive InputGroup primitives',
    );
    assert.match(
      searchModal,
      /<InputGroup className="maka-search-modal-input-row" aria-label=\{copy\.conversationsLabel\}>[\s\S]*<InputGroupAddon>[\s\S]*<InputGroupInput[\s\S]*<InputGroupAddon align="inline-end">/,
      'SearchModal search field must be structured as shared primitive InputGroup + addons',
    );
    assert.doesNotMatch(
      searchModal,
      /<div className="maka-search-modal-input-row"/,
      'SearchModal must not regress to the previous hand-rolled input-row wrapper',
    );
    assert.doesNotMatch(
      inputRowStyle,
      /display:\s*grid/,
      'Search modal input row styling must not restore the old grid shell over shared primitive InputGroup',
    );
    assert.match(
      inputRowStyle,
      /margin:\s*var\(--space-2\)\s*var\(--space-3\);/,
      'Search modal InputGroup should keep the compact modal inset spacing',
    );
  });

  it('empty query invalidates any already-started search request from every clear path', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');

    assert.match(searchModal, /function clearSearchState\(\) \{\s*ticketRef\.current \+= 1;\s*setResults\(\[\]\);/m, 'Shared clear state helper must invalidate in-flight search before clearing results');
    assert.match(searchModal, /function updateSearchQuery\(nextQuery: string\) \{[\s\S]*if \(nextQuery\.trim\(\)\.length === 0\) \{[\s\S]*clearSearchState\(\);[\s\S]*\}/, 'Typing/deleting to an empty query must synchronously invalidate in-flight search');
    assert.match(searchModal, /onValueChange=\{\(next, details\) => \{[\s\S]*?details\.reason === 'item-press'[\s\S]*?updateSearchQuery\(next\)/, 'Autocomplete value changes must go through the synchronized update helper AND skip item-press reasons (selection must not write the result object back into the query)');
    assert.match(searchModal, /keyboardKey\(event, \['Escape'\]\) && query[\s\S]*clearSearchQuery\(\);/, 'Escape clear path must synchronously invalidate in-flight search');
    assert.match(
      searchModal,
      /if \(trimmed\.length === 0\) \{\s*ticketRef\.current \+= 1;\s*setResults\(\[\]\);/m,
      'Clearing the query must invalidate in-flight search responses before clearing results, otherwise stale responses can repopulate an empty query',
    );
    assert.match(searchModal, /if \(ticket !== ticketRef\.current\) return; \/\/ newer query in flight/, 'Search responses must still be guarded by the latest ticket');
  });

  it('closing the modal invalidates already-started search requests before they set state', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');

    assert.match(searchModal, /const searchMountedRef = useMountedRef\(\)/, 'SearchModal must track whether the conditionally mounted dialog is still alive.');
    assert.match(
      searchModal,
      /useEffect\(\(\) => \{\s*return \(\) => \{\s*ticketRef\.current \+= 1;\s*\};\s*\}, \[\]\)/,
      'SearchModal unmount cleanup must invalidate in-flight searches, including requests that already passed the debounce timer.',
    );
    assert.match(
      searchModal,
      /const response = await searchThread\([\s\S]*?\);\s*if \(!searchMountedRef\.current\) return;\s*if \(ticket !== ticketRef\.current\) return;/,
      'Resolved search responses must not set state after SearchModal has unmounted.',
    );
    assert.match(
      searchModal,
      /\} catch \(err\) \{\s*if \(!searchMountedRef\.current\) return;\s*if \(ticket !== ticketRef\.current\) return;/,
      'Rejected search responses must not set error state after SearchModal has unmounted.',
    );
    assert.match(
      searchModal,
      /\} finally \{\s*if \(searchMountedRef\.current && ticket === ticketRef\.current\) setPending\(false\);/,
      'Pending state must not be cleared by an unmounted SearchModal request callback.',
    );
  });

  it('search snippets highlight query matches without unsafe HTML rendering', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const styles = await readRendererContractCss();

    assert.match(searchModal, /renderSearchSnippet\(result\.snippet,\s*trimmed\)/, 'Search snippets must render with the current query highlight helper');
    assert.match(searchModal, /function renderSearchSnippet\(snippet: string,\s*query: string\): ReactNode/, 'Snippet highlight helper must stay local and typed');
    assert.match(searchModal, /<mark key=\{\`\$\{matchIndex\}-\$\{end\}\`\} className="maka-search-modal-snippet-hit">/, 'Highlighted matches must use React-rendered <mark>, not HTML strings');
    assert.doesNotMatch(searchModal, /dangerouslySetInnerHTML/, 'SearchModal must not use dangerouslySetInnerHTML for snippets');
    assert.match(styles, /\.maka-search-modal-snippet-hit/, 'Highlighted search snippets must have dedicated styling');
  });

  it('search result list announces result count and truncation state', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const styles = await readRendererContractCss();

    assert.match(searchModal, /const resultsTruncated = showResults && results\.some\(\(result\) => result\.truncated === true\)/, 'SearchModal must derive truncation state from SearchResult.truncated');
    assert.match(searchModal, /className="maka-search-modal-result-summary" aria-live="polite"/, 'Search result summary must be announced politely');
    assert.match(searchModal, /\{copy\.results\(results\.length\)\}/, 'Search results must show a localized count');
    assert.match(searchModal, /\{copy\.truncatedResults\(results\.length\)\}/, 'Truncated result sets must use localized copy');
    assert.match(styles, /\.maka-search-modal-result-summary/, 'Search result summary needs dedicated styling');
  });

  it('search result rows render source summaries from SearchResult.summary', async () => {
    const searchModal = await readFile(SEARCH_MODAL_PATH, 'utf8');
    const styles = await readRendererContractCss();

    assert.match(searchModal, /result\.summary && <div className="maka-search-modal-result-meta">\{result\.summary\}<\/div>/, 'Search result rows must render source summary metadata');
    assert.match(styles, /\.maka-search-modal-result-meta/, 'Search result source summary needs dedicated styling');
  });

  it('search modal copy reflects session title hits as part of the supported scope', async () => {
    const [searchModal, shellControlsCopy] = await Promise.all([
      readFile(SEARCH_MODAL_PATH, 'utf8'),
      readFile(SHELL_CONTROLS_COPY_PATH, 'utf8'),
    ]);

    assert.match(searchModal, /placeholder=\{copy\.placeholder\}/, 'Search input placeholder must come from the locale catalog');
    assert.match(searchModal, /aria-label=\{copy\.placeholder\}/, 'Search input accessible label must come from the locale catalog');
    assert.match(shellControlsCopy, /placeholder: '搜索会话标题和内容…'/);
    assert.match(shellControlsCopy, /placeholder: 'Search conversation titles and content…'/);
    assert.match(shellControlsCopy, /introduction: '开始输入以按关键词查找历史对话。结果只包含会话标题和内容文本，不进入网络。'/);
    assert.match(shellControlsCopy, /empty: '没有匹配的会话标题或内容。换个关键词试试。'/);
  });

  it('search modal generic error copy is a retryable local-search state', async () => {
    const [searchModal, shellControlsCopy] = await Promise.all([
      readFile(SEARCH_MODAL_PATH, 'utf8'),
      readFile(SHELL_CONTROLS_COPY_PATH, 'utf8'),
    ]);

    assert.match(
      searchModal,
      /function searchModalThrownErrorMessage\(error: unknown, locale: UiLocale, fallback: string\): string \{[\s\S]*generalizedErrorMessageChinese\(error, fallback\)/,
      'Thrown SearchModal errors must be routed through shared Chinese error classification/redaction',
    );
    assert.match(
      searchModal,
      /message: searchModalThrownErrorMessage\(err, locale, copy\.errorFallback\)/,
      'SearchModal catch must not render raw thrown Error.message',
    );
    assert.doesNotMatch(
      searchModal,
      /err instanceof Error \? err\.message/,
      'SearchModal must not leak raw IPC/preload Error.message into visible search copy',
    );
    assert.match(shellControlsCopy, /errorFallback: '搜索服务需要刷新，请重试。'/);
    assert.match(shellControlsCopy, /errorFallback: 'Search needs to be refreshed. Try again.'/);
    assert.doesNotMatch(searchModal, /搜索暂时不可用，请稍后重试。/, 'Search modal fallback error should not read like a generic unavailable feature');
  });

  it('sessions without messages stay in the flat conversation list', async () => {
    const markup = renderSessionListPanel({ session: { lastMessageAt: undefined } });

    assert.match(markup, />测试会话</, 'Sessions without messages still belong to the conversation list');
    assert.doesNotMatch(markup, /maka-list-group-label/, 'A single default list must not render a redundant heading');
    assert.doesNotMatch(markup, /待发送|尚未发送/, 'The flat conversation list must not create an unfinished-state group');
  });
});

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
