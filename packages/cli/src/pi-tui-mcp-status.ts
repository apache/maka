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

import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import type { McpProtocolPreference, McpServerConfig } from '@maka/core/mcp';
import {
  defineUiMessageCatalog,
  formatUiMessage,
  resolveUiMessageCatalog,
  type UiLocale,
} from '@maka/core/ui-locale';
import { normalizeMcpConfig } from '@maka/storage/mcp-config-store';
import type {
  TuiMcpAction,
  TuiMcpActionResult,
  TuiMcpImportPreview,
  TuiMcpManagement,
  TuiMcpServerSnapshot,
} from './tui-mcp-control.js';
import { ansi, editorTheme } from './tui-ansi.js';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';

const CHROME_ROWS = 2;

interface TuiMcpStatusCopy {
  readonly title: string;
  readonly footer: {
    readonly back: string;
    readonly readOnly: string;
    readonly manage: string;
  };
  readonly unavailableTitle: string;
  readonly unavailableDetail: string;
  readonly loading: string;
  readonly loadError: string;
  readonly noServers: string;
  readonly publication: Readonly<
    Record<ReturnType<TuiMcpManagement['snapshot']>['publication'], string>
  >;
  readonly serverState: Readonly<Record<NonNullable<TuiMcpServerSnapshot['state']>, string>>;
  readonly configuredOnly: string;
  readonly configPending: string;
  readonly toolCount: string;
}

const MCP_STATUS_COPY = resolveUiMessageCatalog(
  defineUiMessageCatalog<TuiMcpStatusCopy>()(TUI_COPY_RESOURCES['mcp-status']),
);

type GuidedDraft = {
  serverId: string;
  transport?: 'stdio' | 'remote';
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  protocol?: McpProtocolPreference;
};

type InputKind =
  | 'server_id'
  | 'command'
  | 'args'
  | 'url'
  | 'cwd'
  | 'env'
  | 'headers'
  | 'edit'
  | 'import';

type McpOverlayPhase =
  | { kind: 'list' }
  | { kind: 'add_choice' }
  | { kind: 'transport'; draft: GuidedDraft }
  | { kind: 'protocol'; draft: GuidedDraft }
  | {
      kind: 'input';
      input: InputKind;
      draft?: GuidedDraft;
      serverId?: string;
      revision?: string;
    }
  | { kind: 'confirm_add'; draft: GuidedDraft }
  | { kind: 'confirm_import'; preview: TuiMcpImportPreview }
  | { kind: 'confirm_remove'; serverId: string }
  | { kind: 'busy'; label: string };

/** One in-frame state machine for status, editing, confirmation, and errors.
 * Raw config values live only in the editor and are cleared on every exit;
 * no management result is written into the conversation transcript. */
export class McpManagementOverlay implements Component {
  private top = 0;
  private documentRows = 0;
  private bodyRows = 0;
  private selected = 0;
  private serverRows: { start: number; end: number }[] = [];
  private phase: McpOverlayPhase = { kind: 'list' };
  private notice: { level: 'info' | 'error'; text: string } | undefined;
  private readonly dispose: () => void;
  private editor: Editor | undefined;
  private closed = false;
  private actionAttempt = 0;

  constructor(
    private readonly input: {
      readonly locale: UiLocale;
      readonly tui?: TUI;
      readonly surface?: TuiMcpManagement;
      canManage?(): boolean;
      viewportRows(): number;
      onClose(): void;
      onChange(): void;
    },
  ) {
    this.dispose = input.surface?.subscribe(input.onChange) ?? (() => undefined);
  }

  invalidate(): void {
    this.editor?.invalidate();
  }

  handleInput(data: string): void {
    if (this.phase.kind === 'input') {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
        this.backToList();
      } else {
        this.editor?.handleInput(data);
      }
      return;
    }
    if (this.phase.kind === 'busy') {
      if (matchesKey(data, Key.escape)) {
        this.actionAttempt += 1;
        this.backToList();
      } else if (matchesKey(data, 'q')) {
        this.actionAttempt += 1;
        this.close();
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      if (this.phase.kind === 'list') this.close();
      else this.backToList();
      return;
    }
    if (this.phase.kind === 'list') this.handleListInput(data);
    else if (this.phase.kind === 'add_choice') this.handleAddChoice(data);
    else if (this.phase.kind === 'transport') this.handleTransport(data);
    else if (this.phase.kind === 'protocol') this.handleProtocol(data);
    else if (this.phase.kind === 'confirm_add' && matchesKey(data, 'y')) {
      try {
        const config = guidedConfig(this.phase.draft);
        if (config) {
          void this.runAction({ kind: 'add', serverId: this.phase.draft.serverId, config });
        }
      } catch {
        this.notice = { level: 'error', text: copy(this.input.locale, 'invalid') };
        this.backToList(false);
      }
    } else if (this.phase.kind === 'confirm_import' && matchesKey(data, 'y')) {
      void this.runAction({ kind: 'commit_import', previewId: this.phase.preview.previewId });
    } else if (this.phase.kind === 'confirm_remove' && matchesKey(data, 'y')) {
      void this.runAction({ kind: 'remove', serverId: this.phase.serverId });
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const viewportRows = Math.max(1, Math.floor(this.input.viewportRows()));
    const showFooter = viewportRows > 2;
    this.bodyRows = Math.max(0, viewportRows - (showFooter ? CHROME_ROWS : 1));
    const document = this.document(safeWidth);
    this.documentRows = document.length;
    this.keepSelectionVisible();
    this.top = clamp(this.top, 0, this.maxTop());
    const visible = document.slice(this.top, this.top + this.bodyRows);
    const start = visible.length === 0 ? 0 : this.top + 1;
    const end = visible.length === 0 ? 0 : this.top + visible.length;
    const title = MCP_STATUS_COPY[this.input.locale].title;
    const header = padLine(
      `${ansi.bold(title)} ${ansi.dim(`${start}-${end} / ${document.length}`)}`,
      safeWidth,
    );
    const body = [
      ...visible.map((line) => padLine(line, safeWidth)),
      ...Array.from({ length: Math.max(0, this.bodyRows - visible.length) }, () =>
        ' '.repeat(safeWidth),
      ),
    ];
    if (!showFooter) return [header, ...body];
    return [header, ...body, padLine(ansi.dim(this.footer()), safeWidth)];
  }

  private management(): TuiMcpManagement | undefined {
    return this.input.surface;
  }

  private handleListInput(data: string): void {
    const servers = this.input.surface?.snapshot().servers ?? [];
    if (matchesKey(data, Key.up)) {
      this.selected = clamp(this.selected - 1, 0, servers.length - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selected = clamp(this.selected + 1, 0, servers.length - 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.moveSelectionByPage(-1, servers.length);
    } else if (matchesKey(data, Key.pageDown)) {
      this.moveSelectionByPage(1, servers.length);
    } else if (matchesKey(data, Key.home)) this.selected = 0;
    else if (matchesKey(data, Key.end)) this.selected = Math.max(0, servers.length - 1);
    else if (matchesKey(data, 'a') && this.management()) this.phase = { kind: 'add_choice' };
    else {
      const server = servers[this.selected];
      if (!server || !this.management()) return;
      if (matchesKey(data, Key.enter)) this.startEdit(server.serverId);
      else if (matchesKey(data, Key.space)) {
        void this.runAction({
          kind: 'set_enabled',
          serverId: server.serverId,
          enabled: !server.enabled,
        });
      } else if (matchesKey(data, 't')) {
        void this.runAction({ kind: 'test', serverId: server.serverId });
      } else if (matchesKey(data, 'r')) {
        void this.runAction({ kind: 'reconnect', serverId: server.serverId });
      } else if (matchesKey(data, 'd') && server.configured) {
        this.phase = { kind: 'confirm_remove', serverId: server.serverId };
      }
    }
    this.input.onChange();
  }

  private handleAddChoice(data: string): void {
    if (matchesKey(data, 'g')) this.startInput('server_id', { serverId: '' });
    else if (matchesKey(data, 'j')) this.startInput('import');
  }

  private handleTransport(data: string): void {
    if (this.phase.kind !== 'transport') return;
    if (matchesKey(data, '1')) {
      this.phase.draft.transport = 'stdio';
      this.startInput('command', this.phase.draft);
    } else if (matchesKey(data, '2')) {
      this.phase.draft.transport = 'remote';
      this.startInput('url', this.phase.draft);
    }
  }

  private handleProtocol(data: string): void {
    if (this.phase.kind !== 'protocol') return;
    const protocol = matchesKey(data, '1')
      ? 'legacy'
      : matchesKey(data, '2')
        ? 'auto'
        : matchesKey(data, '3')
          ? '2026-07-28'
          : undefined;
    if (!protocol) return;
    this.phase.draft.protocol = protocol;
    this.startInput(this.phase.draft.transport === 'stdio' ? 'cwd' : 'headers', this.phase.draft);
  }

  private startEdit(serverId: string): void {
    const edit = this.management()?.configForEdit(serverId);
    if (!edit) {
      this.notice = { level: 'error', text: copy(this.input.locale, 'missing') };
      return;
    }
    this.startInput(
      'edit',
      undefined,
      serverId,
      edit.revision,
      JSON.stringify(edit.config, null, 2),
    );
  }

  private startInput(
    input: InputKind,
    draft?: GuidedDraft,
    serverId?: string,
    revision?: string,
    value = '',
  ): void {
    if (!this.input.tui) return;
    this.clearEditor();
    this.notice = undefined;
    this.phase = { kind: 'input', input, draft, serverId, revision };
    this.editor = new Editor(this.input.tui, editorTheme(), { paddingX: 0 });
    this.editor.onSubmit = (submitted) => this.submitInput(submitted);
    this.editor.setText(value);
    this.editor.focused = true;
    this.input.onChange();
  }

  private submitInput(value: string): void {
    if (this.phase.kind !== 'input') return;
    const phase = this.phase;
    const trimmed = value.trim();
    try {
      if (phase.input === 'server_id') {
        if (!trimmed) throw new Error();
        const draft = phase.draft ?? { serverId: '' };
        draft.serverId = trimmed;
        this.clearEditor();
        this.phase = { kind: 'transport', draft };
      } else if (phase.input === 'command') {
        if (!trimmed || !phase.draft) throw new Error();
        phase.draft.command = trimmed;
        this.startInput('args', phase.draft);
      } else if (phase.input === 'args') {
        if (!phase.draft) throw new Error();
        phase.draft.args = trimmed ? stringArray(trimmed) : undefined;
        this.clearEditor();
        this.phase = { kind: 'protocol', draft: phase.draft };
      } else if (phase.input === 'url') {
        if (!trimmed || !phase.draft) throw new Error();
        phase.draft.url = trimmed;
        this.clearEditor();
        this.phase = { kind: 'protocol', draft: phase.draft };
      } else if (phase.input === 'cwd') {
        if (!phase.draft) throw new Error();
        phase.draft.cwd = trimmed || undefined;
        this.startInput('env', phase.draft);
      } else if (phase.input === 'env') {
        if (!phase.draft) throw new Error();
        phase.draft.env = trimmed ? stringMap(trimmed) : undefined;
        this.clearEditor();
        this.phase = { kind: 'confirm_add', draft: phase.draft };
      } else if (phase.input === 'headers') {
        if (!phase.draft) throw new Error();
        phase.draft.headers = trimmed ? stringMap(trimmed) : undefined;
        this.clearEditor();
        this.phase = { kind: 'confirm_add', draft: phase.draft };
      } else if (phase.input === 'edit') {
        if (!phase.serverId || !phase.revision) throw new Error();
        const config = normalizeOneServer(phase.serverId, trimmed);
        this.clearEditor();
        void this.runAction({
          kind: 'edit',
          serverId: phase.serverId,
          expectedRevision: phase.revision,
          config,
        });
      } else {
        const preview = this.management()?.previewImport(value);
        if (!preview || preview.status !== 'ready') throw new Error();
        this.clearEditor();
        this.phase = { kind: 'confirm_import', preview: preview.preview };
      }
      this.notice = undefined;
    } catch {
      this.notice = { level: 'error', text: copy(this.input.locale, 'invalid') };
    }
    this.input.onChange();
  }

  private async runAction(action: TuiMcpAction): Promise<void> {
    const management = this.management();
    if (!management || this.phase.kind === 'busy') return;
    if (this.input.canManage && !this.input.canManage()) {
      this.backToList(false);
      this.notice = { level: 'error', text: copy(this.input.locale, 'turn_active') };
      this.input.onChange();
      return;
    }
    this.clearEditor();
    const attempt = ++this.actionAttempt;
    this.phase = { kind: 'busy', label: actionLabel(action, this.input.locale) };
    this.input.onChange();
    let result: TuiMcpActionResult;
    try {
      result = await management.execute(action);
    } catch {
      result = { status: 'failed', reason: 'manager-failed' };
    }
    if (this.closed || attempt !== this.actionAttempt) return;
    this.phase = { kind: 'list' };
    this.notice = actionNotice(result, this.input.locale);
    this.input.onChange();
  }

  private document(width: number): string[] {
    this.serverRows = [];
    const snapshot = this.input.surface?.snapshot();
    if (!snapshot) return unavailableDocument(this.input.locale);
    if (this.phase.kind === 'input') return this.inputDocument(width);
    if (this.phase.kind === 'add_choice') {
      return [
        heading(this.input.locale, 'Add MCP server', '添加 MCP 服务器'),
        '',
        'g  Guided setup',
        'j  Paste JSON',
      ];
    }
    if (this.phase.kind === 'transport') {
      return [
        heading(this.input.locale, 'Transport', '传输方式'),
        '',
        '1  stdio',
        '2  Streamable HTTP',
      ];
    }
    if (this.phase.kind === 'protocol') {
      return [
        heading(this.input.locale, 'Protocol preference', '协议偏好'),
        '',
        '1  legacy',
        '2  auto',
        '3  2026-07-28',
      ];
    }
    if (this.phase.kind === 'confirm_add') {
      return confirmAddDocument(this.phase.draft, this.input.locale);
    }
    if (this.phase.kind === 'confirm_import') {
      return confirmImportDocument(this.phase.preview, this.input.locale);
    }
    if (this.phase.kind === 'confirm_remove') {
      return [
        ansi.red(
          heading(
            this.input.locale,
            `Remove ${this.phase.serverId}?`,
            `删除 ${this.phase.serverId}？`,
          ),
        ),
        '',
        confirmCopy(this.input.locale),
      ];
    }
    if (this.phase.kind === 'busy') return [ansi.yellow(this.phase.label)];
    const lines = [publicationLine(snapshot, this.input.locale)];
    if (snapshot.configuration !== 'ready') {
      lines.push(configurationLine(snapshot.configuration, this.input.locale));
    }
    if (this.notice) {
      lines.push(
        this.notice.level === 'error' ? ansi.red(this.notice.text) : ansi.green(this.notice.text),
      );
    }
    if (snapshot.initialization === 'loading') return [...lines, loadingCopy(this.input.locale)];
    if (snapshot.initialization === 'error') {
      return [...lines, ansi.red(loadErrorCopy(this.input.locale))];
    }
    if (snapshot.servers.length === 0) return [...lines, '', emptyCopy(this.input.locale)];
    lines.push('');
    this.selected = clamp(this.selected, 0, snapshot.servers.length - 1);
    snapshot.servers.forEach((server, index) => {
      const rows = serverLines(server, this.input.locale, index === this.selected);
      const start = lines.length;
      lines.push(...rows);
      this.serverRows.push({ start, end: lines.length - 1 });
    });
    return lines;
  }

  private inputDocument(width: number): string[] {
    if (this.phase.kind !== 'input' || !this.editor) return [];
    const label = inputLabel(this.phase.input, this.input.locale);
    const hint = inputHint(this.phase.input, this.input.locale);
    return [
      ansi.bold(label),
      ...(hint ? [ansi.dim(hint)] : []),
      '',
      ...this.editor.render(Math.max(1, width - 2)),
      ...(this.notice ? [ansi.red(this.notice.text)] : []),
    ];
  }

  private footer(): string {
    const copy = MCP_STATUS_COPY[this.input.locale].footer;
    if (this.phase.kind !== 'list') return copy.back;
    if (!this.management()) return copy.readOnly;
    return copy.manage;
  }

  private backToList(clearNotice = true): void {
    if (this.phase.kind === 'confirm_import') {
      this.management()?.discardImportPreview(this.phase.preview.previewId);
    }
    this.clearEditor();
    this.phase = { kind: 'list' };
    if (clearNotice) this.notice = undefined;
    this.input.onChange();
  }

  private clearEditor(): void {
    if (!this.editor) return;
    this.editor.focused = false;
    this.editor.onSubmit = undefined;
    this.editor.onChange = undefined;
    this.editor = undefined;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.phase.kind === 'confirm_import') {
      this.management()?.discardImportPreview(this.phase.preview.previewId);
    }
    this.clearEditor();
    this.dispose();
    this.input.onClose();
  }

  private keepSelectionVisible(): void {
    const rows = this.serverRows[this.selected];
    if (!rows || this.bodyRows <= 0) return;
    if (rows.end - rows.start + 1 > this.bodyRows || rows.start < this.top) {
      this.top = rows.start;
    } else if (rows.end >= this.top + this.bodyRows) {
      this.top = rows.end - this.bodyRows + 1;
    }
  }

  private moveSelectionByPage(direction: -1 | 1, serverCount: number): void {
    if (serverCount === 0) {
      this.selected = 0;
      return;
    }
    const current = this.serverRows[this.selected];
    if (!current || this.serverRows.length !== serverCount) {
      this.selected = clamp(
        this.selected + direction * Math.max(1, this.bodyRows),
        0,
        serverCount - 1,
      );
      return;
    }
    const targetRow = current.start + direction * Math.max(1, this.bodyRows);
    const target = this.serverRows.findIndex(
      (rows) => targetRow >= rows.start && targetRow <= rows.end,
    );
    this.selected = target < 0 ? (direction < 0 ? 0 : Math.max(0, serverCount - 1)) : target;
  }

  private maxTop(): number {
    return Math.max(0, this.documentRows - this.bodyRows);
  }
}

function normalizeOneServer(serverId: string, source: string): McpServerConfig {
  const value: unknown = JSON.parse(source);
  return normalizeMcpConfig({ version: 3, mcpServers: { [serverId]: value } }).mcpServers[serverId];
}

function guidedConfig(draft: GuidedDraft): McpServerConfig | undefined {
  if (!draft.transport || !draft.protocol) return undefined;
  const raw =
    draft.transport === 'stdio'
      ? {
          command: draft.command,
          args: draft.args,
          cwd: draft.cwd,
          env: draft.env,
          protocol: draft.protocol,
        }
      : {
          url: draft.url,
          transport: 'auto',
          headers: draft.headers,
          protocol: draft.protocol,
        };
  return normalizeMcpConfig({ version: 3, mcpServers: { [draft.serverId]: raw } }).mcpServers[
    draft.serverId
  ];
}

function stringArray(source: string): string[] {
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error();
  return value;
}

function stringMap(source: string): Record<string, string> {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  if (Object.values(value).some((entry) => typeof entry !== 'string')) throw new Error();
  return value as Record<string, string>;
}

function publicationLine(
  snapshot: ReturnType<TuiMcpManagement['snapshot']>,
  locale: UiLocale,
): string {
  const copy = MCP_STATUS_COPY[locale];
  const publication = copy.publication[snapshot.publication];
  const tools = formatUiMessage(copy.toolCount, { count: snapshot.toolCount }, locale);
  return `${ansi.bold(publication)} · ${tools}`;
}

function serverLines(server: TuiMcpServerSnapshot, locale: UiLocale, selected: boolean): string[] {
  const protocol = server.negotiatedProtocol
    ? `${server.negotiatedProtocol.era} ${server.negotiatedProtocol.revision}`
    : server.configuredProtocol;
  const transport = server.transport ?? server.configuredTransport;
  const copy = MCP_STATUS_COPY[locale];
  const tools = formatUiMessage(copy.toolCount, { count: server.toolCount }, locale);
  const sync = server.synchronized ? undefined : copy.configPending;
  const details = [stateLabel(server.state, locale), transport, protocol, tools, sync]
    .filter(Boolean)
    .join(' · ');
  const cursor = selected ? ansi.accent('›') : ' ';
  return [
    `${cursor} ${statusMarker(server.state)} ${ansi.bold(server.serverId)}  ${details}`,
    ...(server.error ? [`    ${ansi.red(server.error)}`] : []),
  ];
}

function actionNotice(
  result: TuiMcpActionResult,
  locale: UiLocale,
): { level: 'info' | 'error'; text: string } {
  if (result.status === 'conflict') return { level: 'error', text: copy(locale, result.reason) };
  if (result.status === 'failed') return { level: 'error', text: copy(locale, result.reason) };
  if (result.status === 'tested') {
    if (result.test.ok && result.effect === 'publication_failed') {
      return { level: 'error', text: copy(locale, 'test_publication_failed') };
    }
    if (result.test.ok && result.effect === 'pending_host') {
      return { level: 'info', text: copy(locale, 'test_pending_host') };
    }
    return {
      level: result.test.ok ? 'info' : 'error',
      text: result.test.ok ? copy(locale, 'test_ok') : copy(locale, 'test_failed'),
    };
  }
  return {
    level:
      result.effect === 'sync_failed' || result.effect === 'publication_failed' ? 'error' : 'info',
    text: copy(locale, result.effect),
  };
}

function copy(locale: UiLocale, key: string): string {
  const en: Record<string, string> = {
    exists: 'That server ID already exists.',
    stale_config: 'MCP configuration changed; retry the action.',
    stale_edit: 'This server changed; reopen it before editing.',
    stale_import: 'An imported entry changed; preview the import again.',
    missing: 'That server no longer exists.',
    closed: 'The MCP controller is closed.',
    'invalid-config': 'The server configuration is invalid.',
    'credential-cleanup-failed':
      'Stored credentials could not be removed; the configuration was not changed.',
    'persist-failed': 'The configuration could not be saved.',
    'manager-failed': 'The MCP connection action failed.',
    turn_active: 'MCP cannot be changed while a turn or another control action is running.',
    invalid: 'Check the value and try again.',
    published: 'Configuration saved and tools refreshed.',
    pending_host: 'Configuration saved; publication is waiting for Runtime Host.',
    sync_failed: 'Configuration saved, but the MCP manager is out of sync.',
    publication_failed: 'Configuration saved, but capability publication failed.',
    test_ok: 'Connection test passed.',
    test_failed: 'Connection test failed.',
    test_publication_failed: 'Connection test passed, but capability publication failed.',
    test_pending_host: 'Connection test passed; publication is waiting for Runtime Host.',
  };
  const zh: Record<string, string> = {
    exists: '该服务器 ID 已存在。',
    stale_config: 'MCP 配置已变化，请重试。',
    stale_edit: '该服务器已变化，请重新打开后编辑。',
    stale_import: '导入项已变化，请重新预览。',
    missing: '该服务器已不存在。',
    closed: 'MCP 控制器已关闭。',
    'invalid-config': '服务器配置无效。',
    'credential-cleanup-failed': '无法删除旧凭据，配置未修改。',
    'persist-failed': '无法保存配置。',
    'manager-failed': 'MCP 连接操作失败。',
    turn_active: 'Turn 或其他控制操作运行期间不能修改 MCP。',
    invalid: '请检查输入后重试。',
    published: '配置已保存，工具已刷新。',
    pending_host: '配置已保存，正等待 Runtime Host 发布。',
    sync_failed: '配置已保存，但 MCP Manager 尚未同步。',
    publication_failed: '配置已保存，但 capability 发布失败。',
    test_ok: '连接测试通过。',
    test_failed: '连接测试失败。',
    test_publication_failed: '连接测试通过，但 capability 发布失败。',
    test_pending_host: '连接测试通过，正等待 Runtime Host 发布。',
  };
  return (locale === 'zh' ? zh : en)[key] ?? key;
}

function confirmAddDocument(draft: GuidedDraft, locale: UiLocale): string[] {
  return [
    heading(locale, 'Add this MCP server?', '添加该 MCP 服务器？'),
    '',
    `${draft.serverId} · ${draft.transport} · ${draft.protocol}`,
    draft.transport === 'stdio' ? (draft.command ?? '') : (draft.url ?? ''),
    '',
    confirmCopy(locale),
  ];
}

function confirmImportDocument(preview: TuiMcpImportPreview, locale: UiLocale): string[] {
  return [
    heading(locale, 'Import MCP servers?', '导入 MCP 服务器？'),
    '',
    ...preview.entries.map(
      (entry) =>
        `${entry.change === 'add' ? '+' : '~'} ${entry.serverId} · ${entry.transport} · ${entry.protocol}`,
    ),
    '',
    confirmCopy(locale),
  ];
}

function actionLabel(action: TuiMcpAction, locale: UiLocale): string {
  if (locale === 'zh') return '正在应用 MCP 更改…';
  if (action.kind === 'test') return 'Testing MCP server…';
  if (action.kind === 'reconnect') return 'Reconnecting MCP server…';
  return 'Applying MCP configuration…';
}

function inputLabel(kind: InputKind, locale: UiLocale): string {
  const labels: Record<InputKind, [string, string]> = {
    server_id: ['Server ID', '服务器 ID'],
    command: ['Command', '命令'],
    args: ['Arguments', '参数'],
    url: ['Streamable HTTP URL', 'Streamable HTTP URL'],
    cwd: ['Working directory', '工作目录'],
    env: ['Environment', '环境变量'],
    headers: ['Request headers', '请求头'],
    edit: ['Edit server JSON', '编辑服务器 JSON'],
    import: ['Paste MCP JSON', '粘贴 MCP JSON'],
  };
  return labels[kind][locale === 'zh' ? 1 : 0];
}

function inputHint(kind: InputKind, locale: UiLocale): string {
  const optional = locale === 'zh' ? '可留空' : 'optional';
  if (kind === 'args') return `JSON string array, ${optional}`;
  if (kind === 'env' || kind === 'headers') return `JSON string map, ${optional}`;
  if (kind === 'cwd') return optional;
  return locale === 'zh' ? 'Enter 提交 · Esc 返回' : 'Enter submit · Esc back';
}

function configurationLine(state: 'synchronizing' | 'out_of_sync', locale: UiLocale): string {
  if (state === 'synchronizing') {
    return locale === 'zh' ? '配置同步中…' : 'Configuration is synchronizing…';
  }
  return ansi.red(
    locale === 'zh'
      ? '持久化配置与 MCP Manager 尚未同步。'
      : 'Durable configuration and MCP Manager are out of sync.',
  );
}

function unavailableDocument(locale: UiLocale): string[] {
  const copy = MCP_STATUS_COPY[locale];
  return [ansi.yellow(copy.unavailableTitle), copy.unavailableDetail];
}

function heading(locale: UiLocale, en: string, zh: string): string {
  return ansi.bold(locale === 'zh' ? zh : en);
}

function confirmCopy(locale: UiLocale): string {
  return locale === 'zh' ? 'y 确认 · Esc 取消' : 'y Confirm · Esc cancel';
}

function loadingCopy(locale: UiLocale): string {
  return MCP_STATUS_COPY[locale].loading;
}

function loadErrorCopy(locale: UiLocale): string {
  return MCP_STATUS_COPY[locale].loadError;
}

function emptyCopy(locale: UiLocale): string {
  return MCP_STATUS_COPY[locale].noServers;
}

function statusMarker(state: TuiMcpServerSnapshot['state']): string {
  if (state === 'connected') return ansi.green('●');
  if (state === 'connecting') return ansi.yellow('●');
  if (state === 'error' || state === 'needs-auth') return ansi.red('●');
  return ansi.dim('○');
}

function stateLabel(state: TuiMcpServerSnapshot['state'], locale: UiLocale): string {
  const copy = MCP_STATUS_COPY[locale];
  if (!state) return copy.configuredOnly;
  return copy.serverState[state] ?? state;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}
