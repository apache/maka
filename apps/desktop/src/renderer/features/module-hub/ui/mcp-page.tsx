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

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  McpConfigImportResult,
  McpOAuthConfig,
  McpProtocolPreference,
  McpServerConfig,
  McpServerStatus,
} from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import {
  Button,
  Collapsible,
  Divider,
  EmptyState,
  Heading,
  HStack,
  IconButton,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
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
import { Banner } from '@astryxdesign/core/Banner';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import {
  ModulePage,
  BotBrandLogo,
  Selector,
  TextArea,
  useMountedRef,
  useRovingRowFocus,
  useToast,
  useUiLocale,
  type ModuleHubHeader,
  type ModulePageDetail,
  type StatusSemantic,
  dotForStatus,
} from '@maka/ui';

import {
  Globe,
  ICON_SIZE,
  Plus,
  RefreshCcw,
  Search,
  Terminal,
} from '@maka/ui/icons';
import {
  createEmptyMcpDraft,
  mcpConfigFromDraft,
  mcpDraftProtocolPreference,
  mcpDraftFromConfig,
  mcpWriteFailureMessage,
  type McpEditorDraft,
} from '../model/mcp-page-model.js';
import { classifiedErrorFallback } from '../../../application/contracts/operation-diagnostics.js';
import { getMcpCopy, type McpCopy } from '../../../locales/mcp-copy.js';
import { getSettingsSharedCopy } from '../../../locales/settings-shared-copy.js';
import { formatCommandLine } from '../model/mcp-command-line.js';
import { defaultRuntimeHostDiagnosticTarget } from '../controller/default-runtime-host.js';
import { useMcpController } from '../controller/use-mcp-controller.js';
import {
  validateMcpEditorDraft,
  type McpEditorErrors,
} from '../model/mcp-editor-validation.js';

// Holds both ways of adding, so switching between them keeps what was typed.
type EditorState = {
  mode: 'manual' | 'json';
  draft: McpEditorDraft;
  source: string;
  // `basis` is the server as the editor opened it, to notice a change made
  // elsewhere (the TUI edits the same file) while this one is open.
  editing: { id: string; basis: McpServerConfig } | null;
} | null;

type McpEditConflict = 'changed' | 'removed' | null;

type McpMarkSource = { image: string } | { mask: string } | 'feishu';
type McpSuggestion = { id: 'notion' | 'linear' | 'feishu' | 'mcp-docs'; url: string; mark: McpMarkSource };

// Notion's mark paints its own white page, so it stays an image; the
// single-colour Linear and MCP marks are masks that take the plate's ink.
const MCP_SUGGESTIONS: readonly McpSuggestion[] = [
  { id: 'notion', url: 'https://mcp.notion.com/mcp', mark: { image: new URL('../../../assets/provider-brands/notion.svg', import.meta.url).href } },
  { id: 'linear', url: 'https://mcp.linear.app/mcp', mark: { mask: new URL('../../../assets/provider-brands/linear.svg', import.meta.url).href } },
  { id: 'feishu', url: 'https://mcp.feishu.cn/mcp', mark: 'feishu' },
  { id: 'mcp-docs', url: 'https://modelcontextprotocol.io/mcp', mark: { mask: new URL('../../../assets/provider-brands/mcp.svg', import.meta.url).href } },
];

const SEARCH_MIN_CONNECTIONS = 8;

export function McpPage(props: { hubHeader?: ModuleHubHeader }) {
  const locale = useUiLocale();
  const copy = getMcpCopy(locale);
  const controller = useMcpController();
  const { config, statuses, busy, reload, error } = controller;
  const [editor, setEditor] = useState<EditorState>(null);
  const [editorErrors, setEditorErrors] = useState<McpEditorErrors>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const editorSessionRef = useRef(0);
  const mounted = useMountedRef();
  const toast = useToast();
  useEffect(() => {
    if (error) toast.error(copy.errors.update, mcpWriteFailureMessage(error, copy) ?? classifiedErrorFallback(error, getSettingsSharedCopy(locale).unknownError, locale, 'mcp'), undefined, defaultRuntimeHostDiagnosticTarget(error));
  }, [error, locale, copy, toast]);
  // Set when a remove starts, consumed once the row has actually left the
  // list — which only happens when the config write lands.
  const rowsContainerRef = useRef<HTMLDivElement | null>(null);
  const focusRowAfterRemovalRef = useRef<number | null>(null);
  // One tab stop for the whole connection list, same keyboard contract as the
  // skills and 定时任务 pages.
  const rovingRows = useRovingRowFocus(rowsContainerRef);

  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.serverId, status])),
    [statuses],
  );
  const entries = Object.entries(config.mcpServers);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const connectionEntries = entries.filter(([serverId, server]) => {
    if (!normalizedQuery) return true;
    const status = statusById.get(serverId);
    return [serverId, endpointFor(server), ...status?.tools.map((tool) => tool.name) ?? []]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const configuredHosts = new Set(entries.map(([, server]) => hostOf(server)).filter(Boolean));
  const suggestions = busy === 'load' ? [] : MCP_SUGGESTIONS.filter((suggestion) => !configuredHosts.has(hostOf(suggestion)));

  // Derived, not stored: deleting or filtering out a row closes its detail.
  const selectedServer = connectionEntries.find(([serverId]) => serverId === selectedServerId) ?? null;
  const editedServer = editor?.editing && Object.hasOwn(config.mcpServers, editor.editing.id)
    ? config.mcpServers[editor.editing.id]
    : undefined;
  // A save of our own refreshes the config too, before the editor closes.
  const editConflict: McpEditConflict = !editor?.editing || !editorOpen || busy === 'save' ? null
    : !editedServer ? 'removed'
    : JSON.stringify(editedServer) !== JSON.stringify(editor.editing.basis) ? 'changed'
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

  function openEdit(serverId: string, server: McpServerConfig) {
    openEditor({
      mode: 'manual',
      draft: mcpDraftFromConfig(serverId, server),
      source: '',
      editing: { id: serverId, basis: server },
    });
  }

  async function addSuggestion(suggestion: McpSuggestion) {
    const server: McpServerConfig = { enabled: true, url: suggestion.url, transport: 'auto', protocol: 'auto' };
    const result = await controller.add(suggestion.id, server);
    if (!result || !mounted.current) return;
    if (result.status === 'exists') {
      openEditor({ mode: 'manual', draft: mcpDraftFromConfig(suggestion.id, server), source: '', editing: null });
      setEditorErrors({ id: 'exists' });
      return;
    }
    setSelectedServerId(suggestion.id);
    toast.success(copy.toast.saved, copy.toast.savedDetail);
  }

  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.mode !== 'manual') return;
    const validation = validateMcpEditorDraft(editor.draft);
    setEditorErrors(validation);
    if (Object.keys(validation).length) return;
    let server: McpServerConfig;
    try { server = mcpConfigFromDraft(editor.draft, copy); }
    catch (failure) { toast.error(copy.errors.save, classifiedErrorFallback(failure, getSettingsSharedCopy(locale).unknownError, locale, 'mcp')); return; }
    const id = editor.draft.id.trim();
    // Checked against the server as shown now, not as opened: a change made
    // elsewhere already shows as the notice, so saving replaces it. One not
    // shown yet comes back stale, and the refresh brings up the notice.
    const result = editor.editing
      ? editedServer && await controller.update(id, server, editedServer)
      : await controller.add(id, server);
    if (!result || !mounted.current) return;
    if (result.status === 'exists') { setEditorErrors({ id: 'exists' }); return; }
    if (result.status === 'stale') return;
    closeEditor();
    setSelectedServerId(id);
    toast.success(copy.toast.saved, copy.toast.savedDetail);
  }

  async function importJson(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.mode !== 'json') return;
    const result = await controller.importConfig(editor.source);
    if (!result || !mounted.current) return;
    if (result.status === 'invalid') { toast.error(copy.errors.import, mcpImportFailureMessage(result, copy)); return; }
    closeEditor();
    setSelectedServerId(null);
    toast.success(copy.toast.imported, copy.toast.importedDetail(result.importedCount));
  }

  async function testServer(serverId: string) {
    const result = await controller.test(serverId);
    if (!result || !mounted.current) return;
    if (result.ok) toast.success(copy.toast.connectionOk, copy.toast.toolLatency(result.status.toolCount, result.latencyMs));
    else if (result.status.state !== 'needs-auth') toast.error(copy.toast.connectionFailed, result.status.error ?? copy.errors.unavailableStatus);
  }

  async function remove(serverId: string) {
    const confirmed = await toast.confirm({
      title: copy.remove.title(serverId), description: copy.remove.description,
      confirmLabel: copy.remove.confirm, cancelLabel: copy.remove.cancel, destructive: true,
    });
    if (!confirmed || !mounted.current) return;
    focusRowAfterRemovalRef.current = connectionEntries.findIndex(([id]) => id === serverId);
    const result = await controller.remove(serverId);
    if (!result || !mounted.current) return;
    setSelectedServerId(null);
    toast.success(copy.toast.removed);
  }

  const attentionCount = entries.filter(([serverId, server]) => {
    const { status } = presentStatus(statusById.get(serverId), server.enabled !== false, copy);
    return status === 'attention' || status === 'error';
  }).length;
  const searchVisible = entries.length >= SEARCH_MIN_CONNECTIONS || normalizedQuery !== '';

  const connectionsPanel = busy === 'load' || entries.length > 0 ? (
    <div className="maka-module-page-panel" ref={rowsContainerRef} {...rovingRows}>
      {normalizedQuery ? (
        <div className="maka-module-search-summary" role="status" aria-live="polite">
          <span>{copy.page.searchMatches(connectionEntries.length)}</span>
          <Button variant="ghost" size="sm" onClick={() => setQuery('')} label={copy.page.clearSearch} />
        </div>
      ) : null}
      {busy === 'load' ? (
        /* Loading (DESIGN.md §10): rows are predictable, so the list loads as
           row-shaped skeletons in the rows' own geometry — three rows, this
           surface's typical ready count. */
        <div className="maka-module-list-skeleton" role="status" aria-busy="true" aria-label={copy.page.loading}>
          {[0, 1, 2].map((index) => (
            <div key={index} className="maka-module-list-skeleton-row" aria-hidden="true">
              <Skeleton width={28} height={28} radius={2} index={index} />
              <div className="maka-module-list-skeleton-lines">
                <Skeleton width="32%" height={12} radius="rounded" index={index} />
                <Skeleton width="68%" height={10} radius="rounded" index={index} />
              </div>
            </div>
          ))}
        </div>
      ) : connectionEntries.length === 0 ? (
        <EmptyState
          icon={<Search size={ICON_SIZE.empty} />}
          title={copy.page.noConnectionsMatch}
          description={copy.page.noConnectionsMatchDetail(query)}
          actions={<Button variant="ghost" size="sm" label={copy.page.clearSearch} onClick={() => setQuery('')} />}
        />
      ) : (
        /* Selectable, otherwise inert rows: every per-connection control lives
           in the detail dialog — no interactive elements inside an interactive
           list item. */
        <List
          density="balanced"
          hasDividers
          className="maka-module-page-rows"
          header={<Heading level={2} className="maka-mcp-section-heading">{copy.page.connections}</Heading>}
        >
          {connectionEntries.map(([serverId, server]) => {
            const state = presentStatus(statusById.get(serverId), server.enabled !== false, copy);
            const endpoint = endpointFor(server);
            return (
              <ListItem
                key={serverId}
                label={serverId}
                description={(
                  <span className="maka-module-row-description" data-maka-contract="mcp-server-description">
                    <code title={endpoint}>{endpoint}</code>
                  </span>
                )}
                startContent={<McpMark server={server} />}
                endContent={<McpStatusLabel state={state} />}
                isSelected={selectedServerId === serverId}
                onClick={() => setSelectedServerId(serverId)}
              />
            );
          })}
        </List>
      )}
    </div>
  ) : null;

  return (
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="mcp" data-maka-contract="module-main" aria-label={props.hubHeader?.title ?? 'MCP'}>
      <ModulePage
        title={props.hubHeader?.title ?? 'MCP'}
        meta={[
          copy.page.metaConnections(entries.length),
          attentionCount > 0 ? copy.page.metaAttention(attentionCount) : null,
        ].filter(Boolean).join(' · ')}
        onDetailDismiss={() => setSelectedServerId(null)}
        // The editor takes the detail's place instead of stacking on it;
        // closing the editor brings the detail back.
        detail={selectedServer && !editor ? mcpServerDetail({
          serverId: selectedServer[0],
          server: selectedServer[1],
          status: statusById.get(selectedServer[0]),
          busy,
          copy,
          onToggle: (enabled) => void controller.setEnabled(selectedServer[0], enabled),
          onEdit: () => openEdit(selectedServer[0], selectedServer[1]),
          onTest: () => void testServer(selectedServer[0]),
          onRemove: () => void remove(selectedServer[0]),
          onLogin: () => void controller.login(selectedServer[0]),
          onCancelLogin: () => void controller.cancelLogin(selectedServer[0]),
          onLogout: () => void controller.logout(selectedServer[0]),
        }) : undefined}
        actions={
          <div
            className="maka-module-main-actions"
            data-maka-contract="module-actions"
            role="group"
            aria-label={copy.page.actionsAria}
          >
            <Button variant="primary" onClick={() => openEditor({ mode: 'manual', draft: { ...createEmptyMcpDraft(), kind: 'remote' }, source: '', editing: null })} isDisabled={busy !== null} icon={<Plus size={ICON_SIZE.chrome} aria-hidden="true" />} label={copy.page.add} />
            <IconButton
              variant="ghost"
              label={busy === 'load' ? copy.page.refreshing : copy.page.refresh}
              tooltip={copy.page.refresh}
              onClick={() => void reload()}
              isDisabled={busy === 'load'}
              icon={<RefreshCcw size={ICON_SIZE.chrome} aria-hidden="true" />}
            />
          </div>
        }
        toolbar={(
          <div className="maka-module-page-bar">
            {props.hubHeader?.badge}
            <Toolbar
              size="sm"
              label={copy.page.toolbarAria}
              endContent={searchVisible ? (
                <TextInput
                  value={query}
                  onChange={setQuery}
                  placeholder={copy.page.searchPlaceholder}
                  label={copy.page.searchAria}
                  isLabelHidden
                  width={220}
                />
              ) : undefined}
            />
          </div>
        )}
      >
        <VStack gap={0}>
          {connectionsPanel}
          {suggestions.length > 0 ? (
            <div className="maka-module-page-panel">
              <List
                density="balanced"
                hasDividers
                className="maka-module-page-rows"
                header={<Heading level={2} className="maka-mcp-section-heading">{copy.page.recommended}</Heading>}
              >
                {suggestions.map((suggestion) => {
                  const { name, description } = copy.page.suggestions[suggestion.id];
                  return (
                    <ListItem
                      key={suggestion.id}
                      label={name}
                      description={description}
                      startContent={<McpMark suggestion={suggestion} />}
                      endContent={(
                        <IconButton
                          variant="secondary"
                          size="sm"
                          label={copy.page.addSuggestion(name)}
                          tooltip={copy.page.addSuggestion(name)}
                          isDisabled={busy !== null}
                          onClick={() => void addSuggestion(suggestion)}
                          icon={<Plus size={ICON_SIZE.chrome} aria-hidden="true" />}
                        />
                      )}
                    />
                  );
                })}
              </List>
            </div>
          ) : null}
        </VStack>
      </ModulePage>

      {editor && (
        <McpEditorDialog
          state={editor}
          isOpen={editorOpen}
          errors={editorErrors}
          conflict={editConflict}
          copy={copy}
          saving={busy === 'save' || busy === 'import'}
          onChange={(next) => {
            setEditor(next);
            setEditorErrors((current) => next.mode === 'manual' && Object.keys(current).length ? validateMcpEditorDraft(next.draft) : {});
          }}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          onSave={saveDraft}
          onImport={importJson}
        />
      )}
    </section>
  );
}

function mcpImportFailureMessage(
  result: Extract<McpConfigImportResult, { status: 'invalid' }>,
  copy: McpCopy,
): string {
  switch (result.reason) {
    case 'invalid-json':
      return copy.errors.importJson;
    case 'not-object':
      return copy.errors.importObject;
    case 'unsupported-version':
      return copy.errors.importVersion(result.version ?? '?');
    case 'missing-servers':
      return copy.errors.importServersObject;
    case 'protocol-version':
      return copy.errors.importProtocolVersion;
  }
}

function McpMark(props: { server: McpServerConfig } | { suggestion: McpSuggestion }) {
  const suggestion = 'suggestion' in props
    ? props.suggestion
    : MCP_SUGGESTIONS.find((candidate) => hostOf(candidate) === hostOf(props.server));
  const mark = suggestion?.mark;
  // Feishu's mark is already an app-icon tile, so it takes the plate's place.
  if (mark === 'feishu') return <BotBrandLogo provider="feishu" width={ICON_SIZE.plate} height={ICON_SIZE.plate} className="maka-mcp-mark" aria-hidden="true" />;
  return (
    <span className="maka-module-market-icon maka-mcp-mark" aria-hidden="true">
      {mark && 'image' in mark ? <img src={mark.image} alt="" />
        : mark ? <span className="providerAssetMask" style={{ maskImage: `url("${mark.mask}")`, WebkitMaskImage: `url("${mark.mask}")` }} />
        : 'server' in props && isMcpStdioConfig(props.server) ? <Terminal size={ICON_SIZE.empty} />
        : <Globe size={ICON_SIZE.empty} />}
    </span>
  );
}

// The dot is decoration beside the same words, so only the words are read.
function McpStatusLabel(props: { state: McpStatusPresentation }) {
  const { status, label } = props.state;
  const dot = status === 'attention' || status === 'error' ? dotForStatus(status)
    : status === 'active' ? 'neutral'
    : null;
  return (
    <HStack gap={2} vAlign="center" wrap="nowrap">
      {dot ? (
        <span aria-hidden="true" className="maka-mcp-status-dot">
          <StatusDot variant={dot} label={label} isPulsing={status === 'active'} />
        </span>
      ) : null}
      <Text type="supporting" color="secondary">{label}</Text>
    </HStack>
  );
}

function mcpServerDetail(props: {
  serverId: string;
  server: McpServerConfig;
  status?: McpServerStatus;
  busy: string | null;
  copy: McpCopy;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onTest(): void;
  onRemove(): void;
  onLogin(): void;
  onCancelLogin(): void;
  onLogout(): void;
}): ModulePageDetail {
  const { serverId, server, status, copy } = props;
  const state = presentStatus(status, server.enabled !== false, copy);
  const loginActive = status?.authorizationPending || props.busy === `login:${serverId}`;
  const disabled = props.busy !== null || loginActive;
  const note = loginActive ? copy.row.loginPending : status?.error;
  return {
    title: serverId,
    subtitle: state.label,
    startContent: <McpMark server={server} />,
    content: (
      <VStack gap={4}>
        {note ? <Text type="body" color="secondary">{note}</Text> : null}
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <Switch
              value={server.enabled !== false}
              onChange={props.onToggle}
              isDisabled={disabled}
              label={copy.detail.enabled}
            />
          </StackItem>
          {loginActive ? (
            <Button size="sm" variant="secondary" onClick={props.onCancelLogin} label={copy.row.cancelLogin} />
          ) : (
            <>
              {status?.authenticated ? (
                <Button size="sm" variant="secondary" isDisabled={disabled} onClick={props.onLogout} label={copy.row.logout} />
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={props.onTest}
                isDisabled={disabled}
                isLoading={props.busy === `test:${serverId}`}
                label={copy.row.test}
              />
              {status?.state === 'needs-auth' ? (
                <Button size="sm" variant="primary" isDisabled={disabled} onClick={props.onLogin} label={copy.row.login} />
              ) : null}
            </>
          )}
        </HStack>

        <Divider />

        <MetadataList columns="single" label={{ position: 'start', width: 72 }}>
          <MetadataListItem label={isMcpStdioConfig(server) ? copy.editor.command : copy.detail.address}>
            <code className="maka-mcp-detail-endpoint">{endpointFor(server)}</code>
          </MetadataListItem>
        </MetadataList>

        {status?.tools.length ? (
          <VStack gap={2}>
            <Text type="label" color="secondary">{copy.detail.tools}</Text>
            <List density="compact" hasDividers>
              {status.tools.map((tool) => (
                <ListItem key={tool.name} label={tool.name} description={tool.description} />
              ))}
            </List>
          </VStack>
        ) : null}

        {status?.stderrTail?.length ? (
          <VStack gap={2}>
            <Text type="label" color="secondary">{copy.detail.stderr}</Text>
            <pre className="maka-mcp-stderr">{status.stderrTail.join('\n')}</pre>
          </VStack>
        ) : null}
      </VStack>
    ),
    footer: (
      <HStack gap={2} vAlign="center">
        <Button variant="destructive" onClick={props.onRemove} isDisabled={disabled} label={copy.row.delete} />
        <StackItem size="fill" />
        <Button variant="secondary" onClick={props.onEdit} isDisabled={disabled} label={copy.row.edit} />
      </HStack>
    ),
  };
}

function McpEditorDialog(props: {
  state: Exclude<EditorState, null>;
  isOpen: boolean;
  errors: McpEditorErrors;
  conflict: McpEditConflict;
  copy: McpCopy;
  saving: boolean;
  onChange(
    next: Exclude<EditorState, null>,
    changedKey?: keyof McpEditorDraft,
  ): void;
  onOpenChange(isOpen: boolean): void;
  onSave(event: React.FormEvent): void;
  onImport(event: React.FormEvent): void;
}) {
  const editing = Boolean(props.state.editing);
  const draft = props.state.mode === 'manual' ? props.state.draft : null;
  const hasAdvancedSettings = Boolean(draft && (
    draft.kind === 'stdio'
      ? draft.env.trim() || draft.cwd.trim() || mcpDraftProtocolPreference(draft) !== 'auto'
      : draft.transport !== 'auto' || draft.headers.trim() || draft.oauth || mcpDraftProtocolPreference(draft) !== 'auto'
  ));
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedSettings);
  useEffect(() => {
    if (hasAdvancedSettings) setAdvancedOpen(true);
  }, [hasAdvancedSettings]);

  const updateDraft = <K extends keyof McpEditorDraft>(key: K, value: McpEditorDraft[K]) => {
    props.onChange(
      { ...props.state, draft: { ...props.state.draft, [key]: value } },
      key,
    );
  };
  const updateOAuth = <K extends keyof McpOAuthConfig>(key: K, value: McpOAuthConfig[K]) => {
    const oauth = { ...props.state.draft.oauth, [key]: value };
    updateDraft('oauth', Object.values(oauth).some((value) => value !== undefined) ? oauth : undefined);
  };
  const modeSwitch = editing ? null : (
    <Button
      variant="ghost"
      className="maka-mcp-editor-mode"
      label={props.state.mode === 'json' ? props.copy.editor.manual : props.copy.editor.pasteJson}
      onClick={() => props.onChange({ ...props.state, mode: props.state.mode === 'json' ? 'manual' : 'json' })}
    />
  );
  const cancel = <Button variant="ghost" onClick={() => props.onOpenChange(false)} label={props.copy.editor.cancel} />;
  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="maka-mcp-editor-dialog"
      width="min(92vw, 560px)"
      maxHeight="min(760px, calc(100dvh - 32px))"
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            title={props.state.mode === 'json' ? props.copy.editor.importTitle : editing ? props.copy.editor.editTitle(props.state.draft.id) : props.copy.editor.addTitle}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
        {props.state.mode === 'json' ? (
          <form className="maka-mcp-json-form" onSubmit={props.onImport}>
            <div className="maka-mcp-json-field">
              <TextArea hasAutoFocus label={props.copy.editor.jsonConfig} description={props.copy.editor.jsonHelp} value={props.state.source} onChange={(value) => props.onChange({ ...props.state, source: value })} hasSpellCheck={false} rows={14} placeholder={'{\n  "mcpServers": {\n    "my-tools": { "url": "https://example.com/mcp" }\n  }\n}'} />
            </div>
            {/* Stays a submit button so Enter in the textarea still imports —
                clickAction would have to replace the form's onSubmit and take
                that with it. */}
            <div className="maka-mcp-editor-footer">{modeSwitch}{cancel}<Button type="submit" variant="primary" isLoading={props.saving} isDisabled={!props.state.source.trim()} label={props.copy.editor.importConnect} /></div>
          </form>
        ) : (
          <form className="maka-mcp-manual-form" onSubmit={props.onSave}>
            <div className="maka-mcp-form-fields">
              {props.conflict === 'removed' ? (
                <Banner status="error" role="alert" title={props.copy.editor.removedElsewhere} />
              ) : props.conflict === 'changed' ? (
                <Banner status="warning" role="alert" title={props.copy.editor.changedElsewhere} description={props.copy.editor.changedElsewhereDetail} />
              ) : null}
              <HStack>
                <SegmentedControl
                  value={props.state.draft.kind}
                  onChange={(kind) => updateDraft('kind', kind as McpEditorDraft['kind'])}
                  label={props.copy.editor.transportAria}
                  size="sm"
                >
                  <SegmentedControlItem value="remote" label={props.copy.editor.remoteUrl} />
                  <SegmentedControlItem value="stdio" label={props.copy.editor.localStdio} />
                </SegmentedControl>
              </HStack>
              <div className="maka-mcp-primary-fields">
                <TextInput hasAutoFocus={!editing} label={props.copy.editor.serverId} value={props.state.draft.id} onChange={(value) => updateDraft('id', value)} isDisabled={editing} isRequired placeholder="my-tools" status={props.errors.id ? { type: 'error', message: props.errors.id === 'exists' ? props.copy.editor.idExists : props.copy.editor.required } : undefined} />
                {props.state.draft.kind === 'stdio' ? (
                  <TextInput hasAutoFocus={editing} label={props.copy.editor.command} description={props.copy.editor.commandHelp} value={props.state.draft.commandLine} onChange={(value) => updateDraft('commandLine', value)} isRequired placeholder={props.copy.editor.commandPlaceholder} status={props.errors.commandLine ? { type: 'error', message: props.errors.commandLine === 'unbalanced-quote' ? props.copy.editor.unbalancedQuote : props.copy.editor.required } : undefined} />
                ) : (
                  <TextInput hasAutoFocus={editing} label={props.copy.editor.url} value={props.state.draft.url} onChange={(value) => updateDraft('url', value)} isRequired placeholder="https://example.com/mcp" status={props.errors.url ? { type: 'error', message: props.errors.url === 'required' ? props.copy.editor.required : props.copy.editor.invalidUrl } : undefined} />
                )}
              </div>
              <Collapsible
                trigger={props.copy.editor.advanced}
                isOpen={advancedOpen}
                onOpenChange={setAdvancedOpen}
              >
                <VStack gap={3} className="maka-mcp-advanced-fields">
                  {props.state.draft.kind === 'stdio' ? (
                    <>
                      <TextArea label={props.copy.editor.environment} description={props.copy.editor.environmentHelp} value={props.state.draft.env} onChange={(value) => updateDraft('env', value)} />
                      <TextInput label={props.copy.editor.workingDirectory} value={props.state.draft.cwd} onChange={(value) => updateDraft('cwd', value)} placeholder={props.copy.editor.workingDirectoryPlaceholder} />
                    </>
                  ) : (
                    <>
                      <TextArea label={props.copy.editor.headers} description={props.copy.editor.headersHelp} value={props.state.draft.headers} onChange={(value) => updateDraft('headers', value)} />
                      <Selector
                        value={props.state.draft.transport}
                        options={[
                          { value: 'auto', label: props.copy.editor.transportAuto },
                          { value: 'streamable-http', label: props.copy.editor.transportStreamableHttp },
                          { value: 'sse', label: props.copy.editor.transportLegacySse },
                        ]}
                        onChange={(value) => updateDraft('transport', value as McpEditorDraft['transport'])}
                        label={props.copy.editor.transportLabel}
                        width="100%"
                      />
                    </>
                  )}
                  <Selector
                    value={mcpDraftProtocolPreference(props.state.draft)}
                    options={[
                      { value: 'legacy', label: props.copy.editor.protocolLegacy },
                      { value: 'auto', label: props.copy.editor.protocolAuto },
                      { value: '2026-07-28', label: props.copy.editor.protocolModern },
                    ]}
                    onChange={(value) => updateDraft('protocol', value as McpProtocolPreference)}
                    label={props.copy.editor.protocolLabel}
                    description={props.state.draft.kind === 'stdio'
                      ? props.copy.editor.stdioProtocolHelp
                      : props.state.draft.transport === 'sse'
                        ? props.copy.editor.sseProtocolHelp
                        : props.copy.editor.protocolHelp}
                    isDisabled={props.state.draft.kind === 'remote' && props.state.draft.transport === 'sse'}
                    width="100%"
                  />
                  {props.state.draft.kind === 'remote' && (
                    <Collapsible trigger={props.copy.editor.oauth} defaultIsOpen={Boolean(props.state.draft.oauth)}>
                      <VStack gap={3} className="maka-mcp-advanced-fields">
                        <Text type="supporting" color="secondary">{props.copy.editor.oauthHelp}</Text>
                        <TextInput label={props.copy.editor.clientId} value={props.state.draft.oauth?.clientId ?? ''} onChange={(value) => updateOAuth('clientId', value || undefined)} />
                        <TextInput label={props.copy.editor.issuer} value={props.state.draft.oauth?.issuer ?? ''} onChange={(value) => updateOAuth('issuer', value || undefined)} placeholder="https://auth.example.com" status={props.errors.oauthIssuer ? { type: 'error', message: props.errors.oauthIssuer === 'required' ? props.copy.editor.required : props.copy.editor.invalidUrl } : undefined} />
                        <TextInput type="password" label={props.copy.editor.clientSecret} value={props.state.draft.oauth?.clientSecret ?? ''} onChange={(value) => updateOAuth('clientSecret', value || undefined)} />
                        <TextInput label={props.copy.editor.scopes} value={props.state.draft.oauth?.scopes?.join(' ') ?? ''} onChange={(value) => updateOAuth('scopes', value.trim() ? value.split(/\s+/u) : undefined)} />
                        <TextInput label={props.copy.editor.callbackPort} value={props.state.draft.oauth?.callbackPort?.toString() ?? ''} onChange={(value) => updateOAuth('callbackPort', value ? Number(value) : undefined)} />
                      </VStack>
                    </Collapsible>
                  )}
                </VStack>
              </Collapsible>
            </div>
            {/* Same as the JSON form: submit semantics are the reason Enter in
                a field saves, so isLoading carries the busy state here. */}
            <div className="maka-mcp-editor-footer">{modeSwitch}{cancel}<Button type="submit" variant="primary" isLoading={props.saving} isDisabled={props.conflict === 'removed'} label={props.copy.editor.saveConnect} /></div>
          </form>
        )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function endpointFor(server: McpServerConfig): string {
  return isMcpStdioConfig(server) ? formatCommandLine(server.command, server.args ?? []) : server.url;
}

function hostOf(server: McpServerConfig | McpSuggestion): string | null {
  if ('command' in server) return null;
  try { return new URL(server.url).host; } catch { return null; }
}

type McpStatusPresentation = { label: string; status: StatusSemantic };

function presentStatus(status: McpServerStatus | undefined, enabled: boolean, copy: McpCopy): McpStatusPresentation {
  if (status?.authorizationPending) return { label: copy.row.authorizing, status: 'active' };
  if (!enabled || status?.state === 'disabled') return { label: copy.row.disabled, status: 'neutral' };
  if (!status || status.state === 'disconnected') return { label: copy.row.disconnected, status: 'neutral' };
  if (status.state === 'connecting') return { label: copy.row.connecting, status: 'active' };
  if (status.state === 'needs-auth') return { label: copy.row.needsAuth, status: 'attention' };
  if (status.state === 'connected') return { label: copy.row.connected(status.toolCount), status: 'success' };
  return { label: copy.row.failed, status: 'error' };
}
