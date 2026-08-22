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
  type LlmConnection,
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
  type SetupTarget,
} from './provider-catalog-page';
import { isRetiredProvider } from '@maka/core/provider-registry';
import { ConnectionDetail } from './provider-connection-detail';
import { useSettingsRouteFocus } from './settings-route-focus';
import { SettingsRouteHeader } from './settings-route-header';
import { ProviderLogo, providerDisplay } from './provider-display';
import { oauthPanelSubtitle } from './provider-oauth-section';
import { providerPanelActionErrorMessage, type ConnectionsBridge } from './provider-panel-shared';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { useRuntimeHostSettingsErrorReporter } from './runtime-host-settings-target.js';

export type { ConnectionsBridge } from './provider-panel-shared';

/**
 * Where the panel is. Four levels, one container, one back affordance:
 *
 *   list ─┬─ catalog ── setup(credentials | account)
 *         └─ detail
 *
 * Nothing here is a Dialog. A modal exists to interrupt the current task for
 * something short and immediately decidable while preserving the context
 * behind it; browsing 55 providers, filling a credential form, or waiting on a
 * browser login is none of those, and Astryx says as much — "if the content
 * grows beyond what fits, consider a full page instead."
 *
 * `setup` carries its own `origin` rather than the panel keeping a history
 * stack: the graph is this small, and the one ambiguous edge (the first-run
 * hero jumps straight to a provider's form, skipping the catalog) is answered
 * by the route that created it instead of by a rule somewhere else.
 */
type PanelRoute =
  | { kind: 'list' }
  | { kind: 'catalog' }
  | { kind: 'setup'; target: SetupTarget; origin: 'list' | 'catalog' }
  | { kind: 'detail'; slug: string };

function backTarget(route: PanelRoute): PanelRoute {
  if (route.kind === 'setup' && route.origin === 'catalog') return { kind: 'catalog' };
  return { kind: 'list' };
}

export function ProvidersPanel({ bridge, initialPage = 'connections', initialConnectionSlug, initialCreateProviderType, onInitialCreateProviderConsumed }: {
  bridge: ConnectionsBridge;
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
  /** Called once the setup level has been entered. */
  onInitialCreateProviderConsumed?: () => void;
}) {
  const reportHostError = useRuntimeHostSettingsErrorReporter();
  const [connections, setConnections] = useState<LlmConnection[]>([]);
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
  const listReturnFocusRef = useRef<string | null>(null);
  const detailTitleId = useId();
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.panel;

  async function reload(): Promise<boolean> {
    const ticket = ++providersReloadTicketRef.current;
    try {
      const snapshot = await bridge.getSnapshot();
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return false;
      setConnections(snapshot.connections);
      setDefaultSlug(snapshot.defaultConnection);
      setLoadError(null);
      setLoading(false);
      return true;
    } catch (error) {
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return false;
      const message = providerPanelActionErrorMessage(error, locale);
      setLoadError(message);
      setLoading(false);
      reportHostError(copy.loadFailed, message);
      return false;
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
    if (loading || initialPage !== 'catalog' || initialCatalogOpenedRef.current) return;
    initialCatalogOpenedRef.current = true;
    setRoute({ kind: 'catalog' });
  }, [initialPage, loading]);

  const initialConnectionDetailOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || !initialConnectionSlug || initialConnectionDetailOpenedRef.current) return;
    if (!connections.some((candidate) => candidate.slug === initialConnectionSlug)) return;
    initialConnectionDetailOpenedRef.current = true;
    setRoute({ kind: 'detail', slug: initialConnectionSlug });
  }, [loading, initialConnectionSlug, connections]);

  const initialCreateOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || !initialCreateProviderType || initialCreateOpenedRef.current) return;
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
  }, [loading, initialCreateProviderType, onInitialCreateProviderConsumed]);

  function goBack() {
    setRoute(backTarget(route));
  }

  function goToList() {
    setRoute({ kind: 'list' });
  }

  function openDetail(slug: string) {
    listReturnFocusRef.current = slug;
    setRoute({ kind: 'detail', slug });
  }

  function openCatalog() {
    listReturnFocusRef.current = null;
    setRoute({ kind: 'catalog' });
  }

  const selected = route.kind === 'detail'
    ? connections.find((connection) => connection.slug === route.slug) ?? null
    : null;

  // A detail route whose connection vanished (deleted in another window) is an
  // unsatisfiable route, not a state to correct: the list is what it renders
  // as. Deriving that beats scheduling a setState from inside render.
  const level: PanelRoute['kind'] = route.kind === 'detail' && !selected ? 'list' : route.kind;

  useSettingsRouteFocus({
    level,
    routeKey: route,
    isReady: !loading,
    resolveTarget: (current) => {
      const find = (selector: string) => document.querySelector<HTMLElement>(selector);
      if (current === 'catalog') return find('[data-maka-contract="provider-catalog"] input');
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
      const returnToSlug = listReturnFocusRef.current;
      listReturnFocusRef.current = null;
      return (returnToSlug ? find(`[data-connection-slug="${returnToSlug}"] button`) : null)
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
            title={selected.name}
            /* The control sits in the slot that shows the state. Setting the
               default connection was reachable only from the command palette,
               while this page displayed a 默认 Badge and offered no way to
               change it — so a user who came here to change it (the obvious
               place, since it is where the answer is shown) found a read-only
               label and gave up. Whichever of the two a connection is, this
               slot now tells the truth AND is the way to change it.

               `secondary`, not ghost: this button sits alone beside a title,
               where a ghost's bare text reads as a subtitle rather than
               something you can press — which would recreate the very problem
               it exists to solve. 测试连接 below is secondary sm, and that is
               this page's dialect for "quiet but unmistakably a control".

               `clickAction` rather than onClick: it opens no confirm, so there
               is no state-driven UI to await inside the transition, and the
               button gets its own pending affordance for free. */
            /* Retired is checked before either state: the connection cannot
               send, so it can neither become the default nor honestly wear the
               默认 Badge. Loading the catalog releases a default target that
               points at one (connection-catalog-document.ts), so this is the
               in-memory half of that — and it keeps the slot's invariant, since
               a Badge with no way to move the default off it would be exactly
               the read-only label the comment above describes. The row's own
               已停用 status and the detail banner carry the explanation. */
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
                      await bridge.setDefault(selected.slug);
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
            key={selected.slug}
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
            filter={catalogFilter}
            onFilterChange={setCatalogFilter}
            onPick={(target) => setRoute({ kind: 'setup', target, origin: 'catalog' })}
          />
        </VStack>
      ) : level === 'setup' && route.kind === 'setup' ? (
        <VStack gap={5}>
          <SettingsRouteHeader
            onBack={goBack}
            backLabel={route.origin === 'catalog' ? copy.backToCatalog : copy.backToList}
            logo={<ProviderLogo type={route.target.providerType} compact />}
            title={copy.connectTitle(route.target.name)}
            subtitle={route.target.method === 'account'
              ? oauthPanelSubtitle(route.target.cardId, providerCopy.oauthSection)
              : copy.createSubtitle}
          />
          <ProviderSetupPage
            bridge={bridge}
            target={route.target}
            existingSlugs={connections.map((connection) => connection.slug)}
            onCancel={goBack}
            onAccountChanged={async () => { await reload(); }}
            onCreated={async (slug, modelDiscoveryError) => {
              await reload();
              if (!providersPanelMountedRef.current) return;
              // The new connection's detail, not the list: creating it is the
              // start of setting it up, and every next move — pick the default
              // model, enable models, fix the endpoint the discovery error just
              // complained about — is on that page.
              setRoute({ kind: 'detail', slug });
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
        </VStack>
      ) : (
        <>
          <HStack gap={2} vAlign="center" hAlign="between">
            <HStack gap={2} vAlign="center">
              <Heading level={3}>{copy.connections}</Heading>
              {connections.length > 0 && (
                <Text type="supporting" color="secondary">{copy.count(connections.length)}</Text>
              )}
            </HStack>
            <Button
              ref={addButtonRef}
              variant="primary"
              label={copy.addConnection}
              onClick={openCatalog}
              data-maka-contract="add-connection"
            />
          </HStack>
          {loadError ? (
            <Banner
              status="error"
              title={copy.loadFailed}
              description={loadError}
              endContent={<Button variant="ghost" label={copy.retry} onClick={() => void reload()} />}
            />
          ) : connections.length === 0 ? (
            <EmptyState
              icon={<Cpu size={ICON_SIZE.empty} />}
              title={copy.empty}
              description={copy.emptyHelp}
              actions={<Button variant="primary" label={copy.addConnection} onClick={openCatalog} />}
            />
          ) : (
            <List hasDividers>
              {connections.map((connection) => {
                const status = connectionChipStatus(connection, locale);
                const isDefault = connection.slug === defaultSlug;
                return (
                  <ListItem
                    key={connection.slug}
                    className="connectionRow"
                    data-connection-slug={connection.slug}
                    data-disabled={connection.enabled ? undefined : 'true'}
                    startContent={<ProviderLogo type={connection.providerType} compact />}
                    label={(
                      <HStack gap={2} vAlign="center">
                        {/* a11y-allow: this label names the ROW, not the span. Astryx's Item puts consumer props on its outer wrapper and renders a separate invisible <button> for the click target, so an aria-label on the Item never reaches that button — measured. The button is named from its content, and this span is how the status reaches that name. Removing it drops the runtime error from the row's accessible name (settings.spec:226).*/}
                        <span aria-label={chipAriaLabel(connection, isDefault)}>{connection.name}</span>
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
                    onClick={() => openDetail(connection.slug)}
                  />
                );
              })}
            </List>
          )}
        </>
      )}
    </VStack>
  );

  function chipAriaLabel(connection: LlmConnection, isDefault: boolean): string {
    const provider = providerDisplay(connection.providerType, locale).name;
    const status = connectionChipStatus(connection, locale);
    return copy.chipAria(connection.name, provider, isDefault, status?.label);
  }
}

/** Provider · default model — the row's second line, and the detail's subtitle. */
function connectionSubtitle(connection: LlmConnection, locale: 'zh' | 'en'): string {
  const providerName = providerDisplay(connection.providerType, locale).name;
  const parts = [providerName];
  if (connection.defaultModel) parts.push(connection.defaultModel);
  return parts.join(' · ');
}
