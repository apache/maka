// apps/desktop/src/renderer/mcp-page.tsx
//
// The MCP module page, on the shared ModulePage shell (Astryx Layout, the
// vendor's incident-console archetype) — the same surface as 技能 and
// 定时任务:
//
// - header: title, a live count line, 添加 MCP and refresh;
// - toolbar (the header's last row, fixed): the hub switch, the 市场 /
//   已安装 SegmentedControl and search;
// - content: dense Astryx List rows — the market's card grid is gone, brand
//   marks ride the rows;
// - inspector: selecting an installed row opens it, and every per-server
//   control (enable / test / edit / delete) plus the connection
//   diagnostics live there.
//
// Layout owns scroll containment, so the view switch stays put while rows
// scroll — the same contract as the Skills page (#2236).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Heading,
  HStack,
  IconButton,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  StackItem,
  StatusDot,
  Switch,
  Text,
  TextInput,
  Toolbar,
  VStack,
} from '@astryxdesign/core';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import {
  ModulePage,
  RadioList,
  RadioListItem,
  Selector,
  TextArea,
  useMountedRef,
  useRovingRowFocus,
  useToast,
  useUiLocale,
  type ModuleHubHeader,
  dotForStatus,
  type StatusSemantic,
} from '@maka/ui';

import {
  FileCode,
  Globe,
  Loader2,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Terminal,
  X,
} from '@maka/ui/icons';
import { getMcpCatalog, catalogEntryMatches, type McpCatalogEntry } from './mcp-catalog';
import { McpBrandMark, hasMcpBrandMark } from './mcp-brand-marks';
import { parseMcpImport } from './mcp-import';
import { settingsActionErrorMessage } from './settings/settings-error-copy';
import { getMcpCopy, type McpCopy } from './locales/mcp-copy';
import {
  validateMcpEditorDraft,
  type McpEditorErrors,
} from './mcp-editor-validation';

type Draft = {
  id: string;
  kind: 'stdio' | 'remote';
  enabled: boolean;
  command: string;
  args: string;
  cwd: string;
  env: string;
  url: string;
  transport: 'auto' | 'streamable-http' | 'sse';
  headers: string;
};

type EditorState =
  | { mode: 'manual'; draft: Draft; editingId: string | null }
  | { mode: 'json'; source: string }
  | null;

const EMPTY_CONFIG: McpConfigFile = { version: 1, mcpServers: {} };
const MIN_INSTALL_INDICATOR_MS = 500;

type InstallPhase = 'installing' | 'cancelling';
type McpTab = 'market' | 'installed';

export function McpPage(props: { hubHeader?: ModuleHubHeader }) {
  const locale = useUiLocale();
  const copy = getMcpCopy(locale);
  const catalog = getMcpCatalog(locale);
  const [config, setConfig] = useState<McpConfigFile>(EMPTY_CONFIG);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [editorErrors, setEditorErrors] = useState<McpEditorErrors>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<McpTab>('market');
  const [query, setQuery] = useState('');
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [installPhases, setInstallPhases] = useState<Record<string, InstallPhase>>({});
  const cancelledInstalls = useRef(new Set<string>());
  const editorSessionRef = useRef(0);
  const mounted = useMountedRef();
  const toast = useToast();
  // Set when a remove starts, consumed once the row has actually left the
  // list — which only happens when the config write lands.
  const rowsContainerRef = useRef<HTMLDivElement | null>(null);
  const focusRowAfterRemovalRef = useRef<number | null>(null);
  // One tab stop for the whole installed list, same keyboard contract as the
  // skills and 定时任务 pages: without it, reaching the inspector from row
  // k of N costs N−k presses.
  const rovingRows = useRovingRowFocus(rowsContainerRef);

  function switchTab(next: McpTab) {
    // The selection belongs to the view it was made in; carrying it across
    // the switch would reopen the inspector without a user action on return.
    setSelectedServerId(null);
    setActiveTab(next);
  }

  async function reload() {
    setBusy((current) => current ?? 'load');
    try {
      const [nextConfig, nextStatuses] = await Promise.all([
        window.maka.mcp.getConfig(),
        window.maka.mcp.listStatuses(),
      ]);
      if (!mounted.current) return;
      setConfig(nextConfig);
      setStatuses(nextStatuses);
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.load, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  useEffect(() => {
    void reload();
    return window.maka.mcp.subscribeChanges((next) => {
      if (mounted.current) setStatuses(next);
    });
  }, [locale]);

  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.serverId, status])),
    [statuses],
  );
  const entries = Object.entries(config.mcpServers);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const marketEntries = catalog.filter((entry) => catalogEntryMatches(entry, normalizedQuery));
  const installedEntries = entries.filter(([serverId, server]) => {
    if (!normalizedQuery) return true;
    const status = statusById.get(serverId);
    return [serverId, endpointFor(server), ...status?.tools.map((tool) => tool.name) ?? []]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });

  // Derived, not stored: whatever hides the row — deletion, a filter, a
  // view switch — closes the inspector without a reconciliation step.
  const selectedServer = activeTab === 'installed'
    ? installedEntries.find(([serverId]) => serverId === selectedServerId) ?? null
    : null;

  // Synchronising focus with the DOM once the list it points into has been
  // re-rendered — an external system, which is what an Effect is for.
  useEffect(() => {
    const index = focusRowAfterRemovalRef.current;
    if (index == null) return;
    focusRowAfterRemovalRef.current = null;
    // A frame later, not now: the confirm dialog is still closing, and the
    // focus it hands back lands on the 删除 button being removed.
    const frame = requestAnimationFrame(() => {
      const rows = rowsContainerRef.current?.querySelectorAll<HTMLElement>('li button');
      if (!rows?.length) return;
      rows[Math.min(index, rows.length - 1)]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [config]);

  function openEditor(next: Exclude<EditorState, null>) {
    const session = ++editorSessionRef.current;
    setEditorOpen(false);
    setEditorErrors({});
    setEditor(next);
    window.requestAnimationFrame(() => {
      if (mounted.current && editorSessionRef.current === session) {
        setEditorOpen(true);
      }
    });
  }

  function closeEditor() {
    const session = editorSessionRef.current;
    setEditorOpen(false);
    window.requestAnimationFrame(() => {
      if (mounted.current && editorSessionRef.current === session) {
        setEditor(null);
        setEditorErrors({});
      }
    });
  }

  function openManual(draft: Draft = emptyDraft()) {
    openEditor({ mode: 'manual', draft: { ...draft }, editingId: null });
  }

  function openEdit(serverId: string, server: McpServerConfig) {
    openEditor({
      mode: 'manual',
      draft: draftFromConfig(serverId, server),
      editingId: serverId,
    });
  }

  async function installCatalogEntry(entry: McpCatalogEntry) {
    if (installPhases[entry.id] || config.mcpServers[entry.id]) return;
    cancelledInstalls.current.delete(entry.id);
    setInstallPhases((current) => ({ ...current, [entry.id]: 'installing' }));
    try {
      const minimumIndicator = delay(MIN_INSTALL_INDICATOR_MS);
      const next = await window.maka.mcp.install(entry.id, structuredClone(entry.config));
      await minimumIndicator;
      if (!mounted.current || cancelledInstalls.current.has(entry.id)) return;
      setConfig(next);
      if (entry.setupRequired) {
        toast.success(copy.toast.templateInstalled(entry.name), copy.toast.templateInstalledDetail);
      } else {
        toast.success(copy.toast.installed(entry.name), copy.toast.installedDetail);
      }
    } catch (error) {
      if (mounted.current && !cancelledInstalls.current.has(entry.id)) {
        toast.error(copy.errors.install(entry.name), settingsActionErrorMessage(error, locale));
      }
    } finally {
      const wasCancelled = cancelledInstalls.current.delete(entry.id);
      if (mounted.current && !wasCancelled) {
        setInstallPhases((current) => omitKey(current, entry.id));
      }
    }
  }

  async function cancelCatalogInstall(entry: McpCatalogEntry) {
    if (installPhases[entry.id] !== 'installing') return;
    cancelledInstalls.current.add(entry.id);
    setInstallPhases((current) => ({ ...current, [entry.id]: 'cancelling' }));
    try {
      const next = await window.maka.mcp.cancelInstall(entry.id);
      if (!mounted.current) return;
      setConfig(next);
      setStatuses((current) => current.filter((status) => status.serverId !== entry.id));
      toast.info(copy.toast.installCancelled(entry.name));
    } catch (error) {
      cancelledInstalls.current.delete(entry.id);
      if (mounted.current) {
        toast.error(copy.errors.cancelInstall(entry.name), settingsActionErrorMessage(error, locale));
        void reload();
      }
    } finally {
      if (mounted.current) setInstallPhases((current) => omitKey(current, entry.id));
    }
  }

  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.mode !== 'manual') return;
    const validation = validateMcpEditorDraft(editor.draft);
    if (Object.keys(validation).length > 0) {
      setEditorErrors(validation);
      return;
    }
    setEditorErrors({});
    setBusy('save');
    try {
      const next = await window.maka.mcp.upsert(editor.draft.id.trim(), configFromDraft(editor.draft, copy));
      if (!mounted.current) return;
      setConfig(next);
      closeEditor();
      switchTab('installed');
      toast.success(copy.toast.saved, copy.toast.savedDetail);
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.save, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function importJson(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.mode !== 'json') return;
    setBusy('import');
    try {
      const imported = parseMcpImport(editor.source, locale);
      const next = await window.maka.mcp.setConfig({
        version: 1,
        mcpServers: { ...config.mcpServers, ...imported.mcpServers },
      });
      if (!mounted.current) return;
      setConfig(next);
      closeEditor();
      switchTab('installed');
      toast.success(copy.toast.imported, copy.toast.importedDetail(Object.keys(imported.mcpServers).length));
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.import, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function toggle(serverId: string, server: McpServerConfig, enabled: boolean) {
    setBusy(`toggle:${serverId}`);
    try {
      const next = await window.maka.mcp.upsert(serverId, { ...server, enabled });
      if (mounted.current) setConfig(next);
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.update, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function testServer(serverId: string) {
    setBusy(`test:${serverId}`);
    try {
      const result = await window.maka.mcp.test(serverId);
      if (!mounted.current) return;
      setStatuses((current) => replaceStatus(current, result.status));
      if (result.ok) toast.success(copy.toast.connectionOk, copy.toast.toolLatency(result.status.toolCount, result.latencyMs));
      else toast.error(copy.toast.connectionFailed, result.status.error ?? copy.errors.unavailableStatus);
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.test, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function remove(serverId: string) {
    const confirmed = await toast.confirm({
      title: copy.remove.title(serverId),
      description: copy.remove.description,
      confirmLabel: copy.remove.confirm, cancelLabel: copy.remove.cancel, destructive: true,
    });
    if (!confirmed || !mounted.current) return;
    // The 删除 button is about to unmount with the whole inspector, and
    // nothing else would claim focus — hand it to the row that takes the
    // deleted one's place.
    focusRowAfterRemovalRef.current = installedEntries.findIndex(([id]) => id === serverId);
    setBusy(`remove:${serverId}`);
    try {
      const next = await window.maka.mcp.remove(serverId);
      if (!mounted.current) return;
      setConfig(next);
      setStatuses((current) => current.filter((status) => status.serverId !== serverId));
      // Drop the id too — keeping it would reopen the inspector if a server
      // with the same id is added back later, without any user action.
      setSelectedServerId((current) => (current === serverId ? null : current));
      toast.success(copy.toast.removed);
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.remove, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const connectionErrorCount = statuses.filter((status) => status.error).length;
  const searchSummary = normalizedQuery ? (
    <div className="maka-module-search-summary" role="status" aria-live="polite">
      <span>{copy.page.searchMatches(activeTab === 'market' ? marketEntries.length : installedEntries.length)}</span>
      <Button variant="ghost" size="sm" onClick={() => setQuery('')} label={copy.page.clearSearch} />
    </div>
  ) : null;

  const marketPanel = (
    <div className="maka-module-page-panel">
      {searchSummary}
      {marketEntries.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title={copy.page.noMarket}
          description={copy.page.noMarketDetail(query)}
          actions={<Button variant="ghost" size="sm" label={copy.page.clearSearch} onClick={() => setQuery('')} />}
        />
      ) : (
        <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.market}>
          {marketEntries.map((entry) => {
            const installed = Boolean(config.mcpServers[entry.id]);
            return (
              <ListItem
                key={entry.id}
                data-maka-contract="mcp-market-row"
                label={entry.name}
                description={[
                  entry.description,
                  [entry.category, entry.platform === 'darwin' ? copy.card.macOnly : null, entry.setupLabel]
                    .filter(Boolean)
                    .join(' · '),
                ].filter(Boolean).join(' · ')}
                startContent={(
                  <span
                    className="maka-mcp-market-icon"
                    data-brand={entry.id}
                    data-logo={hasMcpBrandMark(entry.id) ? 'true' : undefined}
                    aria-hidden="true"
                  >
                    <McpBrandMark entry={entry} />
                  </span>
                )}
                endContent={installed ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const server = config.mcpServers[entry.id];
                      if (server) openEdit(entry.id, server);
                    }}
                    label={copy.card.manage}
                  />
                ) : (
                  <McpInstallButton
                    entry={entry}
                    copy={copy}
                    phase={installPhases[entry.id]}
                    onInstall={() => void installCatalogEntry(entry)}
                    onCancel={() => void cancelCatalogInstall(entry)}
                  />
                )}
              />
            );
          })}
        </List>
      )}
    </div>
  );

  const installedPanel = (
    <div className="maka-module-page-panel" ref={rowsContainerRef} {...rovingRows}>
      {/* Selecting a row moves no focus, so nothing else would tell a screen
          reader that the details opened. This says so, politely. */}
      <p className="maka-visually-hidden" role="status" aria-live="polite">
        {selectedServer ? copy.detail.inspectorOpened(selectedServer[0]) : ''}
      </p>
      {searchSummary}
      {busy === 'load' ? (
        <div className="maka-mcp-loading" role="status">{copy.page.loading}</div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title={copy.page.noInstalled}
          description={copy.page.noInstalledDetail}
          actions={<Button variant="primary" label={copy.page.browseMarket} onClick={() => switchTab('market')} />}
        />
      ) : installedEntries.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title={copy.page.noInstalledMatch}
          description={copy.page.noInstalledMatchDetail(query)}
          actions={<Button variant="ghost" size="sm" label={copy.page.clearSearch} onClick={() => setQuery('')} />}
        />
      ) : (
        /* Selectable, otherwise inert rows: the switch, test, edit and
           delete controls that used to ride the row now live in the
           inspector — no interactive elements inside an interactive list
           item. */
        <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.installed}>
          {installedEntries.map(([serverId, server]) => {
            const status = statusById.get(serverId);
            const state = presentStatus(status, server.enabled !== false, copy);
            const endpoint = endpointFor(server);
            const transportLabel = isMcpStdioConfig(server)
              ? copy.page.localStdio
              : server.transport ?? 'auto';
            return (
              <ListItem
                key={serverId}
                label={serverId}
                description={(
                  <span className="maka-mcp-row-description" data-maka-contract="mcp-server-description">
                    {/* Exceptional state leads as TEXT; the healthy label
                        rides the dot's accessible name only. */}
                    {state.exception ? <span>{state.label} · </span> : null}
                    <span>{transportLabel} · <code title={endpoint}>{endpoint}</code></span>
                    {state.tone === 'success' ? <span> · {state.label}</span> : null}
                  </span>
                )}
                startContent={(
                  <StatusDot
                    variant={mcpStatusDotVariant(state)}
                    label={state.label}
                  />
                )}
                isSelected={selectedServerId === serverId}
                onClick={() => setSelectedServerId(
                  selectedServerId === serverId ? null : serverId,
                )}
              />
            );
          })}
        </List>
      )}
    </div>
  );

  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="mcp" data-maka-contract="module-main" aria-label={props.hubHeader?.title ?? 'MCP'}>
      <ModulePage
        title={props.hubHeader?.title ?? 'MCP'}
        meta={[
          copy.page.metaInstalled(entries.length),
          connectionErrorCount > 0 ? copy.page.metaErrors(connectionErrorCount) : null,
        ].filter(Boolean).join(' · ')}
        inspectorLabel={copy.detail.label}
        inspectorAutoSaveId="maka-mcp-inspector"
        onInspectorDismiss={() => setSelectedServerId(null)}
        inspector={selectedServer ? (
          <McpServerInspector
            serverId={selectedServer[0]}
            server={selectedServer[1]}
            status={statusById.get(selectedServer[0])}
            busy={busy}
            copy={copy}
            onToggle={(enabled) => void toggle(selectedServer[0], selectedServer[1], enabled)}
            onEdit={() => openEdit(selectedServer[0], selectedServer[1])}
            onTest={() => void testServer(selectedServer[0])}
            onRemove={() => void remove(selectedServer[0])}
          />
        ) : undefined}
        actions={
          <div
            className="maka-module-main-actions"
            data-maka-contract="module-actions"
            role="group"
            aria-label={copy.page.actionsAria}
          >
            <Button variant="primary" onClick={() => openManual()} icon={<Plus aria-hidden="true" />} label={copy.page.add} />
            <IconButton
              variant="ghost"
              label={busy === 'load' ? copy.page.refreshing : copy.page.refresh}
              tooltip={copy.page.refresh}
              onClick={() => void reload()}
              isDisabled={busy === 'load'}
              icon={<RefreshCcw aria-hidden="true" />}
            />
          </div>
        }
        toolbar={(
          <div className="maka-module-page-bar">
            {props.hubHeader?.badge}
            <Toolbar
              size="sm"
              label={copy.page.toolbarAria}
              startContent={(
                <SegmentedControl
                  value={activeTab}
                  onChange={(value) => {
                    if (value !== 'market' && value !== 'installed') return;
                    switchTab(value);
                  }}
                  label={copy.page.categoriesAria}
                  size="sm"
                >
                  <SegmentedControlItem value="market" label={copy.page.market} />
                  <SegmentedControlItem value="installed" label={copy.page.installed} />
                </SegmentedControl>
              )}
              endContent={(
                <TextInput
                  value={query}
                  onChange={setQuery}
                  placeholder={copy.page.searchPlaceholder}
                  label={copy.page.searchAria}
                  isLabelHidden
                  width={220}
                />
              )}
            />
          </div>
        )}
      >
        {busy !== 'load' && entries.length === 0 ? (
          <div className="maka-module-page-panel">
            <Banner
              status="info"
              icon={<Plug aria-hidden="true" />}
              title={copy.page.setupTitle}
              description={copy.page.setupDescription}
            />
          </div>
        ) : null}
        {activeTab === 'market' ? marketPanel : installedPanel}
      </ModulePage>

      {editor && (
        <McpEditorDialog
          state={editor}
          isOpen={editorOpen}
          errors={editorErrors}
          copy={copy}
          saving={busy === 'save' || busy === 'import'}
          onChange={(next, changedKey) => {
            setEditor(next);
            setEditorErrors((current) => {
              if (changedKey === undefined) {
                return {};
              }
              if (Object.keys(current).length === 0 || next.mode !== 'manual') {
                return current;
              }
              if (changedKey === 'kind') {
                return validateMcpEditorDraft(next.draft);
              }
              if (
                changedKey !== 'id' &&
                changedKey !== 'command' &&
                changedKey !== 'url'
              ) {
                return current;
              }
              const nextErrors = { ...current };
              const changedError = validateMcpEditorDraft(next.draft)[changedKey];
              if (changedError) {
                nextErrors[changedKey] = changedError;
              } else {
                delete nextErrors[changedKey];
              }
              return nextErrors;
            });
          }}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          onSave={saveDraft}
          onImport={importJson}
        />
      )}
    </main>
  );
}

function McpInstallButton(props: {
  entry: McpCatalogEntry;
  copy: McpCopy;
  phase?: InstallPhase;
  onInstall(): void;
  onCancel(): void;
}) {
  const installing = props.phase === 'installing';
  const cancelling = props.phase === 'cancelling';
  return (
    <IconButton
      className="maka-mcp-install-button"
      size="sm"
      variant="ghost"
      label={cancelling ? props.copy.card.cancellingAria(props.entry.name) : installing ? props.copy.card.cancelAria(props.entry.name) : props.copy.card.installAria(props.entry.name)}
      tooltip={cancelling ? props.copy.card.cancelling : installing ? props.copy.card.cancel : props.copy.card.install}
      onClick={installing ? props.onCancel : props.onInstall}
      isDisabled={cancelling}
      icon={props.phase ? (
        <span className="maka-mcp-install-icon" data-phase={props.phase}>
          <Loader2 className="maka-mcp-install-spinner" aria-hidden="true" />
          <X className="maka-mcp-install-cancel" aria-hidden="true" />
        </span>
      ) : <Plus aria-hidden="true" />}
    />
  );
}

function McpServerInspector(props: {
  serverId: string;
  server: McpServerConfig;
  status?: McpServerStatus;
  busy: string | null;
  copy: McpCopy;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onTest(): void;
  onRemove(): void;
}) {
  const { serverId, server, status, copy } = props;
  const state = presentStatus(status, server.enabled !== false, copy);
  const endpoint = endpointFor(server);
  const transportLabel = isMcpStdioConfig(server)
    ? copy.page.localStdio
    : server.transport ?? 'auto';
  return (
    <VStack className="maka-mcp-inspector" gap={4}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusDot variant={mcpStatusDotVariant(state)} label={state.label} />
          <Text type="supporting" color="secondary">{state.label}</Text>
        </HStack>
        <Heading level={2}>{serverId}</Heading>
        <Text type="body" color="secondary" className="maka-mcp-inspector-endpoint">
          <code>{endpoint}</code>
        </Text>
      </VStack>

      <HStack gap={3} vAlign="center">
        <StackItem size="fill">
          <Switch
            value={server.enabled !== false}
            onChange={props.onToggle}
            isDisabled={props.busy === `toggle:${serverId}`}
            label={copy.detail.enabled}
          />
        </StackItem>
      </HStack>

      <HStack gap={2} wrap="wrap">
        <Button
          size="sm"
          variant="secondary"
          onClick={props.onTest}
          isDisabled={props.busy === `test:${serverId}`}
          icon={<RefreshCcw aria-hidden="true" />}
          label={props.busy === `test:${serverId}` ? copy.row.testing : copy.row.test}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={props.onEdit}
          label={copy.row.edit}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={props.onRemove}
          isDisabled={props.busy === `remove:${serverId}`}
          label={copy.row.delete}
          style={{ color: 'var(--destructive-text)' }}
        />
      </HStack>

      {status?.error ? (
        <Banner
          status="error"
          title={state.label}
          description={status.error}
        />
      ) : null}

      <Divider />

      <MetadataList columns="single" label={{ position: 'start', width: 88 }}>
        <MetadataListItem label={copy.detail.transport}>
          <Text type="body">{transportLabel}</Text>
        </MetadataListItem>
        <MetadataListItem label={copy.detail.endpoint}>
          <Text type="body"><code>{endpoint}</code></Text>
        </MetadataListItem>
        <MetadataListItem label={copy.detail.statusLabel}>
          <Text type="body">{state.label}</Text>
        </MetadataListItem>
      </MetadataList>

      {status?.tools.length ? (
        <>
          <Divider />
          <VStack gap={2}>
            <Text type="supporting" color="secondary">
              {copy.detail.toolsLabel} · {copy.row.tools(status.tools.length)}
            </Text>
            <div className="maka-mcp-tool-list">{status.tools.map((tool) => <code key={tool.name}>{tool.name}</code>)}</div>
          </VStack>
        </>
      ) : null}
      {status?.stderrTail?.length ? (
        <pre className="maka-mcp-stderr">{status.stderrTail.join('\n')}</pre>
      ) : null}
    </VStack>
  );
}

function mcpStatusSemantic(state: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'error' }): StatusSemantic {
  if (state.tone === 'error') return 'error';
  if (state.tone === 'warning') return 'attention';
  // A connected server is healthy, not merely busy, so it takes success rather
  // than the accent it used to borrow. That accent was a workaround from
  // before this page had a word for "success" — accent means "live" everywhere
  // else (a reminder waiting to fire wears it), and spending it on health made
  // a connected server read as an in-flight one.
  if (state.tone === 'success') return 'success';
  // `info` here is genuinely quiet: 连接中 is transient and says nothing the
  // user must act on, so it sits with the neutral states rather than claiming
  // the eye. Other surfaces read their own `info` as "something is happening"
  // and choose `active` — which is why the vocabulary has no `info` rung for
  // them to disagree inside of.
  return 'neutral';
}

function mcpStatusDotVariant(state: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'error' }) {
  return dotForStatus(mcpStatusSemantic(state));
}
function McpEditorDialog(props: {
  state: Exclude<EditorState, null>;
  isOpen: boolean;
  errors: McpEditorErrors;
  copy: McpCopy;
  saving: boolean;
  onChange(
    next: Exclude<EditorState, null>,
    changedKey?: keyof Draft,
  ): void;
  onOpenChange(isOpen: boolean): void;
  onSave(event: React.FormEvent): void;
  onImport(event: React.FormEvent): void;
}) {
  const editing = props.state.mode === 'manual' && Boolean(props.state.editingId);

  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (props.state.mode !== 'manual') return;
    props.onChange(
      { ...props.state, draft: { ...props.state.draft, [key]: value } },
      key,
    );
  };
  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="maka-mcp-editor-dialog"
      width="min(92vw, 680px)"
      maxHeight="min(760px, calc(100dvh - 32px))"
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            startContent={props.state.mode === 'json' ? <FileCode /> : <Plug />}
            title={props.state.mode === 'json' ? props.copy.editor.importTitle : editing ? props.copy.editor.editTitle(props.state.draft.id) : props.copy.editor.addTitle}
            subtitle={props.state.mode === 'json' ? props.copy.editor.importSubtitle : props.copy.editor.manualSubtitle}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
        {!editing && (
          <RadioList
            className="maka-mcp-editor-choice"
            label={props.copy.editor.modeAria}
            value={props.state.mode}
            orientation="horizontal"
            onChange={(mode) => {
              props.onChange(
                mode === 'json'
                  ? { mode: 'json', source: exampleJson() }
                  : {
                      mode: 'manual',
                      draft: emptyDraft(),
                      editingId: null,
                    },
              );
            }}
          >
            <RadioListItem
              value="manual"
              label={props.copy.editor.manual}
              startContent={<Terminal className="maka-mcp-choice-icon" aria-hidden="true" />}
            />
            <RadioListItem
              value="json"
              label={props.copy.editor.pasteJson}
              startContent={<FileCode className="maka-mcp-choice-icon" aria-hidden="true" />}
            />
          </RadioList>
        )}
        {props.state.mode === 'json' ? (
          <form className="maka-mcp-json-form" onSubmit={props.onImport}>
            <div className="maka-mcp-json-field">
              <TextArea hasAutoFocus label={props.copy.editor.jsonConfig} value={props.state.source} onChange={(value) => props.onChange({ mode: 'json', source: value })} hasSpellCheck={false} rows={14} />
            </div>
            <p>{props.copy.editor.jsonHelp} <code>{'{ "mcpServers": { ... } }'}</code></p>
            {/* Stays a submit button so Enter in the textarea still imports —
                clickAction would have to replace the form's onSubmit and take
                that with it. `isLoading` is the half of the contract that does
                apply: spinner, aria-busy, and the "Loading" announcement,
                instead of the label reading 导入中… . */}
            <div className="maka-mcp-editor-footer"><Button variant="ghost" onClick={() => props.onOpenChange(false)} label={props.copy.editor.cancel} /><Button type="submit" variant="primary" isLoading={props.saving} label={props.copy.editor.importConnect} /></div>
          </form>
        ) : (
          <form className="maka-mcp-manual-form" onSubmit={props.onSave}>
            <RadioList
              className="maka-mcp-editor-choice"
              label={props.copy.editor.transportAria}
              value={props.state.draft.kind}
              orientation="horizontal"
              onChange={(kind) => updateDraft('kind', kind as Draft['kind'])}
            >
              <RadioListItem
                value="stdio"
                label={props.copy.editor.localStdio}
                startContent={<Terminal className="maka-mcp-choice-icon" aria-hidden="true" />}
              />
              <RadioListItem
                value="remote"
                label={props.copy.editor.remoteUrl}
                startContent={<Globe className="maka-mcp-choice-icon" aria-hidden="true" />}
              />
            </RadioList>
            <div className="maka-mcp-form-fields">
              <div className="maka-mcp-primary-fields">
                <TextInput hasAutoFocus={!editing} label={props.copy.editor.serverId} value={props.state.draft.id} onChange={(value) => updateDraft('id', value)} isDisabled={editing} isRequired placeholder="filesystem" status={props.errors.id ? { type: 'error', message: props.copy.editor.required } : undefined} />
                {props.state.draft.kind === 'stdio' ? (
                  <TextInput hasAutoFocus={editing} label={props.copy.editor.command} value={props.state.draft.command} onChange={(value) => updateDraft('command', value)} isRequired placeholder="npx" status={props.errors.command ? { type: 'error', message: props.copy.editor.required } : undefined} />
                ) : (
                  <TextInput hasAutoFocus={editing} label={props.copy.editor.url} value={props.state.draft.url} onChange={(value) => updateDraft('url', value)} isRequired placeholder="https://example.com/mcp" status={props.errors.url ? { type: 'error', message: props.errors.url === 'required' ? props.copy.editor.required : props.copy.editor.invalidUrl } : undefined} />
                )}
              </div>
              {props.state.draft.kind === 'stdio' ? (
                <>
                  <TextArea label={props.copy.editor.arguments} description={props.copy.editor.argumentsHelp} value={props.state.draft.args} onChange={(value) => updateDraft('args', value)} placeholder={props.copy.editor.argumentsPlaceholder} />
                  <TextArea label={props.copy.editor.environment} description={props.copy.editor.environmentHelp} value={props.state.draft.env} onChange={(value) => updateDraft('env', value)} placeholder={'KEY=value\nTOKEN=secret'} />
                  <TextInput label={props.copy.editor.workingDirectory} value={props.state.draft.cwd} onChange={(value) => updateDraft('cwd', value)} placeholder={props.copy.editor.workingDirectoryPlaceholder} />
                </>
              ) : (
                <>
                  <Selector
                    value={props.state.draft.transport}
                    options={[
                      { value: 'auto', label: props.copy.editor.transportAuto },
                      { value: 'streamable-http', label: props.copy.editor.transportStreamableHttp },
                      { value: 'sse', label: props.copy.editor.transportLegacySse },
                    ]}
                    onChange={(value) => updateDraft('transport', value as Draft['transport'])}
                    label={props.copy.editor.transportLabel}
                    width="100%"
                  />
                  <TextArea label={props.copy.editor.headers} description={props.copy.editor.headersHelp} value={props.state.draft.headers} onChange={(value) => updateDraft('headers', value)} placeholder={'Authorization=Bearer …\nX-Workspace=…'} />
                </>
              )}
            </div>
            {/* Same as the JSON form: submit semantics are the reason Enter in
                a field saves, so isLoading carries the busy state here. */}
            <div className="maka-mcp-editor-footer"><Button variant="ghost" onClick={() => props.onOpenChange(false)} label={props.copy.editor.cancel} /><Button type="submit" variant="primary" isLoading={props.saving} label={props.copy.editor.saveConnect} /></div>
          </form>
        )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function emptyDraft(): Draft {
  return { id: '', kind: 'stdio', enabled: true, command: '', args: '', cwd: '', env: '', url: '', transport: 'auto', headers: '' };
}

function draftFromConfig(id: string, config: McpServerConfig): Draft {
  if (isMcpStdioConfig(config)) {
    return { ...emptyDraft(), id, enabled: config.enabled !== false, command: config.command, args: (config.args ?? []).join('\n'), cwd: config.cwd ?? '', env: formatMap(config.env) };
  }
  return { ...emptyDraft(), id, kind: 'remote', enabled: config.enabled !== false, url: config.url, transport: config.transport ?? 'auto', headers: formatMap(config.headers) };
}

function configFromDraft(draft: Draft, copy: McpCopy): McpServerConfig {
  if (draft.kind === 'stdio') {
    return {
      enabled: draft.enabled,
      command: draft.command.trim(),
      args: draft.args.split(/\r?\n/u).filter((line) => line.length > 0),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      env: parseMap(draft.env, copy),
    };
  }
  return { enabled: draft.enabled, url: draft.url.trim(), transport: draft.transport, headers: parseMap(draft.headers, copy) };
}

function parseMap(value: string, copy: McpCopy): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(copy.errors.mapLine(index + 1));
    return [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }));
}

function formatMap(value?: Record<string, string>): string {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join('\n');
}

function endpointFor(server: McpServerConfig): string {
  return isMcpStdioConfig(server) ? [server.command, ...(server.args ?? [])].join(' ') : server.url;
}

function replaceStatus(statuses: McpServerStatus[], next: McpServerStatus): McpServerStatus[] {
  return [...statuses.filter((status) => status.serverId !== next.serverId), next];
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// `exception` marks the states that earn a toned Badge
// (status-color restraint #651). 已停用 / 未连接 / 连接中 / 已连接 are all
// expected states and stay neutral; only 连接失败 raises the destructive tone.
function presentStatus(status: McpServerStatus | undefined, enabled: boolean, copy: McpCopy): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'; exception: boolean } {
  if (!enabled || status?.state === 'disabled') return { label: copy.row.disabled, tone: 'neutral', exception: false };
  if (!status || status.state === 'disconnected') return { label: copy.row.disconnected, tone: 'neutral', exception: false };
  if (status.state === 'connecting') return { label: copy.row.connecting, tone: 'info', exception: false };
  if (status.state === 'connected') return { label: copy.row.connected(status.toolCount), tone: 'success', exception: false };
  return { label: copy.row.failed, tone: 'error', exception: true };
}

function exampleJson(): string {
  return JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder'],
      },
    },
  }, null, 2);
}
