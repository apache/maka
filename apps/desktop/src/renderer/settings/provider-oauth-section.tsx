import { useEffect, useRef, useState } from 'react';
import { Banner, HStack, Text, VStack } from '@astryxdesign/core';
import { type ProviderType } from '@maka/core/llm-connections';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import {
  Badge,
  Button,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy, type ProviderSettingsCopy } from '../locales/settings-provider-copy';
import {
  useOAuthLoginFlow,
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
  type SubscriptionSnapshot,
} from './use-oauth-login-flow';
import { useRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';
import { runtimeHostOAuthLoginBridge } from './runtime-host-settings-bridge.js';

export type OAuthCardId = 'codex' | 'github-copilot' | 'xai';

export interface OAuthCard {
  id: OAuthCardId;
  providerType: ProviderType;
  name: string;
  /** Account email once signed in, the static pitch otherwise. */
  description: string;
  /** A meaningful account state; routine availability stays in the description. */
  status?: string;
  isLoggedIn: boolean;
}

/**
 * Account sign-in rows for the provider catalog, plus the refresh that keeps
 * their badges live.
 *
 * This used to be a self-contained `ModelOAuthSection` that rendered both the
 * rows and a Dialog per service. The rows and the login body are now two
 * levels of the panel's own route, so the hook yields rows and
 * `OAuthLoginPanel` yields the body — no Dialog on either side.
 *
 * The hook lives with the catalog page and dies with it. Coming back from a
 * login remounts it, which re-reads every account state; that is the refresh,
 * and it is why nothing here has to be pushed across a level boundary.
 */
export function useOAuthCards(props: { query?: string }) {
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const cards = modelOAuthCards(copy);
  const mountedRef = useMountedRef();
  const refreshTicketRef = useRef(0);
  // PR-OAUTH-CARD-LIVE-STATE-0 (WAWQAQ msg d79fd115 follow-up): before this
  // lift the cards stayed at their static catalog copy even after the user
  // finished the OAuth flow — there was no parent re-fetch. Each service now
  // carries a runtimeState + email so its row can show the account email inline,
  // re-fetched whenever a login step closes (success OR
  // cancel — the user may have signed out from inside it).
  const [cardStates, setCardStates] = useState<Record<OAuthCardId, SubscriptionSnapshot | null>>({
    codex: null,
    'github-copilot': null,
    xai: null,
  });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';

  function matchesQuery(card: { id: string; name: string; description: string }): boolean {
    if (!normalizedQuery) return true;
    return [card.id, card.name, card.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  }

  async function refreshAllCards() {
    const ticket = refreshTicketRef.current + 1;
    refreshTicketRef.current = ticket;
    const results = await Promise.all(
      cards.map(async (card) => {
        try {
          const snapshot = await getSubscriptionSnapshot(card.id, host);
          return { id: card.id, snapshot } as const;
        } catch (error) {
          return { id: card.id, error } as const;
        }
      }),
    );
    if (!mountedRef.current || refreshTicketRef.current !== ticket) return false;
    const failures = results.filter((result) => 'error' in result);
    setCardStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if ('snapshot' in result && result.snapshot !== undefined) next[result.id] = result.snapshot;
      }
      return next;
    });
    if (failures.length > 0) {
      const firstFailure = failures[0];
      const error = firstFailure && 'error' in firstFailure ? firstFailure.error : undefined;
      const message = error
        ? subscriptionActionErrorMessage(error, locale)
        : copy.serviceUnavailable;
      // Reported once, in the Banner above the rows. This refresh runs on
      // mount, before the user has done anything, so a toast for it would be a
      // second report of a failure they did not ask for.
      setRefreshError(message);
      return false;
    }
    setRefreshError(null);
    return true;
  }

  useEffect(() => {
    void refreshAllCards();
    return () => {
      refreshTicketRef.current += 1;
    };
  }, []);

  const visibleCards: OAuthCard[] = cards
    .filter(matchesQuery)
    .map((card) => {
      const snapshot = cardStates[card.id];
      const runtimeState = snapshot?.runtimeState ?? 'unknown';
      const isLoggedIn =
        runtimeState === 'authenticated' ||
        runtimeState === 'refreshing' ||
        runtimeState === 'quota_unavailable' ||
        runtimeState === 'provider_rejected';
      return {
        id: card.id,
        providerType: card.providerType,
        name: card.name,
        description: isLoggedIn && snapshot?.email ? snapshot.email : card.description,
        ...(isLoggedIn ? { status: copy.signedIn } : {}),
        isLoggedIn,
      };
    });

  return { cards: visibleCards, refreshError };
}

/**
 * The body of one account sign-in, with no Dialog around it. The panel renders
 * this as its setup level; the header and the back affordance belong to that
 * level, the same ones the catalog and the connection detail use.
 */
export function OAuthLoginPanel(props: { cardId: OAuthCardId; onLoginSuccess(): void | Promise<void> }) {
  if (props.cardId === 'github-copilot') {
    return <GitHubCopilotLoginPanel onLoginSuccess={props.onLoginSuccess} />;
  }
  return <SubscriptionLoginPanel service={props.cardId} onLoginSuccess={props.onLoginSuccess} />;
}

/** The subtitle the setup level's header shows above each login panel. */
export function oauthPanelSubtitle(cardId: OAuthCardId, copy: ProviderSettingsCopy['oauthSection']): string {
  if (cardId === 'github-copilot') return copy.copilotSubtitle;
  if (cardId === 'xai') return copy.xaiDetail;
  return copy.codexDetail;
}

function modelOAuthCards(copy: ProviderSettingsCopy['oauthSection']): ReadonlyArray<{
  id: OAuthCardId;
  providerType: ProviderType;
  name: string;
  description: string;
}> {
  return [
    { id: 'codex', providerType: 'openai-codex', name: 'OpenAI Codex', description: copy.codexDescription },
    { id: 'github-copilot', providerType: 'github-copilot', name: 'GitHub Copilot', description: copy.copilotDescription },
    { id: 'xai', providerType: 'xai-oauth', name: 'xAI Grok', description: copy.xaiDescription },
  ];
}

function SubscriptionLoginPanel(props: {
  service: 'codex' | 'xai';
  onLoginSuccess(): void | Promise<void>;
}) {
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const isXai = props.service === 'xai';
  const display: SubscriptionDisplay = isXai
    ? { name: 'xAI Grok', shortName: 'SuperGrok / X Premium', detail: copy.xaiDetail }
    : { name: 'OpenAI Codex', shortName: 'Codex', detail: copy.codexDetail };
  // The whole browser-assisted login/logout controller (getAuthUrl ->
  // openAuthUrl -> refresh -> completeAuthorization, one authRequestId
  // lifecycle, synchronous pending-action guard, cancellation on unmount,
  // localized toast copy) lives in useOAuthLoginFlow so the connection detail
  // page can drive the exact same flow behind its relogin button.
  const flow = useOAuthLoginFlow({
    bridge: runtimeHostOAuthLoginBridge(
      isXai ? window.maka.xaiOAuth : window.maka.openAiCodex,
      host,
    ),
    display: { name: display.name, shortName: display.shortName },
    onLoginSuccess: props.onLoginSuccess,
  });

  return (
    <VStack gap={3} data-status={flow.runtimeState}>
      <Text type="body">{presentSnapshotDetail(flow.state, display, locale)}</Text>
      {!isXai && flow.stateHint && (
        <Text type="supporting" color="secondary">
          {copy.deviceCode} {flow.stateHint}
        </Text>
      )}
      {flow.errorMessage && (
        <Banner status="error" role="alert" title={flow.errorMessage} />
      )}
      <HStack gap={2} hAlign="end">
        {!flow.isLoggedIn ? (
          <Button
            variant="primary"
            onClick={() => void flow.startLogin()}
            isDisabled={flow.actionBusy}
            label={flow.pendingAction === 'login' ? copy.openingBrowser : copy.login(display.shortName)}
          />
        ) : (
          <Button
            variant="ghost"
            onClick={() => void flow.logout()}
            isDisabled={flow.actionBusy}
            label={flow.pendingAction === 'logout' ? copy.loggingOut : copy.logout}
          />
        )}
      </HStack>
    </VStack>
  );
}

function GitHubCopilotLoginPanel(props: { onLoginSuccess(): void | Promise<void> }) {
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const toast = useToast();
  const mountedRef = useMountedRef();
  // The Host owns the device grant, so the panel drives the same browser-
  // assisted controller as Codex and xAI: one attempt at a time, superseded
  // and cancelled by the Host, with the user code arriving as the state hint.
  const flow = useOAuthLoginFlow({
    bridge: runtimeHostOAuthLoginBridge(window.maka.githubCopilotSubscription, host),
    display: { name: 'GitHub Copilot', shortName: 'GitHub Copilot' },
    onLoginSuccess: props.onLoginSuccess,
  });
  // Sign-in is always offered, exactly as Codex and xAI are: the Host owns the
  // enrollment gate and refuses the start with `experimental_disabled`, so the
  // renderer must not carry a second copy of that decision.
  const [directAction, setDirectAction] = useState<'import' | 'refresh' | null>(null);
  const loggedIn = flow.isLoggedIn;
  const actionBusy = flow.actionBusy || directAction !== null;
  // Importing an existing `gh` credential and re-verifying it are single main
  // process calls with no browser handoff, so they run beside the controller
  // rather than through its authRequestId lifecycle.
  const runDirectAction = async (
    action: 'import' | 'refresh',
    call: () => Promise<{ ok: boolean; message?: string }>,
  ) => {
    if (actionBusy) return;
    setDirectAction(action);
    try {
      const result = await call();
      if (!mountedRef.current) return;
      if (!result.ok) {
        toast.error(
          copy.copilotActionFailed,
          subscriptionResultMessage(result.message, copy.copilotActionFailed, locale),
        );
      }
      await flow.refresh();
      if (result.ok && action === 'import' && mountedRef.current) await props.onLoginSuccess();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.copilotActionFailed, subscriptionActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setDirectAction(null);
    }
  };
  return (
    <VStack gap={3} data-status={flow.runtimeState}>
      <Text type="body">
        {loggedIn ? copy.copilotImported : (flow.errorMessage ?? copy.copilotSetup)}
      </Text>
      {flow.stateHint && (
        <Text type="supporting" color="secondary" data-testid="github-copilot-device-code">
          {copy.deviceCode} {flow.stateHint}
        </Text>
      )}
      <HStack gap={2} hAlign="end">
        {!loggedIn && (
          <Button variant="primary" onClick={() => void flow.startLogin()} isDisabled={actionBusy} label={flow.pendingAction === 'login' ? copy.openingBrowser : copy.copilotSignIn} />
        )}
        <Button
          variant="secondary"
          onClick={() => void runDirectAction('import', () => window.maka.githubCopilotSubscription.connectExistingLogin(host))}
          isDisabled={actionBusy}
          label={directAction === 'import' ? copy.importing : loggedIn ? copy.reimport : copy.importCredential}
        />
        {loggedIn && (
          <>
            <Button variant="secondary" onClick={() => void runDirectAction('refresh', () => window.maka.githubCopilotSubscription.refreshTokens(host))} isDisabled={actionBusy} label={directAction === 'refresh' ? copy.verifying : copy.reverify} />
            <Button variant="ghost" onClick={() => void flow.logout()} isDisabled={actionBusy} label={flow.pendingAction === 'logout' ? copy.removing : copy.removeLocal} />
          </>
        )}
      </HStack>
    </VStack>
  );
}

async function getSubscriptionSnapshot(
  serviceId: OAuthCardId,
  host: DesktopRuntimeHostRef,
): Promise<SubscriptionSnapshot> {
  if (serviceId === 'github-copilot') {
    return window.maka.githubCopilotSubscription.getAccountState(host);
  }
  if (serviceId === 'xai') {
    return window.maka.xaiOAuth.getAccountState(host);
  }
  return (await window.maka.openAiCodex.getAccountState(host)) as SubscriptionSnapshot;
}

interface SubscriptionDisplay {
  name: string;
  shortName: string;
  detail: string;
}

function presentSnapshotDetail(state: SubscriptionSnapshot | null, display: SubscriptionDisplay, locale: 'zh' | 'en'): string {
  const copy = getProviderSettingsCopy(locale).oauthSection;
  if (!state) return copy.loadingAccount;
  switch (state.runtimeState) {
    case 'not_logged_in':
      return copy.signedOut(display.name);
    case 'authorizing':
      return copy.authorizing;
    case 'authenticated': {
      const parts = [copy.signedIn];
      if (state.email) parts.push(state.email);
      if (state.plan) parts.push(state.plan);
      return parts.join(' · ');
    }
    case 'refreshing':
      return copy.refreshing;
    case 'refresh_failed':
      return subscriptionResultMessage(state.errorMessage, copy.refreshTokenFailed, locale);
    case 'storage_failed':
      return subscriptionResultMessage(state.errorMessage, copy.storageFailed(display.name), locale);
    case 'quota_unavailable':
    case 'provider_rejected':
      return subscriptionResultMessage(state.errorMessage, copy.providerUnavailable(display.name), locale);
  }
  const _exhaustive: never = state.runtimeState;
  return _exhaustive;
}
