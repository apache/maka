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
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui';
import type { UiLocale } from '@maka/core/ui-locale';
import type { TuiMcpServerSnapshot, TuiMcpSurface } from './tui-mcp-control.js';
import { ansi } from './tui-ansi.js';

const CHROME_ROWS = 2;

export class McpStatusOverlay implements Component {
  private top = 0;
  private documentRows = 0;
  private bodyRows = 0;
  private readonly dispose: () => void;

  constructor(
    private readonly input: {
      readonly locale: UiLocale;
      readonly surface?: TuiMcpSurface;
      viewportRows(): number;
      onClose(): void;
      onChange(): void;
    },
  ) {
    this.dispose = input.surface?.subscribe(input.onChange) ?? (() => undefined);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.dispose();
      this.input.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-Math.max(1, this.bodyRows));
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(Math.max(1, this.bodyRows));
    else if (matchesKey(data, Key.home)) this.scrollTo(0);
    else if (matchesKey(data, Key.end)) this.scrollTo(this.maxTop());
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const viewportRows = Math.max(1, Math.floor(this.input.viewportRows()));
    const showFooter = viewportRows > 2;
    this.bodyRows = Math.max(0, viewportRows - (showFooter ? CHROME_ROWS : 1));
    const document = this.document();
    this.documentRows = document.length;
    this.top = clamp(this.top, 0, this.maxTop());
    const visible = document.slice(this.top, this.top + this.bodyRows);
    const start = visible.length === 0 ? 0 : this.top + 1;
    const end = visible.length === 0 ? 0 : this.top + visible.length;
    const title = this.input.locale === 'zh' ? 'MCP 服务器' : 'MCP SERVERS';
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
    const footer =
      this.input.locale === 'zh'
        ? '↑/↓ 滚动 · PgUp/PgDn 翻页 · Home/End 跳转 · q/Esc 关闭'
        : '↑/↓ scroll · PgUp/PgDn page · Home/End jump · q/Esc close';
    return [header, ...body, padLine(ansi.dim(footer), safeWidth)];
  }

  private document(): string[] {
    const snapshot = this.input.surface?.snapshot();
    if (!snapshot) {
      return this.input.locale === 'zh'
        ? [
            ansi.yellow('当前 TUI 未连接本地 MCP 控制面。'),
            '远程 Runtime Host 的客户端 MCP 工具关联将在后续版本提供。',
          ]
        : [
            ansi.yellow('This TUI is not connected to a local MCP control plane.'),
            'Client MCP tool association for remote Runtime Hosts is planned for a later release.',
          ];
    }
    const lines = [publicationLine(snapshot, this.input.locale)];
    if (snapshot.initialization === 'loading') {
      lines.push(
        this.input.locale === 'zh'
          ? '正在读取 mcp.json 并发现工具…'
          : 'Loading mcp.json and discovering tools…',
      );
      return lines;
    }
    if (snapshot.initialization === 'error') {
      lines.push(
        this.input.locale === 'zh'
          ? ansi.red('无法读取或应用 MCP 配置；没有向 Runtime Host 发布工具。')
          : ansi.red(
              'MCP configuration could not be loaded; no tools were published to the Runtime Host.',
            ),
      );
      return lines;
    }
    if (snapshot.servers.length === 0) {
      lines.push(
        this.input.locale === 'zh' ? '尚未配置 MCP 服务器。' : 'No MCP servers are configured.',
      );
      return lines;
    }
    lines.push('');
    for (const server of snapshot.servers) lines.push(...serverLines(server, this.input.locale));
    return lines;
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.top + delta);
  }

  private scrollTo(next: number): void {
    this.top = clamp(next, 0, this.maxTop());
    this.input.onChange();
  }

  private maxTop(): number {
    return Math.max(0, this.documentRows - this.bodyRows);
  }
}

function publicationLine(
  snapshot: ReturnType<TuiMcpSurface['snapshot']>,
  locale: UiLocale,
): string {
  const publication = {
    waiting: locale === 'zh' ? '等待发布' : 'waiting to publish',
    host_unavailable: locale === 'zh' ? 'Runtime Host 重连中' : 'Runtime Host reconnecting',
    publishing: locale === 'zh' ? '正在发布' : 'publishing',
    published: locale === 'zh' ? '已发布' : 'published',
    not_published: locale === 'zh' ? '未发布' : 'not published',
    error: locale === 'zh' ? '发布失败' : 'publication failed',
  }[snapshot.publication];
  const tools = locale === 'zh' ? `${snapshot.toolCount} 个工具` : `${snapshot.toolCount} tools`;
  return `${ansi.bold(publication)} · ${tools}`;
}

function serverLines(server: TuiMcpServerSnapshot, locale: UiLocale): string[] {
  const protocol = server.negotiatedProtocol
    ? `${server.negotiatedProtocol.era} ${server.negotiatedProtocol.revision}`
    : undefined;
  const tools = locale === 'zh' ? `${server.toolCount} 个工具` : `${server.toolCount} tools`;
  const details = [stateLabel(server.state, locale), server.transport, protocol, tools]
    .filter(Boolean)
    .join(' · ');
  return [
    `${statusMarker(server.state)} ${ansi.bold(server.serverId)}  ${details}`,
    ...(server.error ? [`  ${ansi.red(server.error)}`] : []),
  ];
}

function statusMarker(state: TuiMcpServerSnapshot['state']): string {
  if (state === 'connected') return ansi.green('●');
  if (state === 'connecting') return ansi.yellow('●');
  if (state === 'error' || state === 'needs-auth') return ansi.red('●');
  return ansi.dim('○');
}

function stateLabel(state: TuiMcpServerSnapshot['state'], locale: UiLocale): string {
  if (locale === 'en') return state;
  return {
    disabled: '已停用',
    disconnected: '未连接',
    connecting: '连接中',
    connected: '已连接',
    'needs-auth': '需要登录',
    error: '错误',
  }[state];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}
