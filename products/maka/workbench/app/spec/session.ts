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
  applySpecStreamPatch,
  autoFixSpec,
  getByPath,
  nestedToFlat,
  parseSpecStreamLine,
  type Spec,
  type StateModel,
  type StateStore,
} from '@json-render/core';
import { createStoreAdapter } from '@json-render/core/store-utils';
import { knownSpecComponentTypes } from './names.ts';

export type SpecFrame =
  | { kind: 'loading' }
  | { kind: 'ready'; spec: Spec }
  | { kind: 'error'; reason: string };

export type SpecMarkdownSegment =
  | {
      readonly kind: 'markdown';
      readonly key: string;
      readonly atStart: boolean;
      readonly text: string;
    }
  | {
      readonly kind: 'spec';
      readonly key: string;
      readonly slot: number;
      readonly source: string;
      readonly closed: boolean;
    };

function stripFenceIndent(body: string, indentLen: number): string {
  if (indentLen <= 0 || !body) return body;
  const re = new RegExp(`^ {1,${indentLen}}`, 'gm');
  return body.replace(re, '');
}

/**
 * Splits top-level ```spec / ~~~spec fenced code blocks out of a Markdown
 * stream into stable keyed segments so streaming chunks update SpecView in
 * place without remounting native inputs/signals or colliding sibling blocks.
 */
export function splitSpecMarkdown(markdown: string): readonly SpecMarkdownSegment[] {
  if (!/[`~]{3,}[ \t]*spec(?:[ \t\r\n]|$)/i.test(markdown)) {
    return [{ kind: 'markdown', key: 'm:0', atStart: true, text: markdown }];
  }

  const segments: SpecMarkdownSegment[] = [];
  let mdStart = 0;
  let specSlot = 0;

  type ScanState =
    | { kind: 'normal' }
    | { kind: 'otherFence'; char: '`' | '~'; len: number }
    | {
        kind: 'specFence';
        char: '`' | '~';
        len: number;
        indentLen: number;
        bodyStart: number;
      };

  let state: ScanState = { kind: 'normal' };
  let pos = 0;

  while (pos < markdown.length) {
    const nl = markdown.indexOf('\n', pos);
    const hasNewline = nl !== -1;
    const lineEnd = hasNewline ? nl : markdown.length;
    const rawLine = markdown.slice(pos, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const nextPos = hasNewline ? nl + 1 : markdown.length;

    if (state.kind === 'normal') {
      const open = /^( {0,3})(`{3,}|~{3,})([ \t]*)(.*)$/.exec(line);
      if (open && hasNewline) {
        const indentLen = open[1]!.length;
        const fence = open[2]!;
        const markerChar = fence[0] as '`' | '~';
        const markerLen = fence.length;
        const info = open[4]!;
        if (!(markerChar === '`' && info.includes('`'))) {
          const lang = (info.trim().split(/[ \t]+/, 1)[0] ?? '').toLowerCase();
          if (lang === 'spec') {
            const before = markdown.slice(mdStart, pos);
            if (before.trim().length > 0) {
              segments.push({
                kind: 'markdown',
                key: `m:${specSlot}`,
                atStart: mdStart === 0,
                text: before,
              });
            }
            state = {
              kind: 'specFence',
              char: markerChar,
              len: markerLen,
              indentLen,
              bodyStart: nextPos,
            };
          } else {
            state = { kind: 'otherFence', char: markerChar, len: markerLen };
          }
        }
      }
    } else if (state.kind === 'otherFence') {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === state.char && close[1]!.length >= state.len) {
        state = { kind: 'normal' };
      }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === state.char && close[1]!.length >= state.len) {
        let rawBody = markdown.slice(state.bodyStart, pos);
        if (rawBody.endsWith('\r\n')) {
          rawBody = rawBody.slice(0, -2);
        } else if (rawBody.endsWith('\n')) {
          rawBody = rawBody.slice(0, -1);
        }
        rawBody = stripFenceIndent(rawBody, state.indentLen);
        const slot = specSlot++;
        segments.push({
          kind: 'spec',
          key: `s:${slot}`,
          slot,
          source: rawBody,
          closed: true,
        });
        mdStart = nextPos;
        state = { kind: 'normal' };
      }
    }

    pos = nextPos;
  }

  if (state.kind === 'specFence') {
    const rawBody = stripFenceIndent(markdown.slice(state.bodyStart), state.indentLen);
    const slot = specSlot++;
    segments.push({
      kind: 'spec',
      key: `s:${slot}`,
      slot,
      source: rawBody,
      closed: false,
    });
    mdStart = markdown.length;
  }

  if (specSlot === 0) {
    return [{ kind: 'markdown', key: 'm:0', atStart: true, text: markdown }];
  }

  if (mdStart < markdown.length) {
    const tail = markdown.slice(mdStart);
    if (tail.trim().length > 0) {
      segments.push({
        kind: 'markdown',
        key: `m:${specSlot}`,
        atStart: mdStart === 0,
        text: tail,
      });
    }
  }

  return segments;
}

function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isAncestorTouched(path: string, touched: ReadonlySet<string>): boolean {
  const normalized = normalizePath(path);
  for (const entry of touched) {
    if (entry === '/' || entry === normalized || normalized.startsWith(`${entry}/`)) {
      return true;
    }
  }
  return false;
}

function isPathTouched(path: string, touched: ReadonlySet<string>): boolean {
  const normalized = normalizePath(path);
  for (const entry of touched) {
    if (
      entry === '/' ||
      entry === normalized ||
      normalized.startsWith(`${entry}/`) ||
      entry.startsWith(`${normalized}/`)
    ) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = cloneJson(item);
    }
    return out as T;
  }
  return value;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.hasOwn(objB, k) || !jsonEquals(objA[k], objB[k])) return false;
  }
  return true;
}

function mergeUntouchedValue(
  prev: unknown,
  next: unknown,
  live: unknown,
  path: string,
  touched: ReadonlySet<string>,
): unknown {
  if (isAncestorTouched(path, touched)) {
    return cloneJson(live);
  }
  if (!isPathTouched(path, touched)) {
    return live !== undefined && jsonEquals(prev, next) ? cloneJson(live) : cloneJson(next);
  }
  if (isPlainObject(next)) {
    const prevObj = isPlainObject(prev) ? prev : {};
    const liveObj = isPlainObject(live) ? live : {};
    const out: Record<string, unknown> = { ...cloneJson(liveObj) };
    for (const [key, childNext] of Object.entries(next)) {
      const childPath = `${path}/${escapeToken(key)}`;
      out[key] = mergeUntouchedValue(prevObj[key], childNext, liveObj[key], childPath, touched);
    }
    for (const key of Object.keys(prevObj)) {
      if (!Object.hasOwn(next, key)) {
        const childPath = `${path}/${escapeToken(key)}`;
        if (!isPathTouched(childPath, touched)) {
          delete out[key];
        }
      }
    }
    return out;
  }
  if (Array.isArray(next)) {
    const prevArr = Array.isArray(prev) ? prev : [];
    const liveArr = Array.isArray(live) ? live : [];
    const out: unknown[] = [];
    for (let i = 0; i < next.length; i++) {
      const childPath = `${path}/${i}`;
      out.push(
        mergeUntouchedValue(
          prevArr[i],
          next[i],
          i < liveArr.length ? liveArr[i] : next[i],
          childPath,
          touched,
        ),
      );
    }
    return out;
  }
  return jsonEquals(prev, next) ? cloneJson(live) : cloneJson(next);
}

function parseWholeJsonSpec(trimmed: string): Record<string, unknown> | null {
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (typeof parsed.root === 'string' && isPlainObject(parsed.elements)) {
      return parsed;
    }
    if (typeof parsed.type === 'string') {
      return nestedToFlat(parsed) as unknown as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export class SpecSession {
  private stateSnapshot: StateModel = {};
  private readonly stateListeners = new Set<() => void>();
  readonly store: StateStore = createStoreAdapter({
    getSnapshot: () => this.stateSnapshot,
    setSnapshot: (next) => this.setStateSnapshot(next),
    subscribe: (listener) => {
      this.stateListeners.add(listener);
      return () => {
        this.stateListeners.delete(listener);
      };
    },
  });
  lastSource = '';

  private hasIngested = false;
  private lastStreaming = false;
  private committedLines: string[] = [];
  private committedPatchCount = 0;
  private committedDoc: Record<string, unknown> = {};
  private hadSpecState = false;
  private initialState: StateModel = {};
  private syncedSpecState: StateModel = {};
  private readonly touchedPaths = new Set<string>();
  private frame: SpecFrame = { kind: 'loading' };
  private readonly frameListeners = new Set<() => void>();

  private setStateSnapshot(next: StateModel): void {
    if (this.stateSnapshot === next) return;
    this.stateSnapshot = next;
    for (const listener of this.stateListeners) {
      listener();
    }
  }

  getFrame(): SpecFrame {
    return this.frame;
  }

  subscribeFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  userSet(path: string, value: unknown): void {
    const normalized = normalizePath(path);
    this.touchedPaths.add(normalized);
    this.store.set(normalized, value);
  }

  userUpdate(updates: Record<string, unknown>): void {
    const normalizedUpdates: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(updates)) {
      const normalized = normalizePath(path);
      this.touchedPaths.add(normalized);
      normalizedUpdates[normalized] = value;
    }
    this.store.update(normalizedUpdates);
  }

  resetState(statePath?: string): void {
    if (statePath && statePath !== '/') {
      const normalized = normalizePath(statePath);
      for (const entry of [...this.touchedPaths]) {
        if (entry === normalized || entry.startsWith(`${normalized}/`)) {
          this.touchedPaths.delete(entry);
        }
      }
      const initial = getByPath(this.initialState, normalized);
      if (initial !== undefined) {
        this.store.set(normalized, cloneJson(initial));
      } else {
        const segments = normalized
          .slice(1)
          .split('/')
          .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
        if (segments.length === 1 && Object.hasOwn(this.stateSnapshot, segments[0]!)) {
          const next = { ...this.stateSnapshot };
          delete next[segments[0]!];
          this.setStateSnapshot(next);
        } else {
          this.store.set(normalized, undefined);
        }
      }
      return;
    }
    this.touchedPaths.clear();
    this.setStateSnapshot(cloneJson(this.initialState));
  }

  ingest(source: string, streaming: boolean): SpecFrame {
    if (this.hasIngested && source === this.lastSource && streaming === this.lastStreaming) {
      return this.frame;
    }
    this.hasIngested = true;
    this.lastSource = source;
    this.lastStreaming = streaming;
    const nextFrame = this.compile(source, streaming);
    this.frame = nextFrame;
    for (const listener of this.frameListeners) {
      listener();
    }
    return nextFrame;
  }

  private compile(source: string, streaming: boolean): SpecFrame {
    const trimmed = source.trim();
    if (!trimmed) {
      return streaming ? { kind: 'loading' } : { kind: 'error', reason: 'Empty spec block' };
    }

    const lines = source.split('\n');
    const completeLines = lines.slice(0, -1);
    const tailLine = lines[lines.length - 1] ?? '';

    const prefixMatches =
      completeLines.length >= this.committedLines.length &&
      this.committedLines.every((prev, idx) => completeLines[idx] === prev);

    if (!prefixMatches) {
      this.committedLines = [];
      this.committedPatchCount = 0;
      this.committedDoc = {};
    }

    try {
      for (let i = this.committedLines.length; i < completeLines.length; i++) {
        const line = completeLines[i]!;
        const patch = parseSpecStreamLine(line);
        if (patch) {
          applySpecStreamPatch(this.committedDoc, patch);
          this.committedPatchCount++;
        }
        this.committedLines.push(line);
      }

      let workingDoc = this.committedDoc;
      let patchCount = this.committedPatchCount;
      const tailPatch = parseSpecStreamLine(tailLine);
      if (tailPatch) {
        workingDoc = cloneJson(this.committedDoc);
        applySpecStreamPatch(workingDoc, tailPatch);
        patchCount++;
      }

      if (patchCount === 0) {
        const whole = parseWholeJsonSpec(trimmed);
        if (whole) {
          workingDoc = whole;
        } else {
          return streaming
            ? { kind: 'loading' }
            : { kind: 'error', reason: 'Invalid JSONL spec patch stream' };
        }
      } else if (!streaming && tailLine.trim() && !tailPatch && !tailLine.trim().startsWith('//')) {
        return {
          kind: 'error',
          reason: `Malformed spec patch line: ${tailLine.trim().slice(0, 80)}`,
        };
      }

      if (isPlainObject(workingDoc.state)) {
        this.hadSpecState = true;
        this.syncSpecState(workingDoc.state);
      } else if (this.hadSpecState) {
        this.hadSpecState = false;
        this.syncSpecState({});
      }

      const rootKey = typeof workingDoc.root === 'string' ? workingDoc.root : '';
      const rawElements = isPlainObject(workingDoc.elements) ? workingDoc.elements : {};
      if (!rootKey || !isPlainObject(rawElements[rootKey])) {
        return streaming
          ? { kind: 'loading' }
          : {
              kind: 'error',
              reason: rootKey ? `Missing root element "${rootKey}"` : 'Missing /root',
            };
      }

      const candidate: Spec = {
        root: rootKey,
        elements: cloneJson(rawElements) as Spec['elements'],
        ...(isPlainObject(workingDoc.state) ? { state: cloneJson(workingDoc.state) } : {}),
      };
      const { spec } = autoFixSpec(candidate, { lossy: false });

      for (const [key, el] of Object.entries(spec.elements)) {
        if (!el || typeof el.type !== 'string') {
          if (streaming) continue;
          return { kind: 'error', reason: `Element "${key}" is missing a component type` };
        }
        if (!knownSpecComponentTypes.has(el.type)) {
          return { kind: 'error', reason: `Unknown component "${el.type}" on element "${key}"` };
        }
      }

      return { kind: 'ready', spec };
    } catch (error) {
      return {
        kind: 'error',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private syncSpecState(nextState: StateModel): void {
    this.initialState = cloneJson(nextState);
    const liveSnapshot = this.stateSnapshot;
    const nextSnapshot: StateModel = { ...liveSnapshot };
    let changed = false;
    const allKeys = new Set([...Object.keys(this.syncedSpecState), ...Object.keys(nextState)]);

    for (const key of allKeys) {
      const topPath = `/${escapeToken(key)}`;
      if (!Object.hasOwn(nextState, key)) {
        if (!isPathTouched(topPath, this.touchedPaths)) {
          if (Object.hasOwn(nextSnapshot, key)) {
            delete nextSnapshot[key];
            changed = true;
          }
        } else if (isPlainObject(this.syncedSpecState[key])) {
          const merged = mergeUntouchedValue(
            this.syncedSpecState[key],
            {},
            liveSnapshot[key],
            topPath,
            this.touchedPaths,
          );
          if (!jsonEquals(merged, liveSnapshot[key])) {
            nextSnapshot[key] = merged;
            changed = true;
          }
        }
        continue;
      }

      const prevVal = this.syncedSpecState[key];
      const nextVal = nextState[key];
      if (Object.hasOwn(liveSnapshot, key) && jsonEquals(prevVal, nextVal)) {
        continue;
      }
      const merged = mergeUntouchedValue(
        prevVal,
        nextVal,
        liveSnapshot[key],
        topPath,
        this.touchedPaths,
      );
      if (!Object.hasOwn(liveSnapshot, key) || !jsonEquals(merged, liveSnapshot[key])) {
        nextSnapshot[key] = merged;
        changed = true;
      }
    }

    this.syncedSpecState = cloneJson(nextState);
    if (changed) {
      this.setStateSnapshot(nextSnapshot);
    }
  }
}
