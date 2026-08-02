import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Divider,
  EmptyState,
  HStack,
  List,
  ListItem,
  Skeleton,
  Tab,
  TabList,
  VStack,
} from '@astryxdesign/core';
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
  TextInput,
  SectionHeader,
  useMountedRef,
  useUiLocale,
  useToast,
} from '@maka/ui';
import { connectionChipStatus } from './provider-connection-status';
import { statusBadgeVariant } from './settings-status-badge';
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
  | { kind: 'create'; providerType: ProviderType; session: number }
  | { kind: 'manage'; connection: LlmConnection; session: number }
  | null;

type ProviderDialogInput =
  | { kind: 'create'; providerType: ProviderType }
  | { kind: 'manage'; connection: LlmConnection };

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
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [catalogCategory, setCatalogCategory] = useState<CatalogCategory>('recommended');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providersPanelMountedRef = useMountedRef();
  const providersReloadTicketRef = useRef(0);
  const providerDialogLifecycleRef = useRef(0);
  const focusProviderSearchAfterCloseRef = useRef(false);
  const providerCatalogRef = useRef<HTMLElement>(null);
  const providerCatalogSearchRef = useRef<HTMLInputElement>(null);
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.panel;
  const toast = useToast();

  function openDialog(nextState: ProviderDialogInput) {
    const lifecycle = providerDialogLifecycleRef.current + 1;
    providerDialogLifecycleRef.current = lifecycle;
    setIsDialogOpen(false);
    setDialogState({ ...nextState, session: lifecycle });
    window.requestAnimationFrame(() => {
      if (!providersPanelMountedRef.current || providerDialogLifecycleRef.current !== lifecycle) return;
      setIsDialogOpen(true);
    });
  }

  function requestDialogClose() {
    providerDialogLifecycleRef.current += 1;
    setIsDialogOpen(false);
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setIsDialogOpen(true);
      return;
    }
    requestDialogClose();
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

  useEffect(() => {
    if (isDialogOpen || !focusProviderSearchAfterCloseRef.current) return;
    focusProviderSearchAfterCloseRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      providerCatalogSearchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isDialogOpen]);

  const initialConnectionDetailOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || !initialConnectionSlug || initialConnectionDetailOpenedRef.current) return;
    const connection = connections.find((candidate) => candidate.slug === initialConnectionSlug);
    if (!connection) return;
    initialConnectionDetailOpenedRef.current = true;
    openDialog({ kind: 'manage', connection });
  }, [loading, initialConnectionSlug, connections]);

  useEffect(() => {
    if (loading || !initialCreateProviderType) return;
    openDialog({ kind: 'create', providerType: initialCreateProviderType });
    onInitialCreateProviderConsumed?.();
  }, [loading, initialCreateProviderType, onInitialCreateProviderConsumed]);

  const selected = dialogState?.kind === 'manage'
    ? connections.find((connection) => connection.slug === dialogState.connection.slug)
      ?? dialogState.connection
    : null;

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
      <VStack className="providersPanel" gap={6} data-maka-contract="providers-panel" aria-busy="true" aria-label={copy.loadingAria}>
        <VStack gap={1.5}>
          <Skeleton width="34%" height={16} radius="rounded" index={0} />
          <Skeleton width="52%" height={9} radius="rounded" index={1} />
        </VStack>
        <VStack gap={2}>
          {[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} height={92} radius={3} index={index + 2} />)}
        </VStack>
      </VStack>
    );
  }

  const createType = dialogState?.kind === 'create' ? dialogState.providerType : null;

  return (
    <VStack className="providersPanel" gap={6} data-maka-contract="providers-panel">
      <VStack as="section" gap={3} aria-label={copy.connectionsAria}>
        <SectionHeader
          as="h3"
          title={copy.connected}
          subtitle={copy.connectedHelp}
          count={connections.length > 0 ? copy.count(connections.length) : undefined}
        />
        {loadError ? (
          <Banner
            status="error"
            title={copy.loadFailed}
            description={loadError}
            endContent={<Button variant="ghost" label={copy.retry} onClick={() => void reload()} />}
          />
        ) : connections.length === 0 ? (
          <EmptyState isCompact title={copy.empty} description={copy.emptyHelp} />
        ) : (
          <List hasDividers className="connectionList">
            {connections.map((connection) => {
              const status = connectionChipStatus(connection, locale);
              return (
                <ListItem
                  key={connection.slug}
                  className="connectionRow"
                  isSelected={connection.slug === defaultSlug}
                  data-connection-slug={connection.slug}
                  data-disabled={connection.enabled ? undefined : 'true'}
                  startContent={<ProviderLogo type={connection.providerType} compact />}
                  label={(
                    <HStack gap={2} align="center">
                      <span aria-label={chipAriaLabel(connection)}>{connection.name}</span>
                      {connection.slug === defaultSlug && <Badge variant="neutral" label={copy.default} />}
                    </HStack>
                  )}
                  description={providerDisplay(connection.providerType, locale).name}
                  endContent={(
                    <HStack gap={2} align="center">
                      {status && <Badge variant={statusBadgeVariant(status.tone)} label={status.label} />}
                      <ChevronRight size={16} aria-hidden="true" />
                    </HStack>
                  )}
                  onClick={() => openDialog({ kind: 'manage', connection })}
                />
              );
            })}
          </List>
        )}
      </VStack>

      <Divider />

      <VStack as="section" ref={providerCatalogRef} gap={3} aria-labelledby="provider-catalog-title">
        <SectionHeader
          as="h3"
          titleId="provider-catalog-title"
          title={copy.add}
          subtitle={copy.addHelp}
        />
        <TabList
          value={catalogCategory}
          onChange={(value) => setCatalogCategory(value as CatalogCategory)}
          className="catalogTabs"
          aria-label={copy.categoriesAria}
        >
          {CATALOG_TABS.map((tab) => (
            <Tab key={tab} value={tab} label={copy.tabs[tab]} data-catalog-tab={tab} />
          ))}
        </TabList>
        <TextInput
          ref={providerCatalogSearchRef}
          value={catalogQuery}
          onChange={setCatalogQuery}
          placeholder={copy.searchPlaceholder}
          label={copy.searchAria}
          isLabelHidden
          startIcon={<Search aria-hidden="true" />}
          width="min(100%, 360px)"
        />
        {(catalogCategory === 'recommended' || catalogCategory === 'accounts') && (
          <ModelOAuthSection
            query={catalogQuery}
            onConnectionsChanged={async () => { await reload(); }}
          />
        )}
        {catalogCategory !== 'accounts' && (() => {
          const providers = providersForCategory(catalogCategory);
          return providers.length > 0 ? (
            <List hasDividers className="providerMarketGrid">
              {providers.map((type) => (
                <ProviderCatalogCard
                  key={type}
                  type={type}
                  count={configuredByType(type)}
                  onSelect={() => openDialog({ kind: 'create', providerType: type })}
                />
              ))}
            </List>
          ) : (
            <EmptyState isCompact title={copy.noMatch} />
          );
        })()}
      </VStack>

      {createType && (
        <ProviderConnectionDialog
          key={dialogState?.session}
          title={copy.connectTitle(providerDisplay(createType, locale).name)}
          subtitle={copy.createSubtitle}
          providerType={createType}
          isOpen={isDialogOpen}
          onOpenChange={handleDialogOpenChange}
        >
          <AddProviderForm
            key={createType}
            bridge={bridge}
            providerType={createType}
            existingSlugs={connections.map((connection) => connection.slug)}
            onCancel={requestDialogClose}
            onCreated={async (_slug, modelDiscoveryError) => {
              const lifecycle = providerDialogLifecycleRef.current;
              const reloaded = await reload();
              if (!reloaded || !providersPanelMountedRef.current || providerDialogLifecycleRef.current !== lifecycle) return;
              requestDialogClose();
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
          key={dialogState?.session}
          title={selected.name}
          subtitle={connectionDialogSubtitle(selected, selected.slug === defaultSlug, locale)}
          providerType={selected.providerType}
          isOpen={isDialogOpen}
          onOpenChange={handleDialogOpenChange}
        >
          <ConnectionDetail
            key={selected.slug}
            bridge={bridge}
            connection={selected}
            isDefault={selected.slug === defaultSlug}
            onChanged={async () => { await reload(); }}
            onDeleted={async () => {
              const reloaded = await reload();
              if (!reloaded || !providersPanelMountedRef.current) return;
              focusProviderSearchAfterCloseRef.current = true;
              requestDialogClose();
            }}
          />
        </ProviderConnectionDialog>
      )}
    </VStack>
  );
}

function connectionDialogSubtitle(connection: LlmConnection, isDefault: boolean, locale: UiLocale): string {
  const copy = getProviderSettingsCopy(locale).panel;
  const providerName = providerDisplay(connection.providerType, locale).name;
  const parts = providerName === connection.name ? [] : [providerName];
  parts.push(isDefault ? copy.defaultConnection : copy.connection);
  return parts.join(' · ');
}
