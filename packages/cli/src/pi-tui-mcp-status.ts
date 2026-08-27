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
import { defineTuiCopyCatalog, formatTuiCopy, getTuiCopyCatalog } from './tui-copy-catalog.js';

const CHROME_ROWS = 2;

interface TuiMcpStatusCopy {
  readonly title: string;
  readonly footer: string;
  readonly unavailableTitle: string;
  readonly unavailableDetail: string;
  readonly loading: string;
  readonly loadError: string;
  readonly noServers: string;
  readonly publication: Readonly<
    Record<ReturnType<TuiMcpSurface['snapshot']>['publication'], string>
  >;
  readonly serverState: Readonly<Record<TuiMcpServerSnapshot['state'], string>>;
  readonly toolCount: string;
}

const MCP_STATUS_COPY = defineTuiCopyCatalog<TuiMcpStatusCopy>()(getTuiCopyCatalog('mcp-status'));

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
    const copy = MCP_STATUS_COPY[this.input.locale];
    const header = padLine(
      `${ansi.bold(copy.title)} ${ansi.dim(`${start}-${end} / ${document.length}`)}`,
      safeWidth,
    );
    const body = [
      ...visible.map((line) => padLine(line, safeWidth)),
      ...Array.from({ length: Math.max(0, this.bodyRows - visible.length) }, () =>
        ' '.repeat(safeWidth),
      ),
    ];
    if (!showFooter) return [header, ...body];
    return [header, ...body, padLine(ansi.dim(copy.footer), safeWidth)];
  }

  private document(): string[] {
    const snapshot = this.input.surface?.snapshot();
    const copy = MCP_STATUS_COPY[this.input.locale];
    if (!snapshot) {
      return [ansi.yellow(copy.unavailableTitle), copy.unavailableDetail];
    }
    const lines = [publicationLine(snapshot, this.input.locale)];
    if (snapshot.initialization === 'loading') {
      lines.push(copy.loading);
      return lines;
    }
    if (snapshot.initialization === 'error') {
      lines.push(ansi.red(copy.loadError));
      return lines;
    }
    if (snapshot.servers.length === 0) {
      lines.push(copy.noServers);
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
  const copy = MCP_STATUS_COPY[locale];
  const publication = copy.publication[snapshot.publication];
  const tools = formatTuiCopy(copy.toolCount, { count: snapshot.toolCount });
  return `${ansi.bold(publication)} · ${tools}`;
}

function serverLines(server: TuiMcpServerSnapshot, locale: UiLocale): string[] {
  const protocol = server.negotiatedProtocol
    ? `${server.negotiatedProtocol.era} ${server.negotiatedProtocol.revision}`
    : undefined;
  const copy = MCP_STATUS_COPY[locale];
  const tools = formatTuiCopy(copy.toolCount, { count: server.toolCount });
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
  return MCP_STATUS_COPY[locale].serverState[state];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}
