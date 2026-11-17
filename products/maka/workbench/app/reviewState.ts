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

import { Buffer } from 'buffer';
import { signal } from 'nsh';
import type {
  GitArea,
  ServiceMethods,
  WorkspacePath,
} from '../../../../packages/plugin-sdk/src/index.js';

export type CodeDefinitionResult = ServiceMethods['agent']['codeDefinition']['output'];
export type CodeReferencesResult = ServiceMethods['agent']['codeReferences']['output'];
export type CodeHoverResult = NonNullable<ServiceMethods['agent']['codeHover']['output']>;
export type CodeBackend = CodeDefinitionResult['backend'];
export type CodeLocation = CodeDefinitionResult['locations'][number];
export type GitWorkspaceDiff = NonNullable<ServiceMethods['agent']['gitWorkspaceDiff']['output']>;

export type ReviewNote = {
  id: string;
  sessionId: string;
  path: WorkspacePath;
  pathLabel: string;
  area?: GitArea;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  excerpt: string;
  comment: string;
};

export type SymbolLocationBatch = {
  kind: 'definitions' | 'references';
  symbol: string;
  backend: CodeBackend;
  locations: CodeLocation[];
  truncated: boolean;
  activeIndex: number;
};

export type ReviewStore = {
  notes(sessionId: string): ReviewNote[];
  upsertNote(note: Omit<ReviewNote, 'id'> & { id?: string }): ReviewNote;
  removeNote(sessionId: string, id: string): void;
  clearNotes(sessionId: string): void;
  symbolBatch(sessionId: string): SymbolLocationBatch | null;
  setSymbolBatch(sessionId: string, batch: SymbolLocationBatch | null): void;
  selectSymbolLocation(sessionId: string, index: number): void;
  statusMessage(sessionId: string): string;
  setStatusMessage(sessionId: string, message: string): void;
  pruneSessions(activeSessionIds: readonly string[]): void;
};

export function createReviewStore(): ReviewStore {
  const bySession = signal<Record<string, ReviewNote[]>>({});
  const symbolsBySession = signal<Record<string, SymbolLocationBatch | null>>({});
  const statusBySession = signal<Record<string, string>>({});
  let nextId = 1;

  return {
    notes(sessionId) {
      return bySession()[sessionId] ?? [];
    },
    upsertNote(input) {
      const current = bySession()[input.sessionId] ?? [];
      const id = input.id ?? `note-${nextId++}`;
      const note: ReviewNote = {
        id,
        sessionId: input.sessionId,
        path: input.path,
        pathLabel: input.pathLabel,
        ...(input.area ? { area: input.area } : {}),
        side: input.side,
        startLine: Math.min(input.startLine, input.endLine),
        endLine: Math.max(input.startLine, input.endLine),
        excerpt: input.excerpt,
        comment: input.comment.trim(),
      };
      const exists = current.some((entry) => entry.id === id);
      const next = exists
        ? current.map((entry) => (entry.id === id ? note : entry))
        : [...current, note];
      bySession.set({ ...bySession(), [input.sessionId]: next });
      return note;
    },
    removeNote(sessionId, id) {
      const current = bySession()[sessionId];
      if (!current) return;
      bySession.set({
        ...bySession(),
        [sessionId]: current.filter((entry) => entry.id !== id),
      });
    },
    clearNotes(sessionId) {
      if (!(sessionId in bySession())) return;
      const copy = { ...bySession() };
      delete copy[sessionId];
      bySession.set(copy);
    },
    symbolBatch(sessionId) {
      return symbolsBySession()[sessionId] ?? null;
    },
    setSymbolBatch(sessionId, batch) {
      symbolsBySession.set({ ...symbolsBySession(), [sessionId]: batch });
    },
    selectSymbolLocation(sessionId, index) {
      const current = symbolsBySession()[sessionId];
      if (!current) return;
      symbolsBySession.set({
        ...symbolsBySession(),
        [sessionId]: { ...current, activeIndex: index },
      });
    },
    statusMessage(sessionId) {
      return statusBySession()[sessionId] ?? '';
    },
    setStatusMessage(sessionId, message) {
      statusBySession.set({ ...statusBySession(), [sessionId]: message });
    },
    pruneSessions(activeSessionIds) {
      const keep = new Set(activeSessionIds);
      const filterMap = <T>(record: Record<string, T>): [Record<string, T>, boolean] => {
        let changed = false;
        const next: Record<string, T> = {};
        for (const [k, v] of Object.entries(record)) {
          if (keep.has(k)) next[k] = v;
          else changed = true;
        }
        return [next, changed];
      };
      const [nextNotes, c1] = filterMap(bySession());
      if (c1) bySession.set(nextNotes);
      const [nextSyms, c2] = filterMap(symbolsBySession());
      if (c2) symbolsBySession.set(nextSyms);
      const [nextStatus, c3] = filterMap(statusBySession());
      if (c3) statusBySession.set(nextStatus);
    },
  };
}

export function languageHintFromPath(pathLabel: string): string {
  const lower = pathLabel.toLowerCase();
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'ts';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'js';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'json';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'sh';
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.cc') || lower.endsWith('.cpp') || lower.endsWith('.hpp')) return 'cpp';
  return '';
}

export function formatLineLabel(startLine: number, endLine: number): string {
  const s = startLine + 1;
  const e = endLine + 1;
  return s === e ? `L${s}` : `L${s}-L${e}`;
}

export function formatReviewNote(
  note: Pick<ReviewNote, 'pathLabel' | 'side' | 'startLine' | 'endLine' | 'excerpt' | 'comment'>,
): string {
  const loc = `${note.pathLabel}#${formatLineLabel(note.startLine, note.endLine)}`;
  const sideTag = note.side === 'old' ? ' (before)' : '';
  const lang = languageHintFromPath(note.pathLabel);
  const snippet = note.excerpt.replace(/\r?\n$/, '');
  const parts = [`\`${loc}\`${sideTag}:`];
  if (snippet.trim().length > 0) {
    const runs = snippet.match(/`+/g);
    const maxTicks = runs ? Math.max(...runs.map((r) => r.length)) : 0;
    const fence = '`'.repeat(Math.max(3, maxTicks + 1));
    parts.push(fence + lang + '\n' + snippet + '\n' + fence);
  }
  if (note.comment.trim().length > 0) {
    parts.push(note.comment.trim());
  }
  return parts.join('\n');
}

export function formatReviewBatch(notes: readonly ReviewNote[]): string {
  return notes.map((note) => formatReviewNote(note)).join('\n\n');
}

const IGNORED_WORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'loop',
  'match',
  'switch',
  'case',
  'return',
  'break',
  'continue',
  'let',
  'const',
  'var',
  'mut',
  'pub',
  'fn',
  'def',
  'func',
  'async',
  'await',
  'import',
  'export',
  'from',
  'use',
  'mod',
  'impl',
  'struct',
  'enum',
  'trait',
  'type',
  'interface',
  'class',
  'function',
  'true',
  'false',
  'null',
  'undefined',
  'self',
  'this',
  'super',
  'void',
  'string',
  'number',
  'boolean',
  'u8',
  'u16',
  'u32',
  'u64',
  'usize',
  'i8',
  'i16',
  'i32',
  'i64',
  'isize',
  'f32',
  'f64',
  'bool',
  'str',
  'String',
  'Option',
  'Result',
  'Some',
  'None',
  'Ok',
  'Err',
  'Vec',
]);

/** Extracts distinct navigable identifiers from code text, preserving source appearance order. */
export function extractLineIdentifiers(text: string, limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{1,63}/g);
  for (const match of matches) {
    const word = match[0];
    if (IGNORED_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/** Converts a `file://` link inside the session workspace into a workspace-relative target. */
export function relativizeWorkspaceFileUrl(target: string, workspaceDir?: string): string {
  if (!workspaceDir || !target.startsWith('file://')) return target;
  let rest = target.slice('file://'.length);
  if (rest.startsWith('localhost/')) rest = rest.slice('localhost'.length);
  const hashIdx = rest.indexOf('#');
  const queryIdx = rest.indexOf('?');
  const cut =
    hashIdx >= 0 && queryIdx >= 0 ? Math.min(hashIdx, queryIdx) : hashIdx >= 0 ? hashIdx : queryIdx;
  const rawPath = cut >= 0 ? rest.slice(0, cut) : rest;
  const suffix = cut >= 0 ? rest.slice(cut) : '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return target;
  }
  let normDir = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '');
  let normPath = decoded.replace(/\\/g, '/');
  if (/^\/[A-Za-z]:\//.test(normPath)) normPath = normPath.slice(1);
  if (/^\/[A-Za-z]:\//.test(normDir)) normDir = normDir.slice(1);
  if (/^[A-Za-z]:\//.test(normPath) && /^[A-Za-z]:\//.test(normDir)) {
    normPath = normPath[0]!.toLowerCase() + normPath.slice(1);
    normDir = normDir[0]!.toLowerCase() + normDir.slice(1);
  }
  const candidates = [normDir];
  if (normDir.startsWith('/private/')) candidates.push(normDir.slice('/private'.length));
  else if (normDir.startsWith('/tmp/') || normDir.startsWith('/var/'))
    candidates.push('/private' + normDir);

  for (const root of candidates) {
    if (normPath.startsWith(root + '/')) {
      const rel = normPath.slice(root.length + 1);
      if (rel.length > 0 && !rel.startsWith('/')) {
        const encodedRel = rel
          .split('/')
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        return encodedRel + suffix;
      }
    }
  }
  return target;
}

export function parentPathOf(path: WorkspacePath): WorkspacePath | null {
  try {
    const raw = Buffer.from(path.bytesBase64, 'base64');
    const lastSlash = raw.lastIndexOf(0x2f);
    if (lastSlash <= 0) return null;
    return { bytesBase64: raw.subarray(0, lastSlash).toString('base64') };
  } catch {
    return null;
  }
}
