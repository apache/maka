import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BotOnboardingBrand,
  BotOnboardingProvider,
  BotOnboardingSnapshot,
} from '@maka/core/bot-onboarding';
import { Spinner } from '@astryxdesign/core';
import {
  Button,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { ICON_SIZE, AlertCircle, Check } from '@maka/ui/icons';
import { BotBrandLogo } from './bot-chat-shared';
import { settingsActionErrorMessage } from './settings-error-copy';
import { getBotSettingsCopy, type BotSettingsCopy } from '../locales/settings-bot-copy';

export function BotOnboardingModal(props: {
  provider: BotOnboardingProvider;
  brand?: BotOnboardingBrand;
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  onConnected(snapshot: BotOnboardingSnapshot): void | Promise<void>;
}) {
  const mountedRef = useMountedRef();
  const locale = useUiLocale();
  const onboardingCopy = getBotSettingsCopy(locale).onboarding;
  const [snapshot, setSnapshot] = useState<BotOnboardingSnapshot | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const connectedNotifiedRef = useRef(false);
  // PR1197 review (P2-13): main emits the (large) QR data URL only on the start
  // snapshot; poll snapshots omit it. Cache it here so re-renders driven by
  // subsequent polls keep showing the QR without re-sending it over IPC.
  const qrCacheRef = useRef<string | null>(null);
  const copy = providerCopy(props.provider, props.brand, onboardingCopy);

  const cancelCurrent = useCallback(() => {
    generationRef.current += 1;
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sessionId) {
      void window.maka.settings.bots.onboarding.cancel(sessionId).catch(() => undefined);
    }
  }, []);

  const start = useCallback(async () => {
    cancelCurrent();
    const generation = generationRef.current;
    setStarting(true);
    setError(null);
    setSnapshot(null);
    connectedNotifiedRef.current = false;
    qrCacheRef.current = null;
    try {
      const result = await window.maka.settings.bots.onboarding.start({
        provider: props.provider,
        ...(props.provider === 'feishu' ? { brand: props.brand ?? 'feishu' } : {}),
      });
      if (!mountedRef.current || generation !== generationRef.current) return;
      setStarting(false);
      if (!result.ok) {
        setError(settingsActionErrorMessage(result.error.message, locale));
        return;
      }
      sessionIdRef.current = result.data.sessionId;
      if (result.data.qrCodeDataUrl) qrCacheRef.current = result.data.qrCodeDataUrl;
      setSnapshot(result.data);
    } catch (startError) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setStarting(false);
      setError(settingsActionErrorMessage(startError, locale));
    }
  }, [cancelCurrent, props.provider, props.brand]);

  useEffect(() => {
    void start();
    return cancelCurrent;
  }, [start, cancelCurrent]);

  useEffect(() => {
    const sessionId = snapshot?.sessionId;
    if (!sessionId || !['waiting', 'scanned'].includes(snapshot.state)) return;
    const generation = generationRef.current;
    const delay = Math.max(400, snapshot.nextPollAfterMs);
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.maka.settings.bots.onboarding.poll(sessionId);
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (!result.ok) {
          setError(settingsActionErrorMessage(result.error.message, locale));
          return;
        }
        setSnapshot(result.data);
      } catch (pollError) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setError(settingsActionErrorMessage(pollError, locale));
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    if (snapshot?.state !== 'connected' || connectedNotifiedRef.current) return;
    connectedNotifiedRef.current = true;
    void Promise.resolve(props.onConnected(snapshot)).catch((connectedError) => {
      if (!mountedRef.current || sessionIdRef.current !== snapshot.sessionId) return;
      setError(onboardingCopy.connectedRefreshFailed(settingsActionErrorMessage(connectedError, locale)));
    });
  }, [snapshot, props.onConnected]);

  async function openInBrowser() {
    if (!snapshot) return;
    try {
      const result = await window.maka.settings.bots.onboarding.openInBrowser(snapshot.sessionId);
      if (!mountedRef.current || sessionIdRef.current !== snapshot.sessionId) return;
      if (!result.ok) setError(settingsActionErrorMessage(result.error.message, locale));
    } catch (openError) {
      if (!mountedRef.current || sessionIdRef.current !== snapshot.sessionId) return;
      setError(settingsActionErrorMessage(openError, locale));
    }
  }

  function requestClose() {
    cancelCurrent();
    props.onOpenChange(false);
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) requestClose();
  }

  const status = statusCopy(snapshot, starting, error, copy, locale);
  const qrDataUrl = snapshot?.qrCodeDataUrl ?? qrCacheRef.current;
  const showQr = Boolean(qrDataUrl)
    && snapshot?.state !== 'expired'
    && snapshot?.state !== 'denied'
    && snapshot?.state !== 'error';

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={handleOpenChange}
      className="settingsBotOnboardingModal"
      width={480}
      aria-label={copy.ariaLabel}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            startContent={<BotBrandLogo provider={props.provider} size="large" />}
            title={copy.title}
            subtitle={copy.subtitle}
            onOpenChange={handleOpenChange}
          />
        }
        content={
          <LayoutContent padding={0}>
        <div className="settingsBotOnboardingBody" aria-live="polite">
          <div className="settingsBotOnboardingQrFrame" data-state={snapshot?.state ?? (starting ? 'starting' : 'error')}>
            {showQr ? (
              <img src={qrDataUrl ?? undefined} alt={copy.qrAlt} />
            ) : starting || snapshot?.state === 'connecting' ? (
              <Spinner size="lg" aria-label={onboardingCopy.generatingAria} />
            ) : snapshot?.state === 'connected' ? (
              snapshot.warning ? (
                <span className="settingsBotOnboardingEmpty" aria-hidden="true">
                  <AlertCircle size={ICON_SIZE.plate} />
                </span>
              ) : (
                <span className="settingsBotOnboardingSuccess" aria-hidden="true">
                  <Check size={ICON_SIZE.plate} />
                </span>
              )
            ) : (
              <span className="settingsBotOnboardingEmpty" aria-hidden="true">
                <AlertCircle size={ICON_SIZE.plate} />
              </span>
            )}
          </div>
          <p className="settingsBotOnboardingStatus" data-state={snapshot?.state ?? (error ? 'error' : 'starting')}>
            {status}
          </p>
          <p className="settingsBotOnboardingPrivacy">{onboardingCopy.privacy}</p>
          {snapshot?.canOpenInBrowser && ['waiting', 'scanned'].includes(snapshot.state) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openInBrowser()}
              label={onboardingCopy.openBrowser}
            />
          )}
        </div>
        <div className="settingsBotOnboardingActions">
          {snapshot?.state === 'connected' ? (
            <Button variant="primary" onClick={requestClose} label={onboardingCopy.done} />
          ) : snapshot?.state === 'expired' || snapshot?.state === 'denied' || error ? (
            <Button variant="primary" onClick={() => void start()} label={onboardingCopy.regenerate} />
          ) : (
            <>
              <Button variant="secondary" isDisabled={starting} onClick={() => void start()} label={onboardingCopy.refreshQr} />
              <Button variant="ghost" onClick={requestClose} label={onboardingCopy.cancel} />
            </>
          )}
        </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function providerCopy(
  provider: BotOnboardingProvider,
  brand: BotOnboardingBrand | undefined,
  copy: BotSettingsCopy['onboarding'],
): BotSettingsCopy['onboarding']['providers'][BotOnboardingProvider] {
  if (provider !== 'feishu' || brand !== 'lark') return copy.providers[provider];
  return copy.lark;
}

function statusCopy(
  snapshot: BotOnboardingSnapshot | null,
  starting: boolean,
  error: string | null,
  copy: BotSettingsCopy['onboarding']['providers'][BotOnboardingProvider],
  locale: 'zh' | 'en' = 'zh',
): string {
  const shared = getBotSettingsCopy(locale).onboarding;
  if (starting) return shared.generating;
  if (error) return error;
  switch (snapshot?.state) {
    case 'waiting': return copy.waiting;
    case 'scanned': return copy.scanned;
    case 'connecting': return shared.connecting;
    // PR1197 review (P0-3): honour the honest "saved but not connected" notice
    // instead of claiming a healthy connection.
    case 'connected': return snapshot.warning
      ? (locale === 'zh' ? snapshot.warning : shared.connectedWarning)
      : shared.connected(getBotSettingsCopy(locale).providers[snapshot.provider].label);
    case 'expired': return shared.expired;
    case 'denied': return shared.denied;
    case 'cancelled': return shared.cancelled;
    case 'error': return locale === 'zh' ? (snapshot.error ?? shared.failed) : shared.failed;
    default: return shared.preparing;
  }
}
