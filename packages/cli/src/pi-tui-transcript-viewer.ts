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
  Input,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui';
import type { UiLocale } from '@maka/core/ui-locale';
import { ansi, stripAnsi } from './tui-ansi.js';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';

const VIEWER_CHROME_ROWS = 2;

export interface TranscriptDocument {
  lines: readonly string[];
  anchors: readonly { id: string; line: number }[];
}

export interface TranscriptViewerInput {
  /** Produces the current read-only CLI transcript projection at this width. */
  renderTranscript(width: number, expanded: boolean): TranscriptDocument;
  locale?: UiLocale;
  viewportRows(): number;
  onClose(): void;
  onChange(): void;
}

/**
 * Full-screen, read-only navigation over the CLI transcript projection.
 *
 * The normal editor keeps ownership of its navigation keys. This component only
 * sees them while its capturing overlay is focused, so opening the viewer does
 * not create a second set of global editor bindings or a second history source.
 */
export class TranscriptViewerOverlay implements Component {
  focused = false;
  private top = 0;
  private documentRows = 0;
  private bodyRows = 0;
  private followsEnd = true;
  private document: TranscriptDocument = { lines: [], anchors: [] };
  private expanded = true;
  private anchor: { id: string; offset: number } | undefined;
  private search = new Input();
  private searching = false;
  private query = '';
  private matches: number[] = [];
  private searchOrigin:
    | { top: number; followsEnd: boolean; anchor: { id: string; offset: number } | undefined }
    | undefined;
  private matchedLine: number | undefined;

  constructor(private readonly input: TranscriptViewerInput) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.ctrl('o'))) {
      if (!isKeyRepeat(data)) this.input.onClose();
      return;
    }
    if (this.searching) {
      if (matchesKey(data, Key.escape)) {
        this.searching = false;
        this.query = '';
        this.matches = [];
        if (this.searchOrigin) Object.assign(this, this.searchOrigin);
        this.input.onChange();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.searching = false;
        this.input.onChange();
        return;
      }
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.nextMatch(matchesKey(data, Key.up) ? -1 : 1);
        return;
      }
      this.search.handleInput(data);
      const query = this.search.getValue().trim().toLocaleLowerCase();
      if (query !== this.query) {
        this.query = query;
        this.findMatches();
        const target =
          this.matches.find((line) => line >= (this.searchOrigin?.top ?? 0)) ?? this.matches[0];
        if (target !== undefined) this.goToMatch(target);
      }
      this.input.onChange();
      return;
    }
    if (matchesKey(data, Key.escape) && this.query) {
      this.query = '';
      this.matches = [];
      if (this.searchOrigin) Object.assign(this, this.searchOrigin);
      this.input.onChange();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.input.onClose();
      return;
    }
    if (matchesKey(data, '/')) {
      this.searchOrigin = {
        top: this.top,
        followsEnd: this.followsEnd,
        anchor: this.anchor ? { ...this.anchor } : undefined,
      };
      this.search.setValue(this.query);
      this.searching = true;
      this.input.onChange();
      return;
    }
    if (this.query && (matchesKey(data, 'n') || matchesKey(data, Key.shift('n')))) {
      this.nextMatch(matchesKey(data, Key.shift('n')) ? -1 : 1);
      return;
    }
    if (matchesKey(data, Key.ctrl('e'))) {
      if (!isKeyRepeat(data)) {
        this.expanded = !this.expanded;
        // A detail that disappears on collapse returns to its own heading.
        if (!this.expanded && this.anchor) this.anchor.offset = 0;
        this.input.onChange();
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-Math.max(1, this.bodyRows));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(Math.max(1, this.bodyRows));
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.followsEnd = false;
      this.top = 0;
      this.captureAnchor();
      this.input.onChange();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.followsEnd = true;
      this.top = this.maxTop();
      this.captureAnchor();
      this.input.onChange();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const viewportRows = Math.max(1, Math.floor(this.input.viewportRows()));
    // A two-row terminal is still more useful with one document row than with
    // navigation chrome only. The footer appears once header + body + footer fit.
    const showFooter = viewportRows > 2;
    this.bodyRows = Math.max(0, viewportRows - (showFooter ? VIEWER_CHROME_ROWS : 1));

    this.document = this.input.renderTranscript(safeWidth, this.expanded);
    const document = this.document.lines;
    this.documentRows = document.length;
    if (!this.followsEnd && this.anchor) {
      const index = this.document.anchors.findIndex((entry) => entry.id === this.anchor!.id);
      if (index >= 0) {
        const entry = this.document.anchors[index]!;
        const end = this.document.anchors[index + 1]?.line ?? document.length;
        this.top = entry.line + Math.min(this.anchor.offset, Math.max(0, end - entry.line - 1));
      }
    }
    const maxTop = this.maxTop();
    this.top = this.followsEnd ? maxTop : clamp(this.top, 0, maxTop);
    this.captureAnchor();
    this.findMatches();

    const visible = document.slice(this.top, this.top + this.bodyRows);
    const start = visible.length === 0 ? 0 : this.top + 1;
    const end = visible.length === 0 ? 0 : this.top + visible.length;
    const copy = TUI_COPY_RESOURCES['transcript-reader'][this.input.locale ?? 'en'];
    const header = padLine(
      `${ansi.bold(copy.title)} ${ansi.dim(`${start}-${end}/${document.length} · ${copy.scope}`)}`,
      safeWidth,
    );
    const matchingLines = new Set(this.matches);
    const body = [
      ...visible.map((line, index) =>
        padLine(
          matchingLines.has(this.top + index) ? ansi.reverse(stripAnsi(line)) : line,
          safeWidth,
        ),
      ),
      ...Array.from({ length: Math.max(0, this.bodyRows - visible.length) }, () =>
        ' '.repeat(safeWidth),
      ),
    ];
    if (!showFooter) return [header, ...body];

    this.search.focused = this.focused && this.searching;
    const footer = padLine(
      this.searching
        ? `/ ${this.search.render(Math.max(1, safeWidth - 3))[0] ?? ''}`
        : ansi.dim(
            this.query
              ? `${this.matches.length} ${copy.matches} · n/N · Esc ${copy.back}`
              : copy.hint,
          ),
      safeWidth,
    );
    return [header, ...body, footer];
  }

  private scrollBy(delta: number): void {
    this.matchedLine = undefined;
    const maxTop = this.maxTop();
    this.top = clamp(this.top + delta, 0, maxTop);
    // Follow the tail whenever the clamped position is the end, including the
    // no-op case where a short transcript cannot move at all: a stray Up key
    // must not pin the viewer at the head once the transcript grows.
    this.followsEnd = this.top === maxTop;
    this.captureAnchor();
    this.input.onChange();
  }

  private captureAnchor(): void {
    const entry = [...this.document.anchors].reverse().find((entry) => entry.line <= this.top);
    this.anchor = entry ? { id: entry.id, offset: this.top - entry.line } : undefined;
  }

  private findMatches(): void {
    this.matches = this.query
      ? this.document.lines.flatMap((line, index) =>
          stripAnsi(line).toLocaleLowerCase().includes(this.query) ? [index] : [],
        )
      : [];
  }

  private goToMatch(line: number): void {
    this.matchedLine = line;
    this.top = clamp(line, 0, this.maxTop());
    this.followsEnd = false;
    this.captureAnchor();
  }

  private nextMatch(direction: number): void {
    const current = this.matchedLine ?? this.top;
    const line =
      direction > 0
        ? (this.matches.find((line) => line > current) ?? this.matches[0])
        : ([...this.matches].reverse().find((line) => line < current) ?? this.matches.at(-1));
    if (line !== undefined) this.goToMatch(line);
    this.input.onChange();
  }

  private maxTop(): number {
    return Math.max(0, this.documentRows - this.bodyRows);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}
