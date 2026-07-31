import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { getDailyReviewSettingsCopy } from '../../renderer/locales/settings-daily-review-copy.js';
import { getHealthCenterCopy } from '../../renderer/locales/settings-health-copy.js';
import { getVoiceSettingsCopy } from '../../renderer/locales/settings-voice-copy.js';
import { getDataSettingsCopy } from '../../renderer/locales/settings-data-copy.js';
import { getOpenGatewaySettingsCopy } from '../../renderer/locales/settings-open-gateway-copy.js';
import { getPermissionCenterCopy } from '../../renderer/locales/permission-center-copy.js';
import { getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';
import { getProviderSettingsCopy } from '../../renderer/locales/settings-provider-copy.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings coming-soon cleanup contract', () => {
  it('does not keep the old generic ComingSoon page registry or fallback renderer', async () => {
    const src = await readSettingsCombinedSource();
    assert.doesNotMatch(src, /type\s+ComingSoonCopy\b/, 'Settings must not keep a generic roadmap-page copy registry');
    assert.doesNotMatch(src, /COMING_SOON_PAGES/, 'Settings must not route sections through an empty coming-soon registry');
    assert.doesNotMatch(src, /function\s+ComingSoonPage\b/, 'Settings must not keep the generic unimplemented-page template');
    assert.doesNotMatch(src, /function\s+ComingSoonSection\b/, 'Settings must not keep generic coming-soon sections');
  });

  it('does not expose nav-level comingSoon state or command-palette soon hints', async () => {
    const settings = await readSettingsCombinedSource();
    const providers = await readProviderSettingsCombinedSource();
    const palette = await readRepo('apps/desktop/src/renderer/command-palette-commands.ts');
    const styles = await readRendererContractCss();
    const providerCatalog = await readRepo('packages/core/src/llm-connections.ts');
    assert.doesNotMatch(settings, /comingSoon\??:/, 'Settings nav items must not carry stale comingSoon flags');
    // PR-SETTINGS-NAV-REGROUP-0 (WAWQAQ msg `a9ef0d5d`): `settingsNavBadge`
    // is now legitimately reused as a Beta chip on shipping features.
    // The earlier blanket ban on the class name is dropped; the other
    // copy-level assertions in this block (e.g. command palette `即将推出`
    // ban below) still guard the original intent.
    assert.doesNotMatch(palette, /即将推出/, 'Command palette settings entries must not advertise dead coming-soon hints');
    assert.doesNotMatch(palette, /comingSoon/, 'Command palette must not read removed nav comingSoon flags');
    assert.doesNotMatch(providers, /即将支持的 OAuth 订阅登录/, 'Providers header must not advertise future OAuth login as a model-provider affordance');
    assert.doesNotMatch(providers, /即将推出|尚未实现|路线图/, 'ProvidersPanel must not show unavailable providers as visible roadmap copy');
    assert.doesNotMatch(providers, /providerComingSoon|未开放配置|聊天发送未开放|未进入配置入口/, 'ProvidersPanel must use product-state account copy instead of coming-soon configuration copy');
    assert.match(
      providers,
      /<div className="enabledEmptyChip" role="note">[\s\S]*\{copy\.empty\}[\s\S]*\{copy\.emptyHelp\}[\s\S]*<\/div>/,
      'ProvidersPanel empty state should stay passive and frame setup as an add-connection action',
    );
    assert.equal(getProviderSettingsCopy('zh').panel.empty, '还没有模型连接');
    assert.doesNotMatch(providers, /还没有供应商/, 'ProvidersPanel empty state should not read like unfinished product setup');
    assert.doesNotMatch(providerCatalog, /catalogBadge:\s*'Soon'|future phase/, 'provider catalog metadata must not keep soon/future-phase copy');
    assert.doesNotMatch(styles, /ComingSoonPage|roadmap banner|providerComingSoon|providerCatalogSoon/, 'Settings CSS must not keep stale coming-soon/provider-roadmap naming');
    // PR-SETTINGS-NAV-REGROUP-0: `.settingsNavBadge` is reused as the Beta
    // chip primitive. Lock it down so we don't lose it accidentally.
    assert.match(styles, /\.settingsNavBadge\s*\{/);
  });

  it('keeps feature status pages product-scoped instead of demo-version or future-roadmap copy', async () => {
    const settings = await readSettingsCombinedSource();
    const dailyCopy = getDailyReviewSettingsCopy('zh');

    assert.doesNotMatch(settings, /V0\.1|V0\.2|capture smoke|之后会加|后续版本开放|阶段开放/, 'feature status pages must not read like demo-stage roadmap copy');
    // PR-DAILY-REVIEW-FULL-0: Settings → 每日回顾 became a real config form
    // (enable toggle, execute time, section toggles, deep analysis, manual
    // trigger). The page status now describes the wired automatic analysis
    // path and keeps the local-only fallback copy in the same branch.
    assert.match(dailyCopy.enabledHelp, /每天自动分析/, 'Daily Review status should describe the shipped automatic analysis mode');
    assert.match(dailyCopy.unavailable, /仅本地数字聚合/, 'Daily Review fallback should still describe the local aggregate mode when the pipeline is not wired');
    assert.match(settings, /copy\.enabled/, 'Daily Review settings must surface the auto-run enable toggle');
    assert.match(settings, /copy\.executeTime/, 'Daily Review settings must surface the configurable execute time');
    assert.equal(dailyCopy.sections.summary.title, '对话摘要');
    assert.equal(dailyCopy.sections.gaps.title, '遗漏提醒');
    assert.equal(dailyCopy.sections.usage.title, '使用洞察');
    assert.equal(dailyCopy.sections.code.title, '代码建议');
    assert.equal(dailyCopy.deep, '深度分析');
    assert.equal(dailyCopy.model, '分析模型');
    assert.equal(dailyCopy.generateDaily, '生成每日回顾');
    assert.equal(dailyCopy.generateDeep, '生成深度分析');
    assert.equal(getVoiceSettingsCopy('zh').badge, '本地自检', 'Voice status badge should describe the shipped local smoke boundary');
  });

  it('sanitizes Settings action errors before they reach visible toasts', async () => {
    const settings = await readSettingsCombinedSource();
    const helper = settings.match(/function settingsActionErrorMessage\(error: unknown, locale: UiLocale = 'zh'\): string \{[\s\S]*?\n\}/);

    assert.ok(helper, 'SettingsModal must keep a shared settingsActionErrorMessage helper');
    assert.match(
      helper![0],
      /generalizedErrorMessageChinese\(new Error\(raw\), ''\)/,
      'Settings action errors should use the shared Chinese generalized-error classifier',
    );
    assert.match(settings, /parseLocalMemoryMarkdown/, 'Local memory parsing should stay in the Settings source set');
    assert.match(
      helper![0],
      /redactSecrets\(raw\)\.trim\(\)/,
      'Settings action errors must redact secrets before preserving any raw message',
    );
    assert.match(
      helper![0],
      /\[\\u4E00-\\u9FFF\]/,
      'Settings action errors may preserve already-localized messages only after redaction',
    );
    assert.doesNotMatch(
      helper![0],
      /error\.message\.trim\(\)\) return error\.message\.trim\(\)|typeof error === 'string' && error\.trim\(\)\) return error\.trim\(\)/,
      'Settings action errors must not directly echo raw Error.message or raw string input into visible toasts',
    );
    assert.match(
      helper![0],
      /return getSettingsSharedCopy\(locale\)\.unknownError/,
      'Unknown non-localized Settings action errors should degrade to a Chinese fallback',
    );
  });

  it('keeps Voice settings boundary copy in current-policy language', async () => {
    const settings = await readSettingsCombinedSource();
    const voicePage = settings.match(/function VoiceModelsSettingsPage\([\s\S]*?async function readBrowserMicrophonePermission/);
    const voiceCopy = getVoiceSettingsCopy('zh');

    assert.ok(voicePage, 'Voice settings page block must exist');
    assert.match(voiceCopy.subtitle, /语音转写和语音朗读模型必须遵守这个边界/, 'Voice settings should frame speech features as a current policy boundary');
    assert.match(voiceCopy.boundaries.join('\n'), /转写文本只进入消息输入框草稿；用户发送前必须能编辑。/, 'Voice transcript handling should be stated as current policy');
    assert.match(voiceCopy.boundaries.join('\n'), /录音样本只在本机内存里/, 'Voice privacy boundary must be stated in the current boundary copy');
    assert.doesNotMatch(
      voicePage![0],
      /未来|后续|接入会叠在|之后会加|采集链路 smoke|capture smoke|STT \/ TTS/,
      'Voice settings visible copy must not read like future roadmap copy',
    );
    // Round 11: shipped-feature announcements (已上线 banners) are release
    // notes, not settings chrome — the always-on banner is gone for good.
    assert.doesNotMatch(
      voicePage![0],
      /已上线/,
      'Voice settings must not carry release-note banners',
    );
  });

  it('keeps Data settings backup copy actionable instead of future export/import roadmap copy', async () => {
    const settings = await readSettingsCombinedSource();
    const dataPage = settings.match(/function DataSettingsPage\(\)[\s\S]*?function PersonalizationSettingsPage/);
    const dataCopy = getDataSettingsCopy('zh');

    assert.ok(dataPage, 'Data settings page block must exist');
    assert.match(dataCopy.backupNotice, /需要备份时先退出 Maka，再复制整个目录/, 'Data settings should give a current manual backup path');
    assert.match(dataCopy.backupNotice, /恢复后需要重新测试/, 'Data settings should explain credential restore behavior');
    assert.doesNotMatch(
      dataPage![0],
      /\.maka\.zip|schemaVersion|V0\.2|阶段开放|导入备份/,
      'Data settings must not advertise future export/import roadmap copy',
    );
  });

  it('keeps planned bot platforms out of the credentials-readiness flow', async () => {
    const settings = await readSettingsCombinedSource();

    assert.match(settings, /function botReadinessCopyForSupport\b/, 'Settings bot page must route readiness copy through support-aware presentation');
    assert.match(settings, /if \(support === 'planned'\) return copy\.planned;/, 'planned bot platforms must not reuse credential-readiness copy');
    assert.match(settings, /wechat:[\s\S]*support:\s*'credentials'/, 'WeChat should expose credential probing rather than stay in the planned-only bucket');
    assert.match(settings, /provider === 'wechat'/, 'WeChat needs visible App ID / App Secret credential fields');
    assert.doesNotMatch(settings, /机器人运行时尚未接入|代码中还没有这个平台的运行时|平台运行时尚未接入|运行时未开放|可用运行时|开放前|收发 smoke/, 'planned bot copy must not expose implementation-status placeholder language');
    assert.doesNotMatch(settings, /providerSupport === 'planned'\s*\?\s*\{\s*label: '未接入'/, 'planned bot list tags should use the shared planned copy');
  });

  it('keeps runtime bot platform copy aligned with shipped receive and send paths', async () => {
    const settings = await readSettingsCombinedSource();
    const botCopy = getBotSettingsCopy('zh');

    // PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6`): per-platform
    // help text now lives in BOT_LABELS to match the reference design's
    // single short sentence. The per-platform section detail no longer
    // duplicates a runtime narrative — that's intentional.
    assert.match(botCopy.providers.discord.help, /Discord Developer Portal 创建 Bot/);
    assert.match(botCopy.providers.qq.help, /QQ 开放平台创建机器人并获取 AppID 和 AppSecret/);
    assert.doesNotMatch(
      settings,
      /事件接入需要|独立后续|凭据有效不代表运行可用/,
      'runtime bot detail copy must not describe shipped Gateway bridges as future work',
    );
  });

  it('keeps bot credential follow-up copy action-oriented', async () => {
    const settings = await readSettingsCombinedSource();
    const botCopy = getBotSettingsCopy('zh');

    assert.match(settings, /case 'no-token': return copy\.noToken/);
    assert.match(settings, /case 'missing-feishu-credentials': return copy\.missingFeishuCredentials/);
    assert.match(botCopy.status.feishuDomainRequired, /飞书凭据有效，等待填写事件订阅域名/);
    assert.doesNotMatch(
      settings,
      /缺少 Bot Token|缺少飞书 App ID|飞书凭据有效，但还没有事件订阅域名/,
      'Feishu credential follow-up copy should describe the next setup action, not an unfinished missing state',
    );
  });

  it('keeps Open Gateway token setup copy action-oriented', async () => {
    const settings = await readSettingsCombinedSource();
    const gatewayCopy = getOpenGatewaySettingsCopy('zh');

    assert.match(gatewayCopy.form.waitingNotice, /网关已开启，等待生成访问 token。生成 token 后服务会自动启动。/);
    assert.match(gatewayCopy.status.waitingTokenDetail, /生成访问 token 后服务会自动启动/);
    assert.match(settings, /gatewayDraft\.token \? copy\.summary\.configured : copy\.summary\.waitingToken/);
    assert.match(settings, /if \(error === 'missing_token'\) return copy\.status\.waitingToken/);
    assert.doesNotMatch(
      settings,
      /网关已开启，但还没有 token|缺少访问 token|gateway(?:Draft)?\.token \? '已配置' : '未配置'/,
      'Open Gateway token copy should frame enabled-without-token as a pending token action, not a raw missing-field error',
    );
  });

  it('keeps Permission Center copy scoped to current product boundaries', async () => {
    const settings = await readSettingsCombinedSource();
    const permissionPage = settings.match(/function PermissionCenterPage\(\)[\s\S]*?function CapabilityRow/);
    const capabilityRow = settings.match(/function CapabilityRow\(props: \{ capability: CapabilitySnapshot; copy: PermissionCenterCopy; locale: UiLocale \}\)[\s\S]*?function OsPermissionRow/);
    const permissionCopy = getPermissionCenterCopy('zh');

    assert.ok(permissionPage, 'Permission Center page block must exist');
    assert.ok(capabilityRow, 'Permission Center capability row block must exist');
    // PR-PERMISSION-PAGE-REDESIGN: page is no longer a pure read-only
    // snapshot — system permissions row now exposes 请求授权 / 前往系统设置
    // action buttons. The "read-only snapshot" framing moved to the
    // footnote so the page intro can lead with the action affordance.
    assert.match(permissionCopy.footnote, /只读取系统权限与功能能力的当前快照/, 'Permission Center footnote must still explain the read-only snapshot boundary for capabilities');
    assert.match(permissionCopy.footnote, /系统设置 → 隐私与安全性/, 'Permission Center must point users to the current OS permission path');
    assert.match(permissionPage![0], /<ul className="settingsCapabilityList" aria-label=\{copy\.capabilityListAria\}/, 'Permission Center capability list must have an accessible name');
    assert.match(permissionPage![0], /<ul className="settingsOsPermissionList" aria-label=\{copy\.osListAria\}>/, 'Permission Center OS permission list must have an accessible name');
    assert.match(permissionPage![0], /window\.maka\.permissions\.requestAccess/, 'Permission Center must wire the requestAccess IPC for direct-request permissions');
    assert.match(permissionPage![0], /window\.maka\.permissions\.openSystemSettings/, 'Permission Center must wire the openSystemSettings IPC for deep-link permissions');
    assert.match(capabilityRow![0], /<dl className="settingsCapabilityLayers" aria-label=\{copy\.layers\.aria\(capabilityLabel\)\}>/, 'Capability status definition lists must expose row-scoped accessible names');
    assert.match(capabilityRow![0], /<ul aria-label=\{copy\.requiredPermissionsAria\(capabilityLabel\)\}>/, 'Capability required-permission lists must expose row-scoped accessible names');
    assert.match(capabilityRow![0], /<ul aria-label=\{copy\.guidanceAria\(capabilityLabel\)\}>/, 'Capability guidance lists must expose row-scoped accessible names');
    assert.match(capabilityRow![0], /<ul aria-label=\{copy\.auditAria\(capabilityLabel\)\}>/, 'Capability audit-event lists must expose row-scoped accessible names');
    assert.doesNotMatch(capabilityRow![0], /<dl className="settingsCapabilityLayers">/, 'Capability status details must not regress to an anonymous definition list');
    assert.equal(permissionCopy.osStates.not_determined.label, '等待授权', 'OS not_determined should read as an actionable waiting state');
    assert.equal(permissionCopy.readiness.not_configured.label, '等待配置', 'capability not_configured should read as an actionable waiting state');
    assert.equal(permissionCopy.layers.configurationStates.missing, '等待补齐配置', 'configuration missing should read as an actionable waiting state');
    assert.match(permissionCopy.readiness.degraded.detail, /仍有运行态、权限或子功能需要处理/, 'degraded capability copy should describe a current action state');
    assert.match(
      permissionPage![0],
      /setError\(settingsActionErrorMessage\(err, locale\)\)/,
      'Permission Center snapshot load failures must use the shared sanitized Settings error copy',
    );
    assert.doesNotMatch(
      permissionPage![0],
      /原生 helper|上线后|接入后|即将可用|未接入|尚未授权|子功能没有完成/,
      'Permission Center visible copy must not expose implementation roadmap/helper language',
    );
    assert.doesNotMatch(
      permissionPage![0],
      /setError\(err instanceof Error \? err\.message|setError\(String\(err\)\)/,
      'Permission Center must not echo raw snapshot load errors into the visible alert',
    );
    assert.doesNotMatch(settings, /not_configured:\s*\{\s*label:\s*'未配置'/, 'capability not_configured must not use raw missing-configuration copy');
    assert.doesNotMatch(settings, /case\s+'missing':\s*return\s+'缺少必要配置'/, 'configuration missing must not use raw missing-field copy');
  });

  it('gates Permission Center OS permission actions with one synchronous owner', async () => {
    const settings = await readSettingsCombinedSource();
    const permissionPage = settings.match(/function PermissionCenterPage\(\)[\s\S]*?function CapabilityRow/)?.[0] ?? '';

    assert.match(permissionPage, /const \[pendingPermAction, setPendingPermAction\] = useState<string \| null>\(null\)/);
    assert.match(
      permissionPage,
      /const permissionActionGuard = useActionGuard<string>\(\)/,
      'Permission Center must hold the pending action owner in the shared guard (released on unmount)',
    );
    assert.match(
      permissionPage,
      /const actionKey = `\$\{permId\}:\$\{kind\}`;[\s\S]*if \(!permissionActionGuard\.begin\(actionKey\)\) return;[\s\S]*setPendingPermAction\(actionKey\);/,
      'Permission Center must synchronously reject same-frame duplicate permission actions before React commits disabled state',
    );
    assert.match(
      permissionPage,
      /finally \{[\s\S]*if \(permissionActionGuard\.current === actionKey\) \{[\s\S]*permissionActionGuard\.finish\(\);[\s\S]*\}[\s\S]*if \(mountedRef\.current\) setPendingPermAction\(null\);/,
      'Permission Center must release only the action it owns and avoid state writes after unmount',
    );
    assert.match(permissionPage, /busy=\{pendingPermAction !== null\}/);
    assert.match(
      permissionPage,
      /pendingKey=\{[\s\S]*pendingPermAction === `\$\{id\}:request`[\s\S]*pendingPermAction === `\$\{id\}:dragGrant`[\s\S]*\? 'dragGrant'/,
      'all three permission actions must expose their reachable pending label and aria-busy state',
    );
    assert.match(
      permissionPage,
      /window\.addEventListener\('focus', refreshAfterSystemSettings\)/,
      'Permission Center must re-read TCC after the user returns from System Settings',
    );
  });

  it('keeps bot readiness waiting states action-oriented', async () => {
    const settings = await readSettingsCombinedSource();
    const botCopy = getBotSettingsCopy('zh');

    assert.deepEqual(botCopy.readiness.scaffolded, { label: '待配置', detail: '等待补齐这个平台需要的凭据配置。', tone: 'neutral' });
    assert.deepEqual(botCopy.readiness.configured, { label: '已配置', detail: '已填写配置；等待完成凭据或运行态验证。', tone: 'info' });
    assert.doesNotMatch(
      settings,
      /还没有完成这个平台需要的凭据配置|还没有证明凭据或运行态可用/,
      'Bot readiness copy should describe actionable waiting states, not unfinished implementation states',
    );
  });

  it('keeps Health Center copy scoped to read-only current signals', async () => {
    const settings = await readSettingsCombinedSource();
    const healthPage = settings.match(/function HealthCenterPage\(\)[\s\S]*?function HealthSummaryTile/);
    const healthSignalRow = settings.match(/function HealthSignalRow\(props: \{ signal: HealthSignal; copy: HealthCenterCopy \}\)[\s\S]*?function groupSignalsByLayer/);
    const healthCopy = getHealthCenterCopy('zh');

    assert.ok(healthPage, 'Health Center page block must exist');
    assert.ok(healthSignalRow, 'HealthSignalRow block must exist');
    assert.match(healthSignalRow![0], /copy\.sources\[signal\.source\]/, 'Health Center should use the localized source-label presentation map');
    assert.match(healthCopy.footnote, /只汇总当前已记录的健康信号/, 'Health Center must explain its current read-only signal boundary');
    assert.match(healthCopy.validationWarning, /验证通过 ≠ 运行可用/, 'Health Center must keep validation and operational runtime distinct');
    assert.match(healthCopy.blockers.send(2), /健康信号会阻塞发送/, 'Health Center blocker copy should use localized product wording');
    assert.match(healthCopy.blockers.capability(2), /健康信号会阻塞能力/, 'Health Center capability blocker copy should use localized product wording');
    // PR-HEALTH-SUMMARY-LIST-A11Y-0 (round 19/30): semantic
    // `<ul>` / `<li>` replaces `<section role="list">` +
    // `<div role="listitem">`. ARIA list semantics still hold
    // — the elements carry them implicitly.
    assert.match(healthPage![0], /<ul aria-label=\{copy\.summaryAria\} className="settingsHealthSummary">/, 'Health Center summary metrics must expose list semantics');
    // Convergence R4: the tile is the shared StatTile rendered as="li" —
    // listitem semantics preserved through the primitive's `as` prop.
    assert.match(settings, /<StatTile\s+as="li"\s+className="settingsHealthSummaryTile"/, 'Health Center summary metric tiles must expose listitem semantics via StatTile as="li"');
    assert.match(healthPage![0], /aria-label=\{copy\.layerAria\(layerCopy\.label\)\}/, 'Health Center section aria labels should use the active locale');
    assert.match(healthPage![0], /<ul className="settingsHealthSignalList" aria-label=\{copy\.layerListAria\(layerCopy\.label\)\}>/, 'Health Center signal lists must expose product-scoped accessible names');
    assert.match(healthSignalRow![0], /\{copy\.source\}\{copy\.sources\[signal\.source\]\}/, 'Health Center row should present localized source labels');
    assert.match(healthSignalRow![0], /\{copy\.checked\}<RelativeTime/, 'Health Center row should present localized checked-time labels');
    assert.match(
      healthPage![0],
      /setError\(settingsActionErrorMessage\(err, locale\)\)/,
      'Health Center snapshot load failures must use the shared sanitized Settings error copy',
    );
    assert.doesNotMatch(
      healthPage![0],
      /接入后|落地后|即将|路线图|尚未实现|TODO|V0\.1|条 signal|阻塞 capability|settings 里|validation 层|agent 通路|memory contract/,
      'Health Center visible copy must not read like future roadmap, demo-stage, or implementation copy',
    );
    assert.doesNotMatch(
      healthPage![0],
      /setError\(err instanceof Error \? err\.message|setError\(String\(err\)\)/,
      'Health Center must not echo raw snapshot load errors into the visible alert',
    );
    assert.doesNotMatch(
      healthSignalRow![0],
      /source:\s*<code>|checked:|connection_test|runtime_probe|capability_snapshot|permission_snapshot/,
      'Health Center row must not expose raw source enum labels as visible metadata',
    );
  });

  it('keeps shipped read-only and fallback source naming out of stub vocabulary', async () => {
    const settings = await readSettingsCombinedSource();
    const ui = (
      await Promise.all([
        readRepo('packages/ui/src/components.tsx'),
        readRepo('packages/ui/src/chat-view.tsx'),
        readRepo('packages/ui/src/composer.tsx'),
        // Issue #1044: keep the stub-vocabulary gate on the extracted
        // composer workspace row (moved out of composer.tsx).
        readRepo('packages/ui/src/composer-workspace-row.tsx'),
        readRepo('packages/ui/src/skills-panel.tsx'),
        readRepo('packages/ui/src/daily-review-panel.tsx'),
        readRepo('packages/ui/src/plan-reminder-panel.tsx'),
        // Issue #1044: keep the stub-vocabulary gate on the extracted
        // plan-reminder form dialog (moved out of plan-reminder-panel.tsx).
        readRepo('packages/ui/src/plan-reminder-form-dialog.tsx'),
        readRepo('packages/ui/src/relative-time.tsx'),
      ])
    ).join('\n');

    assert.doesNotMatch(
      settings,
      /Permission Center stub|Health Center stub|Read-only stub/,
      'Settings read-only pages should not be maintained as implementation stubs in source naming',
    );
    assert.doesNotMatch(
      ui,
      /STUB_VIEWS|data-stub-view|dataStubView|stub framework|stub views/,
      'Sidebar fallback/empty surfaces should use product source naming instead of stub terminology',
    );
  });
});
