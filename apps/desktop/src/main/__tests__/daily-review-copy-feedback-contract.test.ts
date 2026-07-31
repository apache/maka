import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource, readRendererShellSources } from './renderer-shell-source-helpers.js';
import { extractFunctionBlock } from './function-block-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { getDailyReviewSettingsCopy } from '../../renderer/locales/settings-daily-review-copy.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function blockBetween(source: string, start: string, end: string): string {
  return source.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Daily Review copy feedback contract', () => {
  it('lets the app shell own clipboard success and failure feedback', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const modulePages = await readFile(resolve(REPO_ROOT, 'packages/ui/src/module-pages.tsx'), 'utf8');
    const main = await readRendererShellSources([
      'daily-review-actions.ts',
      'app-shell-daily-review-actions.ts',
      'app-shell-command-actions.ts',
      'app-shell.tsx',
    ]);

    assert.match(modulePages, /onCopyMarkdown\?: \(input:/);
    assert.match(modulePages, /<DailyReviewPanel \{\.\.\.props\} bridge=\{props\.bridge\}/);
    assert.match(ui, /onCopyMarkdown\?: \(input:/);
    assert.match(ui, /props\.onCopyMarkdown\?\.\(\{\s*markdown:\s*md,\s*label:\s*dayLabel,\s*summary: visibleSummary\s*\}\)/);
    assert.match(ui, /const hasDailyReviewActions = Boolean\(props\.onCopyMarkdown \|\| props\.onAppendMarkdown \|\| props\.onSaveMarkdown\)/);
    assert.match(ui, /visibleSummary && visibleSummary\.totals\.sessionCount \+ visibleSummary\.totals\.requestCount > 0 && hasDailyReviewActions/);
    assert.doesNotMatch(ui, /navigator\.clipboard\.writeText\(md\)\.catch\(\(\) => \{\}\)/);
    assert.match(main, /onCopyMarkdown=\{\(input\) => copyDailyReviewMarkdown\(input, \{ shouldShowFeedback: isDailyReviewSurfaceActive \}\)\}/);
    assert.match(main, /async function copyDailyReviewMarkdown\([\s\S]*?await navigator\.clipboard\.writeText\(input\.markdown\)/);
    assert.match(
      main,
      /function isDailyReviewSurfaceActive\(\): boolean \{[\s\S]*return navSelectionRef\.current\.section === 'automations' && navSelectionRef\.current\.module === 'daily-review';[\s\S]*\}/,
      'Daily Review action feedback must be owned by the active Daily Review surface',
    );
    assert.match(
      main,
      /const shouldShowFeedback = options\.shouldShowFeedback \?\? \(\(\) => true\);[\s\S]*if \(shouldShowFeedback\(\)\) \{[\s\S]*toastApi\.success\(\s*copy\.reviewCopied\(input\.label\)/,
      'Daily Review copy success must not toast after leaving the Daily Review surface',
    );
    assert.match(
      main,
      /if \(shouldShowFeedback\(\)\) \{[\s\S]*toastApi\.error\(copy\.copyFailedTitle, dailyReviewActionErrorMessage\(error, copy\.clipboardDenied, uiLocale\)\)/,
      'Daily Review copy failure must not toast after leaving the Daily Review surface',
    );
  });

  it('appends Daily Review markdown to the composer instead of replacing the existing draft', async () => {
    const main = await readRendererShellSources([
      'daily-review-actions.ts',
      'app-shell-daily-review-actions.ts',
      'app-shell-command-actions.ts',
      'app-shell.tsx',
    ]);
    const handlerBlock = main.match(/onPasteTodayDailyReviewIntoComposer:\s*async \(\) => \{[\s\S]*?^\s*},/m)?.[0] ?? '';

    assert.match(handlerBlock, /const owner = captureComposerImportOwner\(\)/);
    assert.match(handlerBlock, /if \(!owner\.sessionId\) return/);
    assert.match(handlerBlock, /formatDailyReviewMarkdown\(summary,\s*copy\.today,\s*options\.uiLocale\)/);
    assert.match(handlerBlock, /if \(!isComposerImportOwnerActive\(owner\)\) return/);
    assert.match(handlerBlock, /composerRef\.current\?\.appendText\(markdown\)/);
    assert.match(handlerBlock, /toastApi\.success\(\s*copy\.reviewPastedTitle/);
    assert.match(
      handlerBlock,
      /if \(isComposerImportOwnerActive\(owner\)\) \{[\s\S]*toastApi\.error\(\s*copy\.pasteFailedTitle/,
      'Command Palette Daily Review paste must not show stale failure feedback after leaving the original chat composer',
    );
    assert.doesNotMatch(handlerBlock, /composerRef\.current\?\.setText\(markdown\)/);
  });

  it('lets the Daily Review main panel append the current range to the composer', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const modulePages = await readFile(resolve(REPO_ROOT, 'packages/ui/src/module-pages.tsx'), 'utf8');
    const main = await readRendererShellCombinedSource();
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');
    const appendBlock = main.match(/function appendDailyReviewMarkdown\(input: DailyReviewMarkdownInput\): void \{[\s\S]*?^\s*}/m)?.[0] ?? '';

    assert.match(modulePages, /onAppendMarkdown\?: \(input:/);
    assert.match(modulePages, /<DailyReviewPanel \{\.\.\.props\} bridge=\{props\.bridge\}/);
    assert.match(panelBlock, /props\.onAppendMarkdown\?\.\(\{\s*markdown:\s*md,\s*label:\s*dayLabel,\s*summary: visibleSummary\s*\}\)/);
    assert.match(panelBlock, /pendingDailyReviewAction === 'append' \? copy\.export\.appending : copy\.export\.append/);
    assert.match(main, /onAppendMarkdown=\{appendDailyReviewMarkdown\}/);
    assert.match(appendBlock, /composerRef\.current\?\.appendText\(input\.markdown\)/);
    assert.match(appendBlock, /toastApi\.success\(\s*copy\.reviewPasted\(input\.label\)/);
    assert.doesNotMatch(appendBlock, /composerRef\.current\?\.setText\(input\.markdown\)/);
  });

  it('renders Daily Review controls through shared button variants without legacy button classes', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const css = await readRendererContractCss();
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');

    assert.match(
      panelBlock,
      /<IconButton[\s\S]*?variant="ghost"[\s\S]*?size="sm"[\s\S]*?className="maka-daily-review-stepper"/,
    );
    assert.match(panelBlock, /<Segmented[\s\S]*?className="maka-daily-review-range-tabs"/);
    // PR3 (#527) added min-w-[Nrem] utilities to the copy/append/save buttons
    // (text-swap width lock for 复制/已复制 feedback). Match each semantic
    // class as a whole word in the class list — same form as the negative
    // maka-button check on the next line.
    assert.match(panelBlock, /className="[^"]*\bmaka-daily-review-copy\b[^"]*"/);
    assert.match(panelBlock, /className="[^"]*\bmaka-daily-review-append\b[^"]*"/);
    assert.match(panelBlock, /className="[^"]*\bmaka-daily-review-save\b[^"]*"/);
    assert.match(panelBlock, /className="[^"]*\bmaka-daily-review-alert-retry\b[^"]*"/);
    assert.doesNotMatch(panelBlock, /className="[^"]*\bmaka-button\b[^"]*"/);
    assert.doesNotMatch(css, /\.maka-daily-review-range-tab\[data-active/);
    assert.match(css, /\.maka-daily-review-copy,\s*\.maka-daily-review-append,\s*\.maka-daily-review-save/);
    assert.doesNotMatch(css, /\.maka-daily-review-range-tabs > button/);
    assert.doesNotMatch(css, /\.maka-daily-review-actions > button/);
  });

  it('gates Daily Review export actions while async work is pending', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const main = await readRendererShellCombinedSource();
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');
    const gateBlock = panelBlock.match(/async function runDailyReviewAction[\s\S]*?const dailyReviewActionBusy/)?.[0] ?? '';
    assert.ok(gateBlock, 'runDailyReviewAction gate not found in DailyReviewPanel');

    assert.match(panelBlock, /const \[pendingDailyReviewAction, setPendingDailyReviewAction\] = useState<string \| null>\(null\)/);
    assert.match(panelBlock, /const dailyReviewMountedRef = useMountedRef\(\)/);
    assert.match(panelBlock, /const pendingDailyReviewActionRef = useRef<string \| null>\(null\)/);
    assert.match(
      panelBlock,
      /useEffect\(\(\) => \{\s*return \(\) => \{\s*pendingDailyReviewActionRef\.current = null;\s*(?:archiveLoadRequestRef\.current \+= 1;\s*)?\};\s*\}, \[\]\)/,
      'Daily Review export pending ownership must be released when the main panel unmounts or StrictMode replays cleanup',
    );
    assert.match(panelBlock, /const dailyReviewActionBusy = pendingDailyReviewAction !== null/);
    assert.match(panelBlock, /\{props\.onCopyMarkdown && \(/);
    assert.match(
      gateBlock,
      /if \(pendingDailyReviewActionRef\.current !== null\) return;[\s\S]*pendingDailyReviewActionRef\.current = actionKey[\s\S]*setPendingDailyReviewAction\(actionKey\)[\s\S]*await action\(\)[\s\S]*pendingDailyReviewActionRef\.current = null[\s\S]*if \(dailyReviewMountedRef\.current\) setPendingDailyReviewAction\(null\)/,
      'Daily Review export actions must use a ref-backed pending gate so same-frame double clicks cannot run two exports',
    );
    assert.match(panelBlock, /runDailyReviewAction\('copy', async \(\) => \{/);
    assert.match(panelBlock, /runDailyReviewAction\('append', async \(\) => \{/);
    assert.match(panelBlock, /runDailyReviewAction\('save', async \(\) => \{/);
    assert.match(panelBlock, /isDisabled=\{dailyReviewActionBusy\}/);
    assert.match(panelBlock, /aria-busy=\{pendingDailyReviewAction === 'copy' \? 'true' : undefined\}/);
    assert.match(panelBlock, /copy\.export\.copying/);
    assert.match(panelBlock, /copy\.export\.appending/);
    assert.match(panelBlock, /copy\.export\.saving/);
    assert.doesNotMatch(
      main,
      /onSaveMarkdown=\{\(input\) => void saveDailyReviewMarkdown\(input\)\}/,
      'renderer must return the save Promise to the Daily Review pending gate',
    );
    assert.match(
      main,
      /onSaveMarkdown=\{\(input\) => saveDailyReviewMarkdown\(input, \{ shouldShowFeedback: isDailyReviewSurfaceActive \}\)\}/,
      'Daily Review save feedback must be gated to the active Daily Review surface',
    );
  });

  it('guards Daily Review manual run continuations against closed panels', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');
    const manualRunBlock = blockBetween(panelBlock, 'async function triggerManualRun', 'return \\(');
    assert.ok(manualRunBlock, 'triggerManualRun not found in DailyReviewPanel');

    assert.match(
      panelBlock,
      /function isDailyReviewActionCurrent\(actionKey: string\): boolean \{\s*return dailyReviewMountedRef\.current && pendingDailyReviewActionRef\.current === actionKey;\s*\}/,
      'Daily Review manual run continuations need a mounted/current-owner predicate',
    );
    assert.match(
      manualRunBlock,
      /const actionKey = `run:\$\{mode\}`;\s*await runDailyReviewAction\(actionKey, async \(\) => \{/,
      'Manual Daily Review runs should reuse the shared action owner key',
    );
    assert.match(
      manualRunBlock,
      /const result = await runOnce\(\{ mode, modelKey: selectedModelKey \}\);\s*if \(!isDailyReviewActionCurrent\(actionKey\)\) return;\s*chooseDailyReviewArchive\(result\.archiveId\);\s*setArchiveReloadToken\(\(n\) => n \+ 1\);\s*setReloadToken\(\(n\) => n \+ 1\);/,
      'Late manual-run success must not select archives or reload a closed/superseded panel',
    );
    assert.match(
      manualRunBlock,
      /catch \(err\) \{\s*if \(isDailyReviewActionCurrent\(actionKey\)\) setError\(dailyReviewPanelErrorMessage\(err, locale\)\);\s*\}/,
      'Late manual-run failures must not render errors after leaving Daily Review',
    );
    assert.match(panelBlock, /isDisabled=\{dailyReviewActionBusy\}/);
    assert.match(panelBlock, /pendingDailyReviewAction === 'run:daily' \? copy\.page\.generating : copy\.page\.generateDaily/);
    assert.match(panelBlock, /pendingDailyReviewAction === 'run:deep' \? copy\.page\.generating : copy\.page\.generateDeep/);
  });

  it('guards Daily Review archive body loads against stale async responses', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');
    const archiveLoadBlock = panelBlock.match(/useEffect\(\(\) => \{\s*const getArchive = bridgeRef\.current\.getArchive;[\s\S]*?\}, \[archiveReloadToken, locale, selectedArchiveId\]\);/)?.[0] ?? '';
    assert.ok(archiveLoadBlock, 'archive load effect not found in DailyReviewPanel');

    assert.match(panelBlock, /const archiveLoadRequestRef = useRef\(0\)/);
    assert.match(
      panelBlock,
      /return \(\) => \{\s*pendingDailyReviewActionRef\.current = null;\s*archiveLoadRequestRef\.current \+= 1;\s*\};/,
      'Daily Review archive loads must be invalidated when the panel unmounts',
    );
    assert.match(
      panelBlock,
      /function chooseDailyReviewArchive\(archiveId: string\) \{\s*archiveLoadRequestRef\.current \+= 1;\s*setSelectedArchiveId\(archiveId\);\s*setSelectedArchive\(null\);\s*setArchiveLoading\(Boolean\(props\.bridge\.getArchive\)\);\s*setArchiveError\(null\);\s*\}/,
      'Archive row selection must synchronously invalidate the previous body request before React effect cleanup runs',
    );
    assert.match(panelBlock, /onClick=\{\(\) => chooseDailyReviewArchive\(archive\.id\)\}/);
    assert.match(panelBlock, /chooseDailyReviewArchive\(result\.archiveId\);/);
    assert.match(
      archiveLoadBlock,
      /if \(!getArchive \|\| !selectedArchiveId\) \{\s*archiveLoadRequestRef\.current \+= 1;\s*setSelectedArchive\(null\);/,
      'Disabling or clearing the archive selection must invalidate any pending body load',
    );
    assert.match(
      archiveLoadBlock,
      /const archiveId = selectedArchiveId;\s*const archiveRequestId = \+\+archiveLoadRequestRef\.current;[\s\S]*getArchive\(archiveId\)/,
      'Each archive body load must capture both the selected id and a request token',
    );
    assert.match(
      archiveLoadBlock,
      /\.then\(\(next\) => \{\s*if \(cancelled\) return;\s*if \(archiveLoadRequestRef\.current !== archiveRequestId\) return;\s*setSelectedArchive\(next\);/,
      'Older successful archive body loads must not overwrite the current selection',
    );
    assert.match(
      archiveLoadBlock,
      /\.catch\(\(err: unknown\) => \{\s*if \(cancelled\) return;\s*if \(archiveLoadRequestRef\.current !== archiveRequestId\) return;\s*setSelectedArchive\(null\);/,
      'Older failed archive body loads must not clear or error the current selection',
    );
  });

  it('decouples Daily Review data-fetching effects from the bridge object reference (PR-582 follow-up)', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');

    assert.match(
      panelBlock,
      /const bridgeRef = useRef\(props\.bridge\)/,
      'DailyReviewPanel must track bridge via ref so effects survive bridge reference changes',
    );
    assert.match(
      panelBlock,
      /bridgeRef\.current = props\.bridge/,
      'bridgeRef must be updated on every render so effects always use the latest bridge',
    );

    const fetchDayEffect = panelBlock.match(/useEffect\(\(\) => \{[\s\S]*?bridgeRef\.current\s*\n\s*\.fetchDay\([\s\S]*?\}, \[([^\]]*)\]\);/)?.[1] ?? '';
    assert.ok(fetchDayEffect, 'fetchDay effect not found');
    assert.doesNotMatch(
      fetchDayEffect,
      /props\.bridge/,
      'fetchDay effect must not depend on props.bridge — use bridgeRef instead',
    );

    const listArchivesEffect = panelBlock.match(/useEffect\(\(\) => \{[\s\S]*?bridgeRef\.current\.listArchives[\s\S]*?\}, \[([^\]]*)\]\);/)?.[1] ?? '';
    assert.ok(listArchivesEffect, 'listArchives effect not found');
    assert.doesNotMatch(
      listArchivesEffect,
      /props\.bridge/,
      'listArchives effect must not depend on props.bridge — use bridgeRef instead',
    );

    const getArchiveEffect = panelBlock.match(/useEffect\(\(\) => \{[\s\S]*?bridgeRef\.current\.getArchive[\s\S]*?\}, \[([^\]]*)\]\);/)?.[1] ?? '';
    assert.ok(getArchiveEffect, 'getArchive effect not found');
    assert.doesNotMatch(
      getArchiveEffect,
      /props\.bridge/,
      'getArchive effect must not depend on props.bridge — use bridgeRef instead',
    );
  });

  it('gates Daily Review settings saves and manual runs with mounted ref owners', async () => {
    const settings = await readSettingsCombinedSource();
    const pageBlock = blockBetween(settings, 'function DailyReviewSettingsPage', 'function VoiceModelsSettingsPage');
    const saveBlock = blockBetween(pageBlock, 'async function patchConfig', 'async function triggerRun');
    const runBlock = blockBetween(pageBlock, 'async function triggerRun', 'const effectiveConfig');

    assert.match(pageBlock, /const saveConfigGuard = useActionGuard<string>\(\)/);
    assert.match(pageBlock, /const runModeGuard = useActionGuard<DailyReviewMode>\(\)/);
    assert.match(
      saveBlock,
      /if \(!dailyReviewIpc\.setConfig \|\| !config \|\| saveConfigGuard\.current !== null\) return;\s*saveConfigGuard\.begin\(key\);\s*setSavingKey\(key\);/,
      'Daily Review config saves must synchronously reject same-frame duplicate writes before React disables controls',
    );
    assert.match(
      saveBlock,
      /const next = await dailyReviewIpc\.setConfig\(patch\);\s*if \(mountedRef\.current && saveConfigGuard\.current === key\) setConfig\(next\);/,
      'Late config save responses must only update the still-mounted owning settings page',
    );
    assert.match(
      saveBlock,
      /if \(mountedRef\.current && saveConfigGuard\.current === key\) \{\s*toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(err, locale\)\);\s*\}/,
      'Late config save failures must not toast after Settings closes or ownership changes',
    );
    assert.match(
      saveBlock,
      /finally \{\s*if \(saveConfigGuard\.current === key\) \{\s*saveConfigGuard\.finish\(\);\s*\}\s*if \(mountedRef\.current\) setSavingKey\(null\);/,
      'Daily Review config save owners must be released by the matching request only',
    );
    assert.match(pageBlock, /const formDisabled = !hasConfigIpc \|\| loading \|\| Boolean\(loadError\) \|\| !effectiveConfig \|\| savingKey !== null;/);
    assert.match(
      pageBlock,
      /<TextInput[\s\S]*label=\{copy\.executeTimeAria\}[\s\S]*placeholder=\{copy\.executeTimePlaceholder\}[\s\S]*onBlur=\{\(\) => \{[\s\S]*\/\^\(\?:\[01\]\\d\|2\[0-3\]\):\[0-5\]\\d\$\/u\.test\(executeTimeDraft\)[\s\S]*patchConfig\('executeTime'/,
      'Daily Review keeps the necessary time value as a simple Astryx text field and persists only a complete 24-hour value',
    );

    assert.match(
      runBlock,
      /if \(!dailyReviewIpc\.runOnce \|\| runModeGuard\.current !== null\) return;\s*runModeGuard\.begin\(mode\);\s*setRunningMode\(mode\);/,
      'Manual Daily Review runs must synchronously reject duplicate starts before React disables buttons',
    );
    assert.match(
      runBlock,
      /if \(mountedRef\.current && runModeGuard\.current === mode\) \{\s*toast\.success\(copy\.runSuccess\[mode\], copy\.runSuccessDetail\);\s*\}/,
      'Manual run success feedback must be owned by the still-mounted request',
    );
    assert.match(
      runBlock,
      /if \(mountedRef\.current && runModeGuard\.current === mode\) \{\s*toast\.error\(copy\.runFailed, settingsActionErrorMessage\(err, locale\)\);\s*\}/,
      'Manual run failure feedback must be owned by the still-mounted request',
    );
    assert.match(
      runBlock,
      /finally \{\s*if \(runModeGuard\.current === mode\) \{\s*runModeGuard\.finish\(\);\s*\}\s*if \(mountedRef\.current\) setRunningMode\(null\);/,
      'Manual run owners must be released by the matching request only',
    );
    assert.match(pageBlock, /isDisabled=\{runningMode !== null\}/); // #1565 PR 3: Astryx Button uses isDisabled
    assert.equal(getDailyReviewSettingsCopy('zh').runSuccess.daily, '已生成每日回顾');
    assert.equal(getDailyReviewSettingsCopy('en').runSuccess.daily, 'Daily Review generated');
  });

  it('scrubs Daily Review load and action failures before rendering them', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-panel.tsx'), 'utf8');
    // PR-UI-LIB-EXTRACT-2 (round 3/10): `dailyReviewPanelErrorMessage`
    // moved out of `components.tsx` into a sibling helper module so
    // pure logic isn't tangled with the panel JSX. The assertion
    // shape stays — we just read the file the helper now lives in.
    const uiHelpers = await readFile(resolve(REPO_ROOT, 'packages/ui/src/daily-review-helpers.ts'), 'utf8');
    const main = await readRendererShellCombinedSource();
    const panelBlock = extractFunctionBlock(ui, 'DailyReviewPanel');
    const helperBlock = main.match(/function dailyReviewActionErrorMessage\(error: unknown, fallback: string, locale: UiLocale\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const saveBlock = extractFunctionBlock(main, 'saveDailyReviewMarkdown');
    const saveTodayBlock = main.match(/onSaveTodayDailyReviewToFile: async \(\) => \{[\s\S]*?onCopyEnvSummary/)?.[0] ?? '';

    assert.match(uiHelpers, /generalizedErrorMessageChinese/);
    assert.match(panelBlock, /setError\(dailyReviewPanelErrorMessage\(err, locale\)\)/);
    assert.doesNotMatch(panelBlock, /err instanceof Error \? err\.message : ['"]加载失败['"]/);
    assert.match(uiHelpers, /function dailyReviewPanelErrorMessage\(error: unknown, locale: UiLocale\): string \{[\s\S]*getDailyReviewCopy\(locale\)\.errorFallback[\s\S]*locale === 'zh'[\s\S]*generalizedErrorMessageChinese\(error, fallback\)[\s\S]*generalizedErrorMessage\(error, fallback\)/);

    assert.match(helperBlock, /locale === 'zh' \? generalizedErrorMessageChinese\(error, fallback\) : generalizedErrorMessage\(error, fallback\)/);
    assert.match(saveBlock, /const shouldShowFeedback = options\.shouldShowFeedback \?\? \(\(\) => true\)/);
    assert.match(
      saveBlock,
      /if \(shouldShowFeedback\(\)\) \{[\s\S]*toastApi\.error\(copy\.saveFailedTitle, dailyReviewActionErrorMessage\(err, copy\.reviewSaveFallback, uiLocale\)\)/,
      'Daily Review save failures must respect the caller feedback owner predicate',
    );
    assert.match(
      saveTodayBlock,
      /await saveDailyReviewMarkdown\(\{ markdown, label: copy\.today, summary \}\);/,
      'Command Palette daily-review save remains a global command and should keep default visible feedback',
    );
    assert.match(main, /dailyReviewActionErrorMessage\(err, copy\.reviewCopyFallback, options\.uiLocale\)/);
    assert.match(main, /dailyReviewActionErrorMessage\(err, copy\.reviewUnavailable, options\.uiLocale\)/);
    assert.doesNotMatch(main, /保存每日回顾失败'\)|剪贴板或数据不可用|加载今日回顾失败/);
  });
});
