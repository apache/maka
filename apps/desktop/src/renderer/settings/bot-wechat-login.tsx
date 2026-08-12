import { useEffect, useRef, useState } from 'react';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import type { WechatBridgeQrCodeResult } from '@maka/runtime/bots';
import { Button, EmptyState, FormLayout, Spinner, TextInput, useUiLocale, Banner } from '@maka/ui';
import { ICON_SIZE, MessageSquare } from '@maka/ui/icons';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { PasswordInput } from './password-input';
import { settingsActionErrorMessage } from './settings-error-copy';
import { getBotSettingsCopy } from '../locales/settings-bot-copy';

/**
 * PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e` / `e0ae9de2`):
 * WeChat detail follows the reference design — primary surface is a
 * single Bot Token field for the local bridge, with 公众号 (App ID /
 * App Secret) and the bridge URL tucked into a collapsed "高级设置"
 * section so backend wiring stays intact for users that depend on
 * 公众号 messaging.
 *
 * The Bot Token field maps to `channel.token` (used by wechat-bridge
 * for Bearer auth). Advanced fields keep `appId / appSecret /
 * webhookUrl` so the existing runtime contract continues to work.
 */
export function BotWeChatFields(props: {
  channel: BotChannelSettings;
  updateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
}) {
  const { channel, updateChannel } = props;
  const copy = getBotSettingsCopy(useUiLocale()).wechat;
  const hasAdvanced = Boolean(channel.appId || channel.appSecret || channel.webhookUrl);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(hasAdvanced);
  return (
    <FormLayout>
      <PasswordInput
        value={channel.token}
        onChange={(next) => updateChannel({ token: next })}
        placeholder={copy.tokenPlaceholder}
        label={copy.token}
        isRequired
      />
      <Collapsible
        className="settingsBotAdvanced"
        trigger={advancedOpen ? copy.collapseAdvanced : copy.expandAdvanced}
        isOpen={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
          <FormLayout className="settingsBotAdvancedBody">
            <TextInput
              value={channel.webhookUrl ?? ''}
              onChange={(value) => updateChannel({ webhookUrl: value })}
              placeholder="http://127.0.0.1:18400"
              label={copy.bridgeAddress}
            />
            <TextInput
              value={channel.appId ?? ''}
              onChange={(value) => updateChannel({ appId: value })}
              placeholder={copy.appIdPlaceholder}
              label={copy.appId}
            />
            <PasswordInput
              value={channel.appSecret ?? ''}
              onChange={(next) => updateChannel({ appSecret: next })}
              placeholder={copy.appSecretPlaceholder}
              label={copy.appSecret}
            />
            <Banner status="info" title={copy.advancedNotice} />
          </FormLayout>
      </Collapsible>
    </FormLayout>
  );
}

export function WechatQrLoginModal(props: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  onRefreshStatuses(): void | Promise<unknown>;
}) {
  const locale = useUiLocale();
  const copy = getBotSettingsCopy(locale).wechat;
  const [result, setResult] = useState<WechatBridgeQrCodeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const notifiedLoggedInRef = useRef(false);
  const loadingQrRef = useRef(false);

  function reloadQrCode() {
    if (loadingQrRef.current) return;
    loadingQrRef.current = true;
    setLoading(true);
    setReloadNonce((current) => current + 1);
  }

  useEffect(() => {
    let active = true;
    loadingQrRef.current = true;
    setLoading(true);
    void window.maka.settings.bots.wechatQrCode()
      .then((next) => {
        if (!active) return;
        setResult(next);
        if (next.ok && next.loggedIn && !notifiedLoggedInRef.current) {
          notifiedLoggedInRef.current = true;
          void props.onRefreshStatuses();
        }
      })
      .catch((error) => {
        if (!active) return;
        setResult({
          ok: false,
          error: settingsActionErrorMessage(error, locale),
          hint: copy.readQrFailed,
        });
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          loadingQrRef.current = false;
        }
      });
    return () => {
      active = false;
    };
  }, [reloadNonce]);

  // PR-FE-BUG-HUNT-2 (kenji bug-hunt 2026-06-24 MEDIUM): the previous
  // dep `[result]` re-armed the 3-second polling interval every time
  // the QR refresh produced a new `result` object reference — even
  // when the meaningful state (`ok` / `loggedIn` / `expired`) was
  // unchanged. The interval clock drifted on every refresh,
  // sometimes pushing the next poll 2.9s past the intended cadence.
  // Depend on the gating booleans directly so the interval stays
  // armed continuously while the user is actively scanning.
  const shouldPollQr = !!result?.ok && !result.loggedIn && !result.expired;
  useEffect(() => {
    if (!shouldPollQr) return undefined;
    const interval = window.setInterval(() => {
      reloadQrCode();
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [shouldPollQr]);

  const qrDataUrl = result?.ok ? result.qrcode : null;
  const expired = result?.ok ? result.expired : false;
  const loggedIn = result?.ok ? result.loggedIn : false;
  const error = result && !result.ok ? result : null;

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="settingsWechatQrModal"
      width={480}
      purpose="info"
    >
      <Layout
        header={
          <DialogHeader
            title={copy.title}
            subtitle={copy.subtitle}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={0}>
            {/* Astryx convergence (task #136): the four hand-tinted
                `data-tone` placeholder panes are EmptyState / Spinner now —
                the QR frame keeps its bespoke white plate (a QR code needs a
                light background regardless of theme). */}
            <div className="settingsWechatQrBody">
          {loading ? (
            /* Loading is a wait, not an absence (§10): a page-centred spinner
               with one muted line, never a Spinner in an EmptyState icon slot. */
            (<>
              <Spinner size="lg" />
              <p className="settingsWechatQrCaption">{copy.generating}</p>
            </>)
          ) : loggedIn ? (
            <Banner status="success" title={copy.loggedIn} />
          ) : expired ? (
            /* First-run empties (DESIGN.md §10 tier 3) below; headingLevel 4 is
               derived from the dialog outline — DialogHeader owns the title level. */
            (<EmptyState
              headingLevel={4}
              icon={<MessageSquare size={ICON_SIZE.empty} />}
              title={copy.expired}
              description={copy.expiredHint}
              actions={<Button variant="secondary" size="sm" isDisabled={loading} onClick={reloadQrCode} label={loading ? copy.refreshing : copy.refresh} />}
            />)
          ) : qrDataUrl ? (
            <>
              <div className="settingsWechatQrFrame">
                <img src={qrDataUrl} alt={copy.qrAlt} />
              </div>
              <p className="settingsWechatQrCaption">{copy.waiting}</p>
            </>
          ) : error ? (
            <div role="alert">
              <EmptyState
                headingLevel={4}
                icon={<MessageSquare size={ICON_SIZE.empty} />}
                title={error.error}
                description={error.hint}
                actions={<Button variant="secondary" size="sm" isDisabled={loading} onClick={reloadQrCode} label={loading ? copy.retrying : copy.retry} />}
              />
            </div>
          ) : (
            <EmptyState
              headingLevel={4}
              icon={<MessageSquare size={ICON_SIZE.empty} />}
              title={copy.bridgeGenerating}
              description={copy.bridgeGeneratingHint}
              actions={<Button variant="secondary" size="sm" isDisabled={loading} onClick={reloadQrCode} label={loading ? copy.fetching : copy.fetchAgain} />}
            />
          )}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
