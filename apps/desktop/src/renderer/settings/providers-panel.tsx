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

import { useEffect, useId, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Divider,
  EmptyState,
  Heading,
  HStack,
  List,
  ListItem,
  Skeleton,
  StatusDot,
  Text,
  VStack,
} from '@astryxdesign/core';
import { ICON_SIZE, ChevronRight, Cpu } from '@maka/ui/icons';
import {
  connectionEnabledModelIds,
  type IdentifiedLlmConnection,
  type ProjectedLlmConnection,
  type ProviderType,
} from '@maka/core/llm-connections';
import { dotForStatus, useMountedRef, useUiLocale } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';
import { connectionChipStatus } from './provider-connection-status';
import {
  CATALOG_INITIAL_FILTER,
  ProviderCatalogPage,
  ProviderSetupPage,
  type CatalogFilter,
  type CreatedOAuthConnectionIdentity,
  type SetupTarget,
} from './provider-catalog-page';
import { isRetiredProvider } from '@maka/core/provider-registry';
import { ConnectionDetail } from './provider-connection-detail';
import { useSettingsRouteFocus } from './settings-route-focus';
import { SettingsRouteHeader } from './settings-route-header';
import { ProviderLogo, providerDisplay } from './provider-display';
import { oauthPanelSubtitle } from './provider-oauth-section';
import {
  getProviderSettingsCopy,
  providerPanelActionErrorMessage,
  ConnectionSaveUncertaintyObserver,
  type ApiKeyOnboardingBridge,
  type ConnectionsBridge,
  type DesktopConnectionOnboardingIdentity,
} from '../features/connection-settings';
import {
  RuntimeHostSettingsGenerationBoundary,
  useRuntimeHostSettingsErrorReporter,
} from './runtime-host-settings-target.js';

export type { ConnectionsBridge } from '../features/connection-settings';

/**
 * Where the panel is. Four levels, one container, one back affordance:
 *
 *   list ─┬─ catalog ── setup(credentials | account)
 *         ├─ setup (straight from the empty list's recommended rows)
 *         └─ detail
 *
 * Nothing here is a Dialog. A modal exists to interrupt the current task for
 * something short and immediately decidable while preserving the context
 * behind it; browsing 55 providers, filling a credential form, or waiting on a
 * browser login is none of those, and Astryx says as much — "if the content
 * grows beyond what fits, consider a full page instead."
 *
 * `setup` carries its own `origin` rather than the panel keeping a history
 * stack: the graph is this small, and the one ambiguous edge (the list jumps
 * straight to a provider's form, skipping the catalog) is answered by the
 * route that created it instead of by a rule somewhere else.
 */
type PanelRoute =
  | { kind: 'list' }
  | { kind: 'catalog' }
  | {
      kind: 'setup';
      target: SetupTarget;
      origin: 'list' | 'catalog';
    }
  | {
      kind: 'adopting-connection';
      identity: DesktopConnectionOnboardingIdentity | CreatedOAuthConnectionIdentity;
    }
  | { kind: 'detail'; connectionId: string };

function backTarget(route: PanelRoute): PanelRoute {
  if (route.kind === 'setup' && route.origin === 'catalog') return { kind: 'catalog' };
  return { kind: 'list' };
}

type ProvidersPanelProps = {
  bridge: ConnectionsBridge;
  apiKeyOnboardingBridge?: ApiKeyOnboardingBridge;
  initialPage?: 'connections' | 'catalog';
  /**
   * When set, open this connection's detail once the list has loaded.
   */
  initialConnectionSlug?: string;
  /**
   * When set, land straight on this provider's setup once the panel has
   * loaded. One-shot: the caller retires the request via
   * onInitialCreateProviderConsumed.
   */
  initialCreateProviderType?: ProviderType;
  /** Called once the catalog level has consumed the one-shot landing intent. */
  onInitialCatalogConsumed?: () => void;
  /** Called once the setup level has been entered. */
  onInitialCreateProviderConsumed?: () => void;
};

export function ProvidersPanel(props: ProvidersPanelProps) {
  return (
    <ConnectionSaveUncertaintyObserver store={props.apiKeyOnboardingBridge?.saveUncertainty}>
      {(hasOnboardingUncertainty) => (
        <ProvidersPanelContent
          {...props}
          hasOnboardingUncertainty={hasOnboardingUncertainty}
        />
      )}
    </ConnectionSaveUncertaintyObserver>
  );
}

function ProvidersPanelContent({ bridge, apiKeyOnboardingBridge, initialPage = 'connections', initialConnectionSlug, initialCreateProviderType, onInitialCatalogConsumed, onInitialCreateProviderConsumed, hasOnboardingUncertainty }: ProvidersPanelProps & {
  hasOnboardingUncertainty: boolean;
}) {
  const reportHostError = useRuntimeHostSettingsErrorReporter();
  // Projected, not merely identified: the detail editor renders the Host's
  // resolved entries for a connection the user has not edited, so the catalog
  // must survive this state rather than being narrowed away here.
  const [connections, setConnections] = useState<ProjectedLlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [route, setRoute] = useState<PanelRoute>({ kind: 'list' });
  // Browsing state, not navigation state: it outlives the catalog so that
  // backing out of a provider returns the user to the search they typed.
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>(CATALOG_INITIAL_FILTER);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providersPanelMountedRef = useMountedRef();
  const providersReloadTicketRef = useRef(0);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // Which row the user left the list from, so returning puts focus back where
  // they were rather than on the page's primary action.
  const returnFocusRef = useRef<
    | { level: 'list'; connectionId: string }
    | { level: 'catalog'; providerType: ProviderType }
    | null
  >(null);
  const detailTitleId = useId();
  const setupTitleId = useId();
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.panel;

  async function reload(): Promise<Awaited<ReturnType<ConnectionsBridge['getSnapshot']>> | null> {
    const ticket = ++providersReloadTicketRef.current;
    try {
      const snapshot = await bridge.getSnapshot();
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return null;
      setConnections(snapshot.connections);
      setDefaultSlug(snapshot.defaultConnection);
      setLoadError(null);
      setLoading(false);
      return snapshot;
    } catch (error) {
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return null;
      const message = providerPanelActionErrorMessage(error, locale);
      setLoadError(message);
      setLoading(false);
      reportHostError(copy.loadFailed, message);
      return null;
    }
  }

  useEffect(() => {
    void reload();
    const unsubscribe = bridge.subscribeEvents?.(() => {
      void reload();
    });
    return () => {
      providersReloadTicketRef.current += 1;
      unsubscribe?.();
    };
  }, [bridge]);

  const initialCatalogOpenedRef = useRef(false);
  useEffect(() => {
    if (
      loading ||
      hasOnboardingUncertainty ||
      initialPage !== 'catalog' ||
      initialCatalogOpenedRef.current
    ) return;
    initialCatalogOpenedRef.current = true;
    setRoute({ kind: 'catalog' });
    onInitialCatalogConsumed?.();
  }, [hasOnboardingUncertainty, initialPage, loading, onInitialCatalogConsumed]);

  const initialConnectionDetailOpenedRef = useRef(false);
  useEffect(() => {
    if (route.kind === 'adopting-connection') {
      const created = connections.find(
        (connection) => connection.connectionId === route.identity.connectionId,
      );
      if (!created) return;
      if (
        created.slug !== route.identity.slug ||
        created.providerType !== route.identity.providerType
      ) {
        setRoute({ kind: 'list' });
        reportHostError(copy.loadFailed, copy.connectionIdentityChanged);
        return;
      }
      returnFocusRef.current = { level: 'list', connectionId: created.connectionId };
      setRoute({ kind: 'detail', connectionId: created.connectionId });
      return;
    }
    if (loading || !initialConnectionSlug || initialConnectionDetailOpenedRef.current) return;
    const connection = connections.find((candidate) => candidate.slug === initialConnectionSlug);
    if (!connection?.connectionId) return;
    initialConnectionDetailOpenedRef.current = true;
    setRoute({ kind: 'detail', connectionId: connection.connectionId });
  }, [loading, initialConnectionSlug, connections, route, copy.connectionIdentityChanged, copy.loadFailed, reportHostError]);

  const initialCreateOpenedRef = useRef(false);
  useEffect(() => {
    if (
      loading ||
      hasOnboardingUncertainty ||
      !initialCreateProviderType ||
      initialCreateOpenedRef.current
    ) return;
    initialCreateOpenedRef.current = true;
    // Straight to the form, so `origin` is the list: the user never saw a
    // catalog and must not be dropped into one on the way out.
    setRoute({
      kind: 'setup',
      origin: 'list',
      target: {
        method: 'credentials',
        providerType: initialCreateProviderType,
        name: providerDisplay(initialCreateProviderType, locale).name,
      },
    });
    onInitialCreateProviderConsumed?.();
  }, [hasOnboardingUncertainty, loading, initialCreateProviderType, onInitialCreateProviderConsumed]);

  function goBack() {
    setRoute(backTarget(route));
  }

  function goToList() {
    setRoute({ kind: 'list' });
  }

  function openDetail(connection: ProjectedLlmConnection) {
    returnFocusRef.current = { level: 'list', connectionId: connection.connectionId };
    setRoute({ kind: 'detail', connectionId: connection.connectionId });
  }

  function openCatalog() {
    returnFocusRef.current = null;
    setRoute({ kind: 'catalog' });
  }

  const selected = route.kind === 'detail'
    ? connections.find((connection) => connection.connectionId === route.connectionId) ?? null
    : null;
  const pendingConnectionIdentity = route.kind === 'adopting-connection' ? route.identity : null;
  const addBlocked = pendingConnectionIdentity !== null || hasOnboardingUncertainty;

  // A detail route whose connection vanished (deleted in another window) is an
  // unsatisfiable route, not a state to correct: the list is what it renders
  // as. Deriving that beats scheduling a setState from inside render.
  const level: Exclude<PanelRoute['kind'], 'adopting-connection'> = route.kind === 'adopting-connection'
    ? 'list'
    : route.kind === 'detail' && !selected
      ? 'list'
      : route.kind;

  useSettingsRouteFocus({
    level,
    routeKey: route,
    isReady: !loading,
    resolveTarget: (current) => {
      const find = (selector: string) => document.querySelector<HTMLElement>(selector);
      if (current === 'catalog') {
        const target = returnFocusRef.current;
        returnFocusRef.current = null;
        return (target?.level === 'catalog'
          ? find(`[data-provider="${target.providerType}"] button`)
          : null) ?? find('[data-maka-contract="provider-catalog"] input');
      }
      if (current === 'setup') {
        return find('[data-maka-contract="provider-setup"] input')
          ?? find('[data-maka-contract="provider-setup"]');
      }
      // The region rather than its back button, so a screen reader announces
      // the level the user landed in instead of the way out of it.
      if (current === 'detail') return find('[data-maka-contract="connection-detail"]');
      // Consumed here and only here: the ref is set on the way down and has to
      // survive the levels in between. The row the user came from may be gone —
      // that is exactly what a deletion does — so the primary action is the
      // fallback, not the default.
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      return (target?.level === 'list'
        ? find(`[data-connection-id="${target.connectionId}"] button`)
        : null)
        ?? addButtonRef.current;
    },
  });

  if (loading) {
    return (
      <VStack className="providersPanel" gap={6} data-maka-contract="providers-panel" aria-busy="true" aria-label={copy.loadingAria}>
        <VStack gap={1.5}>
          <Skeleton width="34%" height={16} radius="rounded" index={0} />
          <Skeleton width="52%" height={9} radius="rounded" index={1} />
        </VStack>
        <VStack gap={2}>
          {[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} height={64} radius={3} index={index + 2} />)}
        </VStack>
      </VStack>
    );
  }

  return (
    <VStack className="providersPanel" gap={2} data-maka-contract="providers-panel">
      {level === 'detail' && selected ? (
        // tabIndex -1 so a route change can land focus on the level itself —
        // the standard SPA answer to "where does focus go when the page
        // swaps", and it draws no ring.
        (<VStack gap={5} tabIndex={-1} role="region" aria-labelledby={detailTitleId} className="settingsRouteLevel" data-maka-contract="connection-detail">
          <SettingsRouteHeader
            onBack={goToList}
            backLabel={copy.backToList}
            logo={<ProviderLogo type={selected.providerType} compact />}
            titleId={detailTitleId}
            title={connectionDisplayName(selected, connections)}
            /* The control sits in the slot that shows the state: whichever of
               the two a connection is, this slot tells the truth AND is the
               way to change it. A retired connection cannot send, so it can
               neither become the default nor honestly wear the Badge; the
               row's own 已停用 status and the detail banner carry that. */
            badge={isRetiredProvider(selected.providerType)
              ? null
              : selected.slug === defaultSlug
              ? <Badge variant="neutral" label={copy.default} />
              : (
                <Button
                  variant="secondary"
                  size="sm"
                  label={copy.setDefault}
                  tooltip={copy.setDefaultTitle}
                  clickAction={async () => {
                    try {
                      await bridge.setDefault({ connectionId: selected.connectionId, slug: selected.slug });
                      await reload();
                    } catch (error) {
                      // The state is unchanged on failure, so the Badge stays
                      // where it was and the button remains the way to retry.
                      reportHostError(
                        copy.setDefaultFailed,
                        settingsActionErrorMessage(error, locale),
                      );
                    }
                  }}
                />
              )}
            subtitle={connectionSubtitle(selected, locale)}
          />
          <ConnectionDetail
            key={selected.connectionId ?? selected.slug}
            bridge={bridge}
            connection={selected}
            isDefault={selected.slug === defaultSlug}
            onChanged={async () => { await reload(); }}
            onDeleted={async () => {
              const reloaded = await reload();
              if (!reloaded || !providersPanelMountedRef.current) return;
              goToList();
            }}
          />
        </VStack>)
      ) : level === 'catalog' ? (
        <VStack gap={5}>
          <SettingsRouteHeader
            onBack={goToList}
            backLabel={copy.backToList}
            title={copy.addConnection}
            subtitle={copy.addHelp}
          />
          <ProviderCatalogPage
            mode="catalog"
            filter={catalogFilter}
            connections={connections}
            onFilterChange={setCatalogFilter}
            onPick={(target) => {
              returnFocusRef.current = { level: 'catalog', providerType: target.providerType };
              setRoute({ kind: 'setup', target, origin: 'catalog' });
            }}
          />
        </VStack>
      ) : level === 'setup' && route.kind === 'setup' ? (
        <VStack gap={5}>
          <SettingsRouteHeader
            onBack={goBack}
            isBackDisabled={hasOnboardingUncertainty}
            backLabel={route.origin === 'catalog' ? copy.backToCatalog : copy.backToList}
            logo={<ProviderLogo type={route.target.providerType} compact />}
            titleId={setupTitleId}
            title={route.target.method === 'account' && route.target.cardId !== 'github-copilot'
              ? providerCopy.oauthSection.addAccountTitle(route.target.name)
              : copy.connectTitle(route.target.name)}
            subtitle={route.target.method === 'account'
              ? oauthPanelSubtitle(route.target.cardId, providerCopy.oauthSection)
              : copy.createSubtitle}
          />
          <RuntimeHostSettingsGenerationBoundary>
            <ProviderSetupPage
              bridge={bridge}
              apiKeyOnboardingBridge={apiKeyOnboardingBridge}
              target={route.target}
              existingSlugs={connections.map((connection) => connection.slug)}
              labelledBy={setupTitleId}
              hasSaveUncertainty={hasOnboardingUncertainty}
              onCancel={goBack}
              onAccountCreated={async (identity) => {
                if (!identity) return;
                setRoute({ kind: 'adopting-connection', identity });
                await reload();
              }}
              onOnboarded={async (identity) => {
                setRoute({ kind: 'adopting-connection', identity });
                await reload();
              }}
              onOnboardingOutcomeUnknown={async () => {
                setRoute({ kind: 'list' });
                await reload();
              }}
              onCreated={async (slug, modelDiscoveryError) => {
              const snapshot = await reload();
              if (!snapshot || !providersPanelMountedRef.current) return;
              // The new connection's detail, not the list: creating it is the
              // start of setting it up, and every next move — pick the default
              // model, enable models, fix the endpoint the discovery error just
              // complained about — is on that page.
              const created = snapshot.connections.find((connection) => connection.slug === slug);
              if (!created?.connectionId) {
                reportHostError(copy.loadFailed, copy.connectionRemoved);
                return;
              }
              setRoute({ kind: 'detail', connectionId: created.connectionId });
              if (modelDiscoveryError) {
                const providerName = providerDisplay(route.target.providerType, locale).name;
                reportHostError(
                  providerCopy.detail.modelsFetchFailed(providerName),
                  providerCopy.detail.modelsFetchFailedDetail(
                    providerPanelActionErrorMessage(modelDiscoveryError, locale),
                    providerCopy.detail.endpointTroubleshooting,
                  ),
                );
              }
              }}
            />
          </RuntimeHostSettingsGenerationBoundary>
        </VStack>
      ) : (
        <>
          {route.kind === 'detail' && !selected && (
            <Banner status="warning" role="status" title={copy.connectionRemoved} />
          )}
          {hasOnboardingUncertainty && (
            <Banner
              status="warning"
              role="status"
              title={providerCopy.add.onboardingOutcomeUnknown}
              description={providerCopy.add.onboardingOutcomeUnknownDetail}
              endContent={(
                <HStack gap={2}>
                  <Button
                    variant="ghost"
                    label={providerCopy.add.onboardingReloadConnections}
                    onClick={() => void reload()}
                  />
                  <Button
                    variant="secondary"
                    label={providerCopy.add.onboardingRestart}
                    onClick={() => {
                      apiKeyOnboardingBridge?.saveUncertainty.restart();
                      openCatalog();
                    }}
                  />
                </HStack>
              )}
            />
          )}
          {pendingConnectionIdentity && loadError ? (
            <Banner
              status="warning"
              role="status"
              title={copy.connectedLoadFailed}
              description={`${pendingConnectionIdentity.slug} · ${loadError}`}
              endContent={<Button variant="ghost" label={copy.retry} onClick={() => void reload()} />}
            />
          ) : pendingConnectionIdentity ? (
            <Banner
              status="info"
              role="status"
              title={copy.connectedLoading}
              description={pendingConnectionIdentity.slug}
              endContent={<Button variant="ghost" label={copy.retry} onClick={() => void reload()} />}
            />
          ) : loadError ? (
            <Banner
              status="error"
              title={copy.loadFailed}
              description={loadError}
              endContent={<Button variant="ghost" label={copy.retry} onClick={() => void reload()} />}
            />
          ) : null}
          {/* The list is a labeled group like every other settings page: what
              it holds, why it matters, and the one group-level action. This is
              SettingsSection's header written out: the architecture ledger
              freezes this file's dependency list, so the section kit cannot be
              imported here until the panel moves to its feature owner. */}
          <section className="settingsSection">
            <HStack gap={3} align="start" justify="between" wrap="wrap">
              <VStack gap={0.5}>
                <Heading level={3}>{copy.connections}</Heading>
                <Text type="supporting" size="sm" color="secondary">{copy.connectionsHelp}</Text>
              </VStack>
              <div>
                <Button
                  ref={addButtonRef}
                  variant="primary"
                  label={copy.addConnection}
                  onClick={openCatalog}
                  isDisabled={addBlocked}
                  data-maka-contract="add-connection"
                />
              </div>
            </HStack>
            <Divider />
            <div className="settingsSectionBody">
            {connections.length === 0 && !loadError ? (
              <EmptyState
                isCompact
                icon={<Cpu size={ICON_SIZE.empty} />}
                title={copy.empty}
                description={copy.emptyHelp}
                actions={<Button variant="secondary" size="sm" label={copy.browseAll} onClick={openCatalog} isDisabled={addBlocked} />}
              />
            ) : (
              <List hasDividers>
                {connections.map((connection) => {
                  const status = connectionChipStatus(connection, locale);
                  const isDefault = connection.slug === defaultSlug;
                  return (
                    <ListItem
                      key={connection.connectionId ?? connection.slug}
                      className="connectionRow"
                      data-connection-id={connection.connectionId}
                      data-connection-slug={connection.slug}
                      data-disabled={connection.enabled ? undefined : 'true'}
                      startContent={<ProviderLogo type={connection.providerType} compact />}
                      label={(
                        <HStack gap={2} vAlign="center">
                          {/* a11y-allow: this label names the ROW, not the span. Astryx's Item puts consumer props on its outer wrapper and renders a separate invisible <button> for the click target, so an aria-label on the Item never reaches that button — measured. The button is named from its content, and this span is how the status reaches that name. Removing it drops the runtime error from the row's accessible name (settings.spec:226).*/}
                          <span aria-label={chipAriaLabel(connection, isDefault)}>{connectionDisplayName(connection, connections)}</span>
                          {isDefault && <Badge variant="neutral" label={copy.default} />}
                        </HStack>
                      )}
                      description={connectionSubtitle(connection, locale)}
                      endContent={(
                        <HStack gap={2} vAlign="center">
                          {status && (
                            <span className="settingsStatus">
                              <StatusDot variant={dotForStatus(status.tone)} label={status.label} />
                              <span>{status.label}</span>
                            </span>
                          )}
                          <ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />
                        </HStack>
                      )}
                      onClick={() => openDetail(connection)}
                    />
                  );
                })}
              </List>
            )}
            </div>
          </section>
          {connections.length === 0 && !loadError && (
            /* First run: the providers most people connect, one click from
               their form. The full catalog is one more click away above. */
            <div inert={addBlocked || undefined}>
              <ProviderCatalogPage
                mode="shortlist"
                connections={connections}
                onPick={(target) => {
                  returnFocusRef.current = null;
                  setRoute({ kind: 'setup', target, origin: 'list' });
                }}
              />
            </div>
          )}
        </>
      )}
    </VStack>
  );

  function chipAriaLabel(connection: IdentifiedLlmConnection, isDefault: boolean): string {
    const provider = providerDisplay(connection.providerType, locale).name;
    const status = connectionChipStatus(connection, locale);
    return copy.chipAria(
      connectionDisplayName(connection, connections),
      provider,
      isDefault,
      status?.label,
    );
  }
}

/** Provider · models · default model — the row's second line, and the detail's subtitle. */
function connectionSubtitle(connection: IdentifiedLlmConnection, locale: 'zh' | 'en'): string {
  const copy = getProviderSettingsCopy(locale).panel;
  const providerName = providerDisplay(connection.providerType, locale).name;
  const enabledCount = connectionEnabledModelIds(connection).length;
  const parts = [providerName];
  if (enabledCount > 1) parts.push(copy.modelCount(enabledCount));
  if (connection.defaultModel) parts.push(connection.defaultModel);
  return parts.join(' · ');
}

function connectionDisplayName(
  connection: IdentifiedLlmConnection,
  connections: readonly IdentifiedLlmConnection[],
): string {
  const ambiguous = connections.some(
    (candidate) =>
      candidate.connectionId !== connection.connectionId &&
      candidate.providerType === connection.providerType &&
      candidate.name === connection.name,
  );
  return ambiguous ? `${connection.name} · ${connection.slug}` : connection.name;
}
