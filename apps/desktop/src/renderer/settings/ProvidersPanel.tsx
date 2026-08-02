import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Center,
  EmptyState,
  Heading,
  HStack,
  Icon,
  IconButton,
  List,
  ListItem,
  Skeleton,
  Text,
  Toolbar,
  VStack,
} from '@astryxdesign/core';
import { ArrowLeft, ChevronRight, Info } from '@maka/ui/icons';
import {
  type LlmConnection,
  type ProviderType,
} from '@maka/core';
import { useMountedRef, useUiLocale, useToast } from '@maka/ui';
import { connectionChipStatus } from './provider-connection-status';
import { statusBadgeVariant } from './settings-status-badge';
import { AddConnectionDialog } from './provider-add-dialog';
import { ConnectionDetail } from './provider-connection-detail';
import { ProviderLogo, providerDisplay } from './provider-display';
import { providerPanelActionErrorMessage, type ConnectionsBridge } from './provider-panel-shared';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

export type { ConnectionsBridge } from './provider-panel-shared';
export { ProviderLogo, providerDisplay } from './provider-display';

/**
 * Where the panel is: the connection list, or one connection's detail.
 *
 * Detail is a route rather than a dialog because Astryx says so — "Keep
 * dialogs focused on a single task; if the content grows beyond what fits,
 * consider a full page instead." Credentials, the default model, the enabled
 * model list, advanced settings and deletion are five tasks, not one.
 */
type PanelRoute = { kind: 'list' } | { kind: 'detail'; slug: string };

export function ProvidersPanel({ bridge, initialPage = 'connections', initialConnectionSlug, initialCreateProviderType, onInitialCreateProviderConsumed }: {
  bridge: ConnectionsBridge;
  initialPage?: 'connections' | 'catalog';
  /**
   * When set, open this connection's detail once the list has loaded. Used by
   * the `oauth-relogin` e2e fixture so the re-login affordance is captured; a
   * real user reaches the same page by clicking the connection row.
   */
  initialConnectionSlug?: string;
  /**
   * When set, open the add dialog straight on this provider's form once the
   * panel has loaded. Used by the first-run hero so clicking a provider row
   * lands directly in that provider's form. One-shot: the caller retires the
   * request via onInitialCreateProviderConsumed.
   */
  initialCreateProviderType?: ProviderType;
  /** Called once the auto-opened add dialog has been raised. */
  onInitialCreateProviderConsumed?: () => void;
}) {
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null);
  const [route, setRoute] = useState<PanelRoute>({ kind: 'list' });
  const [addDialog, setAddDialog] = useState<{ session: number; providerType?: ProviderType } | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providersPanelMountedRef = useMountedRef();
  const providersReloadTicketRef = useRef(0);
  const addDialogLifecycleRef = useRef(0);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.panel;
  const toast = useToast();

  function openAddDialog(providerType?: ProviderType) {
    const lifecycle = addDialogLifecycleRef.current + 1;
    addDialogLifecycleRef.current = lifecycle;
    setIsAddDialogOpen(false);
    setAddDialog({ session: lifecycle, providerType });
    window.requestAnimationFrame(() => {
      if (!providersPanelMountedRef.current || addDialogLifecycleRef.current !== lifecycle) return;
      setIsAddDialogOpen(true);
    });
  }

  function requestAddDialogClose() {
    addDialogLifecycleRef.current += 1;
    setIsAddDialogOpen(false);
  }

  function handleAddDialogOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setIsAddDialogOpen(true);
      return;
    }
    requestAddDialogClose();
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
      addDialogLifecycleRef.current += 1;
      unsubscribe?.();
    };
  }, [bridge]);

  // `initialPage: 'catalog'` used to scroll to a catalog section further down
  // the page. The catalog is a dialog now, so the same intent is simply
  // raising it.
  const initialCatalogOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || initialPage !== 'catalog' || initialCatalogOpenedRef.current) return;
    initialCatalogOpenedRef.current = true;
    openAddDialog();
  }, [initialPage, loading]);

  const initialConnectionDetailOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || !initialConnectionSlug || initialConnectionDetailOpenedRef.current) return;
    if (!connections.some((candidate) => candidate.slug === initialConnectionSlug)) return;
    initialConnectionDetailOpenedRef.current = true;
    setRoute({ kind: 'detail', slug: initialConnectionSlug });
  }, [loading, initialConnectionSlug, connections]);

  useEffect(() => {
    if (loading || !initialCreateProviderType) return;
    openAddDialog(initialCreateProviderType);
    onInitialCreateProviderConsumed?.();
  }, [loading, initialCreateProviderType, onInitialCreateProviderConsumed]);

  function backToList() {
    setRoute({ kind: 'list' });
    // Return focus to the page's primary action rather than the top of the
    // document — the row the user came from may no longer exist (deletion).
    window.requestAnimationFrame(() => addButtonRef.current?.focus());
  }

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

  const selected = route.kind === 'detail'
    ? connections.find((connection) => connection.slug === route.slug) ?? null
    : null;

  // A detail route whose connection vanished (deleted in another window, or
  // the slug never resolved) falls back to the list rather than rendering an
  // empty page with a back button.
  if (route.kind === 'detail' && !selected) {
    if (route.slug) queueMicrotask(() => setRoute({ kind: 'list' }));
  }

  return (
    <VStack className="providersPanel" gap={6} data-maka-contract="providers-panel">
      {selected ? (
        <ConnectionDetailRoute
          bridge={bridge}
          connection={selected}
          isDefault={selected.slug === defaultSlug}
          onBack={backToList}
          onChanged={async () => { await reload(); }}
          onDeleted={async () => {
            const reloaded = await reload();
            if (!reloaded || !providersPanelMountedRef.current) return;
            backToList();
          }}
        />
      ) : (
        <>
          <Toolbar
            label={copy.connectionsAria}
            gap={2}
            startContent={(
              <HStack gap={2} vAlign="center">
                <Heading level={3}>{copy.connected}</Heading>
                {connections.length > 0 && (
                  <Text type="supporting" color="secondary">{copy.count(connections.length)}</Text>
                )}
              </HStack>
            )}
            endContent={(
              <Button
                ref={addButtonRef}
                variant="primary"
                label={copy.addConnection}
                onClick={() => openAddDialog()}
                data-maka-contract="add-connection"
              />
            )}
          />
          {loadError ? (
            <Banner
              status="error"
              title={copy.loadFailed}
              description={loadError}
              endContent={<Button variant="ghost" label={copy.retry} onClick={() => void reload()} />}
            />
          ) : connections.length === 0 ? (
            <EmptyState
              title={copy.empty}
              description={copy.emptyHelp}
              actions={<Button variant="primary" label={copy.addConnection} onClick={() => openAddDialog()} />}
            />
          ) : (
            <List hasDividers className="connectionList">
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
                        <span aria-label={chipAriaLabel(connection, isDefault)}>{connection.name}</span>
                        {isDefault && <Badge variant="neutral" label={copy.default} />}
                      </HStack>
                    )}
                    description={connectionSubtitle(connection, locale)}
                    endContent={(
                      <HStack gap={2} vAlign="center">
                        {status && <Badge variant={statusBadgeVariant(status.tone)} label={status.label} />}
                        <ChevronRight size={16} aria-hidden="true" />
                      </HStack>
                    )}
                    onClick={() => setRoute({ kind: 'detail', slug: connection.slug })}
                  />
                );
              })}
            </List>
          )}
          {connections.length > 0 && (
            /* The one card on the page, and it is the one thing Astryx's Card
               guidance calls a card: explanatory content beside the rows it
               explains, not a container drawn around them. */
            <Card variant="muted" padding={4}>
              <HStack gap={4} vAlign="start">
                <Center width={40} height={40} className="providerHintIcon">
                  <Icon icon={Info} />
                </Center>
                <VStack gap={1}>
                  <Text type="body" weight="semibold">{copy.defaultHintTitle}</Text>
                  <Text type="supporting" color="secondary">{copy.defaultHintBody}</Text>
                </VStack>
              </HStack>
            </Card>
          )}
        </>
      )}

      {addDialog && (
        <AddConnectionDialog
          key={addDialog.session}
          bridge={bridge}
          existingSlugs={connections.map((connection) => connection.slug)}
          isOpen={isAddDialogOpen}
          onOpenChange={handleAddDialogOpenChange}
          initialProviderType={addDialog.providerType}
          onConnectionsChanged={async () => { await reload(); }}
          onCreated={async (providerType, modelDiscoveryError) => {
            const lifecycle = addDialogLifecycleRef.current;
            const reloaded = await reload();
            if (!reloaded || !providersPanelMountedRef.current || addDialogLifecycleRef.current !== lifecycle) return;
            requestAddDialogClose();
            if (modelDiscoveryError) {
              const providerName = providerDisplay(providerType, locale).name;
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
      )}
    </VStack>
  );

  function chipAriaLabel(connection: LlmConnection, isDefault: boolean): string {
    const provider = providerDisplay(connection.providerType, locale).name;
    const status = connectionChipStatus(connection, locale);
    return copy.chipAria(connection.name, provider, isDefault, status?.label);
  }
}

/**
 * The detail page's own frame: a back affordance beside the connection name,
 * then the connection's sections. Modelled on the settings-sidebar template's
 * detail view, which puts the same Toolbar inside the content area rather than
 * reaching for a second page shell.
 */
function ConnectionDetailRoute(props: {
  bridge: ConnectionsBridge;
  connection: LlmConnection;
  isDefault: boolean;
  onBack(): void;
  onChanged(): Promise<void>;
  onDeleted(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).panel;
  return (
    <VStack gap={5} data-maka-contract="connection-detail">
      <Toolbar
        label={props.connection.name}
        gap={2}
        startContent={(
          <>
            <IconButton
              variant="ghost"
              label={copy.backToList}
              tooltip={copy.backToList}
              icon={<ArrowLeft size={16} aria-hidden="true" />}
              onClick={props.onBack}
              data-maka-contract="connection-detail-back"
            />
            <ProviderLogo type={props.connection.providerType} compact />
            <VStack gap={0}>
              <HStack gap={2} vAlign="center">
                <Heading level={3}>{props.connection.name}</Heading>
                {props.isDefault && <Badge variant="neutral" label={copy.default} />}
              </HStack>
              <Text type="supporting" color="secondary">
                {connectionSubtitle(props.connection, locale)}
              </Text>
            </VStack>
          </>
        )}
      />
      <ConnectionDetail
        key={props.connection.slug}
        bridge={props.bridge}
        connection={props.connection}
        isDefault={props.isDefault}
        onChanged={props.onChanged}
        onDeleted={props.onDeleted}
      />
    </VStack>
  );
}

/** Provider · default model — the row's second line, and the detail's subtitle. */
function connectionSubtitle(connection: LlmConnection, locale: 'zh' | 'en'): string {
  const providerName = providerDisplay(connection.providerType, locale).name;
  const parts = [providerName];
  if (connection.defaultModel) parts.push(connection.defaultModel);
  return parts.join(' · ');
}
