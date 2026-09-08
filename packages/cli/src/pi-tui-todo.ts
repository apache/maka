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
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui';
import {
  projectSessionTodoItemsForDisplay,
  type SessionTodoItem,
  type SessionTodoSnapshot,
} from '@maka/core/session-todo';
import type { UiLocale } from '@maka/core/ui-locale';
import { ansi } from './tui-ansi.js';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';

export interface SessionTodoReader {
  read(sessionId: string): Promise<SessionTodoSnapshot>;
}

export type TodoQueryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface TodoQuerySnapshot {
  status: TodoQueryStatus;
  sessionId?: string;
  generation: number;
  items: readonly SessionTodoItem[];
  refreshing?: boolean;
}

export type TodoQueryListener = (snapshot: TodoQuerySnapshot) => void;

/**
 * Current Todo projection for one session. A load is accepted only when both
 * its generation and session identity still match, so a late response from a
 * previous session cannot overwrite the visible current state.
 */
export class TodoQueryState {
  private snapshot: TodoQuerySnapshot = { status: 'idle', generation: 0, items: [] };
  private readonly listeners = new Set<TodoQueryListener>();

  getSnapshot(): TodoQuerySnapshot {
    return this.snapshot;
  }

  subscribe(listener: TodoQueryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(sessionId: string, reader: SessionTodoReader): Promise<boolean> {
    const generation = this.snapshot.generation + 1;
    const previous = this.snapshot;
    const hasCurrentData =
      previous.sessionId === sessionId &&
      (previous.status === 'ready' || previous.status === 'empty');
    this.publish({
      status: hasCurrentData ? previous.status : 'loading',
      sessionId,
      generation,
      items: hasCurrentData ? previous.items : [],
      refreshing: hasCurrentData,
    });
    try {
      const result = await reader.read(sessionId);
      if (!this.isCurrent(sessionId, generation)) return false;
      const items = projectSessionTodoItemsForDisplay(result.items);
      this.publish({
        status: items.length === 0 ? 'empty' : 'ready',
        sessionId,
        generation,
        items,
        refreshing: false,
      });
      return true;
    } catch {
      if (!this.isCurrent(sessionId, generation)) return false;
      this.publish({ status: 'error', sessionId, generation, items: [] });
      return true;
    }
  }

  reset(): void {
    this.publish({ status: 'idle', generation: this.snapshot.generation + 1, items: [] });
  }

  private isCurrent(sessionId: string, generation: number): boolean {
    return this.snapshot.sessionId === sessionId && this.snapshot.generation === generation;
  }

  private publish(snapshot: TodoQuerySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** Runner-facing owner for the one current-session Todo query. */
export class CurrentTodoStore {
  private readonly query = new TodoQueryState();
  private readonly unsubscribe: () => void;
  private sessionId: string | undefined;
  private disposed = false;
  private refreshRecord: { sessionId: string; promise: Promise<boolean> } | undefined;
  private refreshAgain = false;

  constructor(
    private readonly reader: SessionTodoReader,
    onChange?: TodoQueryListener,
  ) {
    this.unsubscribe = onChange ? this.query.subscribe(onChange) : () => undefined;
  }

  getState(): TodoQuerySnapshot {
    return this.query.getSnapshot();
  }

  setSession(sessionId: string | undefined): void {
    if (this.disposed || this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.refreshAgain = false;
    this.refreshRecord = undefined;
    this.query.reset();
    if (sessionId) void this.refresh();
  }

  refresh(): Promise<boolean> {
    if (this.disposed || !this.sessionId) return Promise.resolve(false);
    const current = this.refreshRecord;
    if (current?.sessionId === this.sessionId) {
      this.refreshAgain = true;
      return current.promise;
    }
    const sessionId = this.sessionId;
    const promise = this.query.load(sessionId, this.reader).finally(() => {
      if (this.refreshRecord?.promise !== promise) return;
      this.refreshRecord = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        if (!this.disposed && this.sessionId === sessionId) void this.refresh();
      }
    });
    this.refreshRecord = { sessionId, promise };
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionId = undefined;
    this.refreshRecord = undefined;
    this.unsubscribe();
    this.query.reset();
  }
}

export interface TodoIndicatorInput {
  locale: UiLocale;
  width: number;
}

/** Render the one-line current Todo indicator. Empty and initial states stay hidden. */
export function renderTodoIndicator(
  snapshot: TodoQuerySnapshot,
  input: TodoIndicatorInput,
): string | undefined {
  const copy = TUI_COPY_RESOURCES.todo[input.locale];
  if (snapshot.status === 'idle' || snapshot.status === 'loading' || snapshot.status === 'empty') {
    return undefined;
  }
  if (snapshot.status === 'error')
    return fitLine(`${copy.unavailable} · ${copy.open}`, input.width);
  const current = snapshot.items.find((item) => item.status === 'in_progress');
  const completed = snapshot.items.filter((item) => item.status === 'completed').length;
  const suffix = `${copy.progress} ${completed}/${snapshot.items.length} · ${copy.open}`;
  const prefix = current ? `${ansi.accent('◐')} ` : '';
  const available = input.width - visibleWidth(prefix) - visibleWidth(suffix) - (current ? 3 : 1);
  if (!current) return fitLine(suffix, input.width);
  if (available < 1) return fitLine(suffix, input.width);
  const content = truncateToWidth(current.content, Math.max(1, available), '…');
  return fitLine(`${prefix}${content} · ${suffix}`, input.width);
}

export interface TodoOverlayInput {
  locale: UiLocale;
  getState: () => TodoQuerySnapshot;
  viewportRows: () => number;
  onClose: () => void;
  onChange?: () => void;
}

/** Read-only, scrollable view of the current Todo projection. */
export class TodoOverlay implements Component {
  private top = 0;
  private bodyRows = 1;
  private width = 80;

  constructor(private readonly input: TodoOverlayInput) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.input.onClose();
      return;
    }
    if (isKeyRepeat(data)) return;
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.bodyRows);
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.bodyRows);
    else if (matchesKey(data, Key.home)) {
      this.scrollTo(0);
      this.input.onChange?.();
    } else if (matchesKey(data, Key.end)) {
      this.scrollTo(Number.MAX_SAFE_INTEGER);
      this.input.onChange?.();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.width = safeWidth;
    const copy = TUI_COPY_RESOURCES.todo[this.input.locale];
    const viewport = Math.max(1, Math.floor(this.input.viewportRows()));
    const showFooter = viewport > 2;
    this.bodyRows = Math.max(0, viewport - (showFooter ? 2 : 1));
    const snapshot = this.input.getState();
    const rows = this.rows(snapshot, safeWidth);
    const maxTop = Math.max(0, rows.length - this.bodyRows);
    this.top = Math.min(this.top, maxTop);
    const visible = rows.slice(this.top, this.top + this.bodyRows);
    const completed = snapshot.items.filter((item) => item.status === 'completed').length;
    const summary =
      snapshot.status === 'ready'
        ? ` · ${completed}/${snapshot.items.length} ${copy.markedComplete}`
        : '';
    const position =
      rows.length > this.bodyRows && this.bodyRows > 0
        ? ` · ${this.top + 1}-${this.top + visible.length}/${rows.length}`
        : '';
    const header = padLine(`${ansi.bold(copy.title)}${summary}${ansi.dim(position)}`, safeWidth);
    const body = [
      ...visible,
      ...Array.from({ length: this.bodyRows - visible.length }, () => ' '.repeat(safeWidth)),
    ];
    if (!showFooter) return [header, ...body];
    const footer = padLine(ansi.dim(copy.hint), safeWidth);
    return [header, ...body, footer];
  }

  private rows(snapshot: TodoQuerySnapshot, width: number): string[] {
    const copy = TUI_COPY_RESOURCES.todo[this.input.locale];
    if (snapshot.status === 'loading') return [padLine(copy.loading, width)];
    if (snapshot.status === 'error') return [padLine(copy.unavailable, width)];
    if (snapshot.status === 'idle' || snapshot.status === 'empty')
      return [padLine(copy.empty, width)];
    return snapshot.items.flatMap((item) => {
      const symbol =
        item.status === 'completed'
          ? ansi.green('✓')
          : item.status === 'in_progress'
            ? ansi.accent('●')
            : ansi.muted('○');
      return wrapTodoItem(`${symbol} `, item.content, width);
    });
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.top + delta);
    this.input.onChange?.();
  }

  private scrollTo(top: number): void {
    const rows = this.rows(this.input.getState(), this.width);
    this.top = Math.max(0, Math.min(top, Math.max(0, rows.length - this.bodyRows)));
  }
}

function wrapTodoItem(prefix: string, content: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const firstWidth = Math.max(1, safeWidth - visibleWidth(prefix));
  const lines: string[] = [];
  let remaining = content;
  let first = true;
  while (remaining.length > 0 || lines.length === 0) {
    const available = first ? firstWidth : safeWidth - 2;
    let take = '';
    for (const character of graphemes(remaining)) {
      if (visibleWidth(`${take}${character}`) > Math.max(1, available)) break;
      take += character;
    }
    if (!take) take = graphemes(remaining)[0] ?? '';
    remaining = remaining.slice(take.length);
    lines.push(padLine(`${first ? prefix : '  '}${take}`, safeWidth));
    first = false;
  }
  return lines;
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(
      (part) => part.segment,
    );
  }
  return Array.from(value);
}

function fitLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), '…');
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = fitLine(text, safeWidth);
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}
