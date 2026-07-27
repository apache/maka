import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft } from '@maka/ui/icons';
import {
  BOT_ONBOARDING_PROVIDERS,
  type BotChannelSettings,
  type BotOnboardingBrand,
  type BotOnboardingProvider,
  type BotProvider,
  type BotReadinessState,
} from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { MAX_ALLOWED_USER_IDS, parseAllowedUserIdsFromText } from '@maka/core/settings';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  BOT_BRAND,
  Button,
  Chip,
  Input,
  RelativeTime,
  Segmented,
  SettingsSelect,
  SettingsSwitch as Switch,
  Textarea,
  useMountedRef,
  useToast,
  useUiLocale,
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

function canEnableBotChannel(readiness: BotReadinessState): boolean {
  return readiness === 'credentials_valid' || readiness === 'operational' || readiness === 'degraded';
}

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
  const [scanLoginOpen, setScanLoginOpen] = useState(Boolean(props.autoOpenScanLogin));
  const [wechatQrOpen, setWechatQrOpen] = useState(false);
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
  const qrOnlyOnboarding = provider === 'wechat' || provider === 'whatsapp';
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

  return (
    <div className="settingsRemoteAccessDetail">
      <Button
        type="button"
        variant="quiet"
        className="settingsRemoteAccessBack"
        aria-label={detailCopy.back}
        disabled={props.actionBusy}
        onClick={props.onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {detailCopy.back}
      </Button>
      <section className="settingsBotDetail">
        <header className="settingsBotDetailHeader" data-support={support}>
          <BotBrandLogo provider={provider} size="large" />
          <div className="settingsBotDetailHeaderBody">
            <h3>
              {providerPresentation.label}
              <Chip dot size="sm" variant={readinessCopy.tone}>{readinessCopy.label}</Chip>
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
            ariaLabel={detailCopy.enableAria(providerPresentation.label)}
            ariaDescribedBy={enableSwitchHint ? enableSwitchHintId : undefined}
            checked={channel.enabled}
            onChange={(enabled) => props.onUpdateChannel({ enabled })}
            disabled={enableSwitchDisabled || props.actionBusy}
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

        <section className="settingsBotRuntime" aria-labelledby="settings-bot-runtime-heading">
          <div className="settingsBotRuntimeHeader">
            <div>
              <h4 id="settings-bot-runtime-heading">{viewState.liveOperational ? detailCopy.listening : readinessCopy.label}</h4>
              <p>{viewState.liveOperational ? detailCopy.healthy : readinessCopy.detail}</p>
            </div>
            <div className="settingsBotActionStack" role="group" aria-label={detailCopy.actionsAria(providerPresentation.label)}>
              {inQuickOnboarding ? (
                <>
                  <Button type="button" disabled={props.actionBusy} onClick={() => setScanLoginOpen(true)}>
                    {provider === 'wecom' ? detailCopy.quickBind : provider === 'wechat' ? detailCopy.scanLogin : detailCopy.scanConnect}
                  </Button>
                  {(
                    (provider === 'wechat' && (channel.token || status?.identity))
                    || (provider === 'whatsapp' && channel.sessionConfigured)
                  ) && (
                    <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => void props.onDisconnectSession()}>
                      {props.pendingAction === 'disconnect'
                        ? detailCopy.disconnecting
                        : provider === 'whatsapp'
                          ? detailCopy.disconnectWhatsapp
                          : detailCopy.disconnectWechat}
                    </Button>
                  )}
                  {provider === 'wechat' && (
                    <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => setWechatQrOpen(true)}>
                      {detailCopy.bridgeQr}
                    </Button>
                  )}
                  <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => void props.onTest()}>
                    {props.pendingAction === 'test' ? detailCopy.testing : detailCopy.test}
                  </Button>
                </>
              ) : support === 'runtime' && !status?.running ? (
                <Button type="button" disabled={props.actionBusy} onClick={() => void props.onTestAndConnect()}>
                  {props.pendingAction === 'connect' ? detailCopy.connecting : detailCopy.testAndConnect}
                </Button>
              ) : (
                <Button type="button" variant="secondary" disabled={props.actionBusy || support === 'planned'} onClick={() => void props.onTest()}>
                  {props.pendingAction === 'test' ? detailCopy.testing : support === 'runtime' ? detailCopy.test : detailCopy.testAndConnect}
                </Button>
              )}
              {support === 'runtime' && (status?.running || props.restarting) && provider !== 'wechat' && (
                <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => void props.onRestart()}>
                  {props.restarting ? detailCopy.restarting : detailCopy.restart}
                </Button>
              )}
            </div>
          </div>

          <dl className="settingsBotStatusGrid" aria-label={detailCopy.runtimeAria(providerPresentation.label)}>
            <div><dt>{detailCopy.identity}</dt><dd>{status?.identity?.username ?? status?.identity?.displayName ?? detailCopy.unknownIdentity}</dd></div>
            <div><dt>{detailCopy.connectionType}</dt><dd>{botConnectionLabel(status?.connection ?? 'none', locale)}</dd></div>
            <div><dt>{detailCopy.lastEvent}</dt><dd>{status?.lastEventAt ? <RelativeTime ts={status.lastEventAt} className="settingsBotMetaTime" /> : detailCopy.noneYet}</dd></div>
            <div><dt>{detailCopy.lastTest}</dt><dd>{channel.lastTestAt ? <RelativeTime ts={channel.lastTestAt} className="settingsBotMetaTime" /> : detailCopy.neverTested}</dd></div>
          </dl>
        </section>

        {props.statusLoadError && (
          <Alert variant="error">
            <AlertTitle>{detailCopy.statusRefreshFailed}</AlertTitle>
            <AlertDescription>{props.statusLoadError}</AlertDescription>
          </Alert>
        )}
        {status?.reason && channel.enabled && !viewState.liveOperational && (
          <Alert variant="warning">
            <AlertTitle>{botStatusDetail(status, locale)}</AlertTitle>
            <AlertDescription>{readinessCopy.detail}</AlertDescription>
          </Alert>
        )}
        {viewState.currentError && support !== 'planned' && (
          <Alert variant="error">
            <AlertTitle>{detailCopy.latestFailure}</AlertTitle>
            <AlertDescription>{locale === 'zh' ? viewState.currentError : detailCopy.latestFailureDetail}</AlertDescription>
          </Alert>
        )}

        <div className="settingsBotConfigurationHeader">
          <h4>{quickOnboarding && !qrOnlyOnboarding ? detailCopy.setupMethod : detailCopy.connectionSettings}</h4>
          <span>{quickOnboarding ? detailCopy.localCredentials : detailCopy.autosave}</span>
        </div>

        {quickOnboarding && !qrOnlyOnboarding && (
          <Segmented<'quick' | 'manual'>
            className="settingsBotSetupModes"
            value={setupMode}
            ariaLabel={detailCopy.setupAria(providerPresentation.label)}
            options={[
              ['quick', detailCopy.quickRecommended],
              ['manual', detailCopy.manual],
            ]}
            onChange={setSetupMode}
          />
        )}

        {quickOnboarding && provider !== 'wechat' && (provider === 'whatsapp' || setupMode === 'quick') && (
          <section className="settingsBotQuickSetup" aria-label={detailCopy.quickAria(providerPresentation.label)}>
            <div>
              <strong>
                {provider === 'wecom'
                  ? detailCopy.quickWecomTitle
                  : provider === 'qq'
                    ? detailCopy.quickQqTitle
                    : provider === 'whatsapp'
                      ? detailCopy.quickWhatsappTitle
                      : detailCopy.quickTitle}
              </strong>
              <p>
                {provider === 'wecom'
                  ? detailCopy.quickWecomDetail
                  : provider === 'qq'
                    ? detailCopy.quickQqDetail
                    : provider === 'whatsapp'
                      ? detailCopy.quickWhatsappDetail
                      : detailCopy.quickDetail}
              </p>
            </div>
            {provider === 'feishu' ? (
              <Segmented<BotOnboardingBrand>
                className="settingsBotBrandChoice"
                value={feishuBrand}
                ariaLabel={detailCopy.feishuRegionAria}
                options={[
                  ['feishu', detailCopy.feishu],
                  ['lark', 'Lark'],
                ]}
                onChange={setFeishuBrand}
              />
            ) : null}
            <Button type="button" onClick={() => setScanLoginOpen(true)}>
              {provider === 'wecom' ? detailCopy.beginQuickBind : detailCopy.scanWith(provider === 'feishu' && feishuBrand === 'lark' ? 'Lark' : providerPresentation.label)}
            </Button>
          </section>
        )}

        {provider === 'whatsapp' && (
          <Alert variant="warning">
            <AlertDescription>{detailCopy.whatsappProtocolNotice}</AlertDescription>
          </Alert>
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
          <Alert variant="passive">
            <AlertDescription>{detailCopy.planned}</AlertDescription>
          </Alert>
        )}

        {/* WeChat keeps scan login as a first-class action, separate from
            connection testing, because QR generation and listener readiness
            are different states. */}
        {scanLoginOpen && (
          <BotOnboardingModal
            provider={provider as BotOnboardingProvider}
            brand={provider === 'feishu' ? feishuBrand : undefined}
            onClose={() => setScanLoginOpen(false)}
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
        {wechatQrOpen && (
          <WechatQrLoginModal
            onClose={() => setWechatQrOpen(false)}
            onRefreshStatuses={props.onRefreshStatuses}
          />
        )}
      </section>
    </div>
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
      label: ReactNode;
      placeholder: string;
      ariaLabel: string;
    }
  | {
      kind: 'select';
      key: 'domain';
      label: ReactNode;
      ariaLabel: string;
      defaultValue: string;
      options: ReadonlyArray<readonly [string, string]>;
    }
  | { kind: 'allowed-user-ids' }
  | { kind: 'notice'; text: string };

function botCredentialFields(copy: BotSettingsCopy['detail']): Partial<Record<BotProvider, ReadonlyArray<BotCredentialField>>> {
  return {
  telegram: [
    { kind: 'password', key: 'token', label: 'Bot Token', placeholder: '123456:ABC-DEF...', ariaLabel: 'Telegram Bot Token' },
    { kind: 'notice', text: copy.telegramOfficialFlow },
    {
      kind: 'text',
      key: 'proxyUrl',
      label: <>{copy.proxy} <em className="settingsFieldHint">{copy.chinaRequired}</em></>,
      placeholder: 'http://127.0.0.1:7890',
      ariaLabel: copy.telegramProxyAria,
    },
    { kind: 'allowed-user-ids' },
    { kind: 'notice', text: copy.telegramNotice },
  ],
  feishu: [
    { kind: 'text', key: 'appId', label: 'App ID', placeholder: 'cli_xxxx', ariaLabel: copy.feishuCredentialId },
    { kind: 'password', key: 'appSecret', label: 'App Secret', placeholder: 'xxxx', ariaLabel: copy.feishuSecret },
    {
      kind: 'select',
      key: 'domain',
      label: copy.domain,
      ariaLabel: copy.feishuDomain,
      defaultValue: 'feishu.cn',
      options: [
        ['feishu.cn', copy.feishuOption],
        ['larksuite.com', 'Lark (larksuite.com)'],
      ],
    },
  ],
  discord: [
    { kind: 'password', key: 'token', label: 'Bot Token', placeholder: 'MTAx...', ariaLabel: 'Discord Bot Token' },
    {
      kind: 'text',
      key: 'proxyUrl',
      label: <>{copy.proxy} <em className="settingsFieldHint">{copy.authOnly}</em></>,
      placeholder: 'http://127.0.0.1:7890',
      ariaLabel: copy.discordProxyAria,
    },
    { kind: 'notice', text: copy.discordNotice },
  ],
  dingtalk: [
    { kind: 'text', key: 'appId', label: 'Client ID (AppKey)', placeholder: 'dingxxxxxxxx', ariaLabel: copy.dingtalkId },
    { kind: 'password', key: 'appSecret', label: 'Client Secret (AppSecret)', placeholder: 'xxxx', ariaLabel: copy.dingtalkSecret },
  ],
  wecom: [
    { kind: 'text', key: 'appId', label: 'Bot ID', placeholder: copy.wecomBotPlaceholder, ariaLabel: copy.wecomBotAria },
    { kind: 'password', key: 'appSecret', label: 'Secret', placeholder: copy.wecomSecretPlaceholder, ariaLabel: copy.wecomSecretAria },
  ],
  qq: [
    { kind: 'text', key: 'appId', label: 'AppID', placeholder: '102xxxxxx', ariaLabel: copy.qqId },
    { kind: 'password', key: 'appSecret', label: 'AppSecret', placeholder: 'xxxx', ariaLabel: 'QQ AppSecret' },
  ],
  slack: [
    { kind: 'password', key: 'token', label: 'Bot Token', placeholder: 'xoxb-…', ariaLabel: 'Slack Bot Token' },
    { kind: 'password', key: 'appSecret', label: 'App-Level Token', placeholder: 'xapp-…', ariaLabel: 'Slack App-Level Token' },
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
    <>
      {fields.map((field, index) => {
        switch (field.kind) {
          case 'text':
            return (
              <label key={field.key} className="settingsField">
                <span>{field.label}</span>
                <Input
                  value={props.channel[field.key] ?? ''}
                  onChange={(event) => props.onUpdateChannel({ [field.key]: event.currentTarget.value })}
                  placeholder={field.placeholder}
                  aria-label={field.ariaLabel}
                />
              </label>
            );
          case 'password':
            return (
              <label key={field.key} className="settingsField">
                <span>{field.label}</span>
                <PasswordInput
                  value={props.channel[field.key] ?? ''}
                  onChange={(next) => props.onUpdateChannel({ [field.key]: next })}
                  placeholder={field.placeholder}
                  ariaLabel={field.ariaLabel}
                />
              </label>
            );
          case 'select':
            return (
              <label key={field.key} className="settingsField">
                <span>{field.label}</span>
                <SettingsSelect
                  value={props.channel[field.key] ?? field.defaultValue}
                  ariaLabel={field.ariaLabel}
                  options={field.options}
                  onChange={(next) => props.onUpdateChannel({ [field.key]: next })}
                />
              </label>
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
            return (
              <Alert key={`notice-${index}`} variant="info">
                <AlertDescription>{field.text}</AlertDescription>
              </Alert>
            );
        }
      })}
    </>
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

  return (
    <label className="settingsField">
      <span>{copy.allowedUsersLabel(parsed.length, MAX_ALLOWED_USER_IDS)}</span>
      <Textarea
        value={buffer}
        onChange={(event) => setBuffer(event.currentTarget.value)}
        onBlur={commit}
        rows={3}
        spellCheck={false}
        placeholder={copy.allowedUsersPlaceholder}
        aria-label={copy.allowedUsersAria}
      />
      <small>
        {copy.allowedUsersHelp}
        {atCap && <strong>{copy.limitReached}</strong>}
        {invalidEntries.length > 0 && (
          <span className="settingsFieldWarning" data-tone="warning">
            {copy.invalidUsers(invalidEntries.slice(0, 3).join(locale === 'zh' ? '、' : ', '))}
            {invalidEntries.length > 3 && copy.moreInvalid(invalidEntries.length)}
          </span>
        )}
      </small>
    </label>
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
