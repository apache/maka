import { useEffect, useMemo, useRef, useState } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { ChevronRight, Search } from '@maka/ui/icons';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  RECOMMENDED_PROVIDER_TYPES,
  type LlmConnection,
  type ProviderCatalogGroup,
  type ProviderType,
  type UiLocale,
} from '@maka/core';
import {
  Chip,
  TextInput,
  PrimitiveTabs, PrimitiveTabsList, PrimitiveTabsTrigger, PrimitiveTabsPanel,
  Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions,
  SectionHeader,
  useMountedRef,
  useUiLocale,
  useToast,
} from '@maka/ui';
import { connectionChipStatus } from './provider-connection-status';
import { AddProviderForm } from './provider-add-form';
import { ProviderCatalogCard } from './provider-catalog';
import { ProviderConnectionDialog } from './provider-connection-dialog';
import { ConnectionDetail } from './provider-connection-detail';
import { ProviderLogo, providerDisplay } from './provider-display';
import { ModelOAuthSection } from './provider-oauth-section';
import { providerPanelActionErrorMessage, type ConnectionsBridge } from './provider-panel-shared';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

export type { ConnectionsBridge } from './provider-panel-shared';
export { ProviderLogo, providerDisplay } from './provider-display';

type ProviderDialogState =
  | { kind: 'create'; providerType: ProviderType }
  | { kind: 'manage'; slug: string }
  | null;

type CatalogCategory = ProviderCatalogGroup | 'accounts';

const CATALOG_TABS: CatalogCategory[] = ['recommended', 'accounts', 'plans', 'api', 'aggregators', 'local'];

export function ProvidersPanel({ bridge, initialPage = 'connections', initialConnectionSlug, initialCreateProviderType, onInitialCreateProviderConsumed }: {
  bridge: ConnectionsBridge;
  initialPage?: 'connections' | 'catalog';
  /**
   * When set, auto-open the connection detail sheet for this slug once the
   * connection list has loaded. Used by the `oauth-relogin` e2e-fixture
   * fixture so the re-login affordance in the detail sheet is captured; a
   * real user reaches the same sheet by clicking the connection row.
   */
  initialConnectionSlug?: string;
  /**
   * When set, auto-open the create-connection dialog for this provider once
   * the panel has loaded. Used by the first-run hero so clicking a provider
   * row lands directly in that provider's form; a real user reaches the
   * same dialog by clicking the provider's catalog card. One-shot: the
   * caller retires the request via onInitialCreateProviderConsumed.
   */
  initialCreateProviderType?: ProviderType;
  /** Called once the auto-opened create dialog has been raised. */
  onInitialCreateProviderConsumed?: () => void;
}) {
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<ProviderDialogState>(null);
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory>('recommended');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providersPanelMountedRef = useMountedRef();
  const providersReloadTicketRef = useRef(0);
  const providerDialogLifecycleRef = useRef(0);
  const providersPanelRef = useRef<HTMLDivElement>(null);
  const providerCatalogRef = useRef<HTMLElement>(null);
  const providerCatalogSearchRef = useRef<HTMLInputElement>(null);
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.panel;
  const toast = useToast();

  function closeDialog() {
    providerDialogLifecycleRef.current += 1;
    setDialogState(null);
  }

  async function reload(): Promise<boolean> {
    const ticket = ++providersReloadTicketRef.current;
    try {
      const [list, defaultConnection] = await Promise.all([
        bridge.list(),
        bridge.getDefault(),
      ]);
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return false;
      setConnections(list);
      setDefaultSlug(defaultConnection);
      setLoadError(null);
      setLoading(false);
      setDialogState((current) => current?.kind === 'manage' && !list.some((connection) => connection.slug === current.slug)
        ? null
        : current);
      return true;
    } catch (error) {
      if (!providersPanelMountedRef.current || providersReloadTicketRef.current !== ticket) return false;
      const message = providerPanelActionErrorMessage(error, locale);
      setLoadError(message);
      setLoading(false);
      toast.error(copy.loadFailed, message);
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
      providerDialogLifecycleRef.current += 1;
      unsubscribe?.();
    };
  }, [bridge]);

  useEffect(() => {
    if (loading || initialPage !== 'catalog') return;
    providerCatalogRef.current?.scrollIntoView({ block: 'start' });
    providerCatalogSearchRef.current?.focus({ preventScroll: true });
  }, [initialPage, loading]);

  const initialConnectionDetailOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || !initialConnectionSlug || initialConnectionDetailOpenedRef.current) return;
    if (!connections.some((connection) => connection.slug === initialConnectionSlug)) return;
    initialConnectionDetailOpenedRef.current = true;
    setDialogState({ kind: 'manage', slug: initialConnectionSlug });
  }, [loading, initialConnectionSlug, connections]);

  useEffect(() => {
    if (loading || !initialCreateProviderType) return;
    setDialogState({ kind: 'create', providerType: initialCreateProviderType });
    onInitialCreateProviderConsumed?.();
  }, [loading, initialCreateProviderType, onInitialCreateProviderConsumed]);

  const selected = useMemo(
    () => dialogState?.kind === 'manage'
      ? connections.find((connection) => connection.slug === dialogState.slug) ?? null
      : null,
    [connections, dialogState],
  );

  function chipTitle(connection: LlmConnection): string {
    const status = connectionChipStatus(connection, locale);
    return status ? `${connection.name} · ${status.label}` : connection.name;
  }

  function chipAriaLabel(connection: LlmConnection): string {
    const provider = providerDisplay(connection.providerType, locale).name;
    const status = connectionChipStatus(connection, locale);
    return copy.chipAria(connection.name, provider, connection.slug === defaultSlug, status?.label);
  }

  const configuredByType = (type: ProviderType) =>
    connections.filter((connection) => connection.providerType === type).length;

  function providersForCategory(category: CatalogCategory): ProviderType[] {
    if (category === 'accounts') return [];
    const source = category === 'recommended' ? RECOMMENDED_PROVIDER_TYPES : CATALOG_PROVIDER_TYPES;
    const normalizedQuery = catalogQuery.trim().toLocaleLowerCase();
    return source.filter((type) => {
      if (!CATALOG_PROVIDER_TYPES.includes(type)) return false;
      if (PROVIDER_DEFAULTS[type].status !== 'ready') return false;
      if (category !== 'recommended' && PROVIDER_DEFAULTS[type].catalogGroup !== category) return false;
      if (!normalizedQuery) return true;
      const display = providerDisplay(type, locale);
      return [type, display.name, display.description, PROVIDER_DEFAULTS[type].label]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }

  if (loading) {
    return (
      <div className="providersPanel providersLoading" data-maka-contract="providers-panel" aria-busy="true" aria-label={copy.loadingAria}>
        <div className="providersLoadingStrip">
          <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '34%' }} />
          <div className="maka-skeleton maka-skeleton-line" data-size="sm" style={{ width: '52%' }} />
        </div>
        <div className="providersLoadingGrid">
          {[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className="maka-skeleton maka-skeleton-card" />)}
        </div>
      </div>
    );
  }

  const createType = dialogState?.kind === 'create' ? dialogState.providerType : null;

  return (
    <div ref={providersPanelRef} className="providersPanel providersMarketPanel" data-maka-contract="providers-panel">
      <section className="providerMarket">
        <div className="enabledStrip" aria-label={copy.connectionsAria}>
          <SectionHeader
            as="h3"
            title={copy.connected}
            subtitle={copy.connectedHelp}
            count={connections.length > 0 ? copy.count(connections.length) : undefined}
          />
          {loadError ? (
            <BaseButton className="enabledEmptyChip enabledEmptyAction" type="button" onClick={() => void reload()}>
              <strong>{copy.loadFailed}</strong>
              <small>{loadError} · {copy.retry}</small>
            </BaseButton>
          ) : connections.length === 0 ? (
            <div className="enabledEmptyChip" role="note">
              <strong>{copy.empty}</strong>
              <small>{copy.emptyHelp}</small>
            </div>
          ) : (
            <ul className="connectionList" role="list">
              {connections.map((connection) => {
                const status = connectionChipStatus(connection, locale);
                return (
                  <li key={connection.slug}>
                    <Item
                      className="connectionRow"
                      selected={connection.slug === defaultSlug}
                      data-connection-slug={connection.slug}
                      data-disabled={connection.enabled ? undefined : 'true'}
                      aria-label={chipAriaLabel(connection)}
                      title={chipTitle(connection)}
                      render={<button type="button" onClick={() => setDialogState({ kind: 'manage', slug: connection.slug })} />}
                    >
                      <ItemMedia><ProviderLogo type={connection.providerType} compact /></ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {connection.name}
                          {connection.slug === defaultSlug && <Chip size="sm" variant="accent">{copy.default}</Chip>}
                        </ItemTitle>
                        <ItemDescription>{providerDisplay(connection.providerType, locale).name}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {status && <Chip dot size="sm" variant={status.tone}>{status.label}</Chip>}
                        <ChevronRight size={16} aria-hidden="true" />
                      </ItemActions>
                    </Item>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <section ref={providerCatalogRef} className="providerCatalogSection" aria-labelledby="provider-catalog-title">
          <SectionHeader
            as="h3"
            titleId="provider-catalog-title"
            title={copy.add}
            subtitle={copy.addHelp}
          />
          <PrimitiveTabs
            className="catalogTabsRoot"
            value={catalogCategory}
            onValueChange={(value) => setCatalogCategory(value as CatalogCategory)}
          >
            <PrimitiveTabsList variant="pill" className="catalogTabs catalogPillTabs" aria-label={copy.categoriesAria}>
              {CATALOG_TABS.map((tab) => (
                <PrimitiveTabsTrigger key={tab} value={tab} data-catalog-tab={tab}>
                  <strong>{copy.tabs[tab]}</strong>
                </PrimitiveTabsTrigger>
              ))}
            </PrimitiveTabsList>
            <TextInput
              ref={providerCatalogSearchRef}
              className="providerCatalogSearch"
              value={catalogQuery}
              onChange={setCatalogQuery}
              placeholder={copy.searchPlaceholder}
              label={copy.searchAria}
              isLabelHidden
              startIcon={<Search aria-hidden="true" />}
              />
            <PrimitiveTabsPanel value={catalogCategory}>
              {(catalogCategory === 'recommended' || catalogCategory === 'accounts') && (
                <ModelOAuthSection
                  query={catalogQuery}
                  onConnectionsChanged={async () => { await reload(); }}
                />
              )}
              {catalogCategory !== 'accounts' && (() => {
                const providers = providersForCategory(catalogCategory);
                return providers.length > 0 ? (
                  <div className="catalogGrid providerMarketGrid">
                    {providers.map((type) => (
                      <ProviderCatalogCard
                        key={type}
                        type={type}
                        count={configuredByType(type)}
                        onSelect={() => setDialogState({ kind: 'create', providerType: type })}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="providerCatalogEmpty" role="status">{copy.noMatch}</div>
                );
              })()}
            </PrimitiveTabsPanel>
          </PrimitiveTabs>
        </section>
      </section>

      {createType && (
        <ProviderConnectionDialog
          title={copy.connectTitle(providerDisplay(createType, locale).name)}
          subtitle={copy.createSubtitle}
          providerType={createType}
          onClose={closeDialog}
          finalFocus={() => providerFocusElement(providersPanelRef.current, { kind: 'catalog-provider', providerType: createType })}
        >
          <AddProviderForm
            key={createType}
            bridge={bridge}
            providerType={createType}
            existingSlugs={connections.map((connection) => connection.slug)}
            onCancel={closeDialog}
            onCreated={async (_slug, modelDiscoveryError) => {
              const lifecycle = providerDialogLifecycleRef.current;
              const reloaded = await reload();
              if (!reloaded || !providersPanelMountedRef.current || providerDialogLifecycleRef.current !== lifecycle) return;
              closeDialog();
              if (modelDiscoveryError) {
                const providerName = providerDisplay(createType, locale).name;
                toast.error(
                  providerCopy.detail.modelsFetchFailed(providerName),
                  providerCopy.detail.modelsFetchFailedDetail(
                    providerPanelActionErrorMessage(modelDiscoveryError, locale),
                    providerCopy.detail.endpointTroubleshooting,
                  ),
                );
              }
            }}
          />
        </ProviderConnectionDialog>
      )}

      {selected && (
        <ProviderConnectionDialog
          title={selected.name}
          subtitle={connectionDialogSubtitle(selected, selected.slug === defaultSlug, locale)}
          providerType={selected.providerType}
          onClose={closeDialog}
          finalFocus={() => providerFocusElement(providersPanelRef.current, { kind: 'connection', slug: selected.slug })}
        >
          <ConnectionDetail
            key={selected.slug}
            bridge={bridge}
            connection={selected}
            isDefault={selected.slug === defaultSlug}
            onChanged={async () => { await reload(); }}
            onDeleted={async () => {
              closeDialog();
              const reloaded = await reload();
              if (!reloaded || !providersPanelMountedRef.current) return;
              providerCatalogSearchRef.current?.focus();
            }}
          />
        </ProviderConnectionDialog>
      )}
    </div>
  );
}

function connectionDialogSubtitle(connection: LlmConnection, isDefault: boolean, locale: UiLocale): string {
  const copy = getProviderSettingsCopy(locale).panel;
  const providerName = providerDisplay(connection.providerType, locale).name;
  const parts = providerName === connection.name ? [] : [providerName];
  parts.push(isDefault ? copy.defaultConnection : copy.connection);
  return parts.join(' · ');
}

type ProviderFocusTarget =
  | { kind: 'catalog-provider'; providerType: ProviderType }
  | { kind: 'connection'; slug: string };

function providerFocusElement(panel: HTMLElement | null, target: ProviderFocusTarget): HTMLElement | null {
  if (!panel) return null;
  if (target.kind === 'catalog-provider') {
    return [...panel.querySelectorAll<HTMLElement>('[data-provider][data-status="ready"]')]
      .find((element) => element.dataset.provider === target.providerType) ?? null;
  }
  return [...panel.querySelectorAll<HTMLElement>('[data-connection-slug]')]
    .find((element) => element.dataset.connectionSlug === target.slug) ?? null;
}
