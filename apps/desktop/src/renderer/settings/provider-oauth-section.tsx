import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from '@maka/ui/icons';
import {
  type ProviderType,
} from '@maka/core';
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy, type ProviderSettingsCopy } from '../locales/settings-provider-copy';
import { ProviderLogo } from './provider-display';
import { ProviderConnectionDialog } from './provider-connection-dialog';
import { ClaudeSubscriptionCard } from './claude-subscription-card';
import {
  useOAuthLoginFlow,
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
  type OAuthLoginFlowBridge,
  type SubscriptionSnapshot,
} from './use-oauth-login-flow';

type OAuthCardId = 'claude' | 'codex' | 'github-copilot' | 'xai';
type OAuthServiceId = OAuthCardId;

interface ModelOAuthCard {
  id: OAuthCardId;
  providerType: ProviderType;
  name: string;
  description: string;
  status: 'available';
  statusLabel: string;
}

export function ModelOAuthSection(props: { query?: string; onConnectionsChanged(): Promise<void> }) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const cards = modelOAuthCards(copy);
  const [openModal, setOpenModal] = useState<OAuthServiceId | null>(null);
  const [claudeCatalogEnabled, setClaudeCatalogEnabled] = useState<boolean | null>(null);
  const toast = useToast();
  const modelOAuthMountedRef = useMountedRef();
  const modelOAuthRefreshTicketRef = useRef(0);
  // PR-OAUTH-CARD-LIVE-STATE-0 (WAWQAQ msg d79fd115 follow-up):
  // before this lift the 3 button cards stayed at the static
  // "可用 / 预览" label even after the user finished the OAuth
  // flow in the modal — there was no parent re-fetch. We now
  // track a runtimeState + email per service so each card can
  // show "已登录" / the account email inline, and we re-fetch
  // every time the modal closes (success OR cancel — the user
  // may have logged out from inside the modal).
  const [cardStates, setCardStates] = useState<Record<OAuthServiceId, SubscriptionSnapshot | null>>({
    claude: null,
    codex: null,
    'github-copilot': null,
    xai: null,
  });
  const [cardRefreshError, setCardRefreshError] = useState<string | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';
  const visibleCards = cards
    .filter((card) => card.id !== 'claude' || claudeCatalogEnabled === true)
    .filter((card) => !normalizedQuery || [card.id, card.name, card.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));

  async function refreshAllCards() {
    const ticket = modelOAuthRefreshTicketRef.current + 1;
    modelOAuthRefreshTicketRef.current = ticket;
    const claudeGate = await window.maka.claudeSubscription
      .isExperimentalEnabled()
      .then((enabled) => ({ enabled } as const))
      .catch((error: unknown) => ({ error } as const));
    const claudeEnabledForRefresh = 'enabled' in claudeGate
      ? claudeGate.enabled
      : claudeCatalogEnabled === true;
    const cardsToRefresh = cards
      .filter((card) => card.id !== 'claude' || claudeEnabledForRefresh)
      .filter((card) => !normalizedQuery || [card.id, card.name, card.description]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
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
    if (!modelOAuthMountedRef.current || modelOAuthRefreshTicketRef.current !== ticket) return false;
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
      setCardRefreshError(message);
      toast.error(copy.refreshFailed, message);
      return false;
    }
    setCardRefreshError(null);
    return true;
  }

  async function refreshAfterOAuthChange() {
    const refreshed = await refreshAllCards();
    if (!modelOAuthMountedRef.current || !refreshed) return;
    try {
      await props.onConnectionsChanged();
    } catch (error) {
      if (!modelOAuthMountedRef.current) return;
      toast.error(copy.refreshConnectionsFailed, subscriptionActionErrorMessage(error, locale));
    }
  }

  useEffect(() => {
    void refreshAllCards();
    return () => {
      modelOAuthRefreshTicketRef.current += 1;
    };
  }, []);

  return (
    <div className="providerOAuthCatalog" aria-label={copy.aria} data-provider-category="oauth">
      {cardRefreshError && (
        <div className="providerOAuthError" role="alert">
          {copy.staleState}{cardRefreshError}
        </div>
      )}
      <div className="providerOAuthGrid">
        {visibleCards.map((card) => {
          const snapshot = cardStates[card.id];
          const runtimeState = snapshot?.runtimeState ?? 'unknown';
          const isLoggedIn =
            runtimeState === 'authenticated' ||
            runtimeState === 'refreshing' ||
            runtimeState === 'quota_unavailable' ||
            runtimeState === 'provider_rejected';
          const liveBadge = isLoggedIn ? copy.signedIn : card.statusLabel;
          const liveDescription = isLoggedIn && snapshot?.email
            ? snapshot.email
            : card.description;
          return (
            <Item
              key={card.id}
              className="providerCatalogRow providerOAuthCard"
              data-card-id={card.id}
              data-provider={card.providerType}
              data-status="ready"
              data-oauth-status={card.status}
              data-logged-in={isLoggedIn ? 'true' : undefined}
              aria-label={copy.cardAria(card.name, liveBadge, liveDescription)}
              render={<button type="button" onClick={() => setOpenModal(card.id)} />}
            >
              <ItemMedia>
                <ProviderLogo type={card.providerType} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="providerCatalogTitle">{card.name}</ItemTitle>
                <ItemDescription className="providerCatalogDesc providerOAuthCardDescription">{liveDescription}</ItemDescription>
              </ItemContent>
              <ItemActions className="providerCatalogActions">
                <span className="providerCatalogBadge providerOAuthCardBadge">{liveBadge}</span>
                <ChevronRight className="providerCatalogChevron" size={15} aria-hidden="true" />
              </ItemActions>
            </Item>
          );
        })}
      </div>
      {openModal === 'claude' && (
        <ClaudeSubscriptionModal
          onClose={() => {
            setOpenModal(null);
            void refreshAfterOAuthChange();
          }}
        />
      )}
      {openModal === 'github-copilot' && (
        <GitHubCopilotSubscriptionModal
          onClose={() => {
            setOpenModal(null);
            void refreshAfterOAuthChange();
          }}
        />
      )}
      {openModal === 'codex' && (
        <SubscriptionLoginModal
          service="codex"
          onLoginSuccess={refreshAfterOAuthChange}
          onClose={() => {
            setOpenModal(null);
            // Always re-fetch after the modal closes — the user may
            // have logged in, logged out, or cancelled.
            void refreshAfterOAuthChange();
          }}
        />
      )}
      {openModal === 'xai' && (
        <SubscriptionLoginModal
          service="xai"
          onLoginSuccess={refreshAfterOAuthChange}
          onClose={() => {
            setOpenModal(null);
            void refreshAfterOAuthChange();
          }}
        />
      )}
    </div>
  );
}

function modelOAuthCards(copy: ProviderSettingsCopy['oauthSection']): ReadonlyArray<ModelOAuthCard> {
  return [
    { id: 'claude', providerType: 'claude-subscription', name: 'Claude Code', description: copy.claudeDescription, status: 'available', statusLabel: copy.available },
    { id: 'codex', providerType: 'openai-codex', name: 'OpenAI Codex', description: copy.codexDescription, status: 'available', statusLabel: copy.available },
    { id: 'github-copilot', providerType: 'github-copilot', name: 'GitHub Copilot', description: copy.copilotDescription, status: 'available', statusLabel: copy.available },
    { id: 'xai', providerType: 'xai-oauth', name: 'xAI Grok', description: copy.xaiDescription, status: 'available', statusLabel: copy.available },
  ];
}

function ClaudeSubscriptionModal(props: { onClose(): void }) {
  const copy = getProviderSettingsCopy(useUiLocale()).oauthSection;
  return (
    <ProviderConnectionDialog
      title={copy.claudeTitle}
      subtitle={copy.claudeSubtitle}
      providerType="claude-subscription"
      onClose={props.onClose}
    >
      <ClaudeSubscriptionCard />
    </ProviderConnectionDialog>
  );
}

function SubscriptionLoginModal(props: {
  service: 'codex' | 'xai';
  onClose(): void;
  onLoginSuccess(): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const isXai = props.service === 'xai';
  const display: SubscriptionDisplay = isXai
    ? {
        name: 'xAI Grok',
        shortName: 'SuperGrok / X Premium',
        detail: copy.xaiDetail,
      }
    : {
        name: 'OpenAI Codex',
        shortName: 'Codex',
        detail: copy.codexDetail,
      };
  // The whole browser-loopback login/logout controller (getAuthUrl ->
  // openAuthUrl -> refresh -> completeAuthorization, one authRequestId
  // lifecycle, synchronous pending-action guard, cancellation on unmount,
  // localized toast copy) lives in useOAuthLoginFlow so the model connection
  // connection dialog can drive the exact same flow behind its relogin button.
  const flow = useOAuthLoginFlow({
    bridge: (isXai ? window.maka.xaiOAuth : window.maka.openAiCodex) as unknown as OAuthLoginFlowBridge,
    display: { name: display.name, shortName: display.shortName },
    onLoginSuccess: props.onLoginSuccess,
  });

  return (
    <ProviderConnectionDialog
      title={copy.connectTitle(display.name)}
      subtitle={display.detail}
      providerType={isXai ? 'xai-oauth' : 'openai-codex'}
      onClose={props.onClose}
    >
        <div className="settingsConnectionRow" data-status={flow.runtimeState}>
          <p className="settingsConnectionDetail">
            {presentSnapshotDetail(flow.state, display, locale)}
          </p>
          {flow.stateHint && (
            <small>
              {isXai ? copy.deviceCode : copy.stateHint}{' '}
              <code>{flow.stateHint}</code>{' '}
              {isXai ? null : copy.startsWith}
            </small>
          )}
          {flow.errorMessage && (
            <small className="settingsErrorText">{flow.errorMessage}</small>
          )}
          <div className="settingsConnectionActions">
            {!flow.isLoggedIn ? (
              <Button
                type="button"
                onClick={() => void flow.startLogin()}
                disabled={flow.actionBusy}
              >
                {flow.pendingAction === 'login' ? copy.openingBrowser : copy.login(display.shortName)}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void flow.logout()}
                disabled={flow.actionBusy}
              >
                {flow.pendingAction === 'logout' ? copy.loggingOut : copy.logout}
              </Button>
            )}
          </div>
        </div>
    </ProviderConnectionDialog>
  );
}

async function getSubscriptionSnapshot(serviceId: OAuthServiceId): Promise<SubscriptionSnapshot> {
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

function GitHubCopilotSubscriptionModal(props: { onClose(): void }) {
  const copy = getProviderSettingsCopy(useUiLocale()).oauthSection;
  // The shared login-flow controller owns the snapshot refresh, the
  // synchronous one-shot pending guard, and the unmount safety; Copilot
  // rides it through the direct account flow (one bridge call per action,
  // no browser loopback, no logout confirm) instead of owning a separate
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
    <ProviderConnectionDialog
      title={copy.copilotTitle}
      subtitle={copy.copilotSubtitle}
      providerType="github-copilot"
      onClose={props.onClose}
    >
      <div className="settingsConnectionRow" data-status={flow.runtimeState}>
        <p className="settingsConnectionDetail">
          {loggedIn
            ? copy.copilotImported
            : flow.state?.runtimeState === 'refresh_failed' || flow.state?.runtimeState === 'storage_failed'
              ? flow.state.errorMessage
              : copy.copilotSetup}
        </p>
        <div className="settingsConnectionActions">
          <Button type="button" onClick={() => void flow.startLogin()} disabled={flow.actionBusy}>
            {flow.pendingAction === 'login' ? copy.importing : loggedIn ? copy.reimport : copy.importCredential}
          </Button>
          {loggedIn && (
            <>
              <Button type="button" variant="secondary" onClick={() => void refreshTokens?.()} disabled={flow.actionBusy}>
                {flow.pendingAction === 'refresh' ? copy.verifying : copy.reverify}
              </Button>
              <Button type="button" variant="ghost" onClick={() => void flow.logout()} disabled={flow.actionBusy}>
                {flow.pendingAction === 'logout' ? copy.removing : copy.removeLocal}
              </Button>
            </>
          )}
        </div>
      </div>
    </ProviderConnectionDialog>
  );
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
