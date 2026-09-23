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
  Banner,
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
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import {
  ModulePage,
  Selector,
  TextArea,
  useMountedRef,
  useRovingRowFocus,
  useToast,
  useUiLocale,
  type ModuleHubHeader,
  dotForStatus,
} from '@maka/ui';

import {
  ICON_SIZE,
  FileCode,
  Plug,
  Plus,
  RefreshCcw,
  Search,
} from '@maka/ui/icons';
import {
  createEmptyMcpDraft,
  mcpConfigFromDraft,
  mcpDraftProtocolPreference,
  mcpDraftFromConfig,
  presentMcpNegotiatedProtocol,
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

type EditorState =
  | { mode: 'manual'; draft: McpEditorDraft; editingId: string | null }
  | { mode: 'json'; source: string }
  | null;

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
  // skills and 定时任务 pages: without it, reaching the inspector from row
  // k of N costs N−k presses.
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

  // Derived, not stored: deleting or filtering out a row closes its inspector.
  const selectedServer = connectionEntries.find(([serverId]) => serverId === selectedServerId) ?? null;

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

  function openManual(draft: McpEditorDraft = createEmptyMcpDraft()) {
    openEditor({ mode: 'manual', draft: { ...draft }, editingId: null });
  }

  function openEdit(serverId: string, server: McpServerConfig) {
    setSelectedServerId(null);
    openEditor({
      mode: 'manual',
      draft: mcpDraftFromConfig(serverId, server),
      editingId: serverId,
    });
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
    const result = await controller.save(id, server, editor.editingId === null);
    if (!result || !mounted.current) return;
    if (result.status === 'exists') { setEditorErrors({ id: 'exists' }); return; }
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

  const connectionErrorCount = statuses.filter((status) => status.error).length;
  const searchSummary = normalizedQuery ? (
    <div className="maka-module-search-summary" role="status" aria-live="polite">
      <span>{copy.page.searchMatches(connectionEntries.length)}</span>
      <Button variant="ghost" size="sm" onClick={() => setQuery('')} label={copy.page.clearSearch} />
    </div>
  ) : null;

  const connectionsPanel = (
    <div className="maka-module-page-panel" ref={rowsContainerRef} {...rovingRows}>
      {/* Selecting a row moves no focus, so nothing else would tell a screen
          reader that the details opened. This says so, politely. */}
      <p className="maka-visually-hidden" role="status" aria-live="polite">
        {selectedServer ? copy.detail.inspectorOpened(selectedServer[0]) : ''}
      </p>
      {searchSummary}
      {busy === 'load' ? (
        /* Loading (DESIGN.md §10): the connection list's structure is predictable,
           so it loads as row-shaped skeletons in the rows' own geometry — three
           rows, this surface's typical ready count. Skeleton's radius scale has
           no 6px step, so the tile takes the nearest one (8px) to the real
           tile's control radius. */
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
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Plug size={ICON_SIZE.empty} />}
          title={copy.page.noConnections}
          description={copy.page.noConnectionsDetail}
        />
      ) : connectionEntries.length === 0 ? (
        <EmptyState
          icon={<Search size={ICON_SIZE.empty} />}
          title={copy.page.noConnectionsMatch}
          description={copy.page.noConnectionsMatchDetail(query)}
          actions={<Button variant="ghost" size="sm" label={copy.page.clearSearch} onClick={() => setQuery('')} />}
        />
      ) : (
        /* Selectable, otherwise inert rows: the switch, test, edit and
           delete controls that used to ride the row now live in the
           inspector — no interactive elements inside an interactive list
           item. */
        <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.connections}>
          {connectionEntries.map(([serverId, server]) => {
            const status = statusById.get(serverId);
            const state = presentStatus(status, server.enabled !== false, copy);
            const endpoint = endpointFor(server);
            const transportLabel = transportLabelFor(server, copy);
            return (
              <ListItem
                key={serverId}
                label={serverId}
                description={(
                  <span className="maka-module-row-description" data-maka-contract="mcp-server-description">
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
    <section className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="mcp" data-maka-contract="module-main" aria-label={props.hubHeader?.title ?? 'MCP'}>
      <ModulePage
        title={props.hubHeader?.title ?? 'MCP'}
        meta={[
          copy.page.metaConnections(entries.length),
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
            onToggle={(enabled) => void controller.setEnabled(selectedServer[0], selectedServer[1], enabled)}
            onEdit={() => openEdit(selectedServer[0], selectedServer[1])}
            onTest={() => void testServer(selectedServer[0])}
            onRemove={() => void remove(selectedServer[0])}
            onLogin={() => void controller.login(selectedServer[0])}
            onCancelLogin={() => void controller.cancelLogin(selectedServer[0])}
            onLogout={() => void controller.logout(selectedServer[0])}
          />
        ) : undefined}
        actions={
          <div
            className="maka-module-main-actions"
            data-maka-contract="module-actions"
            role="group"
            aria-label={copy.page.actionsAria}
          >
            <Button variant="primary" onClick={() => openManual()} isDisabled={busy !== null} icon={<Plus size={ICON_SIZE.chrome} aria-hidden="true" />} label={copy.page.add} />
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
              endContent={entries.length > 0 ? (
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
        {connectionsPanel}
      </ModulePage>

      {editor && (
        <McpEditorDialog
          state={editor}
          isOpen={editorOpen}
          errors={editorErrors}
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
  onLogin(): void;
  onCancelLogin(): void;
  onLogout(): void;
}) {
  const { serverId, server, status, copy } = props;
  const state = presentStatus(status, server.enabled !== false, copy);
  const endpoint = endpointFor(server);
  const transportLabel = transportLabelFor(server, copy);
  const negotiatedProtocol = presentMcpNegotiatedProtocol(status, copy);
  const loginActive = status?.authorizationPending || props.busy === `login:${serverId}`;
  const disabled = props.busy !== null || loginActive;
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
            isDisabled={disabled}
            label={copy.detail.enabled}
          />
        </StackItem>
      </HStack>

      {loginActive ? (
        <Banner status="info" title={copy.row.loginPending}
          endContent={<Button size="sm" variant="secondary" onClick={props.onCancelLogin} label={copy.row.cancelLogin} />} />
      ) : status?.state === 'needs-auth' ? (
        <Banner status="warning" title={copy.row.needsAuth}
          endContent={<Button size="sm" variant="primary" isDisabled={disabled} onClick={props.onLogin} label={copy.row.login} />} />
      ) : null}
      {status?.authenticated ? (
        <Button size="sm" variant="secondary" isDisabled={disabled} onClick={props.onLogout} label={copy.row.logout} />
      ) : null}

      <HStack gap={2} wrap="wrap">
        <Button
          size="sm"
          variant="secondary"
          onClick={props.onTest}
          isDisabled={disabled}
          icon={<RefreshCcw size={ICON_SIZE.chrome} aria-hidden="true" />}
          label={props.busy === `test:${serverId}` ? copy.row.testing : copy.row.test}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={props.onEdit}
          isDisabled={disabled}
          label={copy.row.edit}
        />
        <Button
          size="sm"
          variant="destructive"
          onClick={props.onRemove}
          isDisabled={disabled}
          label={copy.row.delete}
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
        {negotiatedProtocol ? (
          <MetadataListItem label={copy.detail.protocolLabel}>
            <Text type="body">{negotiatedProtocol}</Text>
          </MetadataListItem>
        ) : null}
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

function mcpStatusDotVariant(state: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'error' }) {
  return dotForStatus(state.tone === 'warning' ? 'attention' : state.tone === 'info' ? 'neutral' : state.tone);
}
function McpEditorDialog(props: {
  state: Exclude<EditorState, null>;
  isOpen: boolean;
  errors: McpEditorErrors;
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
  const editing = props.state.mode === 'manual' && Boolean(props.state.editingId);
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
    if (props.state.mode !== 'manual') return;
    props.onChange(
      { ...props.state, draft: { ...props.state.draft, [key]: value } },
      key,
    );
  };
  const updateOAuth = <K extends keyof McpOAuthConfig>(key: K, value: McpOAuthConfig[K]) => {
    if (props.state.mode !== 'manual') return;
    const oauth = { ...props.state.draft.oauth, [key]: value };
    updateDraft('oauth', Object.values(oauth).some((value) => value !== undefined) ? oauth : undefined);
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
            startContent={props.state.mode === 'json' ? <FileCode size={ICON_SIZE.chrome} /> : <Plug size={ICON_SIZE.chrome} />}
            title={props.state.mode === 'json' ? props.copy.editor.importTitle : editing ? props.copy.editor.editTitle(props.state.draft.id) : props.copy.editor.addTitle}
            subtitle={props.state.mode === 'json' ? props.copy.editor.importSubtitle : props.copy.editor.manualSubtitle}
            endContent={!editing ? (
              <Button
                variant="ghost"
                size="sm"
                label={props.state.mode === 'json' ? props.copy.editor.manual : props.copy.editor.pasteJson}
                onClick={() => props.onChange(
                  props.state.mode === 'json'
                    ? { mode: 'manual', draft: createEmptyMcpDraft(), editingId: null }
                    : { mode: 'json', source: '' },
                )}
              />
            ) : undefined}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
        {props.state.mode === 'json' ? (
          <form className="maka-mcp-json-form" onSubmit={props.onImport}>
            <div className="maka-mcp-json-field">
              <TextArea hasAutoFocus label={props.copy.editor.jsonConfig} value={props.state.source} onChange={(value) => props.onChange({ mode: 'json', source: value })} hasSpellCheck={false} rows={14} placeholder={'{\n  "mcpServers": {\n    "my-tools": { "url": "https://example.com/mcp" }\n  }\n}'} />
            </div>
            <p>{props.copy.editor.jsonHelp}</p>
            {/* Stays a submit button so Enter in the textarea still imports —
                clickAction would have to replace the form's onSubmit and take
                that with it. `isLoading` is the half of the contract that does
                apply: spinner, aria-busy, and the "Loading" announcement,
                instead of the label reading 导入中… . */}
            <div className="maka-mcp-editor-footer"><Button variant="ghost" onClick={() => props.onOpenChange(false)} label={props.copy.editor.cancel} /><Button type="submit" variant="primary" isLoading={props.saving} isDisabled={!props.state.source.trim()} label={props.copy.editor.importConnect} /></div>
          </form>
        ) : (
          <form className="maka-mcp-manual-form" onSubmit={props.onSave}>
            <div className="maka-mcp-form-fields">
              <VStack gap={1} align="start">
                <Text type="label" size="sm">{props.copy.editor.transportAria}</Text>
                <SegmentedControl
                  value={props.state.draft.kind}
                  onChange={(kind) => updateDraft('kind', kind as McpEditorDraft['kind'])}
                  label={props.copy.editor.transportAria}
                  size="sm"
                >
                  <SegmentedControlItem value="stdio" label={props.copy.editor.localStdio} />
                  <SegmentedControlItem value="remote" label={props.copy.editor.remoteUrl} />
                </SegmentedControl>
              </VStack>
              <div className="maka-mcp-primary-fields">
                <TextInput hasAutoFocus={!editing} label={props.copy.editor.serverId} value={props.state.draft.id} onChange={(value) => updateDraft('id', value)} isDisabled={editing} isRequired placeholder="my-tools" status={props.errors.id ? { type: 'error', message: props.errors.id === 'exists' ? props.copy.editor.idExists : props.copy.editor.required } : undefined} />
                {props.state.draft.kind === 'stdio' ? (
                  <TextInput hasAutoFocus={editing} label={props.copy.editor.command} description={props.copy.editor.commandHelp} value={props.state.draft.commandLine} onChange={(value) => updateDraft('commandLine', value)} isRequired placeholder={props.copy.editor.commandPlaceholder} status={props.errors.commandLine ? { type: 'error', message: props.errors.commandLine === 'unbalanced-quote' ? props.copy.editor.unbalancedQuote : props.copy.editor.required } : undefined} />
                ) : (
                  <TextInput hasAutoFocus={editing} label={props.copy.editor.url} value={props.state.draft.url} onChange={(value) => updateDraft('url', value)} isRequired placeholder="https://example.com/mcp" status={props.errors.url ? { type: 'error', message: props.errors.url === 'required' ? props.copy.editor.required : props.copy.editor.invalidUrl } : undefined} />
                )}
              </div>
              <Collapsible
                trigger={advancedOpen ? props.copy.editor.collapseAdvanced : props.copy.editor.expandAdvanced}
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
                    <>
                      <TextArea label={props.copy.editor.headers} description={props.copy.editor.headersHelp} value={props.state.draft.headers} onChange={(value) => updateDraft('headers', value)} />
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
                    </>
                  )}
                </VStack>
              </Collapsible>
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

function endpointFor(server: McpServerConfig): string {
  return isMcpStdioConfig(server) ? formatCommandLine(server.command, server.args ?? []) : server.url;
}

function transportLabelFor(server: McpServerConfig, copy: McpCopy): string {
  if (isMcpStdioConfig(server)) return copy.page.localStdio;
  if (server.transport === 'sse') return copy.editor.transportLegacySse;
  if (server.transport === 'streamable-http') return copy.editor.transportStreamableHttp;
  return copy.editor.transportAuto;
}

function presentStatus(status: McpServerStatus | undefined, enabled: boolean, copy: McpCopy): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'; exception: boolean } {
  if (status?.authorizationPending) return { label: copy.row.loginPending, tone: 'info', exception: true };
  if (!enabled || status?.state === 'disabled') return { label: copy.row.disabled, tone: 'neutral', exception: false };
  if (!status || status.state === 'disconnected') return { label: copy.row.disconnected, tone: 'neutral', exception: false };
  if (status.state === 'connecting') return { label: copy.row.connecting, tone: 'info', exception: false };
  if (status.state === 'needs-auth') return { label: copy.row.needsAuth, tone: 'warning', exception: true };
  if (status.state === 'connected') return { label: copy.row.connected(status.toolCount), tone: 'success', exception: false };
  return { label: copy.row.failed, tone: 'error', exception: true };
}
