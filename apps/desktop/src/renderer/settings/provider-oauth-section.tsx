import { useEffect, useRef, useState } from 'react';
import { Banner, HStack, Text, VStack } from '@astryxdesign/core';
import { type ProviderType } from '@maka/core/llm-connections';
import {
  Badge,
  Button,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy, type ProviderSettingsCopy } from '../locales/settings-provider-copy';
import { ClaudeSubscriptionCard } from './claude-subscription-card';
import {
  useOAuthLoginFlow,
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
  type OAuthLoginFlowBridge,
  type SubscriptionSnapshot,
} from './use-oauth-login-flow';

export type OAuthCardId = 'claude' | 'codex' | 'github-copilot' | 'xai';

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
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const cards = modelOAuthCards(copy);
  const [claudeCatalogEnabled, setClaudeCatalogEnabled] = useState<boolean | null>(null);
  const mountedRef = useMountedRef();
  const refreshTicketRef = useRef(0);
  // PR-OAUTH-CARD-LIVE-STATE-0 (WAWQAQ msg d79fd115 follow-up): before this
  // lift the cards stayed at their static catalog copy even after the user
  // finished the OAuth flow — there was no parent re-fetch. Each service now
  // carries a runtimeState + email so its row can show the account email inline,
  // re-fetched whenever a login step closes (success OR
  // cancel — the user may have signed out from inside it).
  const [cardStates, setCardStates] = useState<Record<OAuthCardId, SubscriptionSnapshot | null>>({
    claude: null,
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
    const claudeGate = await window.maka.claudeSubscription
      .isExperimentalEnabled()
      .then((enabled) => ({ enabled } as const))
      .catch((error: unknown) => ({ error } as const));
    const claudeEnabledForRefresh = 'enabled' in claudeGate
      ? claudeGate.enabled
      : claudeCatalogEnabled === true;
    // Every card the gate allows, not just the ones the current search shows.
    // The catalog keeps its query across navigation now, so filtering here left
    // the cards that were hidden at mount with a null state: clearing the
    // search then revealed signed-in accounts rendering as "可用".
    const cardsToRefresh = cards.filter(
      (card) => card.id !== 'claude' || claudeEnabledForRefresh,
    );
    const results = await Promise.all(
      cardsToRefresh.map(async (card) => {
        try {
          const snapshot = await getSubscriptionSnapshot(card.id);
          return { id: card.id, snapshot } as const;
        } catch (error) {
          return { id: card.id, error } as const;
        }
      }),
    );
    if (!mountedRef.current || refreshTicketRef.current !== ticket) return false;
    if ('enabled' in claudeGate) setClaudeCatalogEnabled(claudeGate.enabled);
    const failures = results.filter((result) => 'error' in result);
    setCardStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if ('snapshot' in result && result.snapshot !== undefined) next[result.id] = result.snapshot;
      }
      return next;
    });
    if ('error' in claudeGate || failures.length > 0) {
      const firstFailure = failures[0];
      const error = 'error' in claudeGate
        ? claudeGate.error
        : firstFailure && 'error' in firstFailure
          ? firstFailure.error
          : undefined;
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
    .filter((card) => card.id !== 'claude' || claudeCatalogEnabled === true)
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
  if (props.cardId === 'claude') return <ClaudeSubscriptionCard />;
  if (props.cardId === 'github-copilot') return <GitHubCopilotLoginPanel />;
  return <SubscriptionLoginPanel service={props.cardId} onLoginSuccess={props.onLoginSuccess} />;
}

/** The subtitle the setup level's header shows above each login panel. */
export function oauthPanelSubtitle(cardId: OAuthCardId, copy: ProviderSettingsCopy['oauthSection']): string {
  if (cardId === 'claude') return copy.claudeSubtitle;
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
    { id: 'claude', providerType: 'claude-subscription', name: 'Claude Code', description: copy.claudeDescription },
    { id: 'codex', providerType: 'openai-codex', name: 'OpenAI Codex', description: copy.codexDescription },
    { id: 'github-copilot', providerType: 'github-copilot', name: 'GitHub Copilot', description: copy.copilotDescription },
    { id: 'xai', providerType: 'xai-oauth', name: 'xAI Grok', description: copy.xaiDescription },
  ];
}

function SubscriptionLoginPanel(props: {
  service: 'codex' | 'xai';
  onLoginSuccess(): void | Promise<void>;
}) {
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
    bridge: (isXai ? window.maka.xaiOAuth : window.maka.openAiCodex) as unknown as OAuthLoginFlowBridge,
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

function GitHubCopilotLoginPanel() {
  const copy = getProviderSettingsCopy(useUiLocale()).oauthSection;
  // The shared login-flow controller owns the snapshot refresh, the
  // synchronous one-shot pending guard, and the unmount safety; Copilot
  // rides it through the direct account flow (one bridge call per action,
  // no browser handoff, no logout confirm) instead of owning a separate
  // pending-action state machine here (#1042).
  const flow = useOAuthLoginFlow({
    bridge: window.maka.githubCopilotSubscription as unknown as OAuthLoginFlowBridge,
    display: { name: 'GitHub Copilot', shortName: 'GitHub Copilot' },
    direct: {
      login: () => window.maka.githubCopilotSubscription.connectExistingLogin(),
      refreshTokens: () => window.maka.githubCopilotSubscription.refreshTokens(),
    },
  });
  const refreshTokens = flow.refreshTokens;
  const loggedIn = flow.state?.runtimeState === 'authenticated' || flow.state?.runtimeState === 'refreshing';
  return (
    <VStack gap={3} data-status={flow.runtimeState}>
      <Text type="body">
        {loggedIn
          ? copy.copilotImported
          : flow.state?.runtimeState === 'refresh_failed' || flow.state?.runtimeState === 'storage_failed'
            ? flow.state.errorMessage
            : copy.copilotSetup}
      </Text>
      <HStack gap={2} hAlign="end">
        <Button variant="primary" onClick={() => void flow.startLogin()} isDisabled={flow.actionBusy} label={flow.pendingAction === 'login' ? copy.importing : loggedIn ? copy.reimport : copy.importCredential} />
        {loggedIn && (
          <>
            <Button variant="secondary" onClick={() => void refreshTokens?.()} isDisabled={flow.actionBusy} label={flow.pendingAction === 'refresh' ? copy.verifying : copy.reverify} />
            <Button variant="ghost" onClick={() => void flow.logout()} isDisabled={flow.actionBusy} label={flow.pendingAction === 'logout' ? copy.removing : copy.removeLocal} />
          </>
        )}
      </HStack>
    </VStack>
  );
}

async function getSubscriptionSnapshot(serviceId: OAuthCardId): Promise<SubscriptionSnapshot> {
  if (serviceId === 'claude') {
    const state = await window.maka.claudeSubscription.getAccountState();
    return {
      runtimeState: state.runtimeState,
      email: state.profile?.email,
      errorMessage: state.errorMessage,
    };
  }
  if (serviceId === 'github-copilot') {
    return window.maka.githubCopilotSubscription.getAccountState();
  }
  if (serviceId === 'xai') {
    return window.maka.xaiOAuth.getAccountState();
  }
  return (await window.maka.openAiCodex.getAccountState()) as SubscriptionSnapshot;
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
