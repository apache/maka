/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef, useState } from 'react';
import { Banner, HStack, Text, VStack } from '@astryxdesign/core';
import { type LlmConnection, type ProviderType } from '@maka/core/llm-connections';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import {
  Badge,
  Button,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';
import {
  getProviderSettingsCopy,
  type ConnectionOAuthProviderBridge,
  type ConnectionsBridge,
  type ProviderSettingsCopy,
} from '../features/connection-settings';
import {
  useOAuthLoginFlow,
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
  type OAuthAuthorizationFlowBridge,
  type OAuthConnectionIdentity,
  type SubscriptionSnapshot,
} from './use-oauth-login-flow';
import {
  RuntimeHostSettingsGenerationBoundary,
  useRuntimeHostSettingsGenerationKey,
} from './runtime-host-settings-target.js';

export type OAuthCardId = 'codex' | 'github-copilot' | 'xai';

export interface OAuthCard {
  id: OAuthCardId;
  providerType: ProviderType;
  name: string;
  /** Enrollment summary, or the singleton Copilot account summary. */
  description: string;
  /** A meaningful account state; routine availability stays in the description. */
  status?: string;
  isLoggedIn: boolean;
}

/**
 * Account enrollment rows for the provider catalog. Every OAuth provider is
 * now a connection-scoped add intent, so each row derives its state from the
 * Connection catalog rather than from a provider-wide account snapshot.
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
export function useOAuthCards(props: {
  query?: string;
  connections: readonly LlmConnection[];
}) {
  const generationKey = useRuntimeHostSettingsGenerationKey();
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const cards = modelOAuthCards(copy);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';

  function matchesQuery(card: { id: string; name: string; description: string }): boolean {
    if (!normalizedQuery) return true;
    return [card.id, card.name, card.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  }

  const visibleCards: OAuthCard[] = cards
    .map((card) => {
      const connectionCount = props.connections.filter(
        (connection) => connection.providerType === card.providerType,
      ).length;
      const isLoggedIn = connectionCount > 0;
      return {
        id: card.id,
        providerType: card.providerType,
        name: card.name,
        description: isLoggedIn ? copy.configuredConnections(connectionCount) : card.description,
        isLoggedIn,
      };
    })
    .filter(matchesQuery);

  return { cards: visibleCards, refreshError: null as string | null };
}

/**
 * The body of one account sign-in, with no Dialog around it. The panel renders
 * this as its setup level; the header and the back affordance belong to that
 * level, the same ones the catalog and the connection detail use.
 */
export function OAuthLoginPanel(props: {
  bridge: ConnectionsBridge;
  cardId: OAuthCardId;
  onLoginSuccess(connection?: OAuthConnectionIdentity): void | Promise<void>;
}) {
  return (
    <RuntimeHostSettingsGenerationBoundary>
      <OAuthLoginPanelForCurrentGeneration {...props} />
    </RuntimeHostSettingsGenerationBoundary>
  );
}

function OAuthLoginPanelForCurrentGeneration(props: {
  bridge: ConnectionsBridge;
  cardId: OAuthCardId;
  onLoginSuccess(connection?: OAuthConnectionIdentity): void | Promise<void>;
}) {
  if (props.cardId === 'github-copilot') {
    return (
      <GitHubCopilotLoginPanel
        bridge={props.bridge}
        onLoginSuccess={props.onLoginSuccess}
      />
    );
  }
  return (
    <SubscriptionLoginPanel
      bridge={props.bridge}
      service={props.cardId}
      onLoginSuccess={props.onLoginSuccess}
    />
  );
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
  bridge: ConnectionsBridge;
  service: 'codex' | 'xai';
  onLoginSuccess(connection: OAuthConnectionIdentity): void | Promise<void>;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).oauthSection;
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
    mode: 'create',
    authorizationBridge: authorizationBridge(
      oauthProviderBridge(props.bridge, isXai ? 'xaiOAuth' : 'openAiCodex'),
      { kind: 'create' },
    ),
    display: { name: display.name, shortName: display.shortName },
    onLoginSuccess: props.onLoginSuccess,
  });

  return (
    <VStack gap={3} data-status={flow.runtimeState}>
      <Text type="body">{display.detail}</Text>
      {flow.authRequestId && (
        <Text type="supporting" color="secondary" role="status" aria-live="polite">
          {!isXai && flow.stateHint
            ? <>{copy.deviceCode} {flow.stateHint}</>
            : copy.waitingAuthorization}
        </Text>
      )}
      {flow.errorMessage && (
        <Banner status="error" role="alert" title={flow.errorMessage} />
      )}
      <HStack gap={2} hAlign="end">
        <Button
          variant="primary"
          onClick={() => void flow.startLogin()}
          isDisabled={flow.actionBusy}
          label={flow.pendingAction === 'login'
            ? flow.authRequestId ? copy.waitingAuthorization : copy.openingBrowser
            : copy.loginAndAdd}
        />
      </HStack>
    </VStack>
  );
}

function GitHubCopilotLoginPanel(props: {
  bridge: ConnectionsBridge;
  onLoginSuccess(connection?: OAuthConnectionIdentity): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  const mountedRef = useMountedRef();
  // Copilot now enrolls through the same Host-owned device grant as Codex and
  // xAI, so it drives the shared browser-assisted controller rather than a
  // Desktop-owned state machine. Importing a credential this machine already
  // holds stays available beside it as the secondary route to the same account.
  const flow = useOAuthLoginFlow({
    mode: 'create',
    authorizationBridge: authorizationBridge(
      oauthProviderBridge(props.bridge, 'githubCopilotSubscription'),
      { kind: 'create' },
    ),
    display: { name: 'GitHub Copilot', shortName: 'GitHub Copilot' },
    onLoginSuccess: props.onLoginSuccess,
  });
  const [importing, setImporting] = useState(false);
  const actionBusy = flow.actionBusy || importing;
  // The Host answers whether Copilot may enrol on this install. Until it does
  // (undefined) sign-in stays offered; once it says no, Import becomes the
  // primary action — a disabled sign-in is not a working primary button.
  const enrollmentDisabled = flow.enrollmentEnabled === false;

  const importLocalCredential = async () => {
    if (actionBusy) return;
    setImporting(true);
    try {
      const oauth = requiredOAuthBridge(props.bridge);
      const result = await oauth.githubCopilotSubscription.connectExistingLogin();
      if (!mountedRef.current) return;
      if (!result.ok) {
        flow.reportError(
          copy.copilotActionFailed,
          subscriptionResultMessage(result.message, copy.copilotActionFailed, locale, result.reason),
        );
        return;
      }
      await props.onLoginSuccess();
    } catch (error) {
      if (mountedRef.current) {
        flow.reportError(copy.copilotActionFailed, subscriptionActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  return (
    <VStack gap={3} data-status={flow.runtimeState}>
      <Text type="body">{copy.copilotSetup}</Text>
      {flow.authRequestId && (
        <Text type="supporting" color="secondary" role="status" aria-live="polite" data-testid="github-copilot-device-code">
          {flow.stateHint ? <>{copy.deviceCode} {flow.stateHint}</> : copy.waitingAuthorization}
        </Text>
      )}
      {flow.errorMessage && <Banner status="error" role="alert" title={flow.errorMessage} />}
      <HStack gap={2} hAlign="end">
        <Button
          variant={enrollmentDisabled ? 'secondary' : 'primary'}
          onClick={() => void flow.startLogin()}
          isDisabled={actionBusy || enrollmentDisabled}
          tooltip={enrollmentDisabled ? copy.copilotSignInDisabledHint : undefined}
          label={flow.pendingAction === 'login'
            ? flow.authRequestId ? copy.waitingAuthorization : copy.openingBrowser
            : copy.copilotSignIn}
        />
        <Button
          variant={enrollmentDisabled ? 'primary' : 'secondary'}
          onClick={() => void importLocalCredential()}
          isDisabled={actionBusy}
          label={importing ? copy.importing : copy.importCredential}
        />
      </HStack>
    </VStack>
  );
}

function requiredOAuthBridge(bridge: ConnectionsBridge) {
  return bridge.oauth;
}

function oauthProviderBridge(
  bridge: ConnectionsBridge,
  provider: 'openAiCodex' | 'xaiOAuth' | 'githubCopilotSubscription',
): ConnectionOAuthProviderBridge {
  return requiredOAuthBridge(bridge)[provider];
}

function authorizationBridge(
  provider: ConnectionOAuthProviderBridge,
  target: { readonly kind: 'create' } | { readonly kind: 'existing'; readonly connectionId: string },
): OAuthAuthorizationFlowBridge {
  return {
    getAuthUrl: () => provider.getAuthUrl(target),
    openAuthUrl: (authRequestId) => provider.openAuthUrl(authRequestId),
    completeAuthorization: (authRequestId) => provider.completeAuthorization(authRequestId),
    cancelAuthorization: (authRequestId) => provider.cancelAuthorization(authRequestId),
    getEnrollmentState: () => provider.getEnrollmentState(),
  };
}

interface SubscriptionDisplay {
  name: string;
  shortName: string;
  detail: string;
}
