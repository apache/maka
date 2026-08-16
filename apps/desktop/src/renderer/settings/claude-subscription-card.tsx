import { useEffect, useRef, useState } from 'react';
import { type SubscriptionAccountState } from '@maka/core/oauth-subscription';
import { type UiLocale } from '@maka/core/ui-locale';
import { FieldStatus, ProgressBar, StatusDot } from '@astryxdesign/core';
import {
  Banner,
  Button,
  Divider,
  HStack,
  RelativeTime,
  Text,
  TextArea,
  VStack,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { dotForStatus, type StatusSemantic } from '@maka/ui';
import {
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
} from './use-oauth-login-flow';

/**
 * Claude Pro / Max subscription card: the paste-code OAuth flow (browser →
 * copy the `#`-delimited authorization code back) behind the experimental
 * gate. Extracted from provider-oauth-section.tsx (#1042); the browser
 * loopback/PKCE flow used by the other OAuth providers lives in
 * `useOAuthLoginFlow` — Claude deliberately keeps its own card because it
 * needs the manual authorization-code step and the experimental gate.
 */
export function ClaudeSubscriptionCard() {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).claude;
  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean | null>(null);
  const [experimentalGateError, setExperimentalGateError] = useState<string | null>(null);
  const [state, setState] = useState<SubscriptionAccountState | null>(null);
  const [pendingAction, setPendingAction] = useState<ClaudeSubscriptionPendingAction | null>(null);
  const pendingActionRef = useRef<ClaudeSubscriptionPendingAction | null>(null);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const claudeAuthRequestIdRef = useRef<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const toast = useToast();
  // PR-FE-BUG-HUNT-1 (kenji bug-hunt 2026-06-24): ClaudeSubscriptionCard
  // launches a browser OAuth flow that takes seconds-to-minutes to
  // complete. Closing the Settings modal while a `startLogin` /
  // `submitPaste` / `logout` / `refreshQuota` call was in flight
  // would `setState` on an unmounted component (loud warning in dev,
  // masks real bugs in prod). Mirror the `mountedRef` pattern other
  // settings sub-cards in this file use.
  const claudeCardMountedRef = useMountedRef();
  useEffect(() => {
    return () => {
      const pendingAuthRequestId = claudeAuthRequestIdRef.current;
      claudeAuthRequestIdRef.current = null;
      if (pendingAuthRequestId) void window.maka.claudeSubscription.cancelAuthorization(pendingAuthRequestId);
    };
  }, []);

  const refresh = async () => {
    try {
      const next = await window.maka.claudeSubscription.getAccountState();
      if (!claudeCardMountedRef.current) return;
      setState(next);
      setPasteError(null);
    } catch (error) {
      const message = subscriptionActionErrorMessage(error, locale);
      if (!claudeCardMountedRef.current) return;
      toast.error(copy.refreshFailed, message);
      setPasteError(message);
    }
  };

  const refreshExperimentalGate = async () => {
    try {
      const flag = await window.maka.claudeSubscription.isExperimentalEnabled();
      if (!claudeCardMountedRef.current) return;
      setExperimentalEnabled(flag);
      setExperimentalGateError(null);
      if (flag) void refresh();
    } catch (error) {
      const message = subscriptionActionErrorMessage(error, locale);
      if (!claudeCardMountedRef.current) return;
      setExperimentalEnabled(null);
      setExperimentalGateError(message);
      toast.error(copy.gateReadFailed, message);
    }
  };

  useEffect(() => {
    // kenji `1da909d5` blocking concern: Anthropic does not permit
    // third-party developers to offer Claude.ai login on behalf of
    // users. Until product/legal sign-off, gate the whole UI behind
    // `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1`. Loading state also
    // renders nothing — no teasing UI.
    let cancelled = false;
    void window.maka.claudeSubscription
      .isExperimentalEnabled()
      .then((flag) => {
        if (cancelled) return;
        setExperimentalEnabled(flag);
        setExperimentalGateError(null);
        if (flag) void refresh();
      })
      .catch((error) => {
        if (cancelled) return;
        const message = subscriptionActionErrorMessage(error, locale);
        setExperimentalEnabled(null);
        setExperimentalGateError(message);
        toast.error(copy.gateReadFailed, message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (experimentalGateError) {
    // Astryx convergence (task #136): the gate-read failure was a hand-tinted
    // `.settingsConnectionRow[data-status=error]` card; Banner is the one
    // error surface Settings uses now.
    return (
      <Banner
        status="error"
        role="alert"
        title={copy.title}
        description={`${copy.gateUnknown} ${copy.gateError}${experimentalGateError}`}
        endContent={
          <Button
            variant="primary"
            onClick={() => void refreshExperimentalGate()}
            label={copy.retry}
          />
        }
      />
    );
  }

  if (experimentalEnabled !== true) {
    return null;
  }

  function beginPendingAction(action: ClaudeSubscriptionPendingAction): boolean {
    if (pendingActionRef.current !== null) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  }

  function finishPendingAction() {
    pendingActionRef.current = null;
    setPendingAction(null);
  }

  async function startLogin() {
    if (!beginPendingAction('login')) return;
    try {
      // kenji `027c93c0` + xuan `2e5be5a`: getAuthUrl now returns
      // a union — `AuthorizationUrlPayload` on success, or a
      // `SubscriptionActionResult` envelope when fail-closed
      // (e.g. experimental flag flipped off after the card
      // mounted). Discriminate by checking for the `ok` field; the
      // envelope variant has it, the success payload does not.
      const payload = await window.maka.claudeSubscription.getAuthUrl();
      if ('ok' in payload) {
        if (!claudeCardMountedRef.current) return;
        // Envelope variant. `ok: true` shouldn't happen for
        // getAuthUrl (success returns the payload, not an envelope),
        // so this branch is the failure case in practice.
        toast.error(copy.startFailed, payload.ok ? copy.retryLater : subscriptionResultMessage(payload.message, copy.startFailedRetry, locale));
        return;
      }
      claudeAuthRequestIdRef.current = payload.authRequestId;
      if (!claudeCardMountedRef.current) {
        claudeAuthRequestIdRef.current = null;
        void window.maka.claudeSubscription.cancelAuthorization(payload.authRequestId);
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      setPasteValue('');
      setPasteError(null);
      // kenji `1da909d5` hardening: pass the opaque authRequestId,
      // NOT the URL. Main looks up the URL it generated.
      const opened = await window.maka.claudeSubscription.openAuthUrl(payload.authRequestId);
      if (!claudeCardMountedRef.current) return;
      if (!opened.ok) {
        toast.error(copy.openFailed, subscriptionResultMessage(opened.message, copy.openFailedRetry, locale));
        claudeAuthRequestIdRef.current = null;
        void window.maka.claudeSubscription.cancelAuthorization(payload.authRequestId);
        setAuthRequestId(null);
        setStateHint(null);
      }
      await refresh();
    } catch (error) {
      const pendingAuthRequestId = claudeAuthRequestIdRef.current;
      claudeAuthRequestIdRef.current = null;
      if (pendingAuthRequestId) void window.maka.claudeSubscription.cancelAuthorization(pendingAuthRequestId);
      const message = subscriptionActionErrorMessage(error, locale);
      if (!claudeCardMountedRef.current) return;
      setAuthRequestId(null);
      setStateHint(null);
      toast.error(copy.startFailed, message);
      setPasteError(message);
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function submitPaste() {
    if (!authRequestId) return;
    if (!beginPendingAction('submit')) return;
    setPasteError(null);
    try {
      const result = await window.maka.claudeSubscription.completeAuthorization(
        authRequestId,
        pasteValue,
      );
      if (!claudeCardMountedRef.current) return;
      if (result.ok) {
        toast.success(copy.loginSuccess, copy.bound);
        claudeAuthRequestIdRef.current = null;
        setAuthRequestId(null);
        setStateHint(null);
        setPasteValue('');
        await refresh();
      } else {
        setPasteError(subscriptionResultMessage(result.message, copy.submitFailedRetry, locale));
      }
    } catch (error) {
      const message = subscriptionActionErrorMessage(error, locale);
      if (!claudeCardMountedRef.current) return;
      toast.error(copy.submitFailed, message);
      setPasteError(message);
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function cancelLogin() {
    if (!authRequestId) return;
    if (!beginPendingAction('cancel')) return;
    try {
      await window.maka.claudeSubscription.cancelAuthorization(authRequestId);
      if (!claudeCardMountedRef.current) return;
      claudeAuthRequestIdRef.current = null;
      setAuthRequestId(null);
      setStateHint(null);
      setPasteValue('');
      setPasteError(null);
      await refresh();
    } catch (error) {
      if (!claudeCardMountedRef.current) return;
      toast.error(copy.cancelFailed, subscriptionActionErrorMessage(error, locale));
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function logout() {
    if (!beginPendingAction('logout')) return;
    try {
      const ok = await toast.confirm({
        title: copy.logoutTitle,
        description: copy.logoutDescription,
        confirmLabel: copy.logout,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      const result = await window.maka.claudeSubscription.logout();
      if (!claudeCardMountedRef.current) return;
      if (result.ok) {
        toast.success(copy.loggedOut, copy.cleared);
        await refresh();
      } else {
        toast.error(copy.logoutFailed, subscriptionResultMessage(result.message, copy.logoutFailedRetry, locale));
      }
    } catch (error) {
      if (!claudeCardMountedRef.current) return;
      toast.error(copy.logoutFailed, subscriptionActionErrorMessage(error, locale));
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function refreshQuota() {
    if (!beginPendingAction('quota')) return;
    try {
      await window.maka.claudeSubscription.refreshQuota();
      if (!claudeCardMountedRef.current) return;
      await refresh();
    } catch (error) {
      if (!claudeCardMountedRef.current) return;
      toast.error(copy.quotaFailed, subscriptionActionErrorMessage(error, locale));
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  // Closed-state render mapping per the runtime state enum.
  const presentation = state ? presentSubscriptionState(state, locale) : { label: copy.loading, tone: 'neutral' as const, detail: '' };
  const canStartClaudeLogin =
    state?.runtimeState === 'not_logged_in' ||
    state?.runtimeState === 'refresh_failed' ||
    state?.runtimeState === 'storage_failed';
  const claudeLoginPending = authRequestId !== null || state?.runtimeState === 'authorizing';
  const actionBusy = pendingAction !== null;

  // Deep-review fix: this panel renders under ProvidersPanel's RouteHeader,
  // which already says 连接 Claude + subtitle — the SectionHeader + full-width
  // Card + repeated title made it the one OAuth panel with its own chrome.
  // It is a bare VStack now, the same shape as its sibling login panels, and
  // runtime state reads as the shared StatusDot + text idiom.
  return (
    <VStack gap={3}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <span className="settingsStatus">
          <StatusDot variant={dotForStatus(presentation.tone)} label={presentation.label} />
          <span>{presentation.label}</span>
        </span>
        {state?.profile?.email ? (
          <Text type="supporting" color="secondary">{state.profile.email}</Text>
        ) : null}
      </HStack>
      <Text as="p" type="supporting" color="secondary">{presentation.detail}</Text>
      {pasteError && !authRequestId && (
        <div role="alert">
          <FieldStatus type="error" message={pasteError} variant="detached" />
        </div>
      )}

      {state?.quota && (state.quota.fiveHour || state.quota.sevenDay) && (
        <VStack gap={2}>
          {state.quota.fiveHour && (
            <ProgressBar
              label={copy.fiveHour}
              value={state.quota.fiveHour.utilization}
              hasValueLabel
              formatValueLabel={(value) => `${Math.round(value)}%`}
              variant={quotaVariant(state.quota.fiveHour.utilization)}
            />
          )}
          {state.quota.sevenDay && (
            <ProgressBar
              label={copy.sevenDay}
              value={state.quota.sevenDay.utilization}
              hasValueLabel
              formatValueLabel={(value) => `${Math.round(value)}%`}
              variant={quotaVariant(state.quota.sevenDay.utilization)}
            />
          )}
          <Text type="supporting" color="secondary">
            {copy.updated}<RelativeTime ts={state.quota.fetchedAt} />
          </Text>
        </VStack>
      )}

      <HStack gap={2} hAlign="end" wrap="wrap">
        {canStartClaudeLogin || claudeLoginPending ? (
          <Button
            variant="primary"
            onClick={() => void startLogin()}
            isDisabled={actionBusy || claudeLoginPending}
            label={pendingAction === 'login'
              ? copy.openingBrowser
              : claudeLoginPending
              ? copy.loggingIn
              : state?.runtimeState === 'refresh_failed' || state?.runtimeState === 'storage_failed'
                ? copy.relogin
                : copy.loginSubscription}
          />
        ) : (
          <>
            <Button
              variant="primary"
              onClick={() => void refreshQuota()}
              isDisabled={actionBusy}
              label={pendingAction === 'quota' ? copy.refreshing : copy.refreshQuota}
            />
            <Button
              variant="ghost"
              onClick={() => void logout()}
              isDisabled={actionBusy}
              label={pendingAction === 'logout' ? copy.loggingOut : copy.logout}
            />
          </>
        )}
      </HStack>

      {authRequestId && (
        <>
        <Divider />
        <VStack gap={2} role="region" aria-label={copy.pasteAria}>
          <Text as="p">
            {copy.pasteHelpBefore} <code>#</code> {copy.pasteHelpAfter}
          </Text>
          {stateHint && (
            <Text type="supporting" color="secondary">{copy.stateHint} <code>{stateHint}</code> {copy.startsWith}</Text>
          )}
          <TextArea
            value={pasteValue}
            onChange={(value) => setPasteValue(value)}
            placeholder={copy.codePlaceholder}
            label={copy.codeAria}
            rows={3}
            hasSpellCheck={false}
            status={pasteError ? { type: 'error', message: pasteError } : undefined}
          />
          <HStack gap={2} hAlign="end" wrap="wrap">
            <Button
              variant="primary"
              onClick={() => void submitPaste()}
              isDisabled={actionBusy || pasteValue.trim().length === 0}
              label={pendingAction === 'submit' ? copy.submitting : copy.submitCode}
            />
            <Button
              variant="ghost"
              onClick={() => void cancelLogin()}
              isDisabled={actionBusy}
              label={pendingAction === 'cancel' ? copy.cancelling : copy.cancel}
            />
          </HStack>
        </VStack>
        </>
      )}
    </VStack>
  );
}

function quotaVariant(utilization: number): 'accent' | 'warning' | 'error' {
  if (utilization >= 90) return 'error';
  if (utilization >= 75) return 'warning';
  return 'accent';
}

type ClaudeSubscriptionPendingAction = 'login' | 'submit' | 'cancel' | 'logout' | 'quota';

interface SubscriptionStatePresentation {
  label: string;
  tone: StatusSemantic;
  detail: string;
}

function presentSubscriptionState(state: SubscriptionAccountState, locale: UiLocale): SubscriptionStatePresentation {
  const copy = getProviderSettingsCopy(locale).claude;
  switch (state.runtimeState) {
    case 'not_logged_in':
      return { label: copy.signedOut, tone: 'neutral', detail: copy.signedOutDetail };
    case 'authorizing':
      // The system is working right now — one of only two genuine `active` states
      // on this whole surface.
      return { label: copy.authorizing, tone: 'active', detail: copy.authorizingDetail };
    case 'authenticated':
      return {
        label: copy.signedIn,
        tone: 'success',
        detail: copy.signedInDetail,
      };
    case 'refreshing':
      return { label: copy.tokenRefreshing, tone: 'active', detail: copy.tokenRefreshingDetail };
    case 'refresh_failed':
      return {
        label: copy.tokenRefreshFailed,
        tone: 'attention',
        detail: subscriptionResultMessage(state.errorMessage, copy.tokenRefreshFailedDetail, locale),
      };
    case 'storage_failed':
      return {
        label: copy.storageFailed,
        tone: 'attention',
        detail: subscriptionResultMessage(state.errorMessage, copy.storageFailedDetail, locale),
      };
    case 'quota_unavailable':
      return {
        label: copy.quotaUnavailable,
        tone: 'attention',
        detail: subscriptionResultMessage(state.errorMessage, copy.quotaUnavailableDetail, locale),
      };
    case 'provider_rejected':
      return {
        label: copy.providerRejected,
        tone: 'error',
        detail: subscriptionResultMessage(state.errorMessage, copy.providerRejectedDetail, locale),
      };
    default:
      return { label: copy.unknown, tone: 'neutral', detail: '' };
  }
}
