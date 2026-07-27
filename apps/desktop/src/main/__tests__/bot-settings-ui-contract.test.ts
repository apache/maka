import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  if (path === 'apps/desktop/src/main/main.ts') return readMainProcessCombinedSource();
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Bot settings UI contract', () => {
  it('keeps empty, attention, and detail Storybook baselines renderable', async () => {
    const stories = await readRepo('apps/desktop/stories/settings/settings-pages.stories.tsx');

    assert.match(
      stories,
      /e2eFixture:\s*\{\s*getState:\s*async \(\) => null,\s*\}/,
      'the scoped Settings story bridge must include the real-app e2eFixture probe',
    );
    assert.match(stories, /export const BotChat: Story =/, 'remote access must keep its empty overview baseline');
    assert.match(
      stories,
      /export const BotChatNeedsAttention: Story =/,
      'remote access needs a configured/degraded overview baseline',
    );
    assert.match(
      stories,
      /export const BotChatNeedsAttentionDetail: Story =/,
      'remote access needs a long-diagnostic detail baseline',
    );
  });

  it('presents remote access as an overview of active and available channels', async () => {
    // #1042: the page split into a container (bot-chat-settings-page.tsx)
    // plus overview/detail views and shared brand metadata; the bot-chat
    // surface these invariants pin is the three split sources together.
    const [shared, overview, detail, nav, navCopy, botBrand] = await Promise.all([
      readRepo('apps/desktop/src/renderer/settings/bot-chat-shared.tsx'),
      readRepo('apps/desktop/src/renderer/settings/bot-chat-overview.tsx'),
      readRepo('apps/desktop/src/renderer/settings/bot-chat-detail.tsx'),
      readRepo('apps/desktop/src/renderer/settings/settings-nav.ts'),
      readRepo('apps/desktop/src/renderer/locales/settings-navigation-copy.ts'),
      readRepo('packages/ui/src/bot-brand.ts'),
    ]);
    const page = [shared, overview, detail].join('\n');

    assert.match(nav, /id: 'bot-chat'/, 'The remote-access settings destination must remain registered');
    assert.match(navCopy, /'bot-chat': \{ label: '远程接入'/, 'The Chinese catalog must describe the user goal, not the implementation object');
    assert.match(navCopy, /'bot-chat': \{ label: 'Remote Access'/, 'The English catalog must provide the same destination without fallback');
    assert.match(page, /BOT_BRAND/, 'Bot settings must import shared per-platform brand presentation metadata');
    assert.match(page, /BotBrandLogo as BotBrandMark/, 'Bot settings must render the shared provider-based brand logo component');
    assert.match(page, /<BotBrandMark[\s\S]*provider=\{props\.provider\}/, 'Bot settings must pass provider directly to the local brand logo renderer');
    assert.match(page, /<Item\b/, 'Remote access rows must use the shared Item primitive');
    assert.match(botBrand, /export const BOT_BRAND:/, 'Shared bot brand metadata must stay exported from @maka/ui');
    for (const provider of ['telegram', 'feishu', 'wecom', 'wechat', 'discord', 'dingtalk', 'qq', 'slack', 'whatsapp']) {
      assert.match(botBrand, new RegExp(`${provider}:\\s*\\{[\\s\\S]*?configDocUrl:`), `${provider} needs a visible configuration-document link target`);
    }
    assert.match(page, /function BotBrandLogo\b/, 'Bot settings must use the shared brand-logo component');
    assert.match(page, /className="settingsBotLogo"[\s\S]*aria-hidden="true"/, 'Bot brand logos are decorative and must not be read as part of channel names');
    assert.doesNotMatch(page, /settingsBotLogoStatusDot/, 'Status must be carried by text and Chip rather than a redundant logo dot');
  });

  it('puts channel diagnosis before an always-visible configuration form', async () => {
    const [page, styles] = await Promise.all([
      readRepo('apps/desktop/src/renderer/settings/bot-chat-detail.tsx'),
      readRepo('apps/desktop/src/renderer/styles/settings/bot.css'),
    ]);

    assert.match(page, /<Chip\s+dot\b/, 'The detail header must expose current state with the shared Chip primitive');
    assert.match(page, /className="settingsBotConfigDocLink"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"[\s\S]*detailCopy\.configDocs/, 'Configuration docs link must be visible, localized, and external-link safe');
    assert.doesNotMatch(page, /iframe|webview|dangerouslySetInnerHTML/, 'Bot docs must not be embedded into the renderer');
    assert.doesNotMatch(styles, /--bot-brand-color|\.settingsBotHero/, 'The detail page must not introduce a provider-tinted hero surface');
  });

  it('names the selected platform runtime status grid', async () => {
    const settings = await readSettingsCombinedSource();
    const detailBlock = settings.match(/<section className="settingsBotDetail">[\s\S]*?<\/section>/)?.[0] ?? '';

    assert.match(
      detailBlock,
      /<dl className="settingsBotStatusGrid" aria-label=\{detailCopy\.runtimeAria\(providerPresentation\.label\)\}>/,
      'The selected bot platform status grid must expose a platform-specific accessible name',
    );
    assert.doesNotMatch(
      detailBlock,
      /<dl className="settingsBotStatusGrid">/,
      'Bot runtime status details must not regress to an anonymous definition list',
    );
  });

  it('keeps runtime channel onboarding as test-then-enable-then-restart', async () => {
    const settings = await readSettingsCombinedSource();
    const styles = await readRendererContractCss();
    const updateChannelBlock = settings.match(/async function updateChannelFor\(provider: BotProvider, patch: Partial<typeof channel>\): Promise<boolean>[\s\S]*?async function updateChannel\(patch: Partial<typeof channel>\): Promise<boolean>/)?.[0] ?? '';
    const testChannelBlock = settings.match(/async function testChannel\(\)[\s\S]*?\n\s*\/\*\*/)?.[0] ?? '';
    const testAndConnectBlock = settings.match(/async function testAndConnect\(\)[\s\S]*?\n\s*async function restartBotProvider/)?.[0] ?? '';
    const restartProviderBlock = settings.match(/async function restartBotProvider\(provider: BotProvider\)[\s\S]*?\n\s*async function restartChannel/)?.[0] ?? '';
    const restartChannelBlock = settings.match(/async function restartChannel\(\)[\s\S]*?\n\s*async function refreshBotStatuses/)?.[0] ?? '';
    const actionRowBlock = settings.match(/<div className="settingsBotActionStack"[\s\S]*?<\/div>/)?.[0] ?? '';
    const switchBlock = settings.match(/<Switch\s+ariaLabel=\{detailCopy\.enableAria\(providerPresentation\.label\)\}[\s\S]*?\/>/)?.[0] ?? '';

    assert.match(settings, /type BotPendingActionName = 'test' \| 'connect' \| 'restart' \| 'disconnect'/, 'Bot async actions must use a closed pending-action enum');
    assert.match(settings, /const \[pendingBotAction, setPendingBotAction\] = useState<BotPendingAction \| null>\(null\)/, 'Bot async action pending state must be explicit');
    assert.match(settings, /const pendingBotActionRef = useRef<BotPendingAction \| null>\(null\)/, 'Bot async actions need a synchronous ref guard before React rerenders');
    assert.match(settings, /function beginBotAction\(provider: BotProvider, action: BotPendingActionName\): boolean \{[\s\S]*if \(pendingBotActionRef\.current !== null\) return false;[\s\S]*pendingBotActionRef\.current = next;[\s\S]*setPendingBotAction\(next\);/, 'Bot async actions must synchronously reject duplicate test/connect/restart/disconnect actions');
    assert.match(settings, /function finishBotAction\(provider: BotProvider, action: BotPendingActionName\)[\s\S]*pendingBotActionRef\.current = null;[\s\S]*setPendingBotAction\(null\);/, 'Bot async action guard must release through the matching provider/action owner');
    assert.match(updateChannelBlock, /try \{[\s\S]*props\.onUpdate\(\{ botChat: \{ channels: \{ \[provider\]: patch \} \} \}\)/, 'Bot channel field saves must be scoped to the provider captured by the action');
    assert.match(updateChannelBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.saveFailed\(botCopy\.providers\[provider\]\.label\), settingsActionErrorMessage\(error, locale\)\)[\s\S]*return false/, 'Bot channel save failures must surface a localized visible toast instead of rejecting from field handlers');
    assert.match(settings, /function canEnableBotChannel\(readiness: BotReadinessState\): boolean\s*\{[\s\S]*credentials_valid[\s\S]*operational[\s\S]*degraded[\s\S]*\}/, 'Only validated or already-runtime-capable bot states can be enabled directly');
    assert.match(settings, /const enableSwitchDisabled = support === 'planned' \|\| \(!channel\.enabled && !canEnableBotChannel\(readiness\)\)/, 'Unchecked bot channels must keep the enable switch locked until credentials are tested');
    assert.match(settings, /detailCopy\.testFirstHint/, 'Locked runtime bot channels must explain the localized test-first path');
    assert.match(settings, /const enableSwitchHintId = `settings-bot-enable-hint-\$\{provider\}`/, 'Enable-lock hint must have a stable aria-describedby id');
    assert.match(settings, /<small id=\{enableSwitchHintId\} className="settingsBotEnableHint">/, 'Enable-lock hint must be rendered near the switch');
    assert.match(styles, /\.settingsBotEnableHint\s*\{[\s\S]*display:\s*block/, 'Enable-lock hint needs a stable visible style');
    assert.match(switchBlock, /ariaDescribedBy=\{enableSwitchHint \? enableSwitchHintId : undefined\}/, 'Disabled enable switch must point assistive tech at the reason');
    assert.match(switchBlock, /disabled=\{enableSwitchDisabled \|\| props\.actionBusy\}/, 'Bot enable switch must be disabled while an owned bot action is pending');
    assert.match(testChannelBlock, /const provider = selected;[\s\S]*if \(!beginBotAction\(provider, 'test'\)\) return;[\s\S]*testBotChannel\(provider\)/, 'Separate tests must capture the provider and gate duplicate clicks before IPC');
    assert.match(testAndConnectBlock, /const provider = selected;[\s\S]*const providerChannel = props\.settings\.botChat\.channels\[provider\];[\s\S]*const providerSupport = BOT_LABELS\[provider\]\.support;[\s\S]*if \(!beginBotAction\(provider, 'connect'\)\) return;[\s\S]*testBotChannel\(provider\)/, 'Combined action must capture provider/channel/support and gate duplicate clicks before IPC');
    assert.match(testChannelBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.testError\(botCopy\.providers\[provider\]\.label\), settingsActionErrorMessage\(error, locale\)\)/, 'Separate bot credential tests must scrub thrown IPC failures against the captured provider and locale');
    assert.match(testAndConnectBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.testError\(botCopy\.providers\[provider\]\.label\), settingsActionErrorMessage\(error, locale\)\)/, 'Combined bot credential tests must scrub thrown IPC failures against the captured provider and locale');
    assert.match(testAndConnectBlock, /if \(!testOk \|\| providerSupport !== 'runtime'\) return;/, 'Combined action must stop after a failed credential test');
    assert.match(testAndConnectBlock, /const saved = await updateChannelFor\(provider, \{ enabled: true \}\);[\s\S]*if \(!saved\) return;/, 'Combined action must stop if enabling the runtime channel fails to save');
    assert.match(testAndConnectBlock, /await restartBotProvider\(provider\)/, 'Combined action must start the listener for the same captured provider after enabling');
    assert.match(restartProviderBlock, /catch \(error\) \{[\s\S]*const message = settingsActionErrorMessage\(error, locale\);[\s\S]*toast\.error\(copy\.startFailed\(botCopy\.providers\[provider\]\.label\), message\)/, 'Bot restart failures must use the Settings error scrubber against the captured provider and locale');
    assert.match(restartChannelBlock, /if \(!beginBotAction\(provider, 'restart'\)\) return;[\s\S]*await restartBotProvider\(provider\)[\s\S]*finishBotAction\(provider, 'restart'\)/, 'Manual restart must use the shared provider-scoped pending owner');
    assert.doesNotMatch(`${testChannelBlock}\n${testAndConnectBlock}\n${restartProviderBlock}\n${restartChannelBlock}`, /error instanceof Error \? error\.message : String\(error\)/, 'Bot test/restart actions must not toast raw Error.message');
    assert.match(actionRowBlock, /support === 'runtime' && !status\?\.running/, 'Runtime channels that are not listening must use the combined onboarding path');
    assert.match(
      actionRowBlock,
      /<div className="settingsBotActionStack" role="group" aria-label=\{detailCopy\.actionsAria\(providerPresentation\.label\)\}>/,
      'Selected bot platform actions must expose a platform-specific accessible group name',
    );
    assert.doesNotMatch(
      actionRowBlock,
      /<div className="settingsBotActionStack">\s*<button/,
      'Bot platform action buttons must not regress to an anonymous button stack',
    );
    assert.doesNotMatch(
      actionRowBlock,
      /<button[\s\S]*className="settingsBotAction"/,
      'Bot platform action buttons must use the shared Button primitive',
    );
    assert.match(actionRowBlock, /detailCopy\.testAndConnect/, 'Runtime onboarding CTA must keep the localized combined action label');
    assert.match(actionRowBlock, /pendingAction === 'connect' \? detailCopy\.connecting : detailCopy\.testAndConnect/, 'Runtime onboarding CTA must expose a localized visible connect pending state');
    // PR-BOT-RESTART-RACE-0 added `|| restarting` so the button
    // doesn't unmount during the stop→start cycle. Allow the
    // parenthesized form here without abandoning the original
    // intent (running channels still get the restart action).
    assert.match(actionRowBlock, /support === 'runtime' && \(?status\?\.running/, 'Already-running channels must keep separate test/restart actions');
  });

  it('drives per-provider credential fields from a shared descriptor table (#1042)', async () => {
    const settings = await readSettingsCombinedSource();

    assert.match(
      settings,
      /function botCredentialFields\(copy: BotSettingsCopy\['detail'\]\): Partial<Record<BotProvider, ReadonlyArray<BotCredentialField>>>/,
      'Per-provider credential fields must be declared in a shared descriptor table',
    );
    for (const provider of ['telegram', 'feishu', 'discord', 'dingtalk', 'wecom', 'qq', 'slack']) {
      assert.match(
        settings,
        new RegExp(`\\r?\\n  ${provider}: \\[\\r?\\n`),
        `${provider} credential fields must be descriptor entries`,
      );
      assert.doesNotMatch(
        settings,
        new RegExp(`provider === '${provider}' && \\(`),
        `${provider} credential fields must not be a hand-written JSX branch`,
      );
    }
    // The descriptor renderer must keep each field kind on its governed
    // primitive with the descriptor's accessible name.
    assert.match(settings, /function BotCredentialFields\(/);
    assert.match(settings, /<PasswordInput[\s\S]*ariaLabel=\{field\.ariaLabel\}/);
    assert.match(settings, /<Input[\s\S]*aria-label=\{field\.ariaLabel\}/);
    assert.match(settings, /<SettingsSelect[\s\S]*ariaLabel=\{field\.ariaLabel\}/);
    // WeChat keeps its bespoke fields component (collapsed advanced section),
    // so it is intentionally not part of the descriptor table.
    assert.match(settings, /provider === 'wechat' && \(/);
  });

  it('keeps bot allowlist validation copy text-only and locale-aware', async () => {
    const settings = await readSettingsCombinedSource();
    const styles = await readRendererContractCss();
    const allowlistBlock = settings.match(/function BotAllowedUserIdsField[\s\S]*?function botConnectionLabel/)?.[0] ?? '';

    assert.match(
      allowlistBlock,
      /className="settingsFieldWarning"[\s\S]*data-tone="warning"[\s\S]*copy\.invalidUsers/,
      'Invalid bot allowlist entries should render as styled localized warning text',
    );
    assert.doesNotMatch(
      allowlistBlock,
      /⚠|⚠️|@username/,
      'Bot allowlist validation must not rely on emoji or English placeholder copy',
    );
    assert.match(
      styles,
      /\.settingsFieldWarning\s*\{[\s\S]*color:\s*var\(--warning-text, var\(--info-text\)\);/,
      'Bot allowlist warning should use the design token instead of a decorative glyph',
    );
  });

  it('drops late bot action feedback after Settings is closed', async () => {
    const settings = await readSettingsCombinedSource();
    const pageBlock = settings.match(/function BotChatSettingsPage\([\s\S]*?function BotAllowedUserIdsField/)?.[0] ?? '';
    const finishBlock = pageBlock.match(/function finishBotAction[\s\S]*?async function updateChannelFor/)?.[0] ?? '';
    const updateBlock = pageBlock.match(/async function updateChannelFor[\s\S]*?async function updateChannel/)?.[0] ?? '';
    const statusEffectBlock = pageBlock.match(/useEffect\(\(\) => \{[\s\S]*?window\.maka\.settings\.bots\.subscribeStatusChanges[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    const testBlock = pageBlock.match(/async function testChannel\(\)[\s\S]*?\n\s*\/\*\*/)?.[0] ?? '';
    const connectBlock = pageBlock.match(/async function testAndConnect\(\)[\s\S]*?async function restartBotProvider/)?.[0] ?? '';
    const restartProviderBlock = pageBlock.match(/async function restartBotProvider\(provider: BotProvider\)[\s\S]*?async function restartChannel/)?.[0] ?? '';
    const refreshBlock = pageBlock.match(/async function refreshBotStatuses\(\)[\s\S]*?async function disconnectLinkedSession/)?.[0] ?? '';
    const disconnectBlock = pageBlock.match(/async function disconnectLinkedSession\(\)[\s\S]*?function openChannel/)?.[0] ?? '';

    assert.match(pageBlock, /const botPageMountedRef = useMountedRef\(\)/);
    assert.match(
      pageBlock,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*pendingBotActionRef\.current = null;/,
      'Bot settings page cleanup must release owned async actions when Settings closes',
    );
    assert.match(
      finishBlock,
      /pendingBotActionRef\.current = null;[\s\S]*if \(botPageMountedRef\.current\) \{[\s\S]*setPendingBotAction\(null\);/,
      'Bot pending cleanup must release the ref but not write React state after unmount',
    );
    assert.match(
      updateBlock,
      /await props\.onUpdate\(\{ botChat: \{ channels: \{ \[provider\]: patch \} \} \}\);[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*return true;/,
      'Bot field saves must not report success to a continuation after Settings closes',
    );
    assert.match(
      updateBlock,
      /catch \(error\) \{[\s\S]*if \(botPageMountedRef\.current\) \{[\s\S]*toast\.error\(copy\.saveFailed\(botCopy\.providers\[provider\]\.label\), settingsActionErrorMessage\(error, locale\)\);/,
      'Bot field-save failures must not toast after Settings closes',
    );
    assert.match(
      statusEffectBlock,
      /subscribeStatusChanges\(\(status\) => \{[\s\S]*if \(!botPageMountedRef\.current\) return;[\s\S]*setStatusLoadError\(null\);/,
      'Bot status subscriptions must not write status state after unmount',
    );
    assert.match(
      testBlock,
      /const result = await window\.maka\.settings\.testBotChannel\(provider\);[\s\S]*if \(!botPageMountedRef\.current\) return;[\s\S]*toast\.success/,
      'Separate bot tests must drop late success/failure feedback after unmount',
    );
    assert.match(
      testBlock,
      /catch \(error\) \{[\s\S]*if \(botPageMountedRef\.current\) \{[\s\S]*toast\.error\(copy\.testError\(botCopy\.providers\[provider\]\.label\), settingsActionErrorMessage\(error, locale\)\);/,
      'Separate bot thrown-test errors must not toast after unmount',
    );
    assert.match(
      connectBlock,
      /const result = await window\.maka\.settings\.testBotChannel\(provider\);[\s\S]*if \(!botPageMountedRef\.current\) return;[\s\S]*toast\.success/,
      'Combined bot connect tests must drop late credential-test feedback after unmount',
    );
    assert.match(
      connectBlock,
      /try \{[\s\S]*if \(!botPageMountedRef\.current\) return;[\s\S]*if \(!testOk \|\| providerSupport !== 'runtime'\) return;[\s\S]*const saved = await updateChannelFor\(provider, \{ enabled: true \}\);[\s\S]*if \(!saved\) return;[\s\S]*if \(!botPageMountedRef\.current\) return;[\s\S]*await restartBotProvider\(provider\);/,
      'Combined bot connect must not continue into enable/restart after unmount',
    );
    assert.match(
      restartProviderBlock,
      /async function restartBotProvider\(provider: BotProvider\): Promise<boolean> \{[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*const status = await window\.maka\.settings\.bots\.restart\(provider\);/,
      'Bot restart must not start after Settings has already closed',
    );
    assert.match(
      restartProviderBlock,
      /const status = await window\.maka\.settings\.bots\.restart\(provider\);[\s\S]*if \(!botPageMountedRef\.current\) return status\.running;[\s\S]*setStatuses/,
      'Bot restart must not write status or toast after unmount',
    );
    assert.match(
      restartProviderBlock,
      /catch \(error\) \{[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*toast\.error/,
      'Bot restart thrown errors must not toast after unmount',
    );
    assert.match(
      refreshBlock,
      /async function refreshBotStatuses\(\): Promise<boolean> \{[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*await props\.onReload\(\);[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*const nextStatuses = await window\.maka\.settings\.bots\.listStatuses\(\);[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*setStatuses\(nextStatuses\);/,
      'Bot status refresh must not write refreshed statuses after unmount',
    );
    assert.match(
      refreshBlock,
      /catch \(error\) \{[\s\S]*if \(!botPageMountedRef\.current\) return false;[\s\S]*setStatusLoadError\(message\);[\s\S]*toast\.error\(copy\.refreshFailed, message\);/,
      'Bot status refresh errors must not toast after unmount',
    );
    assert.match(
      disconnectBlock,
      /const saved = await updateChannelFor\([\s\S]*if \(!saved\) return;[\s\S]*if \(!botPageMountedRef\.current\) return;[\s\S]*await refreshBotStatuses\(\);[\s\S]*if \(botPageMountedRef\.current\) \{[\s\S]*toast\.success\(/,
      'Linked-session disconnect success must not toast after unmount',
    );
  });

  it('renders the listener restart action only once outside quick onboarding actions', async () => {
    const detail = await readRepo('apps/desktop/src/renderer/settings/bot-chat-detail.tsx');
    // PR1197 review (P1-8): the scan-login action row is gated on
    // `inQuickOnboarding` (quick mode or WeChat), so manual mode falls through
    // to the shared runtime 测试并连接 CTA instead of losing the connect action.
    const quickActions = detail.match(/\{inQuickOnboarding \? \([\s\S]*?\) : support === 'runtime'/)?.[0] ?? '';

    assert.notEqual(quickActions, '', 'The quick-onboarding action row must stay gated behind inQuickOnboarding');
    assert.match(
      detail,
      /const inQuickOnboarding = quickOnboarding && \(qrOnlyOnboarding \|\| setupMode === 'quick'\)/,
      'Manual mode must drop out of the scan-login action row so runtime providers keep 测试并连接',
    );
    assert.doesNotMatch(quickActions, /props\.onRestart|重启监听/, 'Quick onboarding actions must not embed a duplicate listener restart button');
    assert.match(
      detail,
      /support === 'runtime' && \(status\?\.running \|\| props\.restarting\)[\s\S]*provider !== 'wechat'[\s\S]*onClick=\{\(\) => void props\.onRestart\(\)\}/,
      'The shared runtime action row must remain the single owner of listener restart',
    );
  });

  it('keeps unified onboarding as the only remote WeChat QR authority', async () => {
    const settings = await readSettingsCombinedSource();
    const styles = await readRendererContractCss();
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const onboardingMain = await readRepo('apps/desktop/src/main/bot-onboarding-main.ts');
    const onboardingModal = await readRepo('apps/desktop/src/renderer/settings/bot-onboarding-modal.tsx');
    const onboardingContract = await readRepo('packages/core/src/bot-onboarding.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const scanLogin = await readRepo('apps/desktop/src/main/wechat-scan-login.ts');
    const desktopPackage = await readRepo('apps/desktop/package.json');

    assert.doesNotMatch(settings, /function WeChatScanLoginModal\b/, 'The retired renderer-owned iLink modal must not return');
    assert.doesNotMatch(settings, /window\.maka\.settings\.bots\.wechat\.(?:fetchQrcode|pollQrcodeStatus)/, 'Renderer code must not bypass unified onboarding IPC');
    assert.equal((settings.match(/<BotOnboardingModal\b/g) ?? []).length, 1, 'All quick-onboarding providers must share one modal authority');
    assert.match(onboardingMain, /case 'wechat':[\s\S]*token: credential\.botToken[\s\S]*webhookUrl: credential\.baseUrl[\s\S]*botUserId: credential\.botId/, 'Confirmed iLink credentials must be persisted by the main-process onboarding authority');
    // PR1197 review (P2-12): onboarding device-code HTTP must be proxy-aware.
    assert.match(onboardingMain, /import \{[^}]*proxiedFetch[^}]*\} from '@maka\/runtime'/, 'Onboarding HTTP must import the proxy-aware fetch');
    assert.doesNotMatch(onboardingMain, /await fetch\(/, 'Onboarding provider calls must not bypass the proxy with a bare fetch');
    assert.match(
      settings,
      /onConnected=\{async \(snapshot\) => \{[\s\S]*await props\.onReload\(\);[\s\S]*if \(!botDetailMountedRef\.current\) return;[\s\S]*await props\.onRefreshStatuses\(\);[\s\S]*toast\.success/,
      'Confirmed scan login must refresh persisted settings and runtime status before showing success',
    );
    assert.match(onboardingModal, /return cancelCurrent;/, 'Closing or unmounting the unified QR modal must cancel its main-owned session');
    assert.match(onboardingModal, /onboarding\.start\([\s\S]*onboarding\.poll\(sessionId\)/, 'The unified QR modal must start and poll through typed onboarding IPC');
    assert.match(onboardingModal, /generation !== generationRef\.current/, 'Late QR responses must be ignored after refresh or close');
    assert.match(onboardingModal, /settingsActionErrorMessage\(result\.error\.message, locale\)/, 'Unified onboarding Result failures must be scrubbed for the active locale before rendering');
    assert.match(onboardingModal, /Promise\.resolve\(props\.onConnected\(snapshot\)\)\.catch/, 'Connected follow-up failures must not become unhandled rejections');
    assert.doesNotMatch(onboardingContract, /secret|token|deviceCode|opaqueToken/i, 'Renderer-safe onboarding snapshots must not contain provider secrets or device codes');
    const onboardingModalStyles = styles.match(/\.settingsBotOnboardingModal\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(onboardingModalStyles, /position:\s*fixed;/, 'Unified onboarding modal must preserve viewport-fixed positioning');
    assert.doesNotMatch(onboardingModalStyles, /position:\s*relative;/, 'Unified onboarding modal must not override shared viewport centering with relative positioning');
    assert.match(settings, /function WechatQrLoginModal\b/, 'WeChat scan login must render its own QR modal');
    assert.match(settings, /const loadingQrRef = useRef\(false\)/, 'WeChat bridge QR modal must keep a synchronous reload guard');
    assert.match(settings, /function reloadQrCode\(\) \{[\s\S]*if \(loadingQrRef\.current\) return;[\s\S]*loadingQrRef\.current = true;[\s\S]*setLoading\(true\);[\s\S]*setReloadNonce\(\(current\) => current \+ 1\)/, 'WeChat bridge QR refresh buttons and polling must share the reload guard');
    assert.match(settings, /window\.setInterval\(\(\) => \{[\s\S]*reloadQrCode\(\)/, 'WeChat bridge QR polling must not bypass the reload guard');
    assert.match(settings, /setResult\(\{[\s\S]*ok: false,[\s\S]*error: settingsActionErrorMessage\(error, locale\),[\s\S]*hint: copy\.readQrFailed/, 'WeChat bridge QR thrown failures must use the Settings scrubber and locale catalog before rendering');
    assert.doesNotMatch(settings, /error: error instanceof Error \? error\.message : String\(error\)/, 'WeChat bridge QR modal must not render raw thrown Error.message');
    assert.match(settings, /variant="secondary" size="sm" disabled=\{loading\} onClick=\{reloadQrCode\}/, 'WeChat bridge QR refresh buttons must use the governed compact tier and disable while a QR reload is in flight');
    assert.doesNotMatch(styles, /\.settingsWechatQrSecondary\b/, 'WeChat QR actions must not restore consumer-owned Button states');
    assert.match(settings, /window\.maka\.settings\.bots\.wechatQrCode\(\)/, 'QR modal must call the bridge QR IPC');
    assert.match(settings, /<img src=\{qrDataUrl\} alt=\{copy\.qrAlt\}/, 'QR modal must render a visible QR image with a localized accessible name');
    assert.match(settings, /setWechatQrOpen\(true\)/, 'Scan-login button must open the QR modal');
    assert.match(settings, /async function disconnectLinkedSession\(\)/, 'Saved QR session credentials must have a visible disconnect path');
    assert.match(settings, /detailCopy\.disconnectWechat/, 'WeChat action stack must expose the localized disconnect label after login');
    assert.match(settings, /detailCopy\.disconnectWhatsapp/, 'WhatsApp action stack must expose a localized unlink label after pairing');
    assert.match(settings, /token:\s*''[\s\S]*connected:\s*false[\s\S]*readiness:\s*'scaffolded'/, 'Disconnect must clear saved scan-login credentials and readiness');
    assert.match(settings, /sessionConfigured:\s*false[\s\S]*readiness:\s*'scaffolded'/, 'WhatsApp unlink must clear the local-session marker and readiness');
    assert.match(settings, /const saved = await updateChannelFor\([\s\S]*token:\s*''[\s\S]*if \(!saved\) return;[\s\S]*toast\.success\(/, 'Disconnect must not report success if clearing saved credentials fails');
    assert.doesNotMatch(settings, /扫码登录由本机 wechat-bridge 处理/, 'Scan login must not be a toast-only handoff');
    assert.match(styles, /\.settingsWechatQrModal\b/, 'QR modal styles must be present');
    assert.match(styles, /\.settingsWechatQrFrame img\b/, 'QR image must have a stable frame style');
    assert.match(scanLogin, /get_bot_qrcode\?bot_type=3/, 'Main scan-login wrapper must use the iLink QR endpoint');
    assert.match(scanLogin, /get_qrcode_status\?qrcode=/, 'Main scan-login wrapper must use the iLink status endpoint');
    assert.match(scanLogin, /X-WECHAT-UIN/, 'Main scan-login wrapper must send the required WeChat UIN header');
    assert.match(scanLogin, /createRequire\(import\.meta\.url\)/, 'Main scan-login wrapper must be able to load the QR renderer from Electron ESM');
    assert.match(scanLogin, /qrcode\.toDataURL\(raw/, 'iLink qrcode_img_content is QR payload content and must be rendered before reaching <img>');
    assert.match(scanLogin, /return \{ qrcodeUrl: await renderWeChatQrcode\(qrcodeContent\), qrToken \}/, 'Direct scan login must return a renderer-safe QR image data URL, not raw iLink content');
    assert.match(desktopPackage, /"qrcode":\s*"\^1\.5\.4"/, 'Desktop main process must declare the QR renderer dependency it uses');
    assert.match(onboardingMain, /from '\.\/wechat-scan-login\.js'/, 'Electron ESM onboarding import must include the emitted .js extension');
    assert.match(main, /settings:bots:onboarding:start/, 'main process must expose unified onboarding start IPC');
    assert.match(main, /settings:bots:onboarding:poll/, 'main process must expose unified onboarding poll IPC');
    assert.doesNotMatch(main, /settings:bots:wechat:(?:fetchQrcode|pollQrcodeStatus)/, 'main process must not expose a second renderer-owned iLink authority');
    assert.match(main, /settings:bots:wechatQrCode/, 'main process must expose the WeChat QR IPC');
    assert.match(preload, /wechatQrCode\(\): Promise<WechatBridgeQrCodeResult>/, 'preload must expose the typed QR bridge');
    assert.doesNotMatch(preload, /settings:bots:wechat:(?:fetchQrcode|pollQrcodeStatus)/, 'preload must not expose retired direct iLink channels');
    assert.match(globalTypes, /wechatQrCode\(\): Promise<WechatBridgeQrCodeResult>/, 'global types must mirror the QR bridge');
    assert.doesNotMatch(globalTypes, /fetchQrcode|pollQrcodeStatus/, 'global types must not restore the retired direct iLink API');
  });
});
