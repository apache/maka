import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import {
  Button,
  Chip,
  DialogContent,
  DialogHeader,
  DialogRoot,
  EmptyState,
  IconButton,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  PageHeader,
  type ModuleHubHeader,
  SettingsSwitch as Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
  Textarea,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
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
  const [activeTab, setActiveTab] = useState<'market' | 'installed'>('market');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>('load');
  const [installPhases, setInstallPhases] = useState<Record<string, InstallPhase>>({});
  const cancelledInstalls = useRef(new Set<string>());
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

  function openManual(draft: Draft = emptyDraft()) {
    setEditor({ mode: 'manual', draft: { ...draft }, editingId: null });
  }

  function openEdit(serverId: string, server: McpServerConfig) {
    setEditor({ mode: 'manual', draft: draftFromConfig(serverId, server), editingId: serverId });
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
    setBusy('save');
    try {
      const next = await window.maka.mcp.upsert(editor.draft.id.trim(), configFromDraft(editor.draft, copy));
      if (!mounted.current) return;
      setConfig(next);
      setEditor(null);
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
      setEditor(null);
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
            <Button
              variant="secondary"
              onClick={() => void reload()}
              isDisabled={busy === 'load'}
              icon={<RefreshCcw aria-hidden="true" />}
              label={busy === 'load' ? copy.page.refreshing : copy.page.refresh}
            />
            <Button
              variant="secondary"
              onClick={() => setEditor({ mode: 'json', source: exampleJson() })}
              icon={<FileCode aria-hidden="true" />}
              label={copy.page.importJson}
            />
            <Button variant="primary" onClick={() => openManual()} icon={<Plus aria-hidden="true" />} label={copy.page.add} />
          </div>
        }
      />

      <section className="maka-mcp-workspace" aria-label={copy.page.workspaceAria}>
        <div className="maka-mcp-hero">
          <div>
            <strong>{copy.page.heroTitle}</strong>
            <span>{copy.page.heroDescription}</span>
          </div>
          <div className="maka-mcp-hero-signal" aria-hidden="true">
            <span><Terminal /><small>{copy.page.localStdio}</small></span>
            <span><Plug /><small>{copy.page.connections}</small></span>
            <span><Globe /><small>{copy.page.remoteHttp}</small></span>
          </div>
        </div>

        <TabsRoot value={activeTab} onValueChange={(value) => setActiveTab(value as 'market' | 'installed')}>
          <div className="maka-mcp-tabs-bar">
            <TabsList variant="underline" className="maka-mcp-tabs" aria-label={copy.page.categoriesAria}>
              <TabsTrigger className="maka-mcp-tab" value="market">{copy.page.market} <span>{catalog.length}</span></TabsTrigger>
              <TabsTrigger className="maka-mcp-tab" value="installed">{copy.page.installed} <span>{entries.length}</span></TabsTrigger>
            </TabsList>
            <InputGroup className="maka-mcp-search">
              <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={copy.page.searchPlaceholder} aria-label={copy.page.searchAria} />
            </InputGroup>
          </div>

          <TabsPanel className="maka-mcp-tab-panel" value="market">
            {marketEntries.length > 0 ? (
              <div className="maka-mcp-market-grid">
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
                Icon={Search}
                title={copy.page.noMarket}
                body={copy.page.noMarketDetail(query)}
                cta={{ label: copy.page.clearSearch, onClick: () => setQuery('') }}
                extraClassName="maka-mcp-empty"
              />
            )}
          </TabsPanel>

          <TabsPanel className="maka-mcp-tab-panel" value="installed">
            {busy === 'load' ? (
              <div className="maka-mcp-loading" role="status">{copy.page.loading}</div>
            ) : entries.length === 0 ? (
              <EmptyState
                Icon={Plug}
                title={copy.page.noInstalled}
                body={copy.page.noInstalledDetail}
                cta={{ label: copy.page.browseMarket, onClick: () => setActiveTab('market') }}
                extraClassName="maka-mcp-empty"
              />
            ) : installedEntries.length > 0 ? (
              <ul className="maka-mcp-server-list">
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
              </ul>
            ) : (
              <EmptyState
                Icon={Search}
                title={copy.page.noInstalledMatch}
                body={copy.page.noInstalledMatchDetail(query)}
                cta={{ label: copy.page.clearSearch, onClick: () => setQuery('') }}
                extraClassName="maka-mcp-empty"
              />
            )}
          </TabsPanel>
        </TabsRoot>
      </section>

      {editor && (
        <McpEditorDialog
          state={editor}
          copy={copy}
          saving={busy === 'save' || busy === 'import'}
          onChange={setEditor}
          onClose={() => setEditor(null)}
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
    <article
      className="maka-mcp-market-card"
      data-maka-contract="mcp-market-card"
    >
      <div
        className="maka-mcp-market-icon"
        data-brand={props.entry.id}
        data-logo={hasMcpBrandMark(props.entry.id) ? 'true' : undefined}
        aria-hidden="true"
      >
        <McpBrandMark entry={props.entry} />
      </div>
      <div className="maka-mcp-market-copy">
        <strong>{props.entry.name}</strong>
        <p>{props.entry.description}</p>
        <small>
          {props.entry.category}
          {props.entry.platform === 'darwin' ? ` · ${props.copy.card.macOnly}` : ''}
          {props.entry.setupLabel ? ` · ${props.entry.setupLabel}` : ''}
        </small>
      </div>
      {props.installed ? (
        <Button size="sm" variant="secondary" onClick={props.onManage} label={props.copy.card.manage} />
      ) : (
        <button
          type="button"
          className="maka-mcp-install-button"
          data-phase={props.phase ?? 'idle'}
          aria-label={cancelling ? props.copy.card.cancellingAria(props.entry.name) : installing ? props.copy.card.cancelAria(props.entry.name) : props.copy.card.installAria(props.entry.name)}
          title={cancelling ? props.copy.card.cancelling : installing ? props.copy.card.cancel : props.copy.card.install}
          onClick={installing ? props.onCancel : props.onInstall}
          disabled={cancelling}
        >
          {props.phase ? (
            <>
              <Loader2 className="maka-mcp-install-spinner animate-spin" aria-hidden="true" />
              <X className="maka-mcp-install-cancel" aria-hidden="true" />
            </>
          ) : <Plus aria-hidden="true" />}
        </button>
      )}
    </article>
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
  const transportLabel = isMcpStdioConfig(props.server) ? 'Local stdio' : props.server.transport ?? 'auto';
  return (
    <li className="maka-mcp-server-row">
      <div className="maka-mcp-server-summary">
        <span className="maka-mcp-status-dot" data-tone={state.exception ? state.tone : 'neutral'} aria-hidden="true" />
        <div className="maka-mcp-server-identity">
          <div>
            <strong>{props.serverId}</strong>
            {/* Status-color restraint (#651): a healthy / expected server stays
                neutral — its label rides plain muted text. Only an error /
                unavailable server raises a toned Chip. */}
            {state.exception
              ? <Chip size="sm" variant={state.tone}>{state.label}</Chip>
              : <span className="maka-mcp-server-state">{state.label}</span>}
          </div>
          <span>{transportLabel} · <code title={endpoint}>{endpoint}</code></span>
        </div>
        <Switch
          checked={props.server.enabled !== false}
          onChange={props.onToggle}
          disabled={props.busy === `toggle:${props.serverId}`}
          ariaLabel={props.copy.row.enabledAria(props.serverId)}
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
      {props.status?.error && <div className="maka-mcp-server-error" role="alert">{props.status.error}</div>}
      {(props.status?.tools.length || props.status?.stderrTail?.length) ? (
        <details className="maka-mcp-server-details">
          <summary>{props.status?.tools.length ? props.copy.row.tools(props.status.tools.length) : props.copy.row.diagnostics}</summary>
          {props.status?.tools.length ? (
            <div className="maka-mcp-tool-list">{props.status.tools.map((tool) => <code key={tool.name}>{tool.name}</code>)}</div>
          ) : null}
          {props.status?.stderrTail?.length ? <pre>{props.status.stderrTail.join('\n')}</pre> : null}
        </details>
      ) : null}
    </li>
  );
}

function McpEditorDialog(props: {
  state: Exclude<EditorState, null>;
  copy: McpCopy;
  saving: boolean;
  onChange(next: Exclude<EditorState, null>): void;
  onClose(): void;
  onSave(event: React.FormEvent): void;
  onImport(event: React.FormEvent): void;
}) {
  const titleId = 'maka-mcp-editor-title';
  const editing = props.state.mode === 'manual' && Boolean(props.state.editingId);
  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (props.state.mode !== 'manual') return;
    props.onChange({ ...props.state, draft: { ...props.state.draft, [key]: value } });
  };
  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="maka-modal maka-mcp-editor-dialog" aria-labelledby={titleId} showClose={false}>
        <DialogHeader
          icon={props.state.mode === 'json' ? <FileCode /> : <Plug />}
          title={props.state.mode === 'json' ? props.copy.editor.importTitle : editing ? props.copy.editor.editTitle(props.state.draft.id) : props.copy.editor.addTitle}
          titleId={titleId}
          subtitle={props.state.mode === 'json' ? props.copy.editor.importSubtitle : props.copy.editor.manualSubtitle}
          onClose={props.onClose}
        />
        {!editing && (
          <div className="maka-mcp-editor-mode" role="group" aria-label={props.copy.editor.modeAria}>
            <button type="button" aria-pressed={props.state.mode === 'manual'} data-active={props.state.mode === 'manual'} onClick={() => props.onChange({ mode: 'manual', draft: emptyDraft(), editingId: null })}>
              <Terminal aria-hidden="true" /> {props.copy.editor.manual}
            </button>
            <button type="button" aria-pressed={props.state.mode === 'json'} data-active={props.state.mode === 'json'} onClick={() => props.onChange({ mode: 'json', source: exampleJson() })}>
              <FileCode aria-hidden="true" /> {props.copy.editor.pasteJson}
            </button>
          </div>
        )}
        {props.state.mode === 'json' ? (
          <form className="maka-mcp-json-form" onSubmit={props.onImport}>
            <label><span>{props.copy.editor.jsonConfig}</span><Textarea aria-label={props.copy.editor.jsonConfig} value={props.state.source} onChange={(event) => props.onChange({ mode: 'json', source: event.currentTarget.value })} spellCheck={false} /></label>
            <p>{props.copy.editor.jsonHelp} <code>{'{ "mcpServers": { ... } }'}</code></p>
            <div className="maka-mcp-editor-footer"><Button variant="ghost" onClick={props.onClose} label={props.copy.editor.cancel} /><Button type="submit" variant="primary" isDisabled={props.saving} label={props.saving ? props.copy.editor.importing : props.copy.editor.importConnect} /></div>
          </form>
        ) : (
          <form className="maka-mcp-manual-form" onSubmit={props.onSave}>
            <div className="maka-mcp-kind-picker" role="group" aria-label={props.copy.editor.transportAria}>
              <button type="button" aria-pressed={props.state.draft.kind === 'stdio'} data-active={props.state.draft.kind === 'stdio'} onClick={() => updateDraft('kind', 'stdio')}><Terminal aria-hidden="true" /> {props.copy.editor.localStdio}</button>
              <button type="button" aria-pressed={props.state.draft.kind === 'remote'} data-active={props.state.draft.kind === 'remote'} onClick={() => updateDraft('kind', 'remote')}><Globe aria-hidden="true" /> {props.copy.editor.remoteUrl}</button>
            </div>
            <div className="maka-mcp-form-fields">
              <label className="settingsField"><span>Server ID</span><Input value={props.state.draft.id} onChange={(event) => updateDraft('id', event.currentTarget.value)} disabled={editing} required placeholder="filesystem" /><small>{props.copy.editor.serverIdHelp}</small></label>
              {props.state.draft.kind === 'stdio' ? (
                <>
                  <label className="settingsField"><span>Command</span><Input value={props.state.draft.command} onChange={(event) => updateDraft('command', event.currentTarget.value)} required placeholder="npx" /></label>
                  <label className="settingsField"><span>Arguments</span><Textarea value={props.state.draft.args} onChange={(event) => updateDraft('args', event.currentTarget.value)} placeholder={props.copy.editor.argumentsPlaceholder} /><small>{props.copy.editor.argumentsHelp}</small></label>
                  <details className="maka-mcp-advanced"><summary>{props.copy.editor.advanced}</summary><div>
                    <label className="settingsField"><span>Working directory</span><Input value={props.state.draft.cwd} onChange={(event) => updateDraft('cwd', event.currentTarget.value)} placeholder={props.copy.editor.workingDirectoryPlaceholder} /></label>
                    <label className="settingsField"><span>Environment</span><Textarea value={props.state.draft.env} onChange={(event) => updateDraft('env', event.currentTarget.value)} placeholder={'KEY=value\nTOKEN=secret'} /><small>{props.copy.editor.environmentHelp}</small></label>
                  </div></details>
                </>
              ) : (
                <>
                  <label className="settingsField"><span>MCP URL</span><Input type="url" value={props.state.draft.url} onChange={(event) => updateDraft('url', event.currentTarget.value)} required placeholder="https://example.com/mcp" /></label>
                  <details className="maka-mcp-advanced"><summary>{props.copy.editor.advanced}</summary><div>
                    <label className="settingsField"><span>Transport</span><select value={props.state.draft.transport} onChange={(event) => updateDraft('transport', event.currentTarget.value as Draft['transport'])}><option value="auto">Auto fallback</option><option value="streamable-http">Streamable HTTP</option><option value="sse">Legacy SSE</option></select></label>
                    <label className="settingsField"><span>HTTP headers</span><Textarea value={props.state.draft.headers} onChange={(event) => updateDraft('headers', event.currentTarget.value)} placeholder={'Authorization=Bearer …\nX-Workspace=…'} /><small>{props.copy.editor.headersHelp}</small></label>
                  </div></details>
                </>
              )}
            </div>
            <div className="maka-mcp-editor-footer"><Button variant="ghost" onClick={props.onClose} label={props.copy.editor.cancel} /><Button type="submit" variant="primary" isDisabled={props.saving} label={props.saving ? props.copy.editor.saving : props.copy.editor.saveConnect} /></div>
          </form>
        )}
      </DialogContent>
    </DialogRoot>
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

// `exception` marks the states that earn a toned Chip + colored status dot
// (status-color restraint #651). 已停用 / 未连接 / 连接中 / 已连接 are all
// expected states and stay neutral; only 连接失败 raises the destructive tone.
function presentStatus(status: McpServerStatus | undefined, enabled: boolean, copy: McpCopy): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive'; exception: boolean } {
  if (!enabled || status?.state === 'disabled') return { label: copy.row.disabled, tone: 'neutral', exception: false };
  if (!status || status.state === 'disconnected') return { label: copy.row.disconnected, tone: 'neutral', exception: false };
  if (status.state === 'connecting') return { label: copy.row.connecting, tone: 'info', exception: false };
  if (status.state === 'connected') return { label: copy.row.connected(status.toolCount), tone: 'success', exception: false };
  return { label: copy.row.failed, tone: 'destructive', exception: true };
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
