import { useEffect, useRef, useState } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import type { BotChannelSettings } from '@maka/core';
import type { WechatBridgeQrCodeResult } from '@maka/runtime';
import { Alert, AlertDescription, Button, DialogContent, DialogHeader, DialogRoot, Input, useUiLocale } from '@maka/ui';
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
    <>
      <label className="settingsField">
        <span>Bot Token</span>
        <PasswordInput
          value={channel.token}
          onChange={(next) => updateChannel({ token: next })}
          placeholder={copy.tokenPlaceholder}
          ariaLabel={copy.tokenAria}
        />
      </label>
      <div className="settingsBotAdvanced">
        <BaseButton
          type="button"
          className="settingsBotAdvancedToggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
        >
          {advancedOpen ? copy.collapseAdvanced : copy.expandAdvanced}
        </BaseButton>
        {advancedOpen && (
          <div className="settingsBotAdvancedBody">
            <label className="settingsField">
              <span>{copy.bridgeAddress}</span>
              <Input
                value={channel.webhookUrl ?? ''}
                onChange={(event) => updateChannel({ webhookUrl: event.currentTarget.value })}
                placeholder="http://127.0.0.1:18400"
                aria-label={copy.bridgeAria}
              />
            </label>
            <label className="settingsField">
              <span>{copy.appId}</span>
              <Input
                value={channel.appId ?? ''}
                onChange={(event) => updateChannel({ appId: event.currentTarget.value })}
                placeholder={copy.appIdPlaceholder}
                aria-label={copy.appIdAria}
              />
            </label>
            <label className="settingsField">
              <span>{copy.appSecret}</span>
              <PasswordInput
                value={channel.appSecret ?? ''}
                onChange={(next) => updateChannel({ appSecret: next })}
                placeholder={copy.appSecretPlaceholder}
                ariaLabel={copy.appSecretAria}
              />
            </label>
            <Alert variant="info">
              <AlertDescription>{copy.advancedNotice}</AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    </>
  );
}

export function WechatQrLoginModal(props: {
  onClose(): void;
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
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="settingsWechatQrModal"
        aria-labelledby="settingsWechatQrTitle"
        showClose={false}
      >
        <DialogHeader
          title={copy.title}
          titleId="settingsWechatQrTitle"
          subtitle={copy.subtitle}
          closeLabel={copy.close}
          onClose={props.onClose}
        />

        <div className="settingsWechatQrBody">
          {loading ? (
            <div className="settingsWechatQrState" data-tone="loading">
              {copy.generating}
            </div>
          ) : loggedIn ? (
            <div className="settingsWechatQrState" data-tone="success">
              {copy.loggedIn}
            </div>
          ) : expired ? (
            <div className="settingsWechatQrState" data-tone="warning">
              {copy.expired}
              <Button variant="secondary" size="sm" isDisabled={loading} onClick={reloadQrCode} label={loading ? copy.refreshing : copy.refresh} />
            </div>
          ) : qrDataUrl ? (
            <>
              <div className="settingsWechatQrFrame">
                <img src={qrDataUrl} alt={copy.qrAlt} />
              </div>
              <p className="settingsWechatQrCaption">{copy.waiting}</p>
            </>
          ) : error ? (
            <div className="settingsWechatQrState" data-tone="error" role="alert">
              <strong>{error.error}</strong>
              <span>{error.hint}</span>
              <Button variant="secondary" size="sm" isDisabled={loading} onClick={reloadQrCode} label={loading ? copy.retrying : copy.retry} />
            </div>
          ) : (
            <div className="settingsWechatQrState" data-tone="loading">
              {copy.bridgeGenerating}
              <Button variant="secondary" size="sm" isDisabled={loading} onClick={reloadQrCode} label={loading ? copy.fetching : copy.fetchAgain} />
            </div>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
