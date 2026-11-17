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
import type { CurrentDiffTarget } from './currentDiffState';

export type CodeDefinitionResult = ServiceMethods['agent']['codeDefinition']['output'];
export type CodeReferencesResult = ServiceMethods['agent']['codeReferences']['output'];
export type CodeHoverResult = NonNullable<ServiceMethods['agent']['codeHover']['output']>;
export type CodeBackend = CodeDefinitionResult['backend'];
export type CodeLocation = CodeDefinitionResult['locations'][number];
export type GitWorkspaceDiff = NonNullable<ServiceMethods['agent']['gitWorkspaceDiff']['output']>;

export type GitRevisions = NonNullable<ServiceMethods['agent']['gitRevisions']['output']>;
export type GitCompareSpec = ServiceMethods['agent']['gitCompare']['input']['spec'];
export type GitCompare = NonNullable<ServiceMethods['agent']['gitCompare']['output']>;
export type GitCompareEntry = GitCompare['entries'][number];
export type GitHubRepoRef = NonNullable<
  ServiceMethods['agent']['githubPullRequests']['input']['repo']
>;
export type GitHubPullStateFilter = NonNullable<
  ServiceMethods['agent']['githubPullRequests']['input']['state']
>;
export type GitHubPullRequestsResult = ServiceMethods['agent']['githubPullRequests']['output'];
export type GitHubPullSummary = Extract<
  GitHubPullRequestsResult,
  { kind: 'ready' }
>['pulls'][number];
export type GitHubAuthStatus = Extract<GitHubPullRequestsResult, { kind: 'ready' }>['auth'];
export type GitHubPullDetailResult = ServiceMethods['agent']['githubPullRequestDetail']['output'];
export type GitHubPullDetail = Extract<GitHubPullDetailResult, { kind: 'ready' }>['detail'];
export type GitHubPullFile = GitHubPullDetail['files'][number];
export type GitHubPullFileStatus = GitHubPullFile['status'];
export type GitHubReviewThread = GitHubPullDetail['threads'][number];
export type GitHubReviewComment = GitHubReviewThread['comments'][number];
export type GitHubDiffSide = GitHubReviewThread['side'];
export type GitHubPullFileDiff = ServiceMethods['agent']['githubPullRequestFileDiff']['output'];
export type GitHubReviewEvent = ServiceMethods['agent']['githubSubmitReview']['input']['event'];
export type GitHubDraftReviewComment = NonNullable<
  ServiceMethods['agent']['githubSubmitReview']['input']['comments']
>[number];
export type GitHubSubmitReviewResult = ServiceMethods['agent']['githubSubmitReview']['output'];
export type GitHubReplyCommentResult = ServiceMethods['agent']['githubReplyComment']['output'];
export type GitHubTokenResult = ServiceMethods['agent']['saveGitHubToken']['output'];

type AgentGitHubDiffSide = GitHubDiffSide;
type AgentGitHubRepoRef = GitHubRepoRef;
type AgentGitHubReviewComment = GitHubReviewComment;
type AgentGitHubReviewThread = GitHubReviewThread;

export type ReviewNote = {
  id: string;
  sessionId: string;
  path: WorkspacePath;
  pathLabel: string;
  area?: GitArea;
  diffTarget?: CurrentDiffTarget;
  side: 'old' | 'new';
  /** 0-based virtual line in DiffView / Editor, plus optional 1-based real line override for patch-only diffs. */
  startLine: number;
  endLine: number;
  realStartLine?: number;
  realEndLine?: number;
  excerpt: string;
  comment: string;
};

export type PendingPrComment = {
  id: string;
  prKey: string;
  path: string;
  side: AgentGitHubDiffSide;
  /** 1-based real file line on the specified side, matching GitHub REST API. */
  line: number;
  startLine?: number;
  startSide?: AgentGitHubDiffSide;
  excerpt: string;
  body: string;
};

export type ReviewNavItem = {
  key: string;
  title: string;
  sourceKey: string;
  pathKey: string;
  digest: string;
  target: CurrentDiffTarget;
};

export type ChangesViewCache = {
  sourceTab: 'working' | 'branch' | 'commit' | 'pr';
  mode: 'list' | 'review-all';
  areaFilter: 'all' | GitArea;
  selectedBaseBranch: string;
  selectedCommitOid: string;
  selectedRepo: GitHubRepoRef | null;
  prStateFilter: GitHubPullStateFilter;
  selectedPrNumber: number | null;
  revisions?: GitRevisions | null;
  prListResult?: GitHubPullRequestsResult;
  prDetailEntry?: {
    repoKey: string;
    number: number;
    includePatch: boolean;
    result: GitHubPullDetailResult;
  };
};

export type SymbolLocationBatch = {
  kind: 'definitions' | 'references';
  symbol: string;
  backend: CodeBackend;
  locations: CodeLocation[];
  truncated: boolean;
  activeIndex: number;
};

export function formatPrKey(repo: AgentGitHubRepoRef, number: number): string {
  return `${repo.host.toLowerCase()}/${repo.owner}/${repo.repo}#${number}`;
}

/** Fast deterministic 64-bit FNV-1a digest for binding Viewed status to exact diff content. */
export function computeTextDigest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 ^= code & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code >>> 8) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${text.length.toString(16)}`;
}

export type PatchLineMap = {
  oldLines: string[];
  newLines: string[];
  /** 0-based DiffView virtual line -> 1-based real file line. */
  oldVirtualToReal: number[];
  newVirtualToReal: number[];
  /** 1-based real file line -> 0-based DiffView virtual line. */
  oldRealToVirtual: Map<number, number>;
  newRealToVirtual: Map<number, number>;
};

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Mirrors NSH `FilePatch::texts` / `text_starts` so patch-only GitHub PR diffs
 * map 1-to-1 between 0-based DiffView virtual lines and 1-based GitHub line numbers.
 */
export function buildPatchLineMap(patch: string): PatchLineMap {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldVirtualToReal: number[] = [];
  const newVirtualToReal: number[] = [];
  const oldRealToVirtual = new Map<number, number>();
  const newRealToVirtual = new Map<number, number>();

  const rawLines = patch.split('\n');
  if (patch.endsWith('\n')) rawLines.pop();

  let inHunk = false;
  let realOld = 1;
  let realNew = 1;

  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('index ') ||
      line.startsWith('rename ')
    ) {
      inHunk = false;
      continue;
    }
    const header = HUNK_HEADER_RE.exec(line);
    if (header) {
      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      realOld = oldCount === 0 ? oldStart : Math.max(1, oldStart);
      realNew = newCount === 0 ? newStart : Math.max(1, newStart);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.length === 0) continue;
    const prefix = line[0];
    const content = raw.slice(1);
    if (prefix === ' ') {
      const vOld = oldVirtualToReal.length;
      const vNew = newVirtualToReal.length;
      oldVirtualToReal.push(realOld);
      newVirtualToReal.push(realNew);
      oldRealToVirtual.set(realOld, vOld);
      newRealToVirtual.set(realNew, vNew);
      oldLines.push(content);
      newLines.push(content);
      realOld += 1;
      realNew += 1;
    } else if (prefix === '-') {
      const vOld = oldVirtualToReal.length;
      oldVirtualToReal.push(realOld);
      oldRealToVirtual.set(realOld, vOld);
      oldLines.push(content);
      realOld += 1;
    } else if (prefix === '+') {
      const vNew = newVirtualToReal.length;
      newVirtualToReal.push(realNew);
      newRealToVirtual.set(realNew, vNew);
      newLines.push(content);
      realNew += 1;
    }
  }

  return {
    oldLines,
    newLines,
    oldVirtualToReal,
    newVirtualToReal,
    oldRealToVirtual,
    newRealToVirtual,
  };
}

export type ReviewStore = {
  notes(sessionId: string): ReviewNote[];
  upsertNote(note: Omit<ReviewNote, 'id'> & { id?: string }): ReviewNote;
  removeNote(sessionId: string, id: string): void;
  clearNotes(sessionId: string): void;

  prDrafts(sessionId: string, prKey: string): PendingPrComment[];
  upsertPrDraft(
    sessionId: string,
    draft: Omit<PendingPrComment, 'id'> & { id?: string },
  ): PendingPrComment;
  removePrDraft(sessionId: string, prKey: string, id: string): void;
  clearPrDrafts(sessionId: string, prKey: string): void;

  isViewed(sessionId: string, sourceKey: string, pathKey: string, digest: string): boolean;
  setViewed(
    sessionId: string,
    sourceKey: string,
    pathKey: string,
    digest: string,
    viewed: boolean,
  ): void;
  toggleViewed(sessionId: string, sourceKey: string, pathKey: string, digest: string): boolean;

  reviewQueue(sessionId: string): ReviewNavItem[];
  setReviewQueue(sessionId: string, items: ReviewNavItem[]): void;

  changesViewCache(sessionId: string): ChangesViewCache | undefined;
  patchChangesViewCache(sessionId: string, patch: Partial<ChangesViewCache>): void;

  prThreads(sessionId: string, prKey: string): AgentGitHubReviewThread[];
  setPrThreads(sessionId: string, prKey: string, threads: AgentGitHubReviewThread[]): void;
  appendPrThreadReply(
    sessionId: string,
    prKey: string,
    threadId: number,
    reply: AgentGitHubReviewComment,
  ): void;

  symbolBatch(sessionId: string): SymbolLocationBatch | null;
  setSymbolBatch(sessionId: string, batch: SymbolLocationBatch | null): void;
  selectSymbolLocation(sessionId: string, index: number): void;
  statusMessage(sessionId: string): string;
  setStatusMessage(sessionId: string, message: string): void;
  pruneSessions(activeSessionIds: readonly string[]): void;
};

export function createReviewStore(): ReviewStore {
  const bySession = signal<Record<string, ReviewNote[]>>({});
  const prDraftsBySession = signal<Record<string, Record<string, PendingPrComment[]>>>({});
  const viewedBySession = signal<Record<string, Record<string, string>>>({});
  const queueBySession = signal<Record<string, ReviewNavItem[]>>({});
  const changesCacheBySession = signal<Record<string, ChangesViewCache>>({});
  const threadsBySession = signal<Record<string, Record<string, AgentGitHubReviewThread[]>>>({});
  const symbolsBySession = signal<Record<string, SymbolLocationBatch | null>>({});
  const statusBySession = signal<Record<string, string>>({});
  let nextId = 1;

  const viewedSlotKey = (sourceKey: string, pathKey: string) => `${sourceKey}::${pathKey}`;

  return {
    notes(sessionId) {
      return bySession()[sessionId] ?? [];
    },
    upsertNote(input) {
      const current = bySession()[input.sessionId] ?? [];
      const id = input.id ?? `note-${nextId++}`;
      const startLine = Math.min(input.startLine, input.endLine);
      const endLine = Math.max(input.startLine, input.endLine);
      const realStart =
        input.realStartLine !== undefined && input.realEndLine !== undefined
          ? Math.min(input.realStartLine, input.realEndLine)
          : input.realStartLine;
      const realEnd =
        input.realStartLine !== undefined && input.realEndLine !== undefined
          ? Math.max(input.realStartLine, input.realEndLine)
          : input.realEndLine;
      const note: ReviewNote = {
        id,
        sessionId: input.sessionId,
        path: input.path,
        pathLabel: input.pathLabel,
        ...(input.area ? { area: input.area } : {}),
        ...(input.diffTarget ? { diffTarget: input.diffTarget } : {}),
        side: input.side,
        startLine,
        endLine,
        ...(realStart !== undefined ? { realStartLine: realStart } : {}),
        ...(realEnd !== undefined ? { realEndLine: realEnd } : {}),
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

    prDrafts(sessionId, prKey) {
      return prDraftsBySession()[sessionId]?.[prKey] ?? [];
    },
    upsertPrDraft(sessionId, input) {
      const sessionMap = prDraftsBySession()[sessionId] ?? {};
      const current = sessionMap[input.prKey] ?? [];
      const id = input.id ?? `pr-draft-${nextId++}`;
      const entry: PendingPrComment = {
        id,
        prKey: input.prKey,
        path: input.path,
        side: input.side,
        line: input.line,
        ...(input.startLine !== undefined && input.startLine < input.line
          ? {
              startLine: input.startLine,
              startSide: input.startSide ?? input.side,
            }
          : {}),
        excerpt: input.excerpt,
        body: input.body.trim(),
      };
      const exists = current.some((item) => item.id === id);
      const next = exists
        ? current.map((item) => (item.id === id ? entry : item))
        : [...current, entry];
      prDraftsBySession.set({
        ...prDraftsBySession(),
        [sessionId]: { ...sessionMap, [input.prKey]: next },
      });
      return entry;
    },
    removePrDraft(sessionId, prKey, id) {
      const sessionMap = prDraftsBySession()[sessionId];
      const current = sessionMap?.[prKey];
      if (!sessionMap || !current) return;
      prDraftsBySession.set({
        ...prDraftsBySession(),
        [sessionId]: {
          ...sessionMap,
          [prKey]: current.filter((item) => item.id !== id),
        },
      });
    },
    clearPrDrafts(sessionId, prKey) {
      const sessionMap = prDraftsBySession()[sessionId];
      if (!sessionMap || !(prKey in sessionMap)) return;
      const nextSession = { ...sessionMap };
      delete nextSession[prKey];
      prDraftsBySession.set({
        ...prDraftsBySession(),
        [sessionId]: nextSession,
      });
    },

    isViewed(sessionId, sourceKey, pathKey, digest) {
      if (!digest) return false;
      return viewedBySession()[sessionId]?.[viewedSlotKey(sourceKey, pathKey)] === digest;
    },
    setViewed(sessionId, sourceKey, pathKey, digest, viewed) {
      if (!digest) return;
      const sessionMap = { ...(viewedBySession()[sessionId] ?? {}) };
      const slot = viewedSlotKey(sourceKey, pathKey);
      if (viewed) sessionMap[slot] = digest;
      else delete sessionMap[slot];
      viewedBySession.set({ ...viewedBySession(), [sessionId]: sessionMap });
    },
    toggleViewed(sessionId, sourceKey, pathKey, digest) {
      if (!digest) return false;
      const next = !this.isViewed(sessionId, sourceKey, pathKey, digest);
      this.setViewed(sessionId, sourceKey, pathKey, digest, next);
      return next;
    },

    reviewQueue(sessionId) {
      return queueBySession()[sessionId] ?? [];
    },
    setReviewQueue(sessionId, items) {
      queueBySession.set({ ...queueBySession(), [sessionId]: items });
    },

    changesViewCache(sessionId) {
      return changesCacheBySession()[sessionId];
    },
    patchChangesViewCache(sessionId, patch) {
      const existing: ChangesViewCache = changesCacheBySession()[sessionId] ?? {
        sourceTab: 'working',
        mode: 'list',
        areaFilter: 'all',
        selectedBaseBranch: '',
        selectedCommitOid: '',
        selectedRepo: null,
        prStateFilter: 'open',
        selectedPrNumber: null,
      };
      changesCacheBySession.set({
        ...changesCacheBySession(),
        [sessionId]: { ...existing, ...patch },
      });
    },

    prThreads(sessionId, prKey) {
      return threadsBySession()[sessionId]?.[prKey] ?? [];
    },
    setPrThreads(sessionId, prKey, threads) {
      const sessionMap = threadsBySession()[sessionId] ?? {};
      threadsBySession.set({
        ...threadsBySession(),
        [sessionId]: { ...sessionMap, [prKey]: threads },
      });
    },
    appendPrThreadReply(sessionId, prKey, threadId, reply) {
      const sessionMap = threadsBySession()[sessionId];
      const current = sessionMap?.[prKey];
      if (!sessionMap || !current) return;
      threadsBySession.set({
        ...threadsBySession(),
        [sessionId]: {
          ...sessionMap,
          [prKey]: current.map((thread) =>
            thread.id === threadId ? { ...thread, comments: [...thread.comments, reply] } : thread,
          ),
        },
      });
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
      const [nextPrDrafts, c2] = filterMap(prDraftsBySession());
      if (c2) prDraftsBySession.set(nextPrDrafts);
      const [nextViewed, c3] = filterMap(viewedBySession());
      if (c3) viewedBySession.set(nextViewed);
      const [nextQueue, c4] = filterMap(queueBySession());
      if (c4) queueBySession.set(nextQueue);
      const [nextThreads, c5] = filterMap(threadsBySession());
      if (c5) threadsBySession.set(nextThreads);
      const [nextSyms, c6] = filterMap(symbolsBySession());
      if (c6) symbolsBySession.set(nextSyms);
      const [nextStatus, c7] = filterMap(statusBySession());
      if (c7) statusBySession.set(nextStatus);
      const [nextChangesCache, c8] = filterMap(changesCacheBySession());
      if (c8) changesCacheBySession.set(nextChangesCache);
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

export function formatRealLineLabel(startLine1: number, endLine1: number): string {
  return startLine1 === endLine1 ? `L${startLine1}` : `L${startLine1}-L${endLine1}`;
}

function makeCodeFence(snippet: string, lang: string): string {
  const runs = snippet.match(/`+/g);
  const maxTicks = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = '`'.repeat(Math.max(3, maxTicks + 1));
  return fence + lang + '\n' + snippet + '\n' + fence;
}

export function formatReviewNote(
  note: Pick<
    ReviewNote,
    | 'pathLabel'
    | 'side'
    | 'startLine'
    | 'endLine'
    | 'realStartLine'
    | 'realEndLine'
    | 'excerpt'
    | 'comment'
  >,
): string {
  const lineTag =
    note.realStartLine !== undefined
      ? formatRealLineLabel(note.realStartLine, note.realEndLine ?? note.realStartLine)
      : formatLineLabel(note.startLine, note.endLine);
  const loc = `${note.pathLabel}#${lineTag}`;
  const sideTag = note.side === 'old' ? ' (before)' : '';
  const lang = languageHintFromPath(note.pathLabel);
  const snippet = note.excerpt.replace(/\r?\n$/, '');
  const parts = [`\`${loc}\`${sideTag}:`];
  if (snippet.trim().length > 0) {
    parts.push(makeCodeFence(snippet, lang));
  }
  if (note.comment.trim().length > 0) {
    parts.push(note.comment.trim());
  }
  return parts.join('\n');
}

export function formatReviewBatch(notes: readonly ReviewNote[]): string {
  return notes.map((note) => formatReviewNote(note)).join('\n\n');
}

export function formatGitHubThreadPrompt(
  prNumber: number,
  thread: AgentGitHubReviewThread,
  fallbackExcerpt?: string,
): string {
  const start = thread.startLine ?? thread.line ?? 1;
  const end = thread.line ?? start;
  const loc = `${thread.path}#${formatRealLineLabel(start, end)}`;
  const parts = [`GitHub PR #${prNumber} review thread on \`${loc}\`:`];
  const snippet = (fallbackExcerpt || thread.diffHunk || '').replace(/\r?\n$/, '');
  if (snippet.trim().length > 0) {
    const lang = fallbackExcerpt ? languageHintFromPath(thread.path) : 'diff';
    parts.push(makeCodeFence(snippet, lang));
  }
  for (const comment of thread.comments) {
    parts.push(`**@${comment.author}**: ${comment.body.trim()}`);
  }
  return parts.join('\n\n');
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
