/**
 * PR-WEB-SEARCH-TAVILY-0 — static-analysis gate that the renderer
 * never imports the Tavily client and never declares a cleartext
 * `apiKey` field on the `web-search` boundary.
 *
 * The cleartext Tavily key only ever lives in the main process. The
 * renderer can read a masked sentinel from settings and submit a new
 * draft string to overwrite it, but it must NEVER pull the cleartext
 * value back through any IPC channel.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { readAllRendererCss } from './css-test-helpers.js';
import { RENDERER_SHELL_SOURCE_REPO_PATHS } from './renderer-shell-source-helpers.js';
import {
  readSettingsCombinedSource,
  SETTINGS_SOURCE_REPO_PATHS,
} from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import { getWebSearchSettingsCopy } from '../../renderer/locales/settings-web-search-copy.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const TOOL_RESULT_PREVIEW = join(REPO_ROOT, 'packages/ui/src/tool-activity/tool-result-preview.tsx');

const RENDERER_FILES = [
  ...RENDERER_SHELL_SOURCE_REPO_PATHS,
  ...SETTINGS_SOURCE_REPO_PATHS,
  'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
  'apps/desktop/src/renderer/settings/provider-add-form.tsx',
  'apps/desktop/src/renderer/settings/provider-catalog.tsx',
  'apps/desktop/src/renderer/settings/provider-connection-dialog.tsx',
  'apps/desktop/src/renderer/settings/provider-connection-detail.tsx',
  'apps/desktop/src/renderer/settings/use-connection-detail.ts',
  'apps/desktop/src/renderer/settings/provider-enabled-model-manager.tsx',
  'apps/desktop/src/renderer/settings/provider-display.tsx',
  'apps/desktop/src/renderer/settings/provider-oauth-section.tsx',
  'apps/desktop/src/renderer/settings/claude-subscription-card.tsx',
  'apps/desktop/src/renderer/settings/provider-panel-shared.ts',
  'apps/desktop/src/preload/preload.ts',
];

describe('web-search renderer boundary (PR-WEB-SEARCH-TAVILY-0)', () => {
  it('unsupported provider copy describes the current configuration, not a roadmap gap', async () => {
    const main = await readMainProcessCombinedSource();
    const unsupportedBlock = main.match(/const unsupportedWebSearchProviderResponse[\s\S]*?;\r?\n\s*ipcMain\.handle/);

    assert.ok(unsupportedBlock, 'main process must centralize unsupported-provider copy');
    assert.match(unsupportedBlock![0], /reason:\s*'unsupported_provider'/);
    assert.match(unsupportedBlock![0], /当前配置不支持这个搜索引擎，请选择 Tavily 后重试。/);
    assert.doesNotMatch(
      unsupportedBlock![0],
      /暂未|尚未|即将|coming soon|todo|roadmap/i,
      'unsupported provider copy must not read like unfinished roadmap work',
    );
    assert.equal(
      (main.match(/unsupportedWebSearchProviderResponse/g) ?? []).length,
      3,
      'query/test handlers must reuse the same product copy instead of drifting',
    );
  });

  it('Tavily missing-key copy is an actionable waiting state', async () => {
    const tavily = await readFile(join(REPO_ROOT, 'apps/desktop/src/main/web-search/tavily.ts'), 'utf8');
    const missingKeyBlock = tavily.match(/trimmedKey\.length === 0[\s\S]*?\n\s*\}/);

    assert.ok(missingKeyBlock, 'Tavily client must fail closed before network when the key is empty');
    assert.match(missingKeyBlock![0], /等待配置 Tavily API key 后启用联网搜索。/);
    assert.doesNotMatch(
      missingKeyBlock![0],
      /联网搜索未配置 Tavily API key/,
      'missing Tavily key copy should read as a setup waiting state, not unfinished product work',
    );
  });

  it('renderer never imports the main-process Tavily client', async () => {
    for (const rel of RENDERER_FILES) {
      const src = await readFile(join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(
        src,
        /from\s+['"][^'"]*tavily['"]/,
        `${rel} must not import tavily — main-process only`,
      );
      assert.doesNotMatch(
        src,
        /from\s+['"][^'"]*web-search\/[^'"]+['"]/,
        `${rel} must not pull from apps/desktop main/web-search/* path`,
      );
    }
  });

  it('preload + global type declarations do not surface a cleartext WebSearch apiKey field on responses', async () => {
    // The settings shape may carry `apiKey` (the masked sentinel is
    // routed there). The query/test responses must not.
    const preload = await readFile(join(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    assert.doesNotMatch(
      preload,
      /webSearch:[\s\S]*?apiKey:\s*string;[^{]*?\):/,
      'preload webSearch bridge must not declare an outgoing apiKey on its return types',
    );
    // The response type is `WebSearchResponse` from @maka/core which
    // is a discriminated union of `{results}` / `{reason, message}`.
    // Neither variant carries an `apiKey` field; this assertion is
    // belt-and-braces.
    const coreShape = await readFile(join(REPO_ROOT, 'packages/core/src/web-search.ts'), 'utf8');
    const responseBlock = coreShape.match(/export type WebSearchResponse[\s\S]*?;/);
    assert.ok(responseBlock, 'WebSearchResponse type block must exist');
    assert.doesNotMatch(
      responseBlock![0],
      /apiKey/,
      'WebSearchResponse must NOT carry apiKey in either variant',
    );
  });

  it('Settings persists credential test results with the observed key version', async () => {
    const settings = await readSettingsCombinedSource();
    assert.match(
      settings,
      /const testedCredentialVersion = tavily\.credentialVersion/,
      'credential test must snapshot the saved key version before awaiting network',
    );
    assert.match(
      settings,
      /if \(!usesDraftKey && hasUsableKey\)[\s\S]*?persistCredentialStatus\(webSearchCredentialStatusFromResponse\(result\), testedCredentialVersion\)/,
      'credential test result must carry the observed key version back to settings',
    );
    assert.match(
      settings,
      /const queriedCredentialVersion = tavily\.credentialVersion/,
      'live query must snapshot the saved key version before awaiting network',
    );
    assert.match(
      settings,
      /persistCredentialStatus\('valid', queriedCredentialVersion\)/,
      'successful live query status must carry the observed key version',
    );
  });

  it('Settings surfaces save failures without turning search results into query failures', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(
      page![0],
      /async function updateWebSearch\([\s\S]*?failureTitle = copy\.saveFailed[\s\S]*?await props\.onUpdate\(\{ webSearch: patch \}\);[\s\S]*?return true;[\s\S]*?catch \(error\) \{[\s\S]*?if \(webSearchMountedRef\.current\) \{[\s\S]*?toast\.error\(failureTitle, settingsActionErrorMessage\(error, locale\)\);[\s\S]*?\}[\s\S]*?return false;/,
      'Web search settings updates must surface persistence failures',
    );
    assert.match(
      page![0],
      /return updateWebSearch\([\s\S]*copy\.saveStatusFailed[\s\S]*\);/,
      'Credential status writeback failures should have their own visible copy',
    );
    assert.match(
      page![0],
      /const saved = await updateWebSearch\(\{ providers: \{ tavily: \{ apiKey: draftKey \} \} \}\);[\s\S]*if \(!saved\) return;[\s\S]*if \(!webSearchMountedRef\.current\) return;[\s\S]*toast\.success\(copy\.keySaved/,
      'Saving a Tavily key must not show success after a failed settings save',
    );
    assert.match(
      page![0],
      /const saved = await updateWebSearch\(\{ enabled: false, providers: \{ tavily: \{ apiKey: '' \} \} \}\);[\s\S]*if \(!saved\) return;[\s\S]*if \(!webSearchMountedRef\.current\) return;[\s\S]*toast\.success\(copy\.credentialsCleared/,
      'Clearing a Tavily key must not show success after a failed settings save',
    );
    assert.match(
      page![0],
      /if \(!isCurrentLiveQuery\(queryOwner\)\) return;[\s\S]*if \(result\.ok\) \{[\s\S]*setLiveQueryResults\(result\.results\);[\s\S]*void persistCredentialStatus\('valid', queriedCredentialVersion\);[\s\S]*\} else \{/,
      'Successful live query results must render even if credential-status persistence later fails',
    );
    assert.doesNotMatch(
      page![0],
      /await persistCredentialStatus\(/,
      'Credential-status persistence must not block test/query result handling',
    );
  });

  it('Settings gates web-search credential actions and live query with visible pending feedback', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(page![0], /const \[pendingWebSearchEnabled, setPendingWebSearchEnabled\] = useState\(false\)/);
    assert.match(page![0], /const \[pendingCredentialAction, setPendingCredentialAction\] = useState<'save' \| 'clear' \| null>\(null\)/);
    assert.match(
      page![0],
      /const webSearchActionGuard = useKeyedActionGuard<'set-enabled' \| 'credential' \| 'test' \| 'live-query'>\(\)/,
      'Web search pending owners must come from the shared keyed action guard instead of hand-rolled refs',
    );
    assert.match(page![0], /const liveQueryInputRef = useRef\(liveQuery\)/);
    assert.match(
      page![0],
      /function updateLiveQuery\(next: string\) \{[\s\S]*liveQueryInputRef\.current = next;[\s\S]*setLiveQuery\(next\);[\s\S]*setLiveQueryError\(null\);[\s\S]*setLiveQueryResults\(null\);[\s\S]*\}/,
      'Changing the live-query input must immediately invalidate stale result/error rows.',
    );
    assert.match(
      page![0],
      /function isCurrentLiveQuery\(queryOwner: string\): boolean \{[\s\S]*return webSearchMountedRef\.current && liveQueryInputRef\.current === queryOwner;[\s\S]*\}/,
      'Live-query continuations must be owned by the exact submitted query string.',
    );
    assert.match(
      page![0],
      /async function runCredentialAction\([\s\S]*if \(webSearchActionGuard\.has\('credential'\) \|\| webSearchActionGuard\.has\('test'\)\) return;[\s\S]*webSearchActionGuard\.begin\('credential'\);[\s\S]*setPendingCredentialAction\(action\);[\s\S]*await run\(\);[\s\S]*releaseCredential\(\);[\s\S]*setPendingCredentialAction\(null\);/,
      'Saving or clearing Tavily credentials must reject duplicate clicks synchronously and expose pending state.',
    );
    assert.match(
      page![0],
      /async function setEnabled\(enabled: boolean\) \{[\s\S]*const releaseEnabled = webSearchActionGuard\.begin\('set-enabled'\);[\s\S]*if \(!releaseEnabled\) return;[\s\S]*setPendingWebSearchEnabled\(true\);[\s\S]*await updateWebSearch\(\{ enabled \}\);[\s\S]*releaseEnabled\(\);[\s\S]*setPendingWebSearchEnabled\(false\);/,
      'The web-search enable switch must reject duplicate same-frame toggles and expose local pending state.',
    );
    assert.match(page![0], /runCredentialAction\('save', async \(\) => \{/);
    assert.match(page![0], /runCredentialAction\('clear', async \(\) => \{/);
    assert.match(
      page![0],
      /if \(webSearchActionGuard\.has\('test'\) \|\| webSearchActionGuard\.has\('credential'\)\) return;[\s\S]*const releaseTest = webSearchActionGuard\.begin\('test'\);[\s\S]*if \(!releaseTest\) return;[\s\S]*setTesting\(true\);[\s\S]*releaseTest\(\);[\s\S]*setTesting\(false\);/,
      'Credential tests must also have a guard-backed duplicate-click guard.',
    );
    assert.match(
      page![0],
      /if \(webSearchActionGuard\.has\('live-query'\)\) return;[\s\S]*const queryOwner = liveQueryInputRef\.current;[\s\S]*webSearchActionGuard\.begin\('live-query'\);[\s\S]*setLiveQueryRunning\(true\);[\s\S]*releaseLiveQuery\(\);[\s\S]*setLiveQueryRunning\(false\);/,
      'Live query verification must have a guard-backed duplicate-submit guard.',
    );
    assert.match(page![0], /const credentialActionBusy = pendingCredentialAction !== null \|\| testing/);
    assert.match(page![0], /disabled=\{usingEnvKey \|\| credentialActionBusy\}/, 'Credential input should freeze while save, clear, or test is pending.');
    // #1565 PR 3: Astryx Button takes `isDisabled` instead of `disabled`.
    assert.match(page![0], /isDisabled=\{credentialActionBusy \|\| usingEnvKey \|\| draftKey\.length === 0\}/);
    assert.match(page![0], /pendingCredentialAction === 'save' \? copy\.saving : copy\.saveKey/);
    assert.match(page![0], /isDisabled=\{credentialActionBusy \|\| \(draftKey\.length === 0 && !hasUsableKey\)\}/);
    assert.match(page![0], /isDisabled=\{credentialActionBusy\}[\s\S]*pendingCredentialAction === 'clear' \? copy\.clearing : copy\.clearKey/);
    assert.match(page![0], /onChange=\{\(value\) => updateLiveQuery\(value\)\}/);
    assert.match(page![0], /isDisabled=\{!hasUsableKey \|\| pendingWebSearchEnabled\}/);
  });

  it('Settings web-search async actions stop writing component state after unmount', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(
      page![0],
      /const webSearchMountedRef = useMountedRef\(\)/,
      'Web search Settings needs a mounted ref because test/query/save promises can settle after the section unmounts',
    );
    assert.match(
      page![0],
      /const webSearchActionGuard = useKeyedActionGuard<'set-enabled' \| 'credential' \| 'test' \| 'live-query'>\(\)/,
      'Unmount must release synchronous pending owners (the shared keyed guard hook resets every key on unmount)',
    );
    assert.match(
      page![0],
      /finally \{[\s\S]*releaseEnabled\(\);[\s\S]*if \(webSearchMountedRef\.current\) \{[\s\S]*setPendingWebSearchEnabled\(false\);[\s\S]*\}/,
      'Web-search enable completion must not set pending switch state after unmount',
    );
    assert.match(
      page![0],
      /finally \{[\s\S]*releaseCredential\(\);[\s\S]*if \(webSearchMountedRef\.current\) \{[\s\S]*setPendingCredentialAction\(null\);[\s\S]*\}/,
      'Credential save/clear completion must not set state after unmount',
    );
    assert.match(
      page![0],
      /if \(!webSearchMountedRef\.current\) return;[\s\S]*setDraftKey\(''\);/,
      'Credential save/clear success must not clear local draft state or toast after unmount',
    );
    assert.match(
      page![0],
      /const result = await window\.maka\.webSearch\.test\([\s\S]*if \(!webSearchMountedRef\.current\) return;[\s\S]*if \(!usesDraftKey && hasUsableKey\) \{[\s\S]*void persistCredentialStatus/,
      'Credential test must not toast or write credential status after unmount',
    );
    assert.match(
      page![0],
      /finally \{[\s\S]*releaseTest\(\);[\s\S]*if \(webSearchMountedRef\.current\) \{[\s\S]*setTesting\(false\);[\s\S]*\}/,
      'Credential test completion must not set testing state after unmount',
    );
    assert.match(
      page![0],
      /const result = await window\.maka\.webSearch\.query\([\s\S]*if \(!isCurrentLiveQuery\(queryOwner\)\) return;[\s\S]*if \(result\.ok\) \{[\s\S]*setLiveQueryResults\(result\.results\);/,
      'Live-query success must not set results after unmount or after the query input changed',
    );
    assert.match(
      page![0],
      /if \(isCurrentLiveQuery\(queryOwner\)\) \{[\s\S]*setLiveQueryError\(settingsActionErrorMessage\(err, locale\)\);[\s\S]*\}/,
      'Live-query thrown errors must not set inline error state after unmount or after the query input changed',
    );
    assert.match(
      page![0],
      /finally \{[\s\S]*releaseLiveQuery\(\);[\s\S]*if \(webSearchMountedRef\.current\) \{[\s\S]*setLiveQueryRunning\(false\);[\s\S]*\}/,
      'Live-query completion must not clear running state after unmount',
    );
  });

  it('Settings web-search thrown errors pass through the shared Settings scrubber', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(
      page![0],
      /catch \(err\) \{[\s\S]*toast\.error\(copy\.testError, settingsActionErrorMessage\(err, locale\)\)/,
      'Tavily credential-test thrown errors must not echo raw IPC/provider messages',
    );
    assert.match(
      page![0],
      /catch \(err\) \{[\s\S]*setLiveQueryError\(settingsActionErrorMessage\(err, locale\)\)/,
      'Tavily live-query thrown errors must render scrubbed Settings copy',
    );
    assert.doesNotMatch(
      page![0],
      /Tavily 测试出错', err instanceof Error \? err\.message : String\(err\)|setLiveQueryError\(err instanceof Error \? err\.message : String\(err\)\)/,
      'Web search Settings must not surface raw thrown error messages',
    );
  });

  it('Settings live query button explains the actionable disabled reason', async () => {
    const settings = await readSettingsCombinedSource();
    const helper = settings.match(/function webSearchQueryDisabledReason[\s\S]*?function presentWebSearchCredentialStatus/);
    const zhCopy = getWebSearchSettingsCopy('zh');

    assert.ok(helper, 'Web search settings must have a dedicated disabled-reason helper');
    assert.match(helper![0], /input\.copy\.disabledReasons\.noKey/);
    assert.match(helper![0], /input\.copy\.disabledReasons\.disabled/);
    assert.match(helper![0], /input\.copy\.disabledReasons\.noQuery/);
    assert.match(zhCopy.disabledReasons.noKey, /TAVILY_API_KEY/);
    assert.match(zhCopy.disabledReasons.disabled, /启用联网搜索/);
    assert.match(zhCopy.disabledReasons.noQuery, /输入查询/);
    // #1565 PR 3: Astryx Button takes `isDisabled` instead of `disabled`.
    assert.match(settings, /isDisabled=\{liveQueryRunning \|\| queryDisabledReason !== null\}/);
    assert.match(settings, /\{queryDisabledReason\}/);
    assert.doesNotMatch(
      settings,
      /先开关启用联网搜索/,
      'Web search disabled copy must not tell users to enable a switch that may itself be blocked by a missing key',
    );
  });

  it('Settings web-search simple controls use grouped Settings row cards instead of naked form blocks', async () => {
    const settings = await readSettingsCombinedSource();
    const styles = await readAllRendererCss();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(
      page![0],
      /<SettingsRows className="settingsWebSearchCredentialCard">/,
      'Web search credential controls should sit in the shared grouped Settings card primitive',
    );
    assert.match(
      page![0],
      /<SettingsRows className="settingsWebSearchQueryCard">/,
      'Web search live-query controls should sit in the shared grouped Settings card primitive',
    );
    for (const rowClass of [
      'settingsRow settingsWebSearchEnableRow',
      'settingsRow settingsWebSearchKeyRow',
      'settingsRow settingsWebSearchCredentialActionRow',
      'settingsRow settingsWebSearchQueryIntroRow',
      'settingsRow settingsWebSearchQueryInputRow',
      'settingsRow settingsWebSearchSearchRow',
    ]) {
      assert.match(page![0], new RegExp(`className="${rowClass}"`), `Web search Settings must keep ${rowClass} inside grouped rows`);
    }
    assert.match(page![0], /className="settingsWebSearchDisabledReason"/);
    assert.match(page![0], /<ul className="settingsWebSearchResults" aria-label=\{copy\.resultsAria\}>/);
    assert.doesNotMatch(
      page![0],
      /settingsFormRow|settingsFormGrid|style=\{\{/,
      'Web search Settings must not regress to naked form rows/grids or inline layout styles',
    );
    assert.match(styles, /\.settingsWebSearchKeyRow > \.settingsPasswordField/);
    assert.match(styles, /\.settingsWebSearchQueryIntroRow\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    assert.match(styles, /\.settingsWebSearchDisabledReason\s*\{[\s\S]*?color:\s*var\(--muted-foreground\);/);
  });

  it('Settings credential badge uses waiting-state copy instead of raw missing configuration copy', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);
    const helper = settings.match(/function presentWebSearchCredentialStatus[\s\S]*?function MemorySettingsPage/);
    const zhCopy = getWebSearchSettingsCopy('zh');

    assert.ok(page, 'Web search settings page block must exist');
    assert.ok(helper, 'Web search settings must centralize credential status presentation');
    assert.match(
      page![0],
      /<div className="settingsWebSearchStatusCluster" role="group" aria-label=\{copy\.statusAria\}>/,
      'Web search credential status badge/source cluster must expose an accessible group name',
    );
    assert.doesNotMatch(
      page![0],
      /<div className="settingsWebSearchStatusCluster">/,
      'Web search credential status cluster must not regress to an anonymous group beside the enable switch',
    );
    assert.match(helper![0], /copy\.statuses\.not_configured/);
    assert.match(helper![0], /copy\.sources\.env/);
    assert.match(helper![0], /copy\.sources\.saved/);
    assert.match(zhCopy.statuses.not_configured, /等待配置/);
    assert.match(zhCopy.sources.env, /来源：环境变量/);
    assert.match(zhCopy.sources.saved, /来源：本机已保存密钥/);
    assert.doesNotMatch(helper![0], /未保存 key|等待保存 key|已保存 key|label:\s*'未配置'/);
  });

  it('Settings exposes env credential source without enabling renderer key access', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(page![0], /const usingEnvKey = credentialSource === 'env'/);
    assert.match(page![0], /copy\.envPlaceholder/);
    assert.match(page![0], /copy\.envKeyHelp/);
    assert.match(getWebSearchSettingsCopy('zh').envKeyHelp, /TAVILY_API_KEY \/ MAKA_TAVILY_API_KEY/);
    assert.match(page![0], /disabled=\{usingEnvKey \|\| credentialActionBusy\}/);
    assert.doesNotMatch(page![0], /process\.env|TAVILY_API_KEY[\s\S]{0,40}apiKey/);
  });

  it('settings IPC masks Tavily keys even on save responses', async () => {
    const helper = await readFile(join(REPO_ROOT, 'apps/desktop/src/main/settings-ipc-helpers.ts'), 'utf8');
    const webSearchMaskBlock = helper.match(/webSearch:\s*\{[\s\S]*?credentialSource: getTavilyCredentialSource\(settings\),[\s\S]*?\r?\n\s*\},\r?\n\s*\},\r?\n\s*\},/);

    assert.ok(webSearchMaskBlock, 'settings IPC must have a dedicated webSearch mask block');
    assert.match(webSearchMaskBlock![0], /apiKey:\s*maskSensitive\(settings\.webSearch\.providers\.tavily\.apiKey\) \?\? ''/);
    assert.doesNotMatch(
      webSearchMaskBlock![0],
      /shouldReveal/,
      'web search API key must not use generic reveal-on-save behavior',
    );
  });

  it('Settings live query copy uses product language instead of demo/debug wording', async () => {
    const settings = await readSettingsCombinedSource();
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);
    const zhCopy = getWebSearchSettingsCopy('zh');

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(page![0], /copy\.liveTitle/);
    assert.match(page![0], /copy\.liveHelp/);
    assert.match(page![0], /<ul className="settingsWebSearchResults" aria-label=\{copy\.resultsAria\}>/);
    assert.match(page![0], /placeholder=\{copy\.queryPlaceholder\}/);
    assert.match(zhCopy.liveTitle, /真实查询验证/);
    assert.match(zhCopy.liveHelp, /不写入会话也不写入遥测/);
    assert.match(zhCopy.queryPlaceholder, /本周 AI 产品发布动态/);
    assert.doesNotMatch(page![0], /Electron safeStorage|Tavily API key|保存 key|清空 key|等待保存 key|key 无效/);
    assert.doesNotMatch(page![0], />试一下</);
    assert.doesNotMatch(page![0], />试一下<|不入 telemetry|demoQuery|demoRunning|runDemo|demoResults|demoError|试一下" demo/);
  });

  it('WebSearch shared tool-result source uses live-query naming instead of demo language', async () => {
    const previewSource = await readFile(TOOL_RESULT_PREVIEW, 'utf8');
    const coreEvents = await readFile(join(REPO_ROOT, 'packages/core/src/events.ts'), 'utf8');
    const webSearchPreview = previewSource.match(/function WebSearchPreview[\s\S]*?function WebSearchErrorPreview/);
    const webSearchContent = coreEvents.match(/PR-CHAT-WEB-SEARCH-RENDER-0[\s\S]*?kind:\s*'web_search'/);

    assert.ok(webSearchPreview, 'WebSearchPreview block must exist');
    assert.ok(webSearchContent, 'web_search ToolResultContent block must exist');
    assert.match(previewSource, /live-query[\s\S]*verification/);
    assert.match(coreEvents, /live-query[\s\S]*verification/);
    assert.doesNotMatch(webSearchPreview![0], /试一下|demo|manual try-out/i);
    assert.doesNotMatch(webSearchContent![0], /试一下|demo|manual try-out/i);
  });

  it('WebSearch agent errors render as repair-oriented cards, not raw JSON', async () => {
    const previewSource = await readFile(TOOL_RESULT_PREVIEW, 'utf8');
    const runtime = await readFile(join(REPO_ROOT, 'packages/runtime/src/tool-runtime.ts'), 'utf8');
    const agentTool = await readFile(join(REPO_ROOT, 'apps/desktop/src/main/web-search/agent-tool.ts'), 'utf8');
    const coreEvents = await readFile(join(REPO_ROOT, 'packages/core/src/events.ts'), 'utf8');
    const toolResultPreview = previewSource.match(/export function ToolResultPreview[\s\S]*?if \(content\.kind === 'json'\)/);
    const errorPreview = previewSource.match(/function WebSearchErrorPreview[\s\S]*$/);

    assert.match(coreEvents, /kind:\s*'web_search_error'/);
    assert.match(agentTool, /kind:\s*'web_search_error'/);
    assert.match(runtime, /content\.kind === 'web_search_error'\) return 'error'/);
    assert.ok(toolResultPreview, 'ToolResultPreview block must exist');
    assert.match(toolResultPreview![0], /content\.kind === 'web_search_error'/);
    assert.ok(errorPreview, 'WebSearchErrorPreview block must exist');
    assert.match(errorPreview![0], /copy\.credentialSource\.env/);
    assert.match(errorPreview![0], /copy\.webGuidance\.settings/);
    assert.doesNotMatch(errorPreview![0], /JSON\.stringify|<pre/);
  });
});
