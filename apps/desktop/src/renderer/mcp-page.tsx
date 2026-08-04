import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import { Banner, Card, Collapsible, EmptyState, Item, Tab, TabList } from '@astryxdesign/core';
import {
  Button,
  Badge,
  IconButton,
  PageHeader,
  RadioList,
  RadioListItem,
  Selector,
  type ModuleHubHeader,
  Switch,
  TextArea,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import {
  FileCode,
  Globe,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Terminal,
  Trash2,
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

export function McpPage(props: { hubHeader?: ModuleHubHeader }) {
  const locale = useUiLocale();
  const copy = getMcpCopy(locale);
  const catalog = getMcpCatalog(locale);
  const [config, setConfig] = useState<McpConfigFile>(EMPTY_CONFIG);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [editorErrors, setEditorErrors] = useState<McpEditorErrors>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'market' | 'installed'>('market');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>('load');
  const [installPhases, setInstallPhases] = useState<Record<string, InstallPhase>>({});
  const cancelledInstalls = useRef(new Set<string>());
  const editorSessionRef = useRef(0);
  const mounted = useMountedRef();
  const toast = useToast();

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
      setActiveTab('installed');
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
      setActiveTab('installed');
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
    setBusy(`remove:${serverId}`);
    try {
      const next = await window.maka.mcp.remove(serverId);
      if (!mounted.current) return;
      setConfig(next);
      setStatuses((current) => current.filter((status) => status.serverId !== serverId));
      toast.success(copy.toast.removed);
    } catch (error) {
      if (mounted.current) toast.error(copy.errors.remove, settingsActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <main className="maka-main detailPane maka-module-main maka-mcp-page agents-chat-panel" data-maka-contract="module-main" data-module="mcp" aria-label={props.hubHeader?.title ?? 'MCP'}>
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title={props.hubHeader?.title ?? 'MCP'}
        subtitle={props.hubHeader?.subtitle ?? copy.page.subtitle}
        badge={props.hubHeader?.badge}
        headingRowClassName={props.hubHeader ? 'maka-module-hub-heading' : undefined}
        actions={
          <div
            className="maka-module-main-actions"
            data-maka-contract="module-actions"
            role="group"
            aria-label={copy.page.actionsAria}
          >
            <Button variant="primary" onClick={() => openManual()} icon={<Plus aria-hidden="true" />} label={copy.page.add} />
          </div>
        }
      />

      <section className="maka-mcp-workspace" aria-label={copy.page.workspaceAria}>
        {busy !== 'load' && entries.length === 0 ? (
          <Banner
            className="maka-mcp-setup"
            status="info"
            icon={<Plug aria-hidden="true" />}
            title={copy.page.setupTitle}
            description={copy.page.setupDescription}
          />
        ) : null}

        <div className="maka-mcp-browser">
          <div className="maka-mcp-command-bar" role="toolbar" aria-label={copy.page.toolbarAria}>
            <div className="maka-mcp-tabs">
              <TabList
                value={activeTab}
                onChange={(value) => setActiveTab(value as typeof activeTab)}
                hasDivider
                aria-label={copy.page.categoriesAria}
              >
                <Tab
                  value="market"
                  label={copy.page.market}
                  endContent={<span>{catalog.length}</span>}
                />
                <Tab
                  value="installed"
                  label={copy.page.installed}
                  endContent={<span>{entries.length}</span>}
                />
              </TabList>
            </div>
            <div className="maka-mcp-search">
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder={copy.page.searchPlaceholder}
                label={copy.page.searchAria}
                isLabelHidden
                startIcon={<Search aria-hidden="true" />}
                width="100%"
              />
            </div>
            <IconButton
              className="maka-mcp-refresh"
              variant="ghost"
              label={busy === 'load' ? copy.page.refreshing : copy.page.refresh}
              tooltip={copy.page.refresh}
              onClick={() => void reload()}
              isDisabled={busy === 'load'}
              icon={<RefreshCcw aria-hidden="true" />}
            />
          </div>

          {activeTab === 'market' ? (
            <div className="maka-mcp-tab-panel">
              {marketEntries.length > 0 ? (
              <div className="maka-mcp-market-grid" role="list">
                {marketEntries.map((entry) => (
                  <McpCatalogCard
                    key={entry.id}
                    entry={entry}
                    copy={copy}
                    installed={Boolean(config.mcpServers[entry.id])}
                    phase={installPhases[entry.id]}
                    onInstall={() => void installCatalogEntry(entry)}
                    onCancel={() => void cancelCatalogInstall(entry)}
                    onManage={() => {
                      const installed = config.mcpServers[entry.id];
                      if (installed) openEdit(entry.id, installed);
                    }}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Search />}
                title={copy.page.noMarket}
                description={copy.page.noMarketDetail(query)}
                actions={<Button variant="primary" label={copy.page.clearSearch} onClick={() => setQuery('')} />}
                className="maka-mcp-empty"
              />
              )}
            </div>
          ) : null}

          {activeTab === 'installed' ? (
            <div className="maka-mcp-tab-panel">
              {busy === 'load' ? (
              <div className="maka-mcp-loading" role="status">{copy.page.loading}</div>
            ) : entries.length === 0 ? (
              <EmptyState
                icon={<Plug />}
                title={copy.page.noInstalled}
                description={copy.page.noInstalledDetail}
                actions={<Button variant="primary" label={copy.page.browseMarket} onClick={() => setActiveTab('market')} />}
                className="maka-mcp-empty"
              />
            ) : installedEntries.length > 0 ? (
              <Card className="maka-mcp-server-list" padding={0} role="list">
                {installedEntries.map(([serverId, server]) => (
                  <McpServerRow
                    key={serverId}
                    serverId={serverId}
                    server={server}
                    status={statusById.get(serverId)}
                    busy={busy}
                    copy={copy}
                    onToggle={(enabled) => void toggle(serverId, server, enabled)}
                    onEdit={() => openEdit(serverId, server)}
                    onTest={() => void testServer(serverId)}
                    onRemove={() => void remove(serverId)}
                  />
                ))}
              </Card>
            ) : (
              <EmptyState
                icon={<Search />}
                title={copy.page.noInstalledMatch}
                description={copy.page.noInstalledMatchDetail(query)}
                actions={<Button variant="primary" label={copy.page.clearSearch} onClick={() => setQuery('')} />}
                className="maka-mcp-empty"
              />
              )}
            </div>
          ) : null}
        </div>
      </section>

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

function McpCatalogCard(props: {
  entry: McpCatalogEntry;
  copy: McpCopy;
  installed: boolean;
  phase?: InstallPhase;
  onInstall(): void;
  onCancel(): void;
  onManage(): void;
}) {
  const installing = props.phase === 'installing';
  const cancelling = props.phase === 'cancelling';
  return (
    <Card
      className="maka-mcp-market-card"
      minHeight={104}
      padding={0}
      role="listitem"
      data-maka-contract="mcp-market-card"
    >
      <Item
        className="maka-mcp-market-item"
        align="center"
        density="spacious"
        startContent={(
          <div
            className="maka-mcp-market-icon"
            data-brand={props.entry.id}
            data-logo={hasMcpBrandMark(props.entry.id) ? 'true' : undefined}
            aria-hidden="true"
          >
            <McpBrandMark entry={props.entry} />
          </div>
        )}
        label={props.entry.name}
        description={(
          <span className="maka-mcp-market-copy">
            <span>{props.entry.description}</span>
            <small>
              {props.entry.category}
              {props.entry.platform === 'darwin' ? ` · ${props.copy.card.macOnly}` : ''}
              {props.entry.setupLabel ? ` · ${props.entry.setupLabel}` : ''}
            </small>
          </span>
        )}
        endContent={props.installed ? (
          <Button size="sm" variant="secondary" onClick={props.onManage} label={props.copy.card.manage} />
        ) : (
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
        )}
      />
    </Card>
  );
}

function McpServerRow(props: {
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
  const state = presentStatus(props.status, props.server.enabled !== false, props.copy);
  const endpoint = endpointFor(props.server);
  const transportLabel = isMcpStdioConfig(props.server)
    ? props.copy.page.localStdio
    : props.server.transport ?? 'auto';
  return (
    // Astryx ListItem does not accept children. Keep this semantic wrapper so
    // the summary Item and its expandable diagnostics form one list item.
    <div className="maka-mcp-server-row" role="listitem">
      <Item
        className="maka-mcp-server-summary"
        align="start"
        density="spacious"
        descriptionLines={1}
        label={(
          <span className="maka-mcp-server-heading">
            <span>{props.serverId}</span>
            {/* Status-color restraint (#651): a healthy / expected server stays
                neutral — its label rides plain muted text. Only an error /
                unavailable server raises a toned Badge. */}
            {state.exception ? <Badge variant={state.tone} label={state.label} /> : null}
          </span>
        )}
        description={(
          <span className="maka-mcp-server-description" data-maka-contract="mcp-server-description">
            {!state.exception ? <span>{state.label} · </span> : null}
            <span>{transportLabel} · <code title={endpoint}>{endpoint}</code></span>
          </span>
        )}
        endContent={(
          <div className="maka-mcp-server-controls">
            <Switch
              value={props.server.enabled !== false}
              onChange={props.onToggle}
              isDisabled={props.busy === `toggle:${props.serverId}`}
              label={props.copy.row.enabledAria(props.serverId)}
              isLabelHidden
            />
            <div className="maka-mcp-server-actions">
              <Button
                size="sm"
                variant="secondary"
                onClick={props.onTest}
                isDisabled={props.busy === `test:${props.serverId}`}
                icon={<RefreshCcw aria-hidden="true" />}
                label={props.busy === `test:${props.serverId}` ? props.copy.row.testing : props.copy.row.test}
              />
              <IconButton size="sm" variant="ghost" label={props.copy.row.editAria(props.serverId)} tooltip={props.copy.row.edit} onClick={props.onEdit} icon={<Pencil aria-hidden="true" />} />
              <IconButton size="sm" variant="ghost" label={props.copy.row.deleteAria(props.serverId)} tooltip={props.copy.row.delete} onClick={props.onRemove} isDisabled={props.busy === `remove:${props.serverId}`} icon={<Trash2 aria-hidden="true" />} />
            </div>
          </div>
        )}
      />
      {props.status?.error ? (
        <Banner
          className="maka-mcp-server-error"
          status="error"
          title={state.label}
          description={props.status.error}
        />
      ) : null}
      {(props.status?.tools.length || props.status?.stderrTail?.length) ? (
        <Collapsible
          className="maka-mcp-server-details"
          defaultIsOpen={false}
          trigger={props.status?.tools.length ? props.copy.row.tools(props.status.tools.length) : props.copy.row.diagnostics}
        >
          {props.status?.tools.length ? (
            <div className="maka-mcp-tool-list">{props.status.tools.map((tool) => <code key={tool.name}>{tool.name}</code>)}</div>
          ) : null}
          {props.status?.stderrTail?.length ? <pre>{props.status.stderrTail.join('\n')}</pre> : null}
        </Collapsible>
      ) : null}
    </div>
  );
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
