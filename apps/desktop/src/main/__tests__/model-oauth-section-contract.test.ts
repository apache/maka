/**
 * Static-analysis contract for the OAuth model-provider catalog in
 * the provider settings source files
 * (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the user-visible OAuth login surface: four runnable cards
 * (Claude / Codex / GitHub Copilot / xAI), each marked
 * `status: 'available'`, and each click wires through to its
 * matching `window.maka.<provider>Subscription` bridge namespace.
 *
 * This is a source-grep contract, not a DOM render — we don't
 * pull React into the desktop test runner. Stamp shapes are
 * verified by reading the provider settings sources.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const PRELOAD_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts');
// The browser-loopback login/logout controller was extracted out of
// SubscriptionLoginModal into this shared hook so the model connection detail
// sheet's 重新登录 button drives the identical flow. Its internals are pinned
// here directly (it is not part of the provider settings combined source).
const OAUTH_LOGIN_FLOW_HOOK_SOURCE = resolve(
  REPO_ROOT,
  'apps', 'desktop', 'src', 'renderer', 'settings', 'use-oauth-login-flow.ts',
);

describe('Model OAuth catalog contract (PR-MODEL-OAUTH-ALL-0 + PR-CLAUDE-CARD-MOVE-0)', () => {
  it('keeps runnable OAuth accounts inside the inline add catalog', async () => {
    const src = await readProviderSettingsCombinedSource();
    const tabs = src.match(/const CATALOG_TABS:[\s\S]*?\];/);
    assert.ok(tabs, 'CATALOG_TABS literal must exist');
    assert.match(tabs[0], /['"]accounts['"]/, 'account connections need a direct catalog category');
    assert.match(
      src,
      /\(catalogCategory === 'recommended' \|\| catalogCategory === 'accounts'\)[\s\S]*<ModelOAuthSection[\s\S]*onConnectionsChanged=\{async \(\) => \{ await reload\(\); \}\}/,
      'runnable OAuth accounts must appear in both recommended and account catalog views',
    );
    const marketStart = src.indexOf('<section className="providerMarket">');
    const firstOAuthRender = src.indexOf('<ModelOAuthSection');
    assert.ok(marketStart !== -1, 'provider market section must exist');
    assert.ok(firstOAuthRender > marketStart, 'ModelOAuthSection must stay inside the provider connection surface');
    assert.doesNotMatch(src, /className="providerAccountSection"/, 'account cards must not remain a permanent root-page section');
  });

  it('catalog tabs use the shared primitive Tabs primitive as a real tablist', async () => {
    const src = await readProviderSettingsCombinedSource();
    const tabs = src.match(/<PrimitiveTabs\s+className="catalogTabsRoot"[\s\S]*?<\/PrimitiveTabs>/)?.[0] ?? '';

    // Provider settings files must source UI from the shared @maka/ui
    // primitives (component governance), not hand-rolled markup.
    const uiImports = src.match(/import \{[^}]*\} from '@maka\/ui';/g)?.join('\n') ?? '';
    for (const name of [
      'Button',
      'PrimitiveTabs', 'PrimitiveTabsList', 'PrimitiveTabsTrigger',
      'Item', 'ItemMedia', 'ItemContent', 'ItemTitle', 'ItemDescription', 'ItemActions',
      'Input', 'RelativeTime', 'Textarea', 'useToast',
    ]) {
      assert.ok(
        uiImports.includes(name),
        `provider settings files should import ${name} from the shared @maka/ui primitives`,
      );
    }
    assert.doesNotMatch(src, /function onCatalogTabsKeyDown/, 'provider catalog tabs should not keep a custom keyboard handler');
    assert.doesNotMatch(src, /data-catalog-tab="\$\{CSS\.escape/, 'provider catalog tabs should not use manual focus queries');
    assert.match(tabs, /value=\{catalogCategory\}[\s\S]*onValueChange=\{\(value\) => setCatalogCategory\(value as CatalogCategory\)\}/);
    assert.match(tabs, /<PrimitiveTabsList[^>]*variant="pill"[^>]*aria-label=\{copy\.categoriesAria\}>/);
    assert.match(tabs, /<PrimitiveTabsTrigger[\s\S]*value=\{tab\}/, 'catalog tabs use PrimitiveTabsTrigger as a real tablist (maka-tab comes from the primitive)');
    assert.match(tabs, /data-catalog-tab=\{tab\}/);
    assert.match(tabs, /\{copy\.tabs\[tab\]\}/, 'catalog tab labels must come from the active locale catalog');
  });

  it('ProvidersPanel surfaces model connection reload failures instead of sticking on loading', async () => {
    const src = await readProviderSettingsCombinedSource();
    const panel = src.match(/export function ProvidersPanel[\s\S]*?const selected = useMemo/)?.[0] ?? '';
    const reloadMatch = src.match(/async function reload\(\): Promise<boolean> \{[\s\S]*?\n  \}/);
    assert.ok(reloadMatch, 'ProvidersPanel reload() must exist');
    assert.match(
      panel,
      /const providersPanelMountedRef = useMountedRef\(\);[\s\S]*const providersReloadTicketRef = useRef\(0\);[\s\S]*const providerDialogLifecycleRef = useRef\(0\);/,
      'ProvidersPanel reloads must track mounted state and latest request ownership',
    );
    assert.match(
      reloadMatch[0],
      /const ticket = \+\+providersReloadTicketRef\.current;[\s\S]*Promise\.all\(\[[\s\S]*bridge\.list\(\),[\s\S]*bridge\.getDefault\(\),[\s\S]*\]\)[\s\S]*if \(!providersPanelMountedRef\.current \|\| providersReloadTicketRef\.current !== ticket\) return false;[\s\S]*setLoadError\(null\)[\s\S]*setLoading\(false\)[\s\S]*return true;/,
      'successful reload must clear load error only for the latest mounted request',
    );
    assert.match(
      reloadMatch[0],
      /catch \(error\) \{[\s\S]*if \(!providersPanelMountedRef\.current \|\| providersReloadTicketRef\.current !== ticket\) return false;[\s\S]*providerPanelActionErrorMessage\(error, locale\)[\s\S]*setLoadError\(message\)[\s\S]*setLoading\(false\)[\s\S]*toast\.error\(copy\.loadFailed, message\)[\s\S]*return false;/,
      'failed reload must not toast or write stale failure state after unmount or a newer reload',
    );
    assert.match(
      panel,
      /return \(\) => \{[\s\S]*providersReloadTicketRef\.current \+= 1;[\s\S]*unsubscribe\?\.\(\);/,
      'ProvidersPanel cleanup must invalidate in-flight reloads and unsubscribe from connection events',
    );
    assert.match(
      src,
      /loadError \? \([\s\S]*copy\.loadFailed[\s\S]*copy\.retry/,
      'enabled-model strip must show a retryable load-failure state',
    );
    assert.match(
      src,
      /function closeDialog\(\) \{[\s\S]*providerDialogLifecycleRef\.current \+= 1;[\s\S]*setDialogState\(null\);[\s\S]*\}/,
      'closing a dialog must invalidate pending dialog-scoped continuations',
    );
    assert.match(
      src,
      /onCreated=\{async \(_slug, modelDiscoveryError\) => \{[\s\S]*const lifecycle = providerDialogLifecycleRef\.current;[\s\S]*const reloaded = await reload\(\);[\s\S]*providerDialogLifecycleRef\.current !== lifecycle[\s\S]*\) return;[\s\S]*closeDialog\(\);/,
      'AddProviderForm completion must not close a newer dialog after the original dialog was dismissed',
    );
    assert.match(
      src,
      /onDeleted=\{async \(\) => \{[\s\S]*closeDialog\(\);[\s\S]*const reloaded = await reload\(\);[\s\S]*providerCatalogRef\.current\?\.querySelector<HTMLInputElement>\('\[type="search"\]'\)\?\.focus\(\);/,
      'Connection delete completion must restore focus to the stable provider search after refreshing the root list',
    );
  });

  it('provider detail actions localize and sanitize model-test / model-fetch failures', async () => {
    const providers = await readProviderSettingsCombinedSource();
    const main = await readMainProcessCombinedSource();
    const detail = providers.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';
    const addForm = providers.match(/function AddProviderForm[\s\S]*?function nextSlug/)?.[0] ?? '';

    assert.match(
      providers,
      /const fallback = getProviderSettingsCopy\(locale\)\.shared\.actionFallback;[\s\S]*locale === 'zh' \? generalizedErrorMessageChinese\(error, fallback\) : generalizedErrorMessage\(error, fallback\)/,
      'provider action errors must use the locale-appropriate redaction classifier before reaching toast detail',
    );
    assert.match(
      providers,
      /function connectionTestFailureMessage\([\s\S]*locale: UiLocale = 'zh'[\s\S]*locale === 'zh'[\s\S]*generalizedErrorMessageChinese\(new Error\(result\.errorMessage\), fallback\)[\s\S]*generalizedErrorMessage\(new Error\(result\.errorMessage\), fallback\)/,
      'failed connection tests must not toast raw provider response bodies',
    );
    assert.match(
      providers,
      /function connectionTestFailureFallback\(\s*result: ConnectionTestResult,\s*copy: ConnectionTestTroubleshootingCopy,\s*locale: UiLocale = 'zh',\s*\): string \{[\s\S]*statusCode === 429[\s\S]*errorClass === 'auth'[\s\S]*copy\.auth[\s\S]*copy\.recheck/,
      'connection-test failure classification must live once in provider-panel-shared with injectable surface copy',
    );
    assert.match(
      detail,
      /toast\.error\([\s\S]*copy\.connectionFailed\(connection\.name\),[\s\S]*connectionTestFailureMessage\(result, \{\s*auth: copy\.authTroubleshooting\(credentialTroubleshootingCopy\),\s*recheck: copy\.recheckTroubleshooting\(credentialTroubleshootingCopy\),\s*\}, locale\)/,
      'ConnectionDetail test failure toast must use shared helper with Models-sheet troubleshooting copy',
    );
    assert.doesNotMatch(
      detail,
      /function connectionTestFailure(?:Message|Fallback)\(/,
      'ConnectionDetail must not keep a private connection-test failure classifier after sharing',
    );
    assert.match(
      detail,
      /const connectionDetailActionGuard = useKeyedActionGuard<[\s\S]*'save' \| 'test' \| 'fetch-models' \| 'save-enabled-models' \| 'set-default' \| 'delete'[\s\S]*>\(\)/,
      'ConnectionDetail actions must have synchronous duplicate-action guards from the shared keyed guard, not only React state',
    );
    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*const releaseSave = connectionDetailActionGuard\.beginExclusive\('save'\);[\s\S]*if \(!releaseSave\) return;[\s\S]*props\.bridge\.update\(/,
      'ConnectionDetail save must set its duplicate-submit guard before awaiting bridge.update()',
    );
    assert.match(
      detail,
      /async function runTest\(\) \{[\s\S]*const releaseTest = connectionDetailActionGuard\.beginExclusive\('test'\);[\s\S]*if \(!releaseTest\) return;[\s\S]*props\.bridge\.test\(/,
      'ConnectionDetail test must be gated synchronously before awaiting bridge.test()',
    );
    assert.match(
      detail,
      /async function refreshModels\(opts: \{ silent\?: boolean \} = \{\}\) \{[\s\S]*const releaseFetch = opts\.silent[\s\S]*\? connectionDetailActionGuard\.begin\('fetch-models'\)[\s\S]*: connectionDetailActionGuard\.beginExclusive\('fetch-models'\);[\s\S]*if \(!releaseFetch\) return;[\s\S]*props\.bridge\.fetchModels\(/,
      'ConnectionDetail model refresh must be duplicate-gated while preserving the post-save silent refresh',
    );
    assert.match(
      detail,
      /async function setAsDefault\(\) \{[\s\S]*const releaseSetDefault = connectionDetailActionGuard\.beginExclusive\('set-default'\);[\s\S]*if \(!releaseSetDefault\) return;[\s\S]*props\.bridge\.setDefault\(/,
      'ConnectionDetail default-switch must be gated synchronously before awaiting bridge.setDefault()',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*const releaseDelete = connectionDetailActionGuard\.beginExclusive\('delete'\);[\s\S]*if \(!releaseDelete\) return;[\s\S]*props\.bridge\.delete\(/,
      'ConnectionDetail delete must be gated synchronously before awaiting bridge.delete()',
    );
    assert.match(
      detail,
      /const detailActionBusy = busy \|\| testing \|\| fetchingModels \|\| savingEnabledModels \|\| settingDefault \|\| deleting/,
      'ConnectionDetail must expose one visible busy state that freezes payload-affecting controls',
    );
    assert.match(
      detail,
      /<ConnectionEndpointField[\s\S]*disabled=\{detailActionBusy\}[\s\S]*function ConnectionEndpointField[\s\S]*disabled=\{props\.disabled\}/,
      'ConnectionDetail service-address draft must freeze while any detail action is in flight',
    );
    assert.match(
      detail,
      /<PasswordInput[\s\S]*disabled=\{detailActionBusy\}/,
      'ConnectionDetail API key draft must freeze while any detail action is in flight',
    );
    assert.match(
      detail,
      /<EnabledModelManager[\s\S]*disabled=\{detailActionBusy\}/,
      'ConnectionDetail enabled-model editor must freeze while any detail action is in flight',
    );
    assert.match(
      detail,
      /<Button type="button" disabled=\{detailActionBusy \|\| !hasApiKeyChange\} onClick=\{save\}>[\s\S]*\{busy \? copy\.saving : copy\.updateKey\}/,
      'ConnectionDetail key save button stays present but disabled until the key draft is dirty (constant dialog height)',
    );
    assert.match(
      detail,
      /className="providerEndpointActions"[\s\S]*<Button type="button" disabled=\{detailActionBusy \|\| !hasBaseUrlChange\} onClick=\{save\}>[\s\S]*\{busy \? copy\.saving : copy\.saveEndpoint\}/,
      'ConnectionDetail endpoint save button stays present but disabled until the endpoint draft is dirty',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy \|\| !hasUsableCredential\} onClick=\{runTest\}[\s\S]*\{testing \? copy\.testing : copy\.testConnection\}/,
      'ConnectionDetail test button must show visible pending feedback and disable all peer actions',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy\} onClick=\{setAsDefault\}[\s\S]*\{settingDefault \? copy\.setting : copy\.setDefault\}/,
      'ConnectionDetail default button must show visible pending feedback and disable all peer actions',
    );
    assert.match(
      detail,
      /disabled=\{detailActionBusy\} onClick=\{remove\}[\s\S]*\{deleting \? copy\.deleting : copy\.deleteConnection\}/,
      'ConnectionDetail delete button must show visible pending feedback and disable all peer actions',
    );
    assert.match(
      detail,
      /catch \(error\) \{[\s\S]*const message = providerPanelActionErrorMessage\(error, locale\);[\s\S]*toast\.error\(copy\.connectionTestError\(connection\.name\), message\)/,
      'ConnectionDetail test IPC failures must use the shared localized action-error helper',
    );
    assert.match(
      detail,
      /catch \(error\) \{[\s\S]*const message = providerPanelActionErrorMessage\(error, locale\);[\s\S]*toast\.error\([\s\S]*copy\.modelsFetchFailed\(connection\.name\),[\s\S]*copy\.modelsFetchFailedDetail\(message, credentialTroubleshootingCopy\)/,
      'ConnectionDetail model-fetch failures must use the shared localized action-error helper',
    );
    assert.doesNotMatch(
      detail,
      /error instanceof Error \? error\.message : String\(error\)/,
      'provider detail action toasts must not directly echo raw Error.message',
    );
    assert.match(
      addForm,
      /catch \(err\) \{[\s\S]*setError\(providerPanelActionErrorMessage\(err, locale\)\)/,
      'AddProviderForm create failures must use the shared localized action-error helper',
    );
    assert.match(
      addForm,
      /const submitGuard = useActionGuard<'submit'>\(\)/,
      'AddProviderForm create must have a synchronous duplicate-submit guard from the shared hook',
    );
    assert.match(
      addForm,
      /const addProviderMountedRef = useMountedRef\(\)/,
      'AddProviderForm must track its own sheet lifetime so pending create continuations cannot write after overlay close (the shared guard hook releases on unmount)',
    );
    assert.match(
      addForm,
      /async function submit\(\) \{[\s\S]*if \(submitGuard\.current !== null\) return;[\s\S]*submitGuard\.begin\('submit'\);[\s\S]*setBusy\(true\);[\s\S]*props\.bridge\.create\(/,
      'AddProviderForm create must set the duplicate-submit guard before awaiting bridge.create()',
    );
    assert.match(
      addForm,
      /const connection = await props\.bridge\.create\([\s\S]*\);[\s\S]*if \(!addProviderMountedRef\.current\) return;[\s\S]*await props\.onCreated\(connection\.slug, modelDiscoveryError\);/,
      'AddProviderForm create completion must not re-open/select provider detail after the sheet was closed mid-save',
    );
    assert.match(
      addForm,
      /catch \(err\) \{[\s\S]*if \(addProviderMountedRef\.current\) setError\(providerPanelActionErrorMessage\(err, locale\)\);[\s\S]*\} finally \{[\s\S]*submitGuard\.finish\(\);[\s\S]*if \(addProviderMountedRef\.current\) setBusy\(false\);[\s\S]*\}/,
      'AddProviderForm create guard must release without setting React state after sheet unmount',
    );
    assert.match(
      addForm,
      /disabled=\{isExperimental \|\| busy\} aria-label=\{copy\.slugAria\}/,
      'AddProviderForm fields must freeze while a create request is in flight so visible draft cannot drift from the submitted payload',
    );
    assert.match(
      addForm,
      /<Button variant="ghost" type="button" disabled=\{busy\} onClick=\{props\.onCancel\}>\{copy\.cancel\}<\/Button>/,
      'AddProviderForm cancel must be disabled while create is in flight',
    );
    assert.doesNotMatch(
      addForm,
      /setError\(err instanceof Error \? err\.message : String\(err\)\)/,
      'AddProviderForm must not render raw create-connection Error.message inline',
    );
    assert.match(
      main,
      /connections:fetchModels[\s\S]*generalizedErrorMessageChinese\(error,\s*'拉取模型列表失败'\)/,
      'main-process fetchModels errors must be localized before crossing IPC to renderer toasts',
    );
    assert.doesNotMatch(
      main,
      /No OAuth login stored for this connection|No API key set for this connection|Failed to fetch provider models/,
      'main-process model connection IPC must not throw English user-visible fallback copy',
    );
  });

  it('all API provider creation uses the shared connection dialog', async () => {
    const src = await readProviderSettingsCombinedSource();
    assert.match(src, /type ProviderDialogState =[\s\S]*kind: 'create'[\s\S]*kind: 'manage'/);
    assert.match(src, /usesQuickApiKeyDialog[\s\S]*defaults\.authKind === 'api_key' && Boolean\(defaults\.baseUrl\)/);
    assert.match(src, /const supportsApiKey = providerAuthSupportsApiKey\(props\.providerType\)/);
    assert.match(src, /const requiresApiKey = providerAuthRequiresSecret\(props\.providerType\) && supportsApiKey/);
    assert.match(src, /<ProviderConnectionDialog[\s\S]*<AddProviderForm/);
    assert.match(src, /<DialogContent[\s\S]*className="maka-modal providerConnectionDialog"/);
    assert.match(src, /initialFocus=\{\(\) =>[\s\S]*summary[\s\S]*\?\? true\}/, 'connection dialogs must focus the visible Advanced summary when no form control precedes it');
    assert.match(src, /ariaLabel="API Key"/);
    assert.match(src, /\.\.\.\(normalizedApiKey \? \{ apiKey: normalizedApiKey \} : \{\}\)/);
    assert.match(
      src,
      /defaults\.category === 'local'[\s\S]*props\.bridge\.fetchModels\(connection\.slug\)[\s\S]*props\.onCreated\(connection\.slug, modelDiscoveryError\)/,
      'new local-provider connections must immediately discover the daemon model catalog',
    );
    assert.doesNotMatch(src, /ProviderPageHeader|providerInlineEditor/, 'creation must not retain an in-pane child editor');
  });

  it('OAuth login uses the same centered connection dialog as API providers', async () => {
    const src = await readProviderSettingsCombinedSource();

    assert.match(src, /function ClaudeSubscriptionModal[\s\S]*<ProviderConnectionDialog/);
    assert.match(src, /function SubscriptionLoginModal[\s\S]*<ProviderConnectionDialog/);
    assert.match(src, /function GitHubCopilotSubscriptionModal[\s\S]*<ProviderConnectionDialog/);
    assert.doesNotMatch(src, /ProviderSheet|providerConfigSheet/, 'the retired right-sheet path must be deleted');
    assert.match(src, /DialogRoot[\s\S]*DialogContent[\s\S]*DialogHeader/, 'the shared dialog must retain modal focus and labelling primitives');
  });

  it('does not auto-open the first provider detail page after loading connections', async () => {
    // WAWQAQ goal sweep: Settings -> 模型 kept reopening the first
    // provider config sheet on every Settings open because reload()
    // defaulted selectedSlug to list[0]. A model list refresh should
    // preserve an already-open sheet if that connection still exists,
    // but it must not select the first provider by default.
    const src = await readProviderSettingsCombinedSource();
    const reloadBlock = src.match(/async function reload\(\)[\s\S]*?^\s*\}/m)?.[0] ?? '';

    assert.match(reloadBlock, /setDialogState\(\(current\) => current\?\.kind === 'manage' && !list\.some\(\(connection\) => connection\.slug === current\.slug\)/);
    assert.match(reloadBlock, /\? null\s*:\s*current/);
    assert.doesNotMatch(reloadBlock, /list\[0\]\?\.slug/, 'reload must not auto-select the first provider');
  });

  it('enabled model chips expose a concise aria-label instead of concatenated duplicate visible text', async () => {
    const src = await readProviderSettingsCombinedSource();

    assert.match(
      src,
      /function chipAriaLabel\(connection: LlmConnection\): string/,
      'enabled model chips need a dedicated accessible name',
    );
    assert.match(
      src,
      /import \{[^}]*connectionChipStatus[^}]*\} from '\.\/provider-connection-status'/,
      'status copy must come from the dedicated provider-connection-status helper (behaviour is covered by provider-connection-status.test.ts), not be parsed out of the chip title',
    );
    assert.match(
      src,
      /return copy\.chipAria\(connection\.name, provider, connection\.slug === defaultSlug, status\?\.label\)/,
      'model connection chip aria-label must describe the model and provider explicitly',
    );
    assert.match(
      src,
      /aria-label=\{chipAriaLabel\(connection\)\}/,
      'enabled model chip buttons must use the dedicated accessible name',
    );
    assert.doesNotMatch(
      src,
      /chipStatusLabel\(connection\)\.split\(' · '\)/,
      'connection names can contain " · ", so status text must not be recovered by splitting the title',
    );
  });

  it('provider catalog cards expose explicit names and localized custom-provider copy', async () => {
    const src = await readProviderSettingsCombinedSource();
    const card = src.match(/function ProviderCatalogCard[\s\S]*?function providerDisabledStatus/)?.[0] ?? '';

    assert.match(
      src,
      /aria-label=\{copy\.cardAria\(display\.name, display\.badge, display\.description, props\.count\)\}/,
      'provider catalog cards need a dedicated accessible name instead of concatenated badge/title/description text',
    );
    assert.match(
      card,
      /aria-label=\{copy\.cardAria\(display\.name, display\.badge, display\.description, props\.count\)\}/,
      'ready provider catalog buttons must use the dedicated accessible name',
    );
    assert.match(
      src,
      /copy\.cardAria\(display\.name, display\.badge, display\.description, props\.count\)/,
      'provider catalog accessible name should start from the user action and provider name',
    );
    assert.match(src, /copy\.cardAria\(display\.name, display\.badge, display\.description, props\.count\)/);
    assert.match(src, /智谱 · OpenAI 兼容/);
    // Provider introduction copy is localized zh / en in the display layer
    // (PROVIDER_DISPLAY_COPY). The OpenAI OAuth account path must still name the
    // account login, not a Codex subscription, in its Chinese copy.
    assert.match(
      src,
      /'openai-codex':\s*\{\s*zh:\s*\{ name: 'OpenAI OAuth', description: 'ChatGPT \/ Codex 账号登录；登录后自动成为可用模型连接。' \}/,
      'OpenAI OAuth account path should not be presented as a Codex subscription in provider settings',
    );
    // Both locales ship explicit copy for the custom relay provider, so the Chinese
    // UI never falls through to the raw English registry fallback. The copy must
    // also name the current wire protocol: this provider is OpenAI Chat
    // Completions-compatible, not OpenAI Responses.
    assert.match(src, /zh: \{ name: '自定义中转站（OpenAI Chat）'/);
    assert.match(src, /en: \{ name: 'Custom relay \(OpenAI Chat\)'/);
    assert.doesNotMatch(
      src,
      /Custom OpenAI-compatible endpoint or gateway|OpenAI-compatible \(custom\)/,
      'localized display copy must not leak the raw English registry fallback into UI',
    );
  });

  it('sources model provider form copy from the reactive locale catalog', async () => {
    const src = await readProviderSettingsCombinedSource();
    const addForm = src.match(/function AddProviderForm[\s\S]*?function ConnectionDetail/)?.[0] ?? '';
    const detail = src.match(/function ConnectionDetail[\s\S]*?function connectionDetailSnapshot/)?.[0] ?? '';
    const enabledModels = src.match(/function EnabledModelManager[\s\S]*?function modelDisplayLabel/)?.[0] ?? '';

    assert.match(addForm, /\{copy\.slug\}/);
    assert.match(addForm, /aria-label=\{copy\.slugAria\}/);
    assert.match(addForm, /\{copy\.endpointLabel\(requiresBaseUrl\)\}/);
    assert.match(addForm, /aria-label=\{copy\.endpointAria\}/);
    assert.match(addForm, /copy\.duplicateSlug/);
    assert.match(addForm, /copy\.endpointRequired/);

    // PR-FIELD-PRIMITIVE-PILOT: ConnectionDetail's form rows moved off the
    // hand-written <label><span/> markup onto the governed Base UI Field
    // primitive (FieldRoot + Label + FieldDescription). Label copy stays
    // Chinese-first; the parenthetical state hints split into their own
    // FieldDescription lines. AddProviderForm is intentionally left on the
    // legacy <label><span/> markup this round (single-page pilot).
    assert.match(detail, /<Label[^>]*>\{copy\.endpoint\}<\/Label>/);
    assert.match(detail, /props\.fixedOAuth && <FieldDescription>\{copy\.oauthFixed\}<\/FieldDescription>/);
    assert.match(detail, /<Label[^>]*>\{copy\.modelKey\}<\/Label>/);
    // The credential hint is a single persistent line (constant dialog height);
    // its text still covers the "已设置，粘贴新值可替换" state.
    assert.match(detail, /<FieldDescription>\{apiKeyStatusHint\}<\/FieldDescription>/);
    assert.match(detail, /hasSecret === true\s*\?\s*copy\.keySet/);
    assert.match(detail, /placeholder=\{hasSecret === true \? '••••••••' : copy\.pasteModelKey\}/);
    assert.match(detail, /ariaLabel=\{copy\.modelKeyAria\(display\.name\)\}/);
    assert.match(detail, /\{copy\.getModelKey\}/);
    assert.match(detail, /copy\.keyTroubleshooting/);

    assert.match(enabledModels, /copy\.enabledModelsTitle/);
    assert.match(enabledModels, /copy\.enabledModelsHelp/);
    assert.match(enabledModels, /copy\.searchModels/);
    assert.match(src, /getProviderSettingsCopy\(locale\)/);
    // Provider descriptions are version-agnostic (provider + access path,
    // never a model generation that goes stale).
    assert.match(src, /Anthropic 官方接入/);
    assert.match(src, /OpenAI 官方接入/);

    for (const block of [addForm, detail, enabledModels]) {
      assert.doesNotMatch(block, />Slug</);
      assert.doesNotMatch(block, /Base URL|\(required\)|API key|从 API 刷新|粘贴 API key|获取 API key|该 provider 的真实模型清单/);
    }
  });

  it('exposes only runnable OAuth cards', async () => {
    // WAWQAQ msg 8bb7e186: Claude must not be a huge standalone
    // inline card while the other OAuth providers are compact
    // cards. All runnable login entries live in the same grid.
    const src = await readProviderSettingsCombinedSource();
    const match = src.match(/function modelOAuthCards\([\s\S]*?return \[([\s\S]*?)\];\s*\}/);
    assert.ok(match, 'modelOAuthCards locale-aware factory must exist');
    const body = match[1]!;
    const ids = [...body.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      ids.sort(),
      ['claude', 'codex', 'github-copilot', 'xai'],
      'the catalog must hide account logins that cannot create a runnable model connection',
    );

    const section = src.match(/function ModelOAuthSection[\s\S]*?function modelOAuthCards/)?.[0] ?? '';
    assert.match(
      section,
      /const \[claudeCatalogEnabled, setClaudeCatalogEnabled\] = useState<boolean \| null>\(null\)/,
      'Claude must remain hidden until the experimental availability check resolves',
    );
    assert.match(
      section,
      /window\.maka\.claudeSubscription\s*\.isExperimentalEnabled\(\)/,
      'the catalog must use the main-process experimental gate as the Claude availability authority',
    );
    assert.match(
      section,
      /card\.id !== 'claude' \|\| claudeCatalogEnabled === true/,
      'the catalog must not expose the Claude entry when its experimental send path is disabled or unknown',
    );
  });

  it('keeps OAuth cards visually aligned with domestic and overseas provider cards', async () => {
    const src = await readProviderSettingsCombinedSource();
    const styles = await readRendererContractCss();
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function modelOAuthCards/);
    assert.ok(sectionMatch, 'ModelOAuthSection render block must exist');
    const section = sectionMatch[0]!;

    assert.match(
      section,
      /className="providerCatalogRow providerOAuthCard"/,
      'OAuth tab rows must reuse the same governed provider catalog row chrome as 国内 / 海外 / 本地 rows',
    );
    assert.match(
      section,
      /<ProviderLogo type=\{card\.providerType\} \/>/,
      'OAuth cards must show the same provider logo affordance as provider catalog cards',
    );
    assert.match(
      section,
      /<ItemTitle className="providerCatalogTitle"[\s\S]*<ItemDescription className="providerCatalogDesc providerOAuthCardDescription"/,
      'OAuth rows must reuse the same Item title/description hierarchy as provider catalog rows',
    );
    assert.doesNotMatch(
      section,
      /style=\{\{\s*\['--oauth-accent' as string\]/,
      'OAuth cards must not keep a separate accent-tinted card surface',
    );

    assert.match(
      styles,
      /\.providerMarketGrid,[\s\S]*?grid-template-columns:\s*1fr/,
      'provider market tabs must use a single-column seamless row list so 国内 and 海外 stay visually identical',
    );
    assert.match(
      styles,
      /\.providerCatalogRow\s*\{/,
      'provider catalog + OAuth rows share the governed .providerCatalogRow chrome so the tabs do not look like unrelated surfaces',
    );
    assert.match(
      styles,
      /\.providerOAuthGrid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
      'OAuth tab must use the same single-column row list as the API-key provider tabs',
    );
    assert.match(
      styles,
      /\.providerMarketGrid \.providerCatalogRow \+ \.providerCatalogRow/,
      'API-key provider rows must use the same seamless hairline separators as OAuth rows',
    );
    assert.match(
      styles,
      /\.providerOAuthGrid \.providerCatalogRow \+ \.providerCatalogRow/,
      'OAuth rows must use the same seamless hairline separators as provider catalog rows',
    );
    assert.match(
      styles,
      /\.providerOAuthCardDescription\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/,
      'OAuth account labels and descriptions must not stretch the card grid vertically',
    );
    assert.doesNotMatch(
      styles,
      /\.providerOAuthCard\s*\{[\s\S]*?display:\s*flex;[\s\S]*?background:\s*color-mix/,
      'OAuth cards must not keep the old separate flex/color-mix card implementation',
    );
  });

  it('every card declares status: "available" (no more "planned" placeholders)', async () => {
    const src = await readProviderSettingsCombinedSource();
    const match = src.match(/function modelOAuthCards\([\s\S]*?return \[([\s\S]*?)\];\s*\}/);
    assert.ok(match, 'modelOAuthCards locale-aware factory must exist');
    const body = match[1]!;
    const statuses = [...body.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(statuses.length, 4, 'each visible runnable card must declare a status');
    for (const s of statuses) {
      assert.equal(s, 'available', `card status must be 'available', got '${s}'`);
    }
    assert.doesNotMatch(body, /'planned'/, 'no card may still claim "planned" status');
  });

  it('wired OAuth provider copy does not say account login is separate from model connections', async () => {
    const src = await readProviderSettingsCombinedSource();
    assert.doesNotMatch(
      src,
      /账号登录不作为模型连接|这类账号登录不会出现在模型连接入口|当前请使用 API key 连接聊天模型|默认隐藏/,
      'Claude/Codex OAuth copy must reflect that successful login creates a usable model connection',
    );
    assert.match(
      src,
      /Claude Pro \/ Max 订阅账号登录；登录后自动成为可用模型连接/,
      'Claude provider display copy must point to the wired OAuth model connection path',
    );
    assert.match(
      src,
      /ChatGPT \/ Codex 账号登录；登录后自动成为可用模型连接/,
      'Codex provider display copy must point to the wired OAuth model connection path',
    );
    assert.match(
      src,
      /Google 账号登录暂未接入聊天发送/,
      'unwired OAuth providers must still fail closed without claiming they are wired',
    );
  });

  it('OAuth model connection detail treats Base URL as fixed provider metadata, not an editable endpoint', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      detail,
      /const hasFixedOAuthBaseUrl = needsOAuth && Boolean\(defaults\.baseUrl\)/,
      'ConnectionDetail must detect fixed OAuth provider endpoints',
    );
    assert.match(
      detail,
      /props\.bridge\.update\(connection\.slug, \{[\s\S]*?baseUrl,/,
      'saving an OAuth connection must submit the read-only endpoint loaded from the connection',
    );
    assert.match(
      detail,
      /<ConnectionEndpointField[\s\S]*baseUrl=\{baseUrl\}/,
      'OAuth Base URL input must display the main-owned connection endpoint',
    );
    assert.match(
      detail,
      /readOnly=\{props\.fixedOAuth\}/,
      'OAuth Base URL must be read-only in the provider detail sheet',
    );
    assert.match(
      detail,
      /aria-readonly=\{props\.fixedOAuth \? 'true' : undefined\}/,
      'the fixed OAuth Base URL state must be exposed to assistive tech',
    );
  });

  it('connection management dialogs lead with credentials and keep model visibility in advanced settings', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetailInner[\s\S]*?function GitHubCopilotReloginNotice/)?.[0] ?? '';
    const credential = detail.indexOf('<PasswordInput');
    const advanced = detail.indexOf('<details className="providerAdvancedSettings"');
    const models = detail.indexOf('<EnabledModelManager');

    assert.ok(credential >= 0, 'API-key connection detail must expose its credential field');
    assert.ok(advanced > credential, 'credentials must remain the primary task before advanced settings');
    assert.ok(models > advanced, 'enabled-model management must stay inside advanced settings');
    assert.doesNotMatch(detail, /<ModelTable/, 'connection detail must not render a default-model picker');
    // The last-test message goes through the display helper in the extracted
    // controller (use-connection-detail.ts); the view renders the derived value.
    assert.match(src, /connectionLastTestMessageDisplay\(connection\.lastTestMessage, locale\)/);
    assert.match(detail, /<RelativeTime ts=\{lastTestAtMs\}/);
    assert.doesNotMatch(detail, /<header>[\s\S]*\{connection\.name\}/, 'the shared DialogHeader must be the only title header');
  });

  it('does not let disabled OAuth connections become the default model', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      detail,
      /if \(!connection\.enabled\) \{[\s\S]*toast\.error\(copy\.connectionDisabled/,
      'ConnectionDetail must guard against stale disabled connections before setDefault',
    );
    assert.match(
      detail,
      /!\s*props\.isDefault && connection\.enabled && \([\s\S]*<Button variant="quiet" type="button" disabled=\{detailActionBusy\} onClick=\{setAsDefault\}>[\s\S]*\{settingDefault \? copy\.setting : copy\.setDefault\}[\s\S]*<\/Button>/,
      'disabled connections must not render the set-default action',
    );
  });

  it('keeps each Save action beside its field, disabled until that field is dirty', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      detail,
      /const hasApiKeyChange = apiKey\.length > 0;[\s\S]*const hasBaseUrlChange = draftBaseUrl !== savedBaseUrl;/,
      'ConnectionDetail must compute dirty state separately for each field it writes',
    );
    // The Save buttons stay mounted (disabled while the field is clean) so the
    // dialog does not add or drop a row — and thus does not jitter in height —
    // the moment the user starts typing a key or editing the endpoint.
    assert.match(
      detail,
      /<Button type="button" disabled=\{detailActionBusy \|\| !hasApiKeyChange\} onClick=\{save\}>[\s\S]*<Button type="button" disabled=\{detailActionBusy \|\| !hasBaseUrlChange\} onClick=\{save\}>/,
      'each Save action stays beside its field and disabled (not unmounted) until that field changes',
    );
    // An OAuth-fixed endpoint is readOnly with no dirty path (no jitter risk),
    // so it must not render a permanently-disabled 保存服务地址 button.
    assert.match(
      detail,
      /\{!hasFixedOAuthBaseUrl && \(\s*<div className="providerEndpointActions">/,
      'OAuth-fixed endpoints render no endpoint Save action instead of a forever-disabled one',
    );
  });

  it('forwards an empty service-address draft so the stored override can be cleared', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      detail,
      /props\.bridge\.update\(connection\.slug, \{[\s\S]*?baseUrl,[\s\S]*?\.\.\.\(apiKey/,
      'ConnectionDetail must send an empty string as an explicit service-address clear',
    );
    assert.doesNotMatch(
      detail,
      /baseUrl:\s*baseUrl\s*\|\|\s*undefined/,
      'ConnectionDetail must not turn an explicit empty service address into an omitted patch field',
    );
  });

  it('renders the full model catalog as one named checkbox list', async () => {
    const src = await readProviderSettingsCombinedSource();
    const enabledModels = src.match(/function EnabledModelManager[\s\S]*?function modelDisplayLabel/)?.[0] ?? '';

    // One persistent list of every candidate model; enabled state is a checkbox
    // reflecting `enabledModelIds`, not a separate search-only "add" surface.
    assert.match(
      enabledModels,
      /<ul\s+ref=\{modelListRef\}\s+className="providerModelChoiceList"\s+aria-label=\{copy\.modelListAria\}\s+onKeyDown=\{onModelListKeyDown\}\s*>/,
      'the model catalog must use a single named native list with the roving-tabindex keyboard handler',
    );
    assert.match(
      enabledModels,
      /role="checkbox"\s+aria-checked=\{isEnabled\}/,
      'each model row is a checkbox reflecting its enabled state',
    );
    // Roving tabindex: exactly one row is a Tab stop; the rest are -1.
    assert.match(
      enabledModels,
      /tabIndex=\{row\.id === resolvedActiveRowId \? 0 : -1\}/,
      'model rows must rove a single tabIndex=0 so the list is one Tab stop',
    );
    assert.match(
      enabledModels,
      /<OverlayScrollArea className="providerModelChoiceScroll">/,
      'the list scrolls inside a fixed-height region so filtering never resizes the dialog',
    );
    assert.doesNotMatch(
      enabledModels,
      /role="radio"|role="list"|role="listitem"/,
      'native list markup must not add redundant or incorrect ARIA roles',
    );
  });

  it('automatically persists enabled-model edits without a second Save action', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';
    const enabledModels = src.match(/function EnabledModelManager[\s\S]*?function modelDisplayLabel/)?.[0] ?? '';

    assert.match(
      detail,
      /async function updateEnabledModels\(nextIds: string\[\]\)[\s\S]*connectionEnabledModelIds\([\s\S]*props\.bridge\.update\(connection\.slug, \{ enabledModelIds: next \}\)[\s\S]*await props\.onChanged\(\)/,
    );
    // The default model row is checked and locked (disabled), never toggled off,
    // and there is no second Save action inside the editor.
    assert.match(enabledModels, /disabled=\{props\.disabled \|\| isDefault\}/);
    assert.match(enabledModels, /isDefault && \([\s\S]*providerEnabledModelMeta">\{copy\.defaultModel\}/);
    assert.doesNotMatch(enabledModels, /copy\.saving|copy\.saveEndpoint/);
  });

  it('surfaces provider detail save/delete failures instead of leaking rejected promises from actions', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*let saved = false;[\s\S]*await props\.bridge\.update\(connection\.slug,[\s\S]*saved = true;[\s\S]*catch \(error\) \{[\s\S]*toast\.error\([\s\S]*saved \? copy\.refreshFailed : copy\.saveFailed/,
      'ConnectionDetail save failures and post-save refresh failures must be visible',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*setDeleting\(true\);[\s\S]*let deleted = false;[\s\S]*await props\.bridge\.delete\(connection\.slug\);[\s\S]*deleted = true;[\s\S]*await props\.onDeleted\(\);[\s\S]*catch \(error\) \{[\s\S]*toast\.error\([\s\S]*deleted \? copy\.refreshFailed : copy\.deleteFailed/,
      'ConnectionDetail delete failures and post-delete refresh failures must be visible',
    );
    assert.match(
      detail,
      /<Button className="providerAdvancedDanger" variant="quiet" type="button" disabled=\{detailActionBusy\} onClick=\{remove\}>[\s\S]*\{deleting \? copy\.deleting : copy\.deleteConnection\}[\s\S]*<\/Button>/,
      'Delete should be disabled while provider detail actions are busy and show its own pending copy',
    );
  });

  it('surfaces provider detail credential-presence probe failures', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(src, /type CredentialPresenceStatus = boolean \| 'loading' \| 'error'/);
    assert.match(detail, /useState<CredentialPresenceStatus>\([\s\S]*defaults\.authKind === 'none' \? true : 'loading'/);
    assert.match(detail, /const credentialProbePending = requiresCredential && \(hasSecret === 'loading' \|\| hasSecret === 'error'\)/);
    assert.match(detail, /const hasUsableCredential = !requiresCredential \|\| hasSecret === true/);
    assert.match(
      detail,
      /props\.bridge[\s\S]*\.hasSecret\(connection\.slug\)[\s\S]*\.then\(\(next\) => \{[\s\S]*if \(isConnectionDetailCurrent\(lifecycle\)\) setHasSecret\(next\);[\s\S]*\.catch\(\(error\) => \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*setHasSecret\('error'\);[\s\S]*toast\.error\(copy\.credentialReadFailed, providerPanelActionErrorMessage\(error, locale\)\)/,
      'ConnectionDetail must show a visible error and keep unknown credential state distinct when probing fails',
    );
    assert.doesNotMatch(
      detail,
      /catch\(\(error\) => \{[\s\S]*setHasSecret\(false\)/,
      'credential-presence probe failures must not be downgraded to missing credentials',
    );
    assert.match(detail, /role="alert"[\s\S]*copy\.credentialUnknownDetail/);
    assert.match(detail, /disabled=\{detailActionBusy \|\| !hasUsableCredential\} onClick=\{\(\) => void refreshModels\(\)\}/);
    assert.match(detail, /disabled=\{detailActionBusy \|\| !hasUsableCredential\}/);
    assert.doesNotMatch(
      detail,
      /void props\.bridge\.hasSecret\(connection\.slug\)\.then\(setHasSecret\);/,
      'ConnectionDetail must not leave credential-presence probe rejections unhandled',
    );
  });

  it('shows but does not require LocalAI optional credentials', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(detail, /const supportsApiKey = providerAuthSupportsApiKey\(connection\.providerType\)/);
    assert.match(detail, /const requiresCredential = providerAuthRequiresSecret\(connection\.providerType\)/);
    assert.match(detail, /\{supportsApiKey && \([\s\S]*<PasswordInput/);
  });

  it('provider detail async actions stop writing UI after the detail sheet is closed or switched', async () => {
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      detail,
      /const connectionDetailMountedRef = useMountedRef\(\);[\s\S]*const connectionDetailLifecycleRef = useRef\(0\);/,
      'ConnectionDetail must track mounted/lifecycle ownership',
    );
    assert.match(
      detail,
      /useEffect\(\(\) => \{[\s\S]*connectionDetailLifecycleRef\.current \+= 1;[\s\S]*return \(\) => \{[\s\S]*connectionDetailLifecycleRef\.current \+= 1;[\s\S]*connectionDetailActionGuard\.reset\(\);[\s\S]*\};[\s\S]*\}, \[connection\.slug\]\);/,
      'ConnectionDetail cleanup must release every pending action owner on close or provider switch',
    );
    assert.match(
      detail,
      /function isConnectionDetailCurrent\(lifecycle: number\): boolean \{[\s\S]*return connectionDetailMountedRef\.current && connectionDetailLifecycleRef\.current === lifecycle;[\s\S]*\}/,
      'ConnectionDetail must expose a single current-owner predicate',
    );
    assert.match(
      detail,
      /async function save\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.update\(connection\.slug,[\s\S]*saved = true;[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onChanged\(\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail save must not write stale state or toast after close',
    );
    assert.match(
      detail,
      /async function runTest\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.test\(connection\.slug,[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail test must not toast after close',
    );
    assert.match(
      detail,
      /async function refreshModels\(opts: \{ silent\?: boolean \} = \{\}\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.fetchModels\(connection\.slug\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onChanged\(\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail model refresh must not write stale model state or toast after close',
    );
    assert.match(
      detail,
      /async function setAsDefault\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*await props\.bridge\.setDefault\(connection\.slug\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onChanged\(\);[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.success\(copy\.defaultSet\(connection\.name\)\)/,
      'ConnectionDetail set-default must not toast after close',
    );
    assert.match(
      detail,
      /async function remove\(\) \{[\s\S]*const lifecycle = connectionDetailLifecycleRef\.current;[\s\S]*const ok = await toast\.confirm[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.bridge\.delete\(connection\.slug\);[\s\S]*deleted = true;[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*await props\.onDeleted\(\);[\s\S]*catch \(error\) \{[\s\S]*if \(!isConnectionDetailCurrent\(lifecycle\)\) return;[\s\S]*toast\.error/,
      'ConnectionDetail delete must not continue or toast after close',
    );
  });

  it('keeps an open provider detail sheet in sync with refreshed connection props without clobbering dirty drafts', async () => {
    // task #38 sweep: OAuth login/model refresh can update the same
    // connection while its detail sheet is open. State initialized from
    // props via useState would otherwise keep showing stale models /
    // defaultModel until the sheet is closed and reopened.
    const src = await readProviderSettingsCombinedSource();
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    assert.match(
      src,
      /function connectionDetailSnapshot\([\s\S]*connection: LlmConnection,[\s\S]*defaultBaseUrl: string \| undefined,[\s\S]*\): ConnectionDetailSnapshot/,
      'ConnectionDetail must capture the last synced connection snapshot',
    );
    assert.match(
      detail,
      /useState\(connection\.baseUrl \?\? defaults\.baseUrl \?\? ''\)/,
      'ConnectionDetail must normalize an absent Base URL to an empty controlled input value',
    );
    assert.match(
      src,
      /function connectionDetailDraftMatchesSnapshot\(/,
      'ConnectionDetail must compare local draft state before syncing props',
    );
    assert.match(
      detail,
      /const syncedConnectionSnapshotRef = useRef\(connectionDetailSnapshot\(connection, defaults\.baseUrl\)\)/,
      'ConnectionDetail must keep a stable baseline for stale-prop detection',
    );
    assert.match(
      detail,
      /connection\.slug !== previousSnapshot\.slug \|\| \(apiKey\.length === 0 && localStillSynced\)/,
      'same-slug prop refresh should sync only when the local draft is still clean',
    );
    assert.match(
      detail,
      /setBaseUrl\(nextSnapshot\.baseUrl\)[\s\S]*setModels\(nextSnapshot\.models\)[\s\S]*setModelSource\(nextSnapshot\.modelSource\)/,
      'prop refresh must update every draft field derived from connection props',
    );
    assert.match(
      detail,
      /if \(localAlreadyMatchesNext\) \{[\s\S]*syncedConnectionSnapshotRef\.current = nextSnapshot/,
      'when local fetch state already matches new props, the baseline must advance',
    );
  });

  it('claude opens a modal from the equal-size card instead of rendering a full inline card above the grid', async () => {
    const src = await readProviderSettingsCombinedSource();
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function ClaudeSubscriptionModal/);
    assert.ok(sectionMatch, 'ModelOAuthSection and ClaudeSubscriptionModal must exist');
    assert.doesNotMatch(
      sectionMatch[0],
      /<ClaudeSubscriptionCard\s*\/>/,
      'ModelOAuthSection must not render the full Claude card inline above the OAuth grid',
    );
    assert.match(
      src,
      /openModal === 'claude'[\s\S]*<ClaudeSubscriptionModal/,
      'Claude card must open the provider-specific modal',
    );
    assert.doesNotMatch(
      src,
      /maka:jumpToSettingsSection[\s\S]*?'account'/,
      'after the card move, ModelOAuthSection must NOT jump to the account section',
    );
    assert.match(
      src,
      /setOpenModal\(card\.id\)/,
      'all OAuth cards must open a modal from the grid',
    );
  });

  it('ModelOAuthSection re-fetches account state on modal close so card badges stay live (PR-OAUTH-CARD-LIVE-STATE-0)', async () => {
    // WAWQAQ msg d79fd115 follow-up: after a user completed the
    // OAuth flow in SubscriptionLoginModal, the parent card still
    // showed "可用 / 预览" — no live login indicator. The fix
    // lifts a per-service snapshot map into the section and
    // refreshes on every modal close (success OR cancel).
    const src = await readProviderSettingsCombinedSource();
    // 1. cardStates map keyed by service id must exist.
    assert.match(
      src,
      /cardStates\s*,\s*setCardStates\b/,
      'ModelOAuthSection must track per-service snapshots',
    );
    // 2. refreshAllCards must call getAccountState for each card.
    assert.match(
      src,
      /async function refreshAllCards\(\)/,
      'must define refreshAllCards()',
    );
    assert.match(
      src,
      /getSubscriptionSnapshot\(card\.id\)/,
      'refreshAllCards must query each subscription snapshot',
    );
    // 3. useEffect on mount fires the initial refresh.
    const refreshOnMount = src.match(/useEffect\(\(\) =>\s*\{[\s\S]*void refreshAllCards\(\);[\s\S]*?\},\s*\[\]\)/);
    assert.ok(refreshOnMount, 'ModelOAuthSection must refresh on mount');
    // 4. Modal onClose triggers a re-fetch through a helper that also
    // catches enabled-model refresh failures.
    assert.match(
      src,
      /async function refreshAfterOAuthChange\(\)[\s\S]*?await refreshAllCards\(\)[\s\S]*?await props\.onConnectionsChanged\(\)/,
      'OAuth changes must refresh both the account card and connection list',
    );
    assert.match(
      src,
      /catch \(error\) \{[\s\S]*toast\.error\(copy\.refreshConnectionsFailed, subscriptionActionErrorMessage\(error, locale\)\)/,
      'OAuth modal close must surface model-connection refresh failures',
    );
    assert.match(
      src,
      /onClose=\{\(\)\s*=>\s*\{[\s\S]*?void refreshAfterOAuthChange\(\)/,
      'modal onClose must call the fail-soft refresh helper',
    );
    assert.match(
      src,
      /<SubscriptionLoginModal[\s\S]*onLoginSuccess=\{refreshAfterOAuthChange\}/,
      'successful Codex OAuth must refresh immediately without waiting for modal close',
    );
    // 5. Card render shows "已登录" badge when authenticated.
    assert.match(
      src,
      /isLoggedIn\s*\?\s*copy\.signedIn\s*:\s*card\.statusLabel/,
      'logged-in cards must source their badge from the active locale catalog',
    );
    // 6. data-logged-in attribute exposes the state to CSS / tests.
    assert.match(
      src,
      /data-logged-in=\{isLoggedIn\s*\?\s*'true'\s*:\s*undefined\}/,
      'logged-in cards must surface a data-logged-in attribute',
    );
  });

  it('OAuth card refresh failures preserve the last known login state and alert the user', async () => {
    // task #38 sweep: a transient getAccountState IPC failure must
    // not overwrite a logged-in card snapshot with null. "Unknown"
    // is not the same thing as "not logged in".
    const src = await readProviderSettingsCombinedSource();
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function ClaudeSubscriptionModal/);
    assert.ok(sectionMatch, 'ModelOAuthSection must exist');
    const section = sectionMatch[0]!;
    const refreshMatch = section.match(/async function refreshAllCards\(\)[\s\S]*?async function refreshAfterOAuthChange/);
    assert.ok(refreshMatch, 'refreshAllCards must exist inside ModelOAuthSection');
    const refresh = refreshMatch[0]!;

    assert.match(
      refresh,
      /return \{ id: card\.id, error \} as const/,
      'refresh failures must be represented as failures, not as null snapshots',
    );
    assert.match(
      refresh,
      /setCardStates\(\(prev\) => \{[\s\S]*const next = \{ \.\.\.prev \};[\s\S]*if \('snapshot' in result && result\.snapshot !== undefined\) next\[result\.id\] = result\.snapshot;/,
      'failed OAuth card refreshes must preserve previous snapshots',
    );
    assert.doesNotMatch(
      refresh,
      /catch[\s\S]*return \[card\.id,\s*null\] as const/,
      'refreshAllCards must not downgrade a failed snapshot probe to logged-out/null',
    );
    assert.match(
      section,
      /toast\.error\(copy\.refreshFailed, message\)/,
      'failed OAuth card refreshes must be visible instead of silently changing badges',
    );
    assert.match(
      section,
      /className="providerOAuthError" role="alert"/,
      'the OAuth tab must expose refresh failures as an accessible inline alert',
    );
    const styles = await readRendererContractCss();
    assert.match(styles, /\.providerOAuthError\s*\{/, 'OAuth refresh alert must have a stable style hook');
  });

  it('OAuth card refresh owns the mounted latest request before writing Settings UI feedback', async () => {
    const src = await readProviderSettingsCombinedSource();
    const sectionMatch = src.match(/function ModelOAuthSection[\s\S]*?function ClaudeSubscriptionModal/);
    assert.ok(sectionMatch, 'ModelOAuthSection must exist');
    const section = sectionMatch[0]!;

    assert.match(
      section,
      /const modelOAuthMountedRef = useMountedRef\(\);[\s\S]*const modelOAuthRefreshTicketRef = useRef\(0\);/,
      'ModelOAuthSection must keep mounted and latest-refresh ownership refs',
    );
    assert.match(
      section,
      /async function refreshAllCards\(\) \{[\s\S]*const ticket = modelOAuthRefreshTicketRef\.current \+ 1;[\s\S]*modelOAuthRefreshTicketRef\.current = ticket;[\s\S]*await Promise\.all[\s\S]*if \(!modelOAuthMountedRef\.current \|\| modelOAuthRefreshTicketRef\.current !== ticket\) return false;[\s\S]*setCardStates/,
      'OAuth card refresh must drop stale or unmounted snapshot results before setState',
    );
    assert.match(
      section,
      /useEffect\(\(\) => \{[\s\S]*void refreshAllCards\(\);[\s\S]*return \(\) => \{[\s\S]*modelOAuthRefreshTicketRef\.current \+= 1;[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'OAuth card refresh must invalidate in-flight requests on unmount',
    );
    assert.match(
      section,
      /async function refreshAfterOAuthChange\(\) \{[\s\S]*const refreshed = await refreshAllCards\(\);[\s\S]*if \(!modelOAuthMountedRef\.current \|\| !refreshed\) return;[\s\S]*await props\.onConnectionsChanged\(\);/,
      'modal close continuation must not refresh enabled providers after a stale OAuth card refresh',
    );
    assert.match(
      section,
      /catch \(error\) \{[\s\S]*if \(!modelOAuthMountedRef\.current\) return;[\s\S]*toast\.error\(copy\.refreshConnectionsFailed, subscriptionActionErrorMessage\(error, locale\)\)/,
      'enabled-provider refresh failures after modal close must not toast after Settings unmount',
    );
  });

  it('SettingsModal validates jumpToSettingsSection payloads against SETTINGS_NAV (PR-OAUTH-CARD-LIVE-STATE-0)', async () => {
    // Before: any truthy `detail.section` was passed to setSection,
    // so a typo or stale dispatch would silently land the user on
    // the "该设置页已纳入 Maka 设置树…" fallback page with no clue.
    const src = await readSettingsCombinedSource();
    // Find the handler body — match from `const handler = ` up to
    // its `addEventListener(...)` registration.
    const handler = src.match(
      /const handler =[\s\S]*?window\.addEventListener\(\s*'maka:jumpToSettingsSection'/,
    );
    assert.ok(handler, 'jumpToSettingsSection handler must exist');
    assert.match(
      handler[0],
      /SETTINGS_NAV\.some\(/,
      'jump handler must validate the section id against SETTINGS_NAV before calling setSection',
    );
  });

  it('SettingsModal does not render ClaudeSubscriptionCard (PR-CLAUDE-CARD-MOVE-0)', async () => {
    // PR-CLAUDE-CARD-MOVE-0 moved the card into provider OAuth settings.
    // The former 账户 panel that used to host it has since been retired
    // entirely (U1); confirm the settings surface never renders the card.
    const src = await readSettingsCombinedSource();
    assert.doesNotMatch(
      src,
      /<ClaudeSubscriptionCard\s*\/>/,
      'SettingsModal must not render ClaudeSubscriptionCard — it lives in provider OAuth settings now',
    );
    assert.doesNotMatch(
      src,
      /function ClaudeSubscriptionCard\b/,
      'ClaudeSubscriptionCard definition must be in provider OAuth settings, not SettingsModal',
    );
  });

  it('SubscriptionLoginModal routes the runnable Codex and xAI browser flows through one seam', async () => {
    const src = await readProviderSettingsCombinedSource();
    const modal = src.match(/function SubscriptionLoginModal[\s\S]*?function ClaudeSubscriptionCard/)?.[0] ?? '';
    assert.match(modal, /window\.maka\.openAiCodex/);
    assert.match(modal, /window\.maka\.xaiOAuth/);
    assert.match(modal, /service: 'codex' \| 'xai'/);
    assert.match(
      modal,
      /\{isXai \? copy\.deviceCode : copy\.stateHint\}/,
      'xAI must identify the RFC 8628 user code instead of presenting it as a loopback state hint',
    );
    assert.doesNotMatch(modal, /pickSubscriptionBridge|cursorSubscription|antigravitySubscription/, 'hidden non-runnable catalog services must not retain unreachable modal branches');
  });

  it('shared login flow calls getAuthUrl → openAuthUrl → completeAuthorization on the bridge', async () => {
    const hook = await readFile(OAUTH_LOGIN_FLOW_HOOK_SOURCE, 'utf8');
    const fnMatch = hook.match(/async function startLogin\(\)[\s\S]*?\n  \}/);
    assert.ok(fnMatch, 'startLogin must exist in the shared useOAuthLoginFlow hook');
    const body = fnMatch[0];
    assert.match(body, /bridge\.getAuthUrl\(\)/);
    assert.match(body, /bridge\.openAuthUrl\(payload\.authRequestId\)/);
    assert.match(body, /bridge\.completeAuthorization\(payload\.authRequestId\)/);
    // Both the OAuth catalog modal and the connection detail sheet must drive
    // this one flow rather than re-implementing the browser handoff.
    const src = await readProviderSettingsCombinedSource();
    assert.match(src, /const flow = useOAuthLoginFlow\(\{/, 'SubscriptionLoginModal must consume the shared login-flow hook');
  });

  it('GitHub Copilot modal rides the shared login flow through the direct account flow (#1042)', async () => {
    const src = await readProviderSettingsCombinedSource();
    const hook = await readFile(OAUTH_LOGIN_FLOW_HOOK_SOURCE, 'utf8');
    const copilotModal = src.match(/function GitHubCopilotSubscriptionModal[\s\S]*?\n\}/)?.[0] ?? '';

    // The modal consumes the shared controller instead of owning a separate
    // pending-action state machine.
    assert.match(
      copilotModal,
      /const flow = useOAuthLoginFlow\(\{[\s\S]*bridge: window\.maka\.githubCopilotSubscription as unknown as OAuthLoginFlowBridge[\s\S]*direct: \{[\s\S]*login: \(\) => window\.maka\.githubCopilotSubscription\.connectExistingLogin\(\)[\s\S]*refreshTokens: \(\) => window\.maka\.githubCopilotSubscription\.refreshTokens\(\)/,
      'GitHub Copilot modal must consume the shared login-flow hook with its direct account actions',
    );
    assert.doesNotMatch(
      copilotModal,
      /createOneShotActionGuard|pendingGuard|useRef|useMountedRef/,
      'GitHub Copilot modal must not own a parallel pending-action guard — the shared hook provides it',
    );
    assert.match(copilotModal, /disabled=\{flow\.actionBusy\}/, 'Copilot account actions must share the one busy flag');
    assert.match(copilotModal, /flow\.pendingAction === 'login' \? copy\.importing : loggedIn \? copy\.reimport : copy\.importCredential/, 'Copilot connect must expose its locale-specific pending copy');
    assert.match(copilotModal, /flow\.pendingAction === 'refresh' \? copy\.verifying : copy\.reverify/, 'Copilot token refresh must expose locale-specific progress copy');
    assert.match(copilotModal, /flow\.pendingAction === 'logout' \? copy\.removing : copy\.removeLocal/, 'Copilot logout must expose locale-specific progress copy');

    // The hook gates the direct actions through the same one-shot guard and
    // keeps loopback semantics for the browser services.
    assert.match(
      hook,
      /direct\?: OAuthDirectAccountFlow/,
      'shared OAuth flow must accept the direct account flow as an opt-in mode',
    );
    assert.match(hook, /if \(!beginPendingAction\('refresh'\)\) return;/, 'shared OAuth token refresh must use the ref-backed action guard');
    assert.match(
      hook,
      /const result = await direct\.login\(\);[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return;[\s\S]*await refresh\(\);/,
      'direct login must drop late writes after unmount and refresh the snapshot afterwards',
    );
    assert.match(
      hook,
      /if \(!direct\) \{[\s\S]*const ok = await toast\.confirm/,
      'only the browser-loopback services keep the logout confirm — Copilot never had one',
    );
    assert.doesNotMatch(hook, /toast\.error\('[^']+', result\.message\)/, 'direct account failures must not toast raw service messages');
  });

  it('OAuth login modals surface thrown IPC/service failures instead of leaving console-only rejections', async () => {
    const src = await readProviderSettingsCombinedSource();
    // Localization helpers + the whole browser-loopback controller now live in
    // the shared hook; the thin modal only renders from its return.
    const hook = await readFile(OAUTH_LOGIN_FLOW_HOOK_SOURCE, 'utf8');
    const browserModal = src.match(/function SubscriptionLoginModal[\s\S]*?function ClaudeSubscriptionCard/)?.[0] ?? '';
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';

    assert.match(hook, /getProviderSettingsCopy\(locale\)\.oauthFlow/, 'OAuth thrown-error fallback must come from the active locale catalog');
    assert.match(hook, /redactSecrets\(message \?\? ''\)\.trim\(\)/, 'OAuth service messages must be redacted before reaching visible UI');
    assert.match(hook, /locale === 'zh'[\s\S]*generalizedErrorMessageChinese\(new Error\(raw\), ''\)[\s\S]*generalizedErrorMessage\(new Error\(raw\), ''\)/, 'OAuth service messages must use the locale-appropriate error classifier');
    assert.match(hook, /async function refresh\(\): Promise<boolean>[\s\S]*catch \(error\) \{[\s\S]*toast\.error\(copy\.refreshFailed, message\);[\s\S]*setErrorMessage\(message\);/, 'shared OAuth state refresh must surface thrown failures');
    assert.match(hook, /catch \(error\) \{[\s\S]*toast\.error\(copy\.loginFailed, message\);[\s\S]*setErrorMessage\(message\);/, 'shared OAuth login must toast thrown failures');
    assert.match(hook, /catch \(error\) \{[\s\S]*toast\.error\(copy\.logoutFailed, subscriptionActionErrorMessage\(error, locale\)\);/, 'shared OAuth logout must toast thrown failures');
    assert.doesNotMatch(hook, /toast\.error\('[^']+', (?:payload|opened|result)\.message\)/, 'shared OAuth action envelopes must not toast raw service messages');
    assert.doesNotMatch(hook, /setErrorMessage\((?:payload|opened|result)\.message\)/, 'shared OAuth action envelopes must not render raw service messages');
    assert.match(hook, /subscriptionResultMessage\(payload\.message, copy\.startFailedRetry, locale\)/, 'shared OAuth getAuthUrl failures must be localized');
    assert.match(hook, /subscriptionResultMessage\(opened\.message, copy\.openFailedRetry, locale\)/, 'shared OAuth openAuthUrl failures must be localized');
    assert.match(hook, /subscriptionResultMessage\(result\.message, copy\.incompleteRetry, locale\)/, 'shared OAuth completion failures must be localized');
    assert.match(
      hook,
      /const \[pendingAction, setPendingAction\] = useState<OAuthLoginPendingAction \| null>\(null\)/,
      'shared OAuth flow needs a named pending action, not a bare boolean',
    );
    assert.match(
      hook,
      /const pendingGuard = useRef\(createOneShotActionGuard<OAuthLoginPendingAction>\(\)\)\.current/,
      'shared OAuth flow must gate one-shot auth actions synchronously through a ref-held guard',
    );
    assert.match(
      hook,
      /const oauthLoginFlowMountedRef = useMountedRef\(\)/,
      'shared OAuth flow must own mounted state before writing async feedback',
    );
    assert.match(
      hook,
      /const authRequestIdRef = useRef<string \| null>\(null\)/,
      'shared OAuth flow must keep the pending authorization request in a ref for cleanup',
    );
    assert.match(
      hook,
      /async function refresh\(\): Promise<boolean> \{[\s\S]*const next = \(await bridge\.getAccountState\(\)\) as SubscriptionSnapshot;[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return false;[\s\S]*setState\(next\);[\s\S]*catch \(error\) \{[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return false;[\s\S]*toast\.error\(copy\.refreshFailed, message\);[\s\S]*return true;/,
      'shared OAuth refresh must drop late state/error writes after unmount',
    );
    assert.match(
      hook,
      /useEffect\(\(\) => \{[\s\S]*void refresh\(\);[\s\S]*return \(\) => \{[\s\S]*pendingGuard\.finish\(\);[\s\S]*teardownPendingAuthorization\(authRequestIdRef, \(id\) => void bridge\.cancelAuthorization\(id\)\);[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'shared OAuth flow cleanup must invalidate async feedback and cancel pending authorization',
    );
    assert.match(
      hook,
      /function finishPendingAction\(\) \{[\s\S]*pendingGuard\.finish\(\);[\s\S]*if \(oauthLoginFlowMountedRef\.current\) setPendingAction\(null\);[\s\S]*\}/,
      'shared OAuth pending cleanup must not set state after unmount',
    );
    assert.match(
      hook,
      /function beginPendingAction\(action: OAuthLoginPendingAction\): boolean \{[\s\S]*if \(!pendingGuard\.begin\(action\)\) return false;[\s\S]*setPendingAction\(action\);[\s\S]*return true;/,
      'shared OAuth duplicate clicks must be rejected before React re-renders disabled buttons',
    );
    assert.match(hook, /if \(!beginPendingAction\('login'\)\) return;/, 'shared OAuth login must use the ref-backed action guard');
    assert.match(hook, /if \(!beginPendingAction\('logout'\)\) return;/, 'shared OAuth logout must use the ref-backed action guard');
    assert.match(
      hook,
      /const payload = await bridge\.getAuthUrl\(\);[\s\S]*authRequestIdRef\.current = payload\.authRequestId;[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) \{[\s\S]*authRequestIdRef\.current = null;[\s\S]*void bridge\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*return;[\s\S]*\}[\s\S]*const opened = await bridge\.openAuthUrl\(payload\.authRequestId\);[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return;[\s\S]*const refreshed = await refresh\(\);[\s\S]*if \(!oauthLoginFlowMountedRef\.current \|\| !refreshed\) return;[\s\S]*const result = await bridge\.completeAuthorization\(payload\.authRequestId\);[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return;[\s\S]*authRequestIdRef\.current = null;/,
      'shared OAuth login must stop each async continuation after unmount',
    );
    assert.match(
      hook,
      /if \(!opened\.ok\) \{[\s\S]*void bridge\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*authRequestIdRef\.current = null;[\s\S]*setAuthRequestId\(null\);[\s\S]*setStateHint\(null\);/,
      'shared OAuth open-browser failures must clear and cancel the pending authorization request',
    );
    assert.match(
      hook,
      /catch \(error\) \{[\s\S]*const pendingAuthRequestId = authRequestIdRef\.current;[\s\S]*authRequestIdRef\.current = null;[\s\S]*if \(pendingAuthRequestId\) void bridge\.cancelAuthorization\(pendingAuthRequestId\);[\s\S]*setAuthRequestId\(null\);[\s\S]*setStateHint\(null\);/,
      'shared OAuth thrown login failures must clear and cancel the pending authorization request',
    );
    assert.match(
      hook,
      /const result = await bridge\.logout\(\);[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return;[\s\S]*catch \(error\) \{[\s\S]*if \(!oauthLoginFlowMountedRef\.current\) return;[\s\S]*toast\.error\(copy\.logoutFailed, subscriptionActionErrorMessage\(error, locale\)\);/,
      'shared OAuth logout must not toast after unmount',
    );
    assert.match(hook, /const actionBusy = pendingAction !== null/, 'shared OAuth flow needs a shared busy flag derived from the named action');
    // The thin modal renders login/logout straight from the hook return.
    assert.match(browserModal, /const flow = useOAuthLoginFlow\(\{/, 'SubscriptionLoginModal must consume the shared login-flow hook');
    assert.match(browserModal, /disabled=\{flow\.actionBusy\}/, 'browser OAuth action buttons must disable while another one-shot action is pending');
    assert.match(browserModal, /flow\.pendingAction === 'login' \? copy\.openingBrowser : copy\.login\(display\.shortName\)/, 'browser OAuth login start must expose locale-specific pending copy');
    assert.match(browserModal, /flow\.pendingAction === 'logout' \? copy\.loggingOut : copy\.logout/, 'browser OAuth logout must expose locale-specific progress feedback');
    assert.match(claudeCard, /const refresh = async \(\) => \{[\s\S]*catch \(error\) \{[\s\S]*toast\.error\(copy\.refreshFailed, message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth state refresh must surface thrown failures');
    assert.match(claudeCard, /settingsErrorText" role="alert"\>\{pasteError\}/, 'Claude OAuth refresh failures must be visible in the modal body');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\(copy\.startFailed, message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth start must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\(copy\.submitFailed, message\);[\s\S]*setPasteError\(message\);/, 'Claude OAuth paste submit must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\(copy\.cancelFailed, subscriptionActionErrorMessage\(error, locale\)\);/, 'Claude OAuth cancel must toast thrown failures');
    assert.match(claudeCard, /catch \(error\) \{[\s\S]*toast\.error\(copy\.quotaFailed, subscriptionActionErrorMessage\(error, locale\)\);/, 'Claude OAuth quota refresh must toast thrown failures');
    assert.doesNotMatch(claudeCard, /toast\.error\('[^']+', (?:payload|opened|result)\.message\)/, 'Claude OAuth action envelopes must not toast raw service messages');
    assert.doesNotMatch(claudeCard, /setPasteError\(result\.message\)/, 'Claude OAuth paste failures must not render raw service messages');
    assert.match(claudeCard, /subscriptionResultMessage\(payload\.message, copy\.startFailedRetry, locale\)/, 'Claude OAuth getAuthUrl failures must be localized');
    assert.match(claudeCard, /subscriptionResultMessage\(opened\.message, copy\.openFailedRetry, locale\)/, 'Claude OAuth openAuthUrl failures must be localized');
    assert.match(claudeCard, /subscriptionResultMessage\(result\.message, copy\.submitFailedRetry, locale\)/, 'Claude OAuth paste failures must be localized');
  });

  it('OAuth local credential storage failures are visible and repairable', async () => {
    const src = await readProviderSettingsCombinedSource();
    const snapshotPresenter = src.match(/function presentSnapshotDetail[\s\S]*?function ProviderLogoMark/)?.[0] ?? '';
    const claudePresenter = src.match(/function presentSubscriptionState[\s\S]*?\n\}/)?.[0] ?? '';
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';

    assert.match(
      src,
      /storage_failed/,
      'OAuth UI must understand storage_failed instead of collapsing it to not_logged_in',
    );
    assert.match(
      snapshotPresenter,
      /case 'storage_failed':[\s\S]*copy\.storageFailed\(display\.name\)/,
      'browser OAuth cards must explain local credential read failures',
    );
    assert.match(
      claudePresenter,
      /case 'storage_failed':[\s\S]*label: copy\.storageFailed[\s\S]*copy\.storageFailedDetail/,
      'Claude OAuth card must explain local credential read failures',
    );
    assert.match(
      claudeCard,
      /const canStartClaudeLogin =[\s\S]*state\?\.runtimeState === 'not_logged_in'[\s\S]*state\?\.runtimeState === 'refresh_failed'[\s\S]*state\?\.runtimeState === 'storage_failed'/,
      'Claude OAuth storage failures must keep the re-login action visible so the user can repair the local credential',
    );
  });

  it('Claude paste-code login keeps authorizing out of logout/refresh actions', async () => {
    const src = await readProviderSettingsCombinedSource();
    const claudeCard = src.match(/function ClaudeSubscriptionCard[\s\S]*?function presentSubscriptionState/)?.[0] ?? '';
    const actionsBlock = claudeCard.match(/<div className="settingsConnectionActions">[\s\S]*?\{authRequestId &&/)?.[0] ?? '';

    assert.match(
      claudeCard,
      /const claudeLoginPending = authRequestId !== null \|\| state\?\.runtimeState === 'authorizing'/,
      'Claude OAuth must model paste-code authorization as an in-progress login, not an authenticated account',
    );
    assert.match(
      claudeCard,
      /const \[pendingAction, setPendingAction\] = useState<ClaudeSubscriptionPendingAction \| null>\(null\)/,
      'Claude OAuth needs a named pending action, not a bare boolean that cannot explain what is happening',
    );
    assert.match(
      claudeCard,
      /const pendingActionRef = useRef<ClaudeSubscriptionPendingAction \| null>\(null\)/,
      'Claude OAuth must gate one-shot auth actions synchronously through a ref',
    );
    assert.match(
      claudeCard,
      /const claudeAuthRequestIdRef = useRef<string \| null>\(null\)/,
      'Claude OAuth must keep the active auth request in a ref so unmount cleanup can cancel it',
    );
    assert.match(
      claudeCard,
      /return \(\) => \{[\s\S]*const pendingAuthRequestId = claudeAuthRequestIdRef\.current;[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*if \(pendingAuthRequestId\) void window\.maka\.claudeSubscription\.cancelAuthorization\(pendingAuthRequestId\);[\s\S]*\};/,
      'closing the Claude OAuth modal mid-login must cancel the pending auth request',
    );
    assert.match(
      claudeCard,
      /function beginPendingAction\(action: ClaudeSubscriptionPendingAction\): boolean \{[\s\S]*if \(pendingActionRef\.current !== null\) return false;[\s\S]*pendingActionRef\.current = action;[\s\S]*setPendingAction\(action\);[\s\S]*return true;/,
      'Claude OAuth duplicate clicks must be rejected before React re-renders disabled buttons',
    );
    assert.match(
      claudeCard,
      /claudeAuthRequestIdRef\.current = payload\.authRequestId;[\s\S]*if \(!claudeCardMountedRef\.current\) \{[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*void window\.maka\.claudeSubscription\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*return;[\s\S]*\}/,
      'Claude OAuth must cancel auth requests created after the component was already closed',
    );
    assert.match(
      claudeCard,
      /if \(!opened\.ok\) \{[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*void window\.maka\.claudeSubscription\.cancelAuthorization\(payload\.authRequestId\);[\s\S]*setAuthRequestId\(null\);/,
      'Claude OAuth must cancel a pending request when opening the browser fails',
    );
    assert.match(
      claudeCard,
      /if \(result\.ok\) \{[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*setAuthRequestId\(null\);/,
      'successful Claude paste-code completion must clear the pending auth request ref',
    );
    assert.match(
      claudeCard,
      /await window\.maka\.claudeSubscription\.cancelAuthorization\(authRequestId\);[\s\S]*claudeAuthRequestIdRef\.current = null;[\s\S]*setAuthRequestId\(null\);/,
      'explicit Claude OAuth cancellation must clear the pending auth request ref',
    );
    assert.match(claudeCard, /if \(!beginPendingAction\('login'\)\) return;/, 'starting login must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('submit'\)\) return;/, 'submitting an authorization code must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('cancel'\)\) return;/, 'canceling authorization must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('logout'\)\) return;/, 'logging out must use the ref-backed action guard');
    assert.match(claudeCard, /if \(!beginPendingAction\('quota'\)\) return;/, 'refreshing quota must use the ref-backed action guard');
    assert.match(
      actionsBlock,
      /\{canStartClaudeLogin \|\| claudeLoginPending \? \(/,
      'authorizing must take the start/login branch instead of the authenticated refresh/logout branch',
    );
    assert.match(claudeCard, /const actionBusy = pendingAction !== null/);
    assert.match(actionsBlock, /disabled=\{actionBusy \|\| claudeLoginPending\}/);
    assert.match(actionsBlock, /\? copy\.loggingIn/, 'pending Claude OAuth should show a disabled locale-specific login-in-progress action');
    assert.match(actionsBlock, /pendingAction === 'login'[\s\S]*copy\.openingBrowser/, 'login start must expose a locale-specific pending label before the auth code panel appears');
    assert.match(actionsBlock, /pendingAction === 'quota' \? copy\.refreshing : copy\.refreshQuota/, 'quota refresh must expose local progress feedback');
    assert.match(actionsBlock, /pendingAction === 'logout' \? copy\.loggingOut : copy\.logout/, 'logout must expose local progress feedback');
    assert.match(
      actionsBlock,
      /\{canStartClaudeLogin \|\| claudeLoginPending \? \([\s\S]*copy\.loggingIn[\s\S]*\) : \([\s\S]*copy\.refreshQuota[\s\S]*copy\.logout/,
      'refresh/logout actions must be behind the non-pending branch so they cannot clear pending authorization before paste submit',
    );
    assert.match(claudeCard, /pendingAction === 'submit' \? copy\.submitting : copy\.submitCode/, 'authorization-code submit must expose local progress feedback');
    assert.match(claudeCard, /pendingAction === 'cancel' \? copy\.cancelling : copy\.cancel/, 'authorization cancel must expose local progress feedback');
  });

  it('OAuth model connection detail offers an in-sheet 重新登录 action wired to the shared login flow', async () => {
    const src = await readProviderSettingsCombinedSource();
    const mapping = src.match(/function oauthLoginServiceFor\(providerType: ProviderType\): OAuthLoginService \| null \{[\s\S]*?\n\}/)?.[0] ?? '';
    const notice = src.match(/function OAuthReloginNotice\([\s\S]*?\ntype ConnectionDetailSnapshot/)?.[0] ?? '';
    const detail = src.match(/function ConnectionDetail[\s\S]*?function modelIdListsEqual\(/)?.[0] ?? '';

    // Loopback services (Codex, Antigravity) get a bridge; Claude's paste flow
    // and plain API-key providers fall through to null so the notice renders
    // prose, never a dead button.
    assert.match(mapping, /case 'openai-codex':[\s\S]*window\.maka\.openAiCodex as unknown as OAuthLoginFlowBridge/);
    assert.match(mapping, /case 'gemini-cli':[\s\S]*window\.maka\.antigravitySubscription as unknown as OAuthLoginFlowBridge/);
    assert.match(mapping, /default:\s*return null;/);
    assert.doesNotMatch(mapping, /case 'claude-subscription'/, 'Claude uses a paste-code flow and must not be routed through the one-button loopback hook');

    // The notice drives the shared hook; its onLoginSuccess re-probes the
    // credential and reloads the connection.
    assert.match(notice, /const flow = useOAuthLoginFlow\(\{[\s\S]*bridge: props\.service\.bridge,[\s\S]*onLoginSuccess: props\.onRelogin,/);
    // The button shows in every credential state EXCEPT 'loading'. An expired
    // token still reads hasSecret===true, so the action must NOT hide behind
    // hasSecret===false.
    assert.match(notice, /const loggedIn = hasSecret === true;/);
    assert.match(notice, /\{!loading && \(/);
    assert.match(notice, /<Button[\s\S]*size="sm"[\s\S]*disabled=\{flow\.actionBusy\}[\s\S]*onClick=\{\(\) => void flow\.startLogin\(\)\}/);
    assert.match(notice, /flow\.pendingAction === 'login' \? copy\.loggingIn : loggedIn \? copy\.relogin : copy\.login/);
    // Honest logged-in banner: it points at the re-auth action instead of
    // claiming there is nothing to do.
    assert.match(notice, /copy\.oauthReloginDetail/);
    assert.doesNotMatch(notice, /请到上方 OAuth 分类完成登录/, 'the mapped notice must drop the go-hunt-the-catalog prose');

    // ConnectionDetail wires the notice for mapped OAuth types and keeps a
    // buttonless prose fallback for unmapped ones.
    assert.match(detail, /const oauthLoginService = needsOAuth \? oauthLoginServiceFor\(connection\.providerType\) : null/);
    assert.match(detail, /oauthLoginService \? \(\s*<OAuthReloginNotice/);
    assert.match(
      detail,
      /async function refreshAfterRelogin\(\) \{[\s\S]*await props\.bridge\.hasSecret\(connection\.slug\)[\s\S]*setHasSecret\(nextHasSecret\);[\s\S]*await props\.onChanged\(\);/,
      'a successful in-sheet re-login must re-probe the credential (expired tokens read hasSecret===true) and reload the connection status',
    );
    assert.match(detail, /copy\.oauthWaitingDetail/, 'unmapped OAuth types keep an honest localized prose fallback');
  });

  it('preload exposes every subscription namespace alongside claudeSubscription', async () => {
    const src = await readFile(PRELOAD_SOURCE, 'utf8');
    assert.match(src, /openAiCodex:\s*\{/, 'preload must expose window.maka.openAiCodex');
    assert.match(src, /cursorSubscription:\s*\{/, 'preload must expose window.maka.cursorSubscription');
    assert.match(src, /githubCopilotSubscription:\s*\{/, 'preload must expose window.maka.githubCopilotSubscription');
    assert.match(
      src,
      /antigravitySubscription:\s*\{/,
      'preload must expose window.maka.antigravitySubscription',
    );
    for (const channel of [
      'openai-codex:get-auth-url',
      'openai-codex:complete-authorization',
      'openai-codex:get-account-state',
      'openai-codex:logout',
      'cursor-subscription:get-auth-url',
      'cursor-subscription:complete-authorization',
      'cursor-subscription:get-account-state',
      'cursor-subscription:logout',
      'antigravity-subscription:get-auth-url',
      'antigravity-subscription:complete-authorization',
      'antigravity-subscription:get-account-state',
      'antigravity-subscription:logout',
      'github-copilot:connect-existing-login',
      'github-copilot:get-account-state',
      'github-copilot:refresh-tokens',
      'github-copilot:logout',
    ]) {
      assert.match(
        src,
        new RegExp(channel.replace(/:/g, ':').replace(/-/g, '-')),
        `preload must invoke '${channel}' on the IPC bus`,
      );
    }
  });
});
