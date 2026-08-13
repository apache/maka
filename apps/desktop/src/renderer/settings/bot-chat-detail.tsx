import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ICON_SIZE, ArrowLeft } from '@maka/ui/icons';
import {
  BOT_ONBOARDING_PROVIDERS,
  type BotOnboardingBrand,
  type BotOnboardingProvider,
} from '@maka/core/bot-onboarding';
import { type BotChannelSettings, type BotProvider, type BotReadinessState } from '@maka/core/bot-chat-settings';
import type { BotStatus } from '@maka/runtime/bots';
import { MAX_ALLOWED_USER_IDS, parseAllowedUserIdsFromText } from '@maka/core/settings';
import { Card, MetadataList, MetadataListItem, SegmentedControl, SegmentedControlItem, StatusDot, Text, VStack } from '@astryxdesign/core';
import {
  BOT_BRAND,
  Button,
  FormLayout,
  TextInput,
  RelativeTime,
  Selector,
  Switch,
  TextArea,
  useMountedRef,
  useToast,
  useUiLocale,
  Banner,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { BotWeChatFields, WechatQrLoginModal } from './bot-wechat-login';
import { BotOnboardingModal } from './bot-onboarding-modal';
import { deriveBotChannelViewState } from './bot-settings-view-model';
import {
  BOT_LABELS,
  BotBrandLogo,
  botReadinessCopyForSupport,
  botStatusDetail,
  type BotPendingActionName,
} from './bot-chat-shared';
import { getBotSettingsCopy, type BotSettingsCopy } from '../locales/settings-bot-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { dotForStatus } from '@maka/ui';

function canEnableBotChannel(readiness: BotReadinessState): boolean {
  return readiness === 'credentials_valid' || readiness === 'operational' || readiness === 'degraded';
}

type BotDialogPhase = 'closed' | 'mounting' | 'open' | 'closing';

function supportsQuickOnboarding(provider: BotProvider): provider is BotOnboardingProvider {
  return (BOT_ONBOARDING_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Remote-access channel detail: header with the enable switch, runtime
 * status + action stack, and the auto-saving credential form for the
 * selected platform. The page owns the async action lifecycles and status
 * fetching; this component owns only its local modal state and derives the
 * render values from the channel/status props.
 */
export function BotChatChannelDetail(props: {
  provider: BotProvider;
  /**
   * #1233 deferral: when true (only under the settings-bots-onboarding
   * e2e-fixture fixture), open the scan-login modal at mount so the QR
   * waiting state renders deterministically. Real users never set this.
   */
  autoOpenScanLogin?: boolean;
  channel: BotChannelSettings;
  status: BotStatus | undefined;
  statusLoadError: string | null;
  actionBusy: boolean;
  pendingAction: BotPendingActionName | null;
  restarting: boolean;
  onBack(): void;
  onUpdateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
  onTest(): void;
  onTestAndConnect(): void;
  onRestart(): void;
  onDisconnectSession(): void;
  onReload(): Promise<void>;
  onRefreshStatuses(): Promise<boolean>;
}) {
  const { provider, channel, status } = props;
  const [scanLoginPhase, setScanLoginPhase] = useState<BotDialogPhase>(
    props.autoOpenScanLogin ? 'mounting' : 'closed',
  );
  const [wechatQrPhase, setWechatQrPhase] = useState<BotDialogPhase>('closed');
  const [setupMode, setSetupMode] = useState<'quick' | 'manual'>('quick');
  const [feishuBrand, setFeishuBrand] = useState<BotOnboardingBrand>(
    channel.domain === 'larksuite.com' ? 'lark' : 'feishu',
  );
  const botDetailMountedRef = useMountedRef();
  const toast = useToast();
  const locale = useUiLocale();
  const botCopy = getBotSettingsCopy(locale);
  const detailCopy = botCopy.detail;
  const providerPresentation = botCopy.providers[provider];

  const support = BOT_LABELS[provider].support;
  const viewState = deriveBotChannelViewState({ channel, status });
  const readiness = viewState.readiness;
  const readinessCopy = botReadinessCopyForSupport(support, readiness, locale);
  const quickOnboarding = supportsQuickOnboarding(provider);
  const qrOnlyOnboarding = provider === 'wechat';

  useEffect(() => {
    if (scanLoginPhase === 'mounting') {
      const frame = window.requestAnimationFrame(() => setScanLoginPhase('open'));
      return () => window.cancelAnimationFrame(frame);
    }
    if (scanLoginPhase === 'closing') {
      const frame = window.requestAnimationFrame(() => setScanLoginPhase('closed'));
      return () => window.cancelAnimationFrame(frame);
    }
  }, [scanLoginPhase]);

  useEffect(() => {
    if (wechatQrPhase === 'mounting') {
      const frame = window.requestAnimationFrame(() => setWechatQrPhase('open'));
      return () => window.cancelAnimationFrame(frame);
    }
    if (wechatQrPhase === 'closing') {
      const frame = window.requestAnimationFrame(() => setWechatQrPhase('closed'));
      return () => window.cancelAnimationFrame(frame);
    }
  }, [wechatQrPhase]);
  // PR1197 review (P1-8): the scan-login action row belongs to quick mode only.
  // WeChat has no manual mode, so it always uses the scan affordance. In manual
  // mode the runtime providers (e.g. DingTalk) must fall through to the shared
  // 测试并连接 CTA — otherwise the manual credential form has no way to start the
  // listener and the connect action is lost.
  const inQuickOnboarding = quickOnboarding && (qrOnlyOnboarding || setupMode === 'quick');
  const enableSwitchDisabled = support === 'planned' || (!channel.enabled && !canEnableBotChannel(readiness));
  const enableSwitchHint = support === 'planned'
    ? detailCopy.unavailableHint
    : !channel.enabled && !canEnableBotChannel(readiness)
      // PR1197 review (P1-8): point the user at the action that actually exists
      // in the current mode — scanning in quick onboarding, test-and-connect
      // everywhere else — instead of a stale reference to the removed button.
      ? inQuickOnboarding
        ? detailCopy.scanFirstHint
        : detailCopy.testFirstHint
      : undefined;
  const enableSwitchHintId = `settings-bot-enable-hint-${provider}`;

  // PR1197 review (P1-7): reset to the quick tab ONLY when the provider
  // changes. Folding channel.domain into this effect ejected a user out of
  // manual mode the moment they picked a different Feishu/Lark domain (a
  // channel.domain write), because the effect re-ran and forced setupMode back
  // to 'quick'. Mode reset is a provider-change concern; brand sync is a
  // domain-change concern — they must not share a dependency array.
  useEffect(() => {
    setSetupMode('quick');
  }, [provider]);

  // Keep the Feishu/Lark brand toggle in sync with the persisted domain. Safe
  // to run on domain changes: it only mirrors state, it never resets the tab.
  useEffect(() => {
    if (provider === 'feishu') {
      setFeishuBrand(channel.domain === 'larksuite.com' ? 'lark' : 'feishu');
    }
  }, [provider, channel.domain]);

  // Deep-review fix: the old wrapper pair (.settingsRemoteAccessDetail had no
  // CSS rule at all; .settingsBotDetail set `gap` on a display:block section,
  // which discards it) left this page with zero inter-section rhythm. The kit
  // page container owns the rhythm now, same as the overview next door.
  return (
    <SettingsPage>
      <Button
        variant="ghost"
        className="settingsRemoteAccessBack"
        aria-label={detailCopy.back}
        isDisabled={props.actionBusy}
        onClick={props.onBack}
        icon={<ArrowLeft size={ICON_SIZE.chrome} aria-hidden="true" />}
        label={detailCopy.back}
      />
      <header className="settingsBotDetailHeader" data-support={support}>
          <BotBrandLogo provider={provider} size="large" />
          <div className="settingsBotDetailHeaderBody">
            <h3>
              {providerPresentation.label}
              {/* Astryx convergence: readiness reads as the shared StatusDot +
                  text idiom — "no decorative Badge" (astryx docs principles). */}
              <span className="settingsStatus">
                <StatusDot variant={dotForStatus(readinessCopy.tone)} label={readinessCopy.label} />
                <span>{readinessCopy.label}</span>
              </span>
            </h3>
            <p>{providerPresentation.help}</p>
            {enableSwitchHint && (
              <small id={enableSwitchHintId} className="settingsBotEnableHint">
                {enableSwitchHint}
              </small>
            )}
          </div>
          {/* Keep the detail introduction first for heading navigation, while
              placing the switch before the first focusable documentation link. */}
          <Switch
            className="settingsBotDetailSwitch"
            label={detailCopy.enableAria(providerPresentation.label)}
            isLabelHidden
            disabledMessage={enableSwitchHint}
            value={channel.enabled}
            onChange={(enabled) => props.onUpdateChannel({ enabled })}
            isDisabled={enableSwitchDisabled || props.actionBusy}
          />
          {BOT_BRAND[provider].configDocUrl && (
            <a
              className="settingsBotConfigDocLink"
              href={BOT_BRAND[provider].configDocUrl}
              aria-label={detailCopy.configDocs}
              target="_blank"
              rel="noopener noreferrer"
            >
              {detailCopy.configDocs}
            </a>
          )}
        </header>
      {/* Astryx convergence: the runtime block was a full-width tinted card
          used as page structure (the named cards-in-page anti-pattern). It
          is an open kit section now — header + anchor divider + rows. */}
      <SettingsSection
        variant="bare"
        titleId="settings-bot-runtime-heading"
        title={viewState.liveOperational ? detailCopy.listening : readinessCopy.label}
        description={viewState.liveOperational ? detailCopy.healthy : readinessCopy.detail}
        action={(
          <div className="settingsBotActionStack" role="group" aria-label={detailCopy.actionsAria(providerPresentation.label)}>
            {inQuickOnboarding ? (
              <>
                <Button variant="primary" isDisabled={props.actionBusy} onClick={() => setScanLoginPhase('mounting')} label={provider === 'wecom' ? detailCopy.quickBind : provider === 'wechat' ? detailCopy.scanLogin : detailCopy.scanConnect} />
                {provider === 'wechat' && (channel.token || status?.identity) && (
                  <Button variant="secondary" isDisabled={props.actionBusy} onClick={() => void props.onDisconnectSession()} label={props.pendingAction === 'disconnect' ? detailCopy.disconnecting : detailCopy.disconnectWechat} />
                )}
                {provider === 'wechat' && (
                  <Button variant="secondary" isDisabled={props.actionBusy} onClick={() => setWechatQrPhase('mounting')} label={detailCopy.bridgeQr} />
                )}
                <Button variant="secondary" isDisabled={props.actionBusy} onClick={() => void props.onTest()} label={props.pendingAction === 'test' ? detailCopy.testing : detailCopy.test} />
              </>
            ) : support === 'runtime' && !status?.running ? (
              <Button variant="primary" isDisabled={props.actionBusy} onClick={() => void props.onTestAndConnect()} label={props.pendingAction === 'connect' ? detailCopy.connecting : detailCopy.testAndConnect} />
            ) : (
              <Button variant="secondary" isDisabled={props.actionBusy || support === 'planned'} onClick={() => void props.onTest()} label={props.pendingAction === 'test' ? detailCopy.testing : support === 'runtime' ? detailCopy.test : detailCopy.testAndConnect} />
            )}
            {support === 'runtime' && (status?.running || props.restarting) && provider !== 'wechat' && (
              <Button variant="secondary" isDisabled={props.actionBusy} onClick={() => void props.onRestart()} label={props.restarting ? detailCopy.restarting : detailCopy.restart} />
            )}
          </div>
        )}
      >
        {/* Astryx convergence: the hand-rolled <dl> grid (4→2→1 columns via
            two media queries) is MetadataList, whose multi-column layout
            handles the collapse itself. */}
        {/* Deep-review fix: MetadataList destructures a closed prop list and
            silently drops aria-label — the group name rides a real wrapper. */}
        <div role="group" aria-label={detailCopy.runtimeAria(providerPresentation.label)}>
        <MetadataList columns="multi">
          <MetadataListItem label={detailCopy.identity}>{status?.identity?.username ?? status?.identity?.displayName ?? detailCopy.unknownIdentity}</MetadataListItem>
          <MetadataListItem label={detailCopy.connectionType}>{botConnectionLabel(status?.connection ?? 'none', locale)}</MetadataListItem>
          <MetadataListItem label={detailCopy.lastEvent}>{status?.lastEventAt ? <RelativeTime ts={status.lastEventAt} /> : detailCopy.noneYet}</MetadataListItem>
          <MetadataListItem label={detailCopy.lastTest}>{channel.lastTestAt ? <RelativeTime ts={channel.lastTestAt} /> : detailCopy.neverTested}</MetadataListItem>
        </MetadataList>
        </div>
      </SettingsSection>
      {props.statusLoadError && (
        <Banner
          status="error"
          title={detailCopy.statusRefreshFailed}
          description={props.statusLoadError} />
      )}
      {status?.reason && channel.enabled && !viewState.liveOperational && (
        <Banner
          status="warning"
          title={botStatusDetail(status, locale)}
          description={readinessCopy.detail} />
      )}
      {viewState.currentError && support !== 'planned' && (
        <Banner
          status="error"
          title={detailCopy.latestFailure}
          description={(
            <span className="settingsBotBannerDescription">
              {locale === 'zh' ? viewState.currentError : detailCopy.latestFailureDetail}
            </span>
          )} />
      )}
      {/* Astryx convergence: the bespoke configuration header dialect
          becomes a kit section wrapping the mode toggle, quick-setup
          callout, and credential form. */}
      <SettingsSection
        variant="bare"
        title={quickOnboarding && !qrOnlyOnboarding ? detailCopy.setupMethod : detailCopy.connectionSettings}
        description={quickOnboarding ? detailCopy.localCredentials : detailCopy.autosave}
      >
      {quickOnboarding && !qrOnlyOnboarding && (
        <SegmentedControl
          className="settingsBotSetupModes"
          value={setupMode}
          label={detailCopy.setupAria(providerPresentation.label)}
          onChange={(value) => setSetupMode(value as 'quick' | 'manual')}
        >
          <SegmentedControlItem value="quick" label={detailCopy.quickRecommended} />
          <SegmentedControlItem value="manual" label={detailCopy.manual} />
        </SegmentedControl>
      )}

      {quickOnboarding && provider !== 'wechat' && setupMode === 'quick' && (
        /* Astryx convergence: the hand-tinted quick-setup plate is an
           Astryx Card — a genuine callout, the one legitimate Card use
           inside a settings page. */
        (<Card padding={4} role="region" aria-label={detailCopy.quickAria(providerPresentation.label)}>
          <VStack gap={2} align="start">
            <VStack gap={0.5}>
              <Text weight="semibold">
                {provider === 'wecom'
                  ? detailCopy.quickWecomTitle
                  : provider === 'qq'
                    ? detailCopy.quickQqTitle
                    : detailCopy.quickTitle}
              </Text>
              <Text type="supporting" color="secondary">
                {provider === 'wecom'
                  ? detailCopy.quickWecomDetail
                  : provider === 'qq'
                    ? detailCopy.quickQqDetail
                    : detailCopy.quickDetail}
              </Text>
            </VStack>
            {provider === 'feishu' ? (
              <SegmentedControl
                className="settingsBotBrandChoice"
                value={feishuBrand}
                label={detailCopy.feishuRegionAria}
                onChange={(value) => setFeishuBrand(value as BotOnboardingBrand)}
              >
                <SegmentedControlItem value="feishu" label={detailCopy.feishu} />
                <SegmentedControlItem value="lark" label="Lark" />
              </SegmentedControl>
            ) : null}
            <Button variant="primary" onClick={() => setScanLoginPhase('mounting')} label={provider === 'wecom' ? detailCopy.beginQuickBind : detailCopy.scanWith(provider === 'feishu' && feishuBrand === 'lark' ? 'Lark' : providerPresentation.label)} />
          </VStack>
        </Card>)
      )}

      {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6` screenshots):
          each platform's fields, labels, placeholders and notices
          rewritten to match the reference design 1:1. The previous
          implementations diverged with technical wording, extra
          fields, and missing TUN-mode amber notices. */}
      {(!quickOnboarding || provider === 'wechat' || setupMode === 'manual') && (
        <BotCredentialFields
          provider={provider}
          channel={channel}
          onUpdateChannel={props.onUpdateChannel}
        />
      )}

      {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e`): WeChat
          personal account integration. Reference design uses ONE
          Bot Token field for the local bridge connection + a
          scan-login affordance. 公众号 (App ID / App Secret) and
          advanced bridge URL stay available behind a collapsed
          「高级设置」section so runtime backward compatibility is
          preserved. */}
      {provider === 'wechat' && (
        <BotWeChatFields channel={channel} updateChannel={props.onUpdateChannel} />
      )}

      {support === 'planned' && (
        <Banner status="info" title={detailCopy.planned} />
      )}
      </SettingsSection>
      {/* WeChat keeps scan login as a first-class action, separate from
          connection testing, because QR generation and listener readiness
          are different states. */}
      {scanLoginPhase !== 'closed' && (
        <BotOnboardingModal
          provider={provider as BotOnboardingProvider}
          brand={provider === 'feishu' ? feishuBrand : undefined}
          isOpen={scanLoginPhase === 'open'}
          onOpenChange={(isOpen) => setScanLoginPhase(isOpen ? 'open' : 'closing')}
          onConnected={async (snapshot) => {
            await props.onReload();
            if (!botDetailMountedRef.current) return;
            await props.onRefreshStatuses();
            if (!botDetailMountedRef.current) return;
            // PR1197 review (P0-3): the bridge may have failed to start even
            // though credentials saved. Reflect that honestly instead of a
            // success toast that overstates the connection.
            if (snapshot.warning) {
              toast.warning(
                detailCopy.credentialsSaved(providerPresentation.label),
                locale === 'zh' ? snapshot.warning : detailCopy.savedButNotConnected,
              );
              return;
            }
            toast.success(
              detailCopy.scanComplete(providerPresentation.label),
              snapshot.identity?.displayName ?? snapshot.identity?.id ?? detailCopy.savedAndConnected,
            );
          }}
        />
      )}
      {wechatQrPhase !== 'closed' && (
        <WechatQrLoginModal
          isOpen={wechatQrPhase === 'open'}
          onOpenChange={(isOpen) => setWechatQrPhase(isOpen ? 'open' : 'closing')}
          onRefreshStatuses={props.onRefreshStatuses}
        />
      )}
    </SettingsPage>
  );
}

/**
 * Per-platform credential form descriptors (#1042). The per-provider
 * credential blocks were structurally identical hand-written JSX branches;
 * the uniform fields are data-driven from this table (like BOT_LABELS).
 * WeChat keeps its bespoke `BotWeChatFields` because of the collapsed
 * advanced section, and `planned` platforms render no fields at all.
 */
type BotCredentialField =
  | {
      kind: 'text' | 'password';
      key: 'token' | 'proxyUrl' | 'appId' | 'appSecret';
      label: string;
      description?: string;
      placeholder: string;
    }
  | {
      kind: 'select';
      key: 'domain';
      label: string;
      defaultValue: string;
      options: ReadonlyArray<readonly [string, string]>;
    }
  | { kind: 'allowed-user-ids' }
  | { kind: 'notice'; text: string };

function botCredentialFields(copy: BotSettingsCopy['detail']): Partial<Record<BotProvider, ReadonlyArray<BotCredentialField>>> {
  return {
  telegram: [
    { kind: 'password', key: 'token', label: 'Telegram Bot Token', placeholder: '123456:ABC-DEF...' },
    { kind: 'notice', text: copy.telegramOfficialFlow },
    {
      kind: 'text',
      key: 'proxyUrl',
      label: copy.telegramProxyAria,
      description: copy.chinaRequired,
      placeholder: 'http://127.0.0.1:7890',
    },
    { kind: 'allowed-user-ids' },
    { kind: 'notice', text: copy.telegramNotice },
  ],
  feishu: [
    { kind: 'text', key: 'appId', label: copy.feishuCredentialId, placeholder: 'cli_xxxx' },
    { kind: 'password', key: 'appSecret', label: copy.feishuSecret, placeholder: 'xxxx' },
    {
      kind: 'select',
      key: 'domain',
      label: copy.feishuDomain,
      defaultValue: 'feishu.cn',
      options: [
        ['feishu.cn', copy.feishuOption],
        ['larksuite.com', 'Lark (larksuite.com)'],
      ],
    },
  ],
  discord: [
    { kind: 'password', key: 'token', label: 'Discord Bot Token', placeholder: 'MTAx...' },
    {
      kind: 'text',
      key: 'proxyUrl',
      label: copy.discordProxyAria,
      description: copy.authOnly,
      placeholder: 'http://127.0.0.1:7890',
    },
    { kind: 'notice', text: copy.discordNotice },
  ],
  dingtalk: [
    { kind: 'text', key: 'appId', label: copy.dingtalkId, placeholder: 'dingxxxxxxxx' },
    { kind: 'password', key: 'appSecret', label: copy.dingtalkSecret, placeholder: 'xxxx' },
  ],
  wecom: [
    { kind: 'text', key: 'appId', label: copy.wecomBotAria, placeholder: copy.wecomBotPlaceholder },
    { kind: 'password', key: 'appSecret', label: copy.wecomSecretAria, placeholder: copy.wecomSecretPlaceholder },
  ],
  qq: [
    { kind: 'text', key: 'appId', label: copy.qqId, placeholder: '102xxxxxx' },
    { kind: 'password', key: 'appSecret', label: 'QQ AppSecret', placeholder: 'xxxx' },
  ],
  slack: [
    { kind: 'password', key: 'token', label: 'Slack Bot Token', placeholder: 'xoxb-…' },
    { kind: 'password', key: 'appSecret', label: 'Slack App-Level Token', placeholder: 'xapp-…' },
  ],
  };
}

function BotCredentialFields(props: {
  provider: BotProvider;
  channel: BotChannelSettings;
  onUpdateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
}) {
  const copy = getBotSettingsCopy(useUiLocale()).detail;
  const fields = botCredentialFields(copy)[props.provider];
  if (!fields) return null;
  return (
    <FormLayout>
      {fields.map((field, index) => {
        switch (field.kind) {
          case 'text':
            return (
              <TextInput
                key={field.key}
                value={props.channel[field.key] ?? ''}
                onChange={(value) => props.onUpdateChannel({ [field.key]: value })}
                placeholder={field.placeholder}
                label={field.label}
                description={field.description}
              />
            );
          case 'password':
            return (
              <PasswordInput
                key={field.key}
                value={props.channel[field.key] ?? ''}
                onChange={(next) => props.onUpdateChannel({ [field.key]: next })}
                placeholder={field.placeholder}
                label={field.label}
                description={field.description}
              />
            );
          case 'select':
            return (
              <Selector
                key={field.key}
                value={props.channel[field.key] ?? field.defaultValue}
                label={field.label}
                options={field.options.map(([value, label]) => ({ value, label }))}
                width="100%"
                onChange={(next) => props.onUpdateChannel({ [field.key]: next })}
              />
            );
          case 'allowed-user-ids':
            return (
              <BotAllowedUserIdsField
                key="allowed-user-ids"
                value={props.channel.allowedUserIds}
                onChange={(next) => props.onUpdateChannel({ allowedUserIds: next })}
              />
            );
          case 'notice':
            return <Banner status="info" key={`notice-${index}`} title={field.text} />;
        }
      })}
    </FormLayout>
  );
}

/**
 * PR-BOT-USER-ALLOWLIST-UI-0 — textarea bound to
 * `BotChannelSettings.allowedUserIds`. Empty / blank lines are stripped;
 * duplicates are dedup'd; entries are trimmed; the list is capped at
 * `MAX_ALLOWED_USER_IDS`. Empty array is forwarded as `undefined` so the
 * settings persist layer sees the "no restriction" default sentinel.
 *
 * Local-only buffer state: the user can type a value mid-edit (e.g.
 * `1234567`) without the in-progress short ID being dropped by the
 * parse function. We only emit the parsed array on commit (onBlur).
 */
function BotAllowedUserIdsField(props: {
  value: ReadonlyArray<string> | undefined;
  onChange(next: ReadonlyArray<string> | undefined): void;
}): ReactNode {
  const locale = useUiLocale();
  const copy = getBotSettingsCopy(locale).detail;
  const persisted = props.value ?? [];
  const [buffer, setBuffer] = useState<string>(persisted.join('\n'));

  // Reset the buffer when the persisted value changes from outside
  // (e.g. settings reload). Compare by join so identity differences
  // do not cause noisy resets.
  useEffect(() => {
    const next = persisted.join('\n');
    if (next !== buffer) {
      setBuffer(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted.join('\n')]);

  const parsed = useMemo(() => parseAllowedUserIdsFromText(buffer), [buffer]);
  const atCap = parsed.length >= MAX_ALLOWED_USER_IDS;
  // PR-BOT-ALLOWLIST-INVALID-ID-WARN-0: Telegram user IDs are decimal
  // integers (e.g. `123456789`). Common mistake is pasting `@alice`
  // (username) instead — that string will persist and silently never
  // match anyone. Surface the invalid entries so the user can fix them.
  // Persistence is NOT enforced here (normalize still accepts any
  // non-empty string) — the gate is informational so a power user
  // tracking a non-Telegram platform later is not blocked.
  const invalidEntries = useMemo(
    () => parsed.filter((id) => !/^[0-9]+$/.test(id)),
    [parsed],
  );

  const commit = (): void => {
    const next = parsed.length === 0 ? undefined : parsed;
    const same =
      (next?.length ?? 0) === persisted.length &&
      (next ?? []).every((id, idx) => id === persisted[idx]);
    if (!same) props.onChange(next);
  };
  const warning = invalidEntries.length > 0
    ? `${copy.invalidUsers(invalidEntries.slice(0, 3).join(locale === 'zh' ? '、' : ', '))}${invalidEntries.length > 3 ? copy.moreInvalid(invalidEntries.length) : ''}`
    : undefined;

  return (
    <TextArea
      value={buffer}
      onChange={(value) => setBuffer(value)}
      onBlur={commit}
      rows={3}
      hasSpellCheck={false}
      placeholder={copy.allowedUsersPlaceholder}
      label={copy.allowedUsersLabel(parsed.length, MAX_ALLOWED_USER_IDS)}
      description={`${copy.allowedUsersHelp}${atCap ? ` ${copy.limitReached}` : ''}`}
      status={warning ? { type: 'warning', message: warning } : undefined}
    />
  );
}

function botConnectionLabel(connection: BotStatus['connection'], locale: 'zh' | 'en'): string {
  const copy = getBotSettingsCopy(locale).status;
  switch (connection) {
    case 'polling': return copy.polling;
    case 'gateway': return copy.gateway;
    case 'webhook': return copy.webhook;
    case 'none': return copy.none;
  }
}
