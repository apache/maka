import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Command palette accessibility and visible copy', () => {
  it('uses Base UI Autocomplete for the command results listbox (#520 PR8)', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    assert.match(
      src,
      /import \{ Autocomplete \} from '@base-ui\/react\/autocomplete'/,
      'CommandPalette must consume Base UI Autocomplete for the result list',
    );
    assert.match(
      src,
      /<Autocomplete\.Root[\s\S]*?inline[\s\S]*?\bopen\b[\s\S]*?mode="none"[\s\S]*?autoHighlight="always"[\s\S]*?\bkeepHighlight\b[\s\S]*?filter=\{null\}/,
      'Autocomplete.Root must render `inline open` + keepHighlight: `inline open` so the list is treated as visible (Base UI docs); keepHighlight so pointer leave preserves the hovered highlight (hover item -> leave -> Enter runs that item, not the first — #562 P2); mode="none" (palette owns fuzzy + content-search filtering) + autoHighlight="always"',
    );
    assert.match(
      src,
      /<Autocomplete\.Root[\s\S]*?itemToStringValue=\{\(cmd\) => cmd\.label\}/,
      'Autocomplete.Root must serialize object commands via itemToStringValue — without it, item-press can write [object Object] back into the query',
    );
    assert.match(
      src,
      /onValueChange=\{\(next, details\) => \{[\s\S]*?details\.reason === 'item-press'[\s\S]*?setQuery\(next\)/,
      'Autocomplete value changes must skip item-press reasons (selection must not write the command object back into the query)',
    );
    assert.match(src, /<Autocomplete\.Input/, 'Palette input must be Autocomplete.Input');
    assert.match(
      src,
      /<Autocomplete\.List className="maka-palette-list" id="maka-palette-list" aria-label=\{copy\.resultsLabel\}>/,
      'Palette results must render as Autocomplete.List (listbox) with an accessible name',
    );
    assert.match(
      src,
      /<Autocomplete\.Group[\s\S]*?<Autocomplete\.GroupLabel className="maka-palette-group-label">/,
      'Palette groups must render as Autocomplete.Group + GroupLabel',
    );
    assert.match(
      src,
      /<Autocomplete\.Item[\s\S]*?onClick=\{\(\) => commit\(cmd\)\}/,
      'Each command must be Autocomplete.Item with onClick firing commit (pointer click or Enter on highlighted)',
    );
    // P2-c: Home/End decision — accept Base UI ComboboxInput's input-cursor
    // default. The old hand-rolled highlight jump (Home/End -> first/last) is
    // gone and must not return.
    assert.doesNotMatch(
      src,
      /\bjumpActive\w*\(|onInputKeyDown/,
      'Home/End must NOT jump highlight and there must be no hand-rolled input keydown handler — Base UI input-cursor default is the decided behavior (#562 P2-c)',
    );
    // P2: empty state renders inside Autocomplete.List, not a standalone div,
    // so the input always references a stable listbox container.
    assert.doesNotMatch(
      src,
      /<div className="maka-palette-list"/,
      'Empty state must render inside Autocomplete.List, not a standalone div — input must always reference a listbox container (#562 P2)',
    );
  });

  it('uses shared primitive InputGroup for the palette input shell without restoring the old flex wrapper', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const styles = await readRendererContractCss();
    const inputWrapStyle = styles.match(/\.maka-palette-input-wrap\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(
      src,
      /import \{[^}]*\bDialogContent\b[^}]*\bDialogRoot\b[^}]*\bInputGroup\b[^}]*\bInputGroupInput\b[^}]*\bKbd\b[^}]*\bKbdGroup\b[^}]*\} from '@maka\/ui';/,
      'CommandPalette must consume shared primitive InputGroup + Dialog primitives from @maka/ui',
    );
    assert.match(
      src,
      /<InputGroup[\s\S]*className="maka-palette-input-wrap"[\s\S]*aria-label=\{copy\.searchLabel\}[\s\S]*onMouseDown=\{\(event\) => \{[\s\S]*inputRef\.current\?\.focus\(\);[\s\S]*<InputGroupInput[\s\S]*aria-label=\{copy\.placeholder\}/,
      'CommandPalette input shell must be shared primitive InputGroup with an accessible input label and whole-shell click focus',
    );
    assert.match(
      src,
      /<InputGroupAddon align="inline-start" className="maka-palette-search-icon" aria-hidden="true">[\s\S]*?<Search \/>[\s\S]*?<\/InputGroupAddon>/,
      'The primary search field keeps one leading search affordance',
    );
    // Detail round 6: the shortcut hints (↵ 执行 / Esc 关闭) live in the
    // footer bar ONLY. An inline input addon duplicated them in the same
    // viewport — one affordance, one home.
    assert.doesNotMatch(
      src,
      /maka-palette-input-hint/,
      'Shortcut hints must not be duplicated in an input addon — the palette footer is the single source',
    );
    assert.doesNotMatch(
      src,
      /<div className="maka-palette-input-wrap"/,
      'CommandPalette must not regress to the previous hand-rolled input wrapper',
    );
    assert.doesNotMatch(
      inputWrapStyle,
      /display:\s*flex/,
      'Palette input wrapper styling must not restore the old flex shell over shared primitive InputGroup',
    );
    assert.match(
      inputWrapStyle,
      /width:\s*100%;/,
      'Palette InputGroup should fill the search column while the header owns outer spacing',
    );
    assert.match(
      inputWrapStyle,
      /background:\s*var\(--background\);/,
      'Palette search should stay on the modal working plane instead of adding a gray nested fill',
    );
    assert.doesNotMatch(
      styles,
      /maka-palette-input-hint/,
      'Input-addon hint CSS must stay deleted along with the duplicated hint markup',
    );
  });

  it('keeps the close action beside the input group so the search shell cannot cover its hit target', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const styles = await readRendererContractCss();
    const headerStyle = styles.match(/\.maka-palette-header\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const inputStyle = styles.match(/\.maka-palette-input\s*\{[\s\S]*?\}/)?.[0] ?? '';
    assert.match(
      src,
      /<DialogContent[\s\S]*?showClose=\{false\}/,
      'the palette must disable DialogContent\'s absolute close button',
    );
    // The close action uses the dedicated Astryx IconButton; label becomes
    // its accessible name and the icon rides the `icon` prop.
    assert.match(
      src,
      /<div className="maka-palette-header">[\s\S]*?<InputGroup[\s\S]*?<\/InputGroup>[\s\S]*?<IconButton[\s\S]*?icon=\{<X aria-hidden="true" \/>\}[\s\S]*?label=\{copy\.closeLabel\}[\s\S]*?onClick=\{props\.onClose\}[\s\S]*?\/>[\s\S]*?<\/div>/,
      'the close button must be a sibling immediately to the right of the input group',
    );
    assert.match(headerStyle, /grid-template-columns:\s*minmax\(0, 1fr\) var\(--h-control-md\);/);
    assert.match(headerStyle, /gap:\s*var\(--space-2\);/);
    assert.match(inputStyle, /padding-inline:\s*var\(--space-2\);/);
  });

  it('keeps command palette chrome compact, non-selectable, and tactile without blocking text entry', async () => {
    const styles = await readRendererContractCss();
    const modalStyle = styles.match(/\.maka-palette-modal\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const inputStyle = styles.match(/\.maka-palette-input\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const rowStyle = styles.match(/\.maka-palette-item\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(modalStyle, /width:\s*min\(584px, calc\(100vw - 32px\)\);/);
    assert.match(modalStyle, /border:\s*var\(--border-width-hairline\) solid var\(--border\);/);
    assert.match(modalStyle, /border-radius:\s*var\(--radius-modal\);/);
    assert.match(
      styles,
      /\.maka-palette-modal,[\s\S]*?\.maka-palette-footer\s*\{[\s\S]*user-select:\s*none;/,
      'Palette modal/list/rows/footer should behave as app chrome, not accidental selectable text',
    );
    assert.match(inputStyle, /user-select:\s*text;/, 'Palette input text must stay selectable/editable');
    assert.match(rowStyle, /min-height:\s*var\(--h-control-lg\);/);
    assert.match(rowStyle, /grid-template-columns:\s*18px minmax\(0, 1fr\) auto;/);
    assert.match(
      styles,
      /\.maka-palette-item:hover:not\(\[data-disabled="true"\]\)\s*\{[\s\S]*background:\s*var\(--state-hover-bg\);/,
      'Palette rows need a hover state independent of keyboard active state',
    );
    assert.match(
      styles,
      /\.maka-palette-item:active:not\(\[data-disabled="true"\]\)\s*\{[\s\S]*background:\s*var\(--state-selected-bg\);/,
      'Palette rows need pressed feedback via the state-selected background, not a scale transform',
    );
    assert.match(styles, /\.maka-palette-item:focus-visible\s*\{[\s\S]*outline:\s*var\(--focus-ring-width\) solid var\(--ring\);/);
    assert.match(styles, /\.maka-palette-item\[data-pending="true"\]\s*\{[\s\S]*cursor:\s*progress;/);
    assert.match(
      styles,
      /\.maka-palette-item\[data-highlighted\]\s*\{[\s\S]*background:\s*var\(--state-selected-bg\)/,
      'Palette active row uses the neutral state-selected token, not a brand rail',
    );
    assert.match(styles, /\.maka-palette-icon\s*\{[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;/);
    assert.match(styles, /\.maka-palette-hint\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums;/);
  });

  it('keeps the footer as one quiet shortcut rail instead of a nested card', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const styles = await readRendererContractCss();
    const footerStyle = [...styles.matchAll(/\.maka-palette-footer\s*\{[\s\S]*?\}/g)].map((match) => match[0]).join('\n');

    assert.doesNotMatch(src, /PALETTE_DELIM/, 'Shortcut groups should use spacing, not decorative dot separators');
    assert.match(src, /className="maka-palette-footer-hint"/);
    assert.match(footerStyle, /justify-content:\s*flex-end;/);
    assert.match(footerStyle, /min-height:\s*var\(--h-control-md\);/);
    assert.match(footerStyle, /background:\s*transparent;/);
  });

  it('has an e2e-fixture opener for the command palette input shell', async () => {
    const main = await readRendererShellCombinedSource();
    const core = await readRepo('packages/core/src/e2e-fixture.ts');
    const fixture = await readRepo('apps/desktop/src/main/e2e-fixture.ts');

    assert.match(core, /\| 'command-palette-open'/, 'E2eFixtureScenario must include command-palette-open');
    assert.match(core, /paletteOpen\?: boolean;/, 'E2eFixtureState must expose the paletteOpen hint');
    assert.match(fixture, /'command-palette-open'/, 'e2e-fixture resolver must accept command-palette-open');
    assert.match(fixture, /case 'command-palette-open':[\s\S]*paletteOpen: true/, 'command-palette-open must auto-open the palette');
    assert.match(main, /if \(state\.paletteOpen\) \{\s*openPalette\(\);\s*\}/, 'renderer must consume paletteOpen and open CommandPalette');
  });

  it('sources primary command hints from the locale catalog', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette-commands.ts');
    const catalog = await readRepo('apps/desktop/src/renderer/locales/shell-copy.ts');
    assert.match(src, /const copy = getShellCopy\(args\.locale\)\.commandPalette/);
    assert.doesNotMatch(src, /label: '新建对话'/, 'visible command copy belongs in the typed locale catalog');
    assert.match(catalog, /label: '新建对话',[\s\S]*?hint: '开始新的会话'/);
    assert.match(catalog, /label: 'New conversation',[\s\S]*?hint: 'Start a new conversation'/);
  });

  it('gates command execution so Enter/click cannot run the same palette action twice', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    const commandsSrc = await readRepo('apps/desktop/src/renderer/command-palette-commands.ts');
    const mainSrc = await readRendererShellCombinedSource();
    const commandTypes = await readRepo('apps/desktop/src/renderer/command-palette-types.ts');
    // #520 PR8: onInputKeyDown is gone (Autocomplete owns ArrowUp/Down/Enter),
    // so the block boundary is the commit() helper now.
    const commandPaletteBlock = src.match(/export function CommandPalette[\s\S]*?function commit/)?.[0] ?? '';
    const commitBlock = src.match(/function commit\(cmd: Command \| undefined\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const rowBlock = src.match(/const commandCommitPending = committedCommandId === cmd\.id;[\s\S]*?data-pending=\{commandCommitPending \? 'true' : undefined\}/)?.[0] ?? '';

    assert.match(commandTypes, /run\(\): void \| Promise<void>/, 'command actions may be async and must be awaited by commit()');
    assert.match(commandPaletteBlock, /const commitPendingRef = useRef\(false\)/);
    assert.match(commandPaletteBlock, /const \[committedCommandId, setCommittedCommandId\] = useState<string \| null>\(null\)/);
    assert.match(
      commitBlock,
      /if \(!cmd\) return;[\s\S]*if \(commitPendingRef\.current\) return;[\s\S]*if \(cmd\.disabled\) return;[\s\S]*commitPendingRef\.current = true;[\s\S]*setCommittedCommandId\(cmd\.id\);[\s\S]*await cmd\.run\(\);[\s\S]*finally \{[\s\S]*props\.onClose\(\);[\s\S]*\}[\s\S]*\.catch\(\(\) => undefined\)/,
      'CommandPalette commit() must synchronously drop duplicate activations, await async actions, and close from finally',
    );
    assert.doesNotMatch(
      commandsSrc,
      /run: \(\) => void args\./,
      'buildCommandList must return host callback promises instead of voiding them before commit() can await',
    );
    assert.doesNotMatch(
      mainSrc,
      /on(NewChat|StartDeepResearch|SetPermissionMode):\s*\([^)]*\)\s*=>\s*void /,
      'renderer must pass command palette async owner actions through instead of voiding their promises at the prop boundary',
    );
    assert.match(rowBlock, /aria-busy=\{commandCommitPending \? 'true' : undefined\}/);
    assert.match(rowBlock, /data-pending=\{commandCommitPending \? 'true' : undefined\}/);
  });

  it('resets active command to the first result when the result set changes (#520 PR8)', async () => {
    const src = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    // #520 PR8: Autocomplete's autoHighlight="always" owns highlight reset —
    // the first item is always highlighted, so Enter on a fresh result set
    // always activates the top command. The old hand-rolled highlight state +
    // useEffect reset is gone.
    assert.match(
      src,
      /autoHighlight="always"/,
      'Autocomplete.Root must use autoHighlight="always" so the first command is always highlighted and Enter works without an extra ArrowDown',
    );
    assert.doesNotMatch(
      src,
      /\[highlight, setHighlight\]/,
      'CommandPalette must not keep a hand-rolled highlight state — Autocomplete owns it',
    );
  });

  it('scrubs thrown command action failures before toast', async () => {
    const main = await readRendererShellCombinedSource();
    const commandPaletteBlock = main.match(/export function buildAppShellCommandList[\s\S]*?^\}/m)?.[0] ?? '';
    const helperBlock = main.match(/function commandPaletteActionErrorMessage\(error: unknown, fallback: string, locale: UiLocale\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const connectionTestHelperBlock = main.match(/function commandPaletteConnectionTestFailureMessage\(result: ConnectionTestResult, locale: UiLocale\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const connectionTestFallbackBlock = main.match(/function commandPaletteConnectionTestFailureFallback\(result: ConnectionTestResult, locale: UiLocale\): string \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(helperBlock, /localizedErrorMessage\(error, fallback, locale\)/);
    assert.match(
      connectionTestHelperBlock,
      /localizedErrorMessage\(new Error\(result\.errorMessage\), fallback, locale\)/,
      'Command palette connection-test failures must classify/redact raw provider messages before toast',
    );
    assert.match(connectionTestFallbackBlock, /statusCode === 429[\s\S]*return copy\.rateLimit/);
    assert.match(connectionTestFallbackBlock, /errorClass === 'auth'[\s\S]*return copy\.auth/);
    assert.match(connectionTestFallbackBlock, /errorClass === 'network'[\s\S]*return copy\.network/);
    assert.match(commandPaletteBlock, /commandPaletteConnectionTestFailureMessage\(result, options\.uiLocale\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, copy\.exportFallback, options\.uiLocale\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, copy\.connectionUnavailable, options\.uiLocale\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, copy\.setDefaultFallback, options\.uiLocale\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, copy\.memoryOpenFallback, options\.uiLocale\)/);
    assert.match(commandPaletteBlock, /commandPaletteActionErrorMessage\(err, copy\.instructionsOpenFallback, options\.uiLocale\)/);
    assert.doesNotMatch(
      commandPaletteBlock,
      /(?:err|error) instanceof Error \? (?:err|error)\.message : (?:String\((?:err|error)\)|'导出当前对话失败'|'路径无效'|'剪贴板不可用'|'网络代理测试异常')/,
      'Command palette actions must not toast raw thrown Error.message',
    );
    assert.doesNotMatch(
      commandPaletteBlock,
      /toastApi\.error\(`连接测试失败 · \$\{name\}`, result\.errorMessage \?\? '未知错误'\)/,
      'Command palette connection test must not echo raw ConnectionTestResult.errorMessage',
    );
  });
});
