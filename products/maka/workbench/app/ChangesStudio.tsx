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

import { formatCount } from './numberFormat';
import { cleanup, computed, effect, Scroll, signal, Text, untracked, View, windowSize } from 'nsh';
import {
  Button,
  DiffView,
  type DiffAnnotation,
  type DiffFile,
  type DiffLineRange,
  type DiffViewRef,
  Input,
  Popover,
} from 'nsh/base';
import type {
  GitArea,
  GitStatus,
  WorkspacePath,
} from '../../../../packages/plugin-sdk/src/index.js';
import {
  type CurrentDiffTarget,
  resolveDiffSourceKey,
  workspacePathFromUtf8,
} from './currentDiffState';
import { useHost } from './host';
import { NativeFileTree } from './NativeFileTree';
import { pathTree } from './fileTreePaths';
import { InlineCallout, RegionEmptyError } from './Feedback';
import { Icon } from './Icon';
import { LoadingState } from './Loading';
import { tr } from './locale';
import { settingsValue } from './settingsOperations';
import {
  AddLineNoteButton,
  GitHubThreadCard,
  InlineReviewComposer,
  InlineReviewNoteCard,
  PendingPrCommentCard,
} from './ReviewComposer';
import {
  basenameLabel,
  buildPatchLineMap,
  computeTextDigest,
  formatPrKey,
  formatGitHubThreadPrompt,
  formatReviewBatch,
  formatReviewNote,
  type GitCompare,
  type GitCompareSpec,
  type GitHubPullDetail,
  type GitHubReplyCommentResult,
  type GitHubReviewThread,
  type GitRevisions,
  type GitWorkspaceDiff,
  type GitWorktreeEntry,
  isAutoCollapsedPath,
  isRangeInSinglePatchHunk,
  parentPathOf,
  type PatchLineMap,
  type ReviewNote,
  type ReviewStore,
} from './reviewState';
import { errorText, renderText } from './text';
import { WorktreePicker } from './WorktreePicker';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlStyle,
  DisclosureChevron,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';
import type { WorkspaceFileTarget } from './workspaceFileState';

type StudioSourceTab = 'working' | 'branch' | 'commit';

type PatchSection = {
  path: string;
  oldPath: string | null;
  rawPatch: string;
  lineMap: PatchLineMap;
  oldAt: number;
  newAt: number;
  added: number;
  deleted: number;
  digest: string;
};

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '/dev/null') return '';
  let unquoted = trimmed;
  if (unquoted.startsWith('"') && unquoted.endsWith('"')) {
    try {
      unquoted = JSON.parse(unquoted);
    } catch {
      unquoted = unquoted.slice(1, -1);
    }
  }
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2);
  }
  return unquoted;
}

function parseMultiFilePatch(patch: string): PatchSection[] {
  if (!patch.trim()) return [];
  const sections: PatchSection[] = [];
  const chunks = patch.split(/(?=^diff --git )/m);
  let oldAt = 0;
  let newAt = 0;

  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let added = 0;
    let deleted = 0;
    let inHunk = false;

    for (const line of chunk.split('\n')) {
      if (line.startsWith('@@ ')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        if (line.startsWith('--- ')) {
          const p = unquoteGitPath(line.slice(4));
          oldPath = p || null;
        } else if (line.startsWith('+++ ')) {
          const p = unquoteGitPath(line.slice(4));
          newPath = p || null;
        } else if (line.startsWith('rename from ')) {
          oldPath = line.slice('rename from '.length).trim() || oldPath;
        } else if (line.startsWith('rename to ')) {
          newPath = line.slice('rename to '.length).trim() || newPath;
        }
      } else {
        if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
        else if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
      }
    }

    const resolvedPath = newPath ?? oldPath ?? '';
    if (!resolvedPath) continue;
    const lineMap = buildPatchLineMap(chunk);
    sections.push({
      path: resolvedPath,
      oldPath: oldPath && oldPath !== resolvedPath ? oldPath : null,
      rawPatch: chunk.endsWith('\n') ? chunk : `${chunk}\n`,
      lineMap,
      oldAt,
      newAt,
      added,
      deleted,
      digest: computeTextDigest(chunk),
    });
    oldAt += lineMap.oldLines.length;
    newAt += lineMap.newLines.length;
  }
  return sections;
}

function gitMark(status: string | undefined) {
  switch (status) {
    case 'added':
      return 'A';
    case 'removed':
    case 'deleted':
      return 'D';
    case 'modified':
    case 'changed':
      return 'M';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'type_changed':
      return 'T';
    case 'conflicted':
      return 'U';
    default:
      return '';
  }
}

type FileRowItem = {
  diffPath: string;
  displayPath: string;
  status: string;
  added: number;
  deleted: number;
  statusColor: string;
  sourceKey: string;
  pathKey: string;
  digest: string;
  wsPath: WorkspacePath;
  area?: GitArea;
  canOpenSource: boolean;
};

type ActiveComposerDraft = {
  section: PatchSection;
  wsPath: WorkspacePath;
  area?: GitArea;
  target: CurrentDiffTarget;
  side: 'old' | 'new';
  localStart: number;
  localEnd: number;
  realStartLine?: number;
  realEndLine?: number;
  joinedEndLine: number;
  excerpt: string;
  hunkValid: boolean;
  editingNoteId?: string;
  editingPrDraftId?: string;
  initialComment?: string;
};

const LARGE_DIFF_MAX_FILES = 30;
const LARGE_DIFF_MAX_BYTES = 512 * 1024;

export function ChangesStudio(props: {
  sessionId: string;
  reviewStore: ReviewStore;
  canPrompt(): boolean;
  deliverPrompt(text: string, mode: 'insert' | 'send'): boolean;
  openFile(target: WorkspaceFileTarget): void;
  prDetail?: GitHubPullDetail;
  focusFilePath?: string | null;
  onFocusFileHandled?(): void;
}) {
  const host = useHost();
  const isPrMode = () => props.prDetail !== undefined;
  const initialCache = untracked(() => props.reviewStore.changesViewCache(props.sessionId));
  const initialTab: StudioSourceTab =
    initialCache?.sourceTab === 'branch' || initialCache?.sourceTab === 'commit'
      ? initialCache.sourceTab
      : 'working';

  const sourceTab = signal<StudioSourceTab>(initialTab);
  const revisions = signal<GitRevisions | null>(initialCache?.revisions ?? null);
  const selectedBaseBranch = signal(initialCache?.selectedBaseBranch ?? '');
  const selectedCommitOid = signal(initialCache?.selectedCommitOid ?? '');
  const branchSearch = signal('');

  type ScopedGitData<T> = { scope: string; data: T };
  const workingStatus = signal<ScopedGitData<GitStatus> | null>(null);
  const workingDiff = signal<ScopedGitData<GitWorkspaceDiff> | null>(null);
  const compareResult = signal<ScopedGitData<GitCompare> | null>(null);
  const loading = signal(!isPrMode());
  const loadError = signal('');

  const sourceMenuOpen = signal(false);
  const contextMenuOpen = signal(false);
  const moreMenuOpen = signal(false);
  const notesMenuOpen = signal(false);
  const studioWidth = signal(800);
  const activeDraft = signal<ActiveComposerDraft | null>(null);

  let diffRef: DiffViewRef | undefined;
  let alive = true;
  let fetchSeq = 0;
  let restoredForScope = '';
  let layoutAppliedForPatch = '';

  cleanup(() => {
    alive = false;
    fetchSeq += 1;
  });

  const activeWorktree = () => props.reviewStore.activeWorktree(props.sessionId);

  const scopeKey = computed(() => {
    if (props.prDetail) {
      return `pr:${formatPrKey(props.prDetail.repo, props.prDetail.number)}`;
    }
    const tab = sourceTab();
    const wt = activeWorktree() ?? 'default';
    if (tab === 'branch') return `branch:${wt}:${selectedBaseBranch()}`;
    if (tab === 'commit') return `commit:${wt}:${selectedCommitOid()}`;
    return `working:${wt}`;
  });
  const dataScopeKey = computed(() => `${props.sessionId}:${scopeKey()}`);
  const scopedData = <T,>(entry: ScopedGitData<T> | null): T | null =>
    entry !== null && entry.scope === dataScopeKey() ? entry.data : null;

  const studio = () => props.reviewStore.studioViewState(props.sessionId, scopeKey());
  const patchStudio = (patch: Parameters<ReviewStore['patchStudioViewState']>[2]) =>
    props.reviewStore.patchStudioViewState(props.sessionId, scopeKey(), patch);

  const fileTreeOpen = () => studio().fileTreeOpen ?? studioWidth() >= 600;

  const refreshWorkspaceGit = async () => {
    if (isPrMode()) return;
    const sid = props.sessionId;
    const wt = activeWorktree();
    const tab = sourceTab();
    const seq = ++fetchSeq;
    loading.set(true);
    loadError.set('');

    try {
      const rev = await host.query('agent', 'gitRevisions', {
        sessionId: sid,
        ...(wt ? { worktreePath: wt } : {}),
      });
      if (!alive || seq !== fetchSeq) return;
      revisions.set(rev);

      let base = selectedBaseBranch();
      if (rev && (!base || !rev.branches.some((b) => b.name === base))) {
        base = rev.defaultBase ?? rev.branches[0]?.name ?? '';
        selectedBaseBranch.set(base);
      }
      let oid = selectedCommitOid();
      if (rev && (!oid || !rev.commits.some((c) => c.oid === oid))) {
        oid = rev.commits[0]?.oid ?? '';
        selectedCommitOid.set(oid);
      }

      props.reviewStore.patchChangesViewCache(sid, {
        sourceTab: tab,
        revisions: rev,
        selectedBaseBranch: base,
        selectedCommitOid: oid,
      });

      const wtKey = wt ?? 'default';
      if (tab === 'working') {
        const fetchedScope = `${sid}:working:${wtKey}`;
        const [st, diff] = await Promise.all([
          host.query('agent', 'gitStatus', {
            sessionId: sid,
            ...(wt ? { worktreePath: wt } : {}),
          }),
          host.query('agent', 'gitWorkspaceDiff', {
            sessionId: sid,
            ...(wt ? { worktreePath: wt } : {}),
          }),
        ]);
        if (!alive || seq !== fetchSeq) return;
        workingStatus.set(st ? { scope: fetchedScope, data: st } : null);
        workingDiff.set(diff ? { scope: fetchedScope, data: diff } : null);
      } else if (tab === 'branch') {
        if (base) {
          const fetchedScope = `${sid}:branch:${wtKey}:${base}`;
          const cmp = await host.query('agent', 'gitCompare', {
            sessionId: sid,
            ...(wt ? { worktreePath: wt } : {}),
            spec: { kind: 'branch', base },
            includePatch: true,
          });
          if (!alive || seq !== fetchSeq) return;
          compareResult.set(cmp ? { scope: fetchedScope, data: cmp } : null);
        } else {
          compareResult.set(null);
        }
      } else if (tab === 'commit') {
        if (oid) {
          const fetchedScope = `${sid}:commit:${wtKey}:${oid}`;
          const cmp = await host.query('agent', 'gitCompare', {
            sessionId: sid,
            ...(wt ? { worktreePath: wt } : {}),
            spec: { kind: 'commit', oid },
            includePatch: true,
          });
          if (!alive || seq !== fetchSeq) return;
          compareResult.set(cmp ? { scope: fetchedScope, data: cmp } : null);
        } else {
          compareResult.set(null);
        }
      }
    } catch (reason) {
      if (!alive || seq !== fetchSeq) return;
      loadError.set(renderText(errorText(reason, 'Could not read file changes.')));
    } finally {
      if (alive && seq === fetchSeq) loading.set(false);
    }
  };

  effect(() => {
    if (isPrMode()) return;
    void props.sessionId;
    void sourceTab();
    void activeWorktree();
    void selectedBaseBranch();
    void selectedCommitOid();
    untracked(() => {
      void refreshWorkspaceGit();
    });
  });

  const rawCombinedPatch = computed(() => {
    if (props.prDetail) return props.prDetail.patch?.patch ?? '';
    const tab = sourceTab();
    if (tab === 'working') return scopedData(workingDiff())?.patch ?? '';
    return scopedData(compareResult())?.patch?.patch ?? '';
  });

  const patchSections = computed(() => parseMultiFilePatch(rawCombinedPatch()));
  const sectionByPath = computed(() => {
    const map = new Map<string, PatchSection>();
    for (const sec of patchSections()) map.set(sec.path, sec);
    return map;
  });

  const allFileRows = computed<FileRowItem[]>(() => {
    const sid = props.sessionId;
    const secMap = sectionByPath();

    if (props.prDetail) {
      const detail = props.prDetail;
      return detail.files.map((file) => {
        const sec = secMap.get(file.path);
        const wsPath = workspacePathFromUtf8(file.path);
        const target: CurrentDiffTarget = {
          sessionId: sid,
          source: {
            kind: 'pr',
            repo: detail.repo,
            number: detail.number,
            headSha: detail.headSha,
            baseSha: detail.baseSha,
            pathString: file.path,
          },
          digest: file.digest,
          path: wsPath,
          title: file.path,
        };
        return {
          diffPath: file.path,
          displayPath: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
          status: file.status,
          added: file.additions,
          deleted: file.deletions,
          statusColor:
            file.status === 'added'
              ? C.success
              : file.status === 'removed'
                ? C.danger
                : C.secondary,
          sourceKey: resolveDiffSourceKey(target),
          pathKey: wsPath.bytesBase64,
          digest: file.digest,
          wsPath,
          canOpenSource: file.status !== 'removed',
        };
      });
    }

    const tab = sourceTab();
    const wt = activeWorktree() ?? undefined;
    if (tab === 'working') {
      const entries = scopedData(workingStatus())?.entries ?? [];
      const seen = new Set<string>();
      const out: FileRowItem[] = [];
      for (const entry of entries) {
        const pathStr = host.pathLabel(entry.path);
        if (seen.has(entry.path.bytesBase64)) continue;
        seen.add(entry.path.bytesBase64);
        const sec = secMap.get(pathStr);
        const target: CurrentDiffTarget = {
          sessionId: sid,
          ...(wt ? { worktreePath: wt } : {}),
          area: entry.area,
          source: { kind: 'working', area: entry.area },
          digest: entry.digest,
          path: entry.path,
          title: pathStr,
        };
        out.push({
          diffPath: pathStr,
          displayPath: pathStr,
          status: entry.kind,
          added: sec?.added ?? 0,
          deleted: sec?.deleted ?? 0,
          statusColor:
            entry.kind === 'added'
              ? C.success
              : entry.kind === 'deleted' || entry.kind === 'conflicted'
                ? C.danger
                : C.secondary,
          sourceKey: resolveDiffSourceKey(target),
          pathKey: entry.path.bytesBase64,
          digest: entry.digest,
          wsPath: entry.path,
          area: entry.area,
          canOpenSource: entry.kind !== 'deleted' && !wt,
        });
      }
      return out;
    }

    const cmp = scopedData(compareResult());
    if (!cmp) return [];
    const spec: GitCompareSpec =
      tab === 'branch'
        ? { kind: 'branch', base: selectedBaseBranch() }
        : { kind: 'commit', oid: selectedCommitOid() };
    const label =
      tab === 'branch' ? `${selectedBaseBranch()}…HEAD` : selectedCommitOid().slice(0, 7);

    return cmp.entries.map((entry) => {
      const pathStr = host.pathLabel(entry.path);
      const sec = secMap.get(pathStr);
      const target: CurrentDiffTarget = {
        sessionId: sid,
        ...(wt ? { worktreePath: wt } : {}),
        source: { kind: 'compare', spec, label },
        digest: entry.digest,
        path: entry.path,
        title: pathStr,
      };
      return {
        diffPath: pathStr,
        displayPath: pathStr,
        status: entry.kind,
        added: sec?.added ?? 0,
        deleted: sec?.deleted ?? 0,
        statusColor:
          entry.kind === 'added' ? C.success : entry.kind === 'deleted' ? C.danger : C.secondary,
        sourceKey: resolveDiffSourceKey(target),
        pathKey: entry.path.bytesBase64,
        digest: entry.digest,
        wsPath: entry.path,
        canOpenSource: entry.kind !== 'deleted' && !wt,
      };
    });
  });

  const filteredFileRows = computed(() => {
    const q = studio().filterQuery.trim().toLowerCase();
    const rows = allFileRows();
    if (!q) return rows;
    return rows.filter((r) => r.displayPath.toLowerCase().includes(q));
  });

  const totalStats = computed(() => {
    let added = 0;
    let deleted = 0;
    for (const row of allFileRows()) {
      added += row.added;
      deleted += row.deleted;
    }
    return { added, deleted };
  });

  const viewedCount = computed(
    () =>
      allFileRows().filter((r) =>
        props.reviewStore.isViewed(props.sessionId, r.sourceKey, r.pathKey, r.digest),
      ).length,
  );

  const singleFileMode = computed(() => {
    const override = studio().singleFileOverride;
    if (override !== null) return override;
    return (
      filteredFileRows().length > LARGE_DIFF_MAX_FILES ||
      rawCombinedPatch().length > LARGE_DIFF_MAX_BYTES
    );
  });

  const clampedFileIndex = computed(() => {
    const rows = filteredFileRows();
    if (rows.length === 0) return 0;
    return Math.max(0, Math.min(studio().activeFileIndex, rows.length - 1));
  });

  const displayedPatch = computed(() => {
    const q = studio().filterQuery.trim();
    const single = singleFileMode();
    if (!single && !q) return rawCombinedPatch();

    const secMap = sectionByPath();
    if (single) {
      const activeRow = filteredFileRows()[clampedFileIndex()];
      if (!activeRow) return '';
      return secMap.get(activeRow.diffPath)?.rawPatch ?? '';
    }
    return filteredFileRows()
      .map((r) => secMap.get(r.diffPath)?.rawPatch ?? '')
      .join('');
  });

  const displayedSections = computed(() => parseMultiFilePatch(displayedPatch()));

  const applyCollapseAndScrollState = () => {
    if (!diffRef) return;
    const patchKey = `${scopeKey()}::${displayedPatch().length}`;
    const state = untracked(() => studio());
    if (layoutAppliedForPatch !== patchKey) {
      layoutAppliedForPatch = patchKey;
      for (const row of untracked(() => filteredFileRows())) {
        const explicit = state.collapsedPaths[row.diffPath];
        const viewed = props.reviewStore.isViewed(
          props.sessionId,
          row.sourceKey,
          row.pathKey,
          row.digest,
        );
        const shouldCollapse =
          explicit !== undefined
            ? explicit && !singleFileMode()
            : !singleFileMode() && (viewed || isAutoCollapsedPath(row.diffPath));
        if (shouldCollapse) diffRef.collapseFile(row.diffPath);
        else diffRef.expandFile(row.diffPath);
      }
    }
    if (restoredForScope !== patchKey) {
      restoredForScope = patchKey;
      if (state.scrollOffset > 0 && !singleFileMode()) {
        diffRef.setScrollOffset({ x: 0, y: state.scrollOffset });
      }
    }
  };

  effect(() => {
    const targetPath = props.focusFilePath;
    if (!targetPath) return;
    const rows = filteredFileRows();
    const idx = rows.findIndex((r) => r.diffPath === targetPath);
    if (idx >= 0) {
      untracked(() => {
        if (singleFileMode()) {
          patchStudio({ activeFileIndex: idx });
        } else if (diffRef) {
          diffRef.expandFile(targetPath);
          diffRef.scrollToFile(targetPath);
        }
        props.onFocusFileHandled?.();
      });
    }
  });

  const prKey = () =>
    props.prDetail ? formatPrKey(props.prDetail.repo, props.prDetail.number) : null;

  const sessionNotes = () => props.reviewStore.notes(props.sessionId);
  const prDrafts = () => {
    const key = prKey();
    return key ? props.reviewStore.prDrafts(props.sessionId, key) : [];
  };
  const prThreads = (): readonly GitHubReviewThread[] => {
    const key = prKey();
    return key ? props.reviewStore.prThreads(props.sessionId, key) : [];
  };

  const makeTargetForSection = (
    section: PatchSection,
  ): {
    target: CurrentDiffTarget;
    wsPath: WorkspacePath;
    area?: GitArea;
  } => {
    const row = allFileRows().find((r) => r.diffPath === section.path);
    const wsPath = row?.wsPath ?? workspacePathFromUtf8(section.path);
    const wt = activeWorktree() ?? undefined;
    if (props.prDetail) {
      return {
        wsPath,
        target: {
          sessionId: props.sessionId,
          source: {
            kind: 'pr',
            repo: props.prDetail.repo,
            number: props.prDetail.number,
            headSha: props.prDetail.headSha,
            baseSha: props.prDetail.baseSha,
            pathString: section.path,
          },
          digest: row?.digest ?? section.digest,
          path: wsPath,
          title: section.path,
        },
      };
    }
    const tab = sourceTab();
    if (tab === 'working') {
      const area = row?.area ?? 'worktree';
      return {
        wsPath,
        area,
        target: {
          sessionId: props.sessionId,
          ...(wt ? { worktreePath: wt } : {}),
          area,
          source: { kind: 'working', area },
          digest: row?.digest ?? section.digest,
          path: wsPath,
          title: section.path,
        },
      };
    }
    const spec: GitCompareSpec =
      tab === 'branch'
        ? { kind: 'branch', base: selectedBaseBranch() }
        : { kind: 'commit', oid: selectedCommitOid() };
    const label =
      tab === 'branch' ? `${selectedBaseBranch()}…HEAD` : selectedCommitOid().slice(0, 7);
    return {
      wsPath,
      target: {
        sessionId: props.sessionId,
        ...(wt ? { worktreePath: wt } : {}),
        source: { kind: 'compare', spec, label },
        digest: row?.digest ?? section.digest,
        path: wsPath,
        title: section.path,
      },
    };
  };

  const openInlineDraftForRange = (range: DiffLineRange) => {
    const secs = displayedSections();
    const side = range.side;
    const rawStart = Math.min(range.start, range.end);
    const rawEnd = Math.max(range.start, range.end);

    const section = secs.find((sec) => {
      const at = side === 'old' ? sec.oldAt : sec.newAt;
      const len = side === 'old' ? sec.lineMap.oldLines.length : sec.lineMap.newLines.length;
      return len > 0 && rawStart >= at && rawStart < at + len;
    });
    if (!section) return;

    const at = side === 'old' ? section.oldAt : section.newAt;
    const lines = side === 'old' ? section.lineMap.oldLines : section.lineMap.newLines;
    const v2r =
      side === 'old' ? section.lineMap.oldVirtualToReal : section.lineMap.newVirtualToReal;

    const clampedEnd = Math.min(rawEnd, at + lines.length - 1);
    const localStart = rawStart - at;
    const localEnd = Math.max(localStart, clampedEnd - at);
    const realStartLine = v2r[localStart];
    const realEndLine = v2r[localEnd];
    const excerpt = lines.slice(localStart, localEnd + 1).join('\n');
    const hunkValid =
      realStartLine !== undefined &&
      realEndLine !== undefined &&
      isRangeInSinglePatchHunk(section.lineMap, side, realStartLine, realEndLine);

    const { target, wsPath, area } = makeTargetForSection(section);
    activeDraft.set({
      section,
      wsPath,
      area,
      target,
      side,
      localStart,
      localEnd,
      realStartLine,
      realEndLine,
      joinedEndLine: at + localEnd,
      excerpt,
      hunkValid,
    });
  };

  const annotations = computed<DiffAnnotation[]>(() => {
    const secs = displayedSections();
    if (secs.length === 0) return [];
    const byPath = new Map<string, PatchSection>();
    for (const s of secs) byPath.set(s.path, s);

    const list: DiffAnnotation[] = [];
    const draft = activeDraft();
    if (draft) {
      const liveSec = byPath.get(draft.section.path);
      if (liveSec) {
        const at = draft.side === 'old' ? liveSec.oldAt : liveSec.newAt;
        list.push({
          id: 'draft-composer',
          side: draft.side,
          line: at + draft.localEnd,
        });
      }
    }

    for (const note of sessionNotes()) {
      if (draft?.editingNoteId === note.id) continue;
      const sec = byPath.get(note.pathLabel);
      if (!sec) continue;
      const at = note.side === 'old' ? sec.oldAt : sec.newAt;
      const r2v = note.side === 'old' ? sec.lineMap.oldRealToVirtual : sec.lineMap.newRealToVirtual;
      const vLine =
        note.realEndLine !== undefined ? (r2v.get(note.realEndLine) ?? note.endLine) : note.endLine;
      const maxLen =
        note.side === 'old' ? sec.lineMap.oldLines.length : sec.lineMap.newLines.length;
      if (vLine >= 0 && vLine < maxLen) {
        list.push({
          id: `note:${note.id}`,
          side: note.side,
          line: at + vLine,
        });
      }
    }

    for (const prDraft of prDrafts()) {
      if (draft?.editingPrDraftId === prDraft.id) continue;
      const sec = byPath.get(prDraft.path);
      if (!sec) continue;
      const side: 'old' | 'new' = prDraft.side === 'LEFT' ? 'old' : 'new';
      const at = side === 'old' ? sec.oldAt : sec.newAt;
      const r2v = side === 'old' ? sec.lineMap.oldRealToVirtual : sec.lineMap.newRealToVirtual;
      const vLine = r2v.get(prDraft.line);
      if (vLine !== undefined) {
        list.push({
          id: `pr-draft:${prDraft.id}`,
          side,
          line: at + vLine,
        });
      }
    }

    for (const thread of prThreads()) {
      if (thread.line === null) continue;
      const sec = byPath.get(thread.path);
      if (!sec) continue;
      const side: 'old' | 'new' = thread.side === 'LEFT' ? 'old' : 'new';
      const at = side === 'old' ? sec.oldAt : sec.newAt;
      const r2v = side === 'old' ? sec.lineMap.oldRealToVirtual : sec.lineMap.newRealToVirtual;
      const vLine = r2v.get(thread.line);
      if (vLine !== undefined) {
        list.push({
          id: `pr-thread:${thread.id}`,
          side,
          line: at + vLine,
        });
      }
    }

    return list;
  });

  const saveLocalNote = (comment: string): ReviewNote | null => {
    const d = activeDraft();
    if (!d) return null;
    const saved = props.reviewStore.upsertNote({
      id: d.editingNoteId,
      sessionId: props.sessionId,
      path: d.wsPath,
      pathLabel: d.section.path,
      area: d.area,
      diffTarget: d.target,
      side: d.side,
      startLine: d.localStart,
      endLine: d.localEnd,
      realStartLine: d.realStartLine,
      realEndLine: d.realEndLine,
      excerpt: d.excerpt,
      comment,
    });
    activeDraft.set(null);
    return saved;
  };

  const renderAnnotation = (ann: DiffAnnotation) => {
    if (ann.id === 'draft-composer') {
      const d = activeDraft();
      if (!d) return <View />;
      const key = prKey();
      const canAddPr = Boolean(key) && d.hunkValid && d.realEndLine !== undefined;
      return (
        <InlineReviewComposer
          startLine={d.localStart}
          endLine={d.localEnd}
          realStartLine={d.realStartLine}
          realEndLine={d.realEndLine}
          initialComment={d.initialComment}
          canPrompt={props.canPrompt()}
          prCommentMode={Boolean(d.editingPrDraftId)}
          prHunkNotice={
            key && !d.hunkValid
              ? tr(
                  'Outside PR diff hunks — GitHub only accepts comments on changed hunk lines. Use local review actions below.',
                )
              : undefined
          }
          onAddPrComment={
            canAddPr && key
              ? (body) => {
                  const ghSide = d.side === 'old' ? ('LEFT' as const) : ('RIGHT' as const);
                  props.reviewStore.upsertPrDraft(props.sessionId, {
                    id: d.editingPrDraftId,
                    prKey: key,
                    path: d.section.path,
                    side: ghSide,
                    line: d.realEndLine!,
                    ...(d.realStartLine !== undefined && d.realStartLine < d.realEndLine!
                      ? { startLine: d.realStartLine, startSide: ghSide }
                      : {}),
                    excerpt: d.excerpt,
                    body,
                  });
                  activeDraft.set(null);
                }
              : undefined
          }
          onSave={(comment) => {
            saveLocalNote(comment);
          }}
          onInsertPrompt={(comment) => {
            const dCur = activeDraft();
            if (!dCur) return;
            const tempNote: ReviewNote = {
              id: 'inline',
              sessionId: props.sessionId,
              path: dCur.wsPath,
              pathLabel: dCur.section.path,
              side: dCur.side,
              startLine: dCur.localStart,
              endLine: dCur.localEnd,
              realStartLine: dCur.realStartLine,
              realEndLine: dCur.realEndLine,
              excerpt: dCur.excerpt,
              comment: comment.trim(),
            };
            if (props.deliverPrompt(formatReviewNote(tempNote), 'insert')) {
              if (dCur.editingNoteId) {
                props.reviewStore.removeNote(props.sessionId, dCur.editingNoteId);
              }
              activeDraft.set(null);
            }
          }}
          onSendNow={(comment) => {
            const dCur = activeDraft();
            if (!dCur) return;
            const tempNote: ReviewNote = {
              id: 'inline',
              sessionId: props.sessionId,
              path: dCur.wsPath,
              pathLabel: dCur.section.path,
              side: dCur.side,
              startLine: dCur.localStart,
              endLine: dCur.localEnd,
              realStartLine: dCur.realStartLine,
              realEndLine: dCur.realEndLine,
              excerpt: dCur.excerpt,
              comment: comment.trim(),
            };
            if (props.deliverPrompt(formatReviewBatch([tempNote]), 'send')) {
              if (dCur.editingNoteId) {
                props.reviewStore.removeNote(props.sessionId, dCur.editingNoteId);
              }
              activeDraft.set(null);
            }
          }}
          onCancel={() => activeDraft.set(null)}
        />
      );
    }

    if (ann.id.startsWith('note:')) {
      const noteId = ann.id.slice('note:'.length);
      const note = sessionNotes().find((n) => n.id === noteId);
      if (!note) return <View />;
      return (
        <InlineReviewNoteCard
          note={note}
          canPrompt={props.canPrompt()}
          onEdit={() => {
            const sec = displayedSections().find((s) => s.path === note.pathLabel);
            if (!sec) return;
            const at = note.side === 'old' ? sec.oldAt : sec.newAt;
            const { target, wsPath, area } = makeTargetForSection(sec);
            activeDraft.set({
              section: sec,
              wsPath,
              area,
              target,
              side: note.side,
              localStart: note.startLine,
              localEnd: note.endLine,
              realStartLine: note.realStartLine,
              realEndLine: note.realEndLine,
              joinedEndLine: at + note.endLine,
              excerpt: note.excerpt,
              hunkValid:
                note.realStartLine !== undefined &&
                note.realEndLine !== undefined &&
                isRangeInSinglePatchHunk(
                  sec.lineMap,
                  note.side,
                  note.realStartLine,
                  note.realEndLine,
                ),
              editingNoteId: note.id,
              initialComment: note.comment,
            });
          }}
          onRemove={() => props.reviewStore.removeNote(props.sessionId, note.id)}
          onSendNow={() => {
            if (props.deliverPrompt(formatReviewBatch([note]), 'send')) {
              props.reviewStore.removeNote(props.sessionId, note.id);
            }
          }}
        />
      );
    }

    if (ann.id.startsWith('pr-draft:')) {
      const draftId = ann.id.slice('pr-draft:'.length);
      const key = prKey();
      const item = prDrafts().find((d) => d.id === draftId);
      if (!item || !key) return <View />;
      return (
        <PendingPrCommentCard
          draft={item}
          onEdit={() => {
            const sec = displayedSections().find((s) => s.path === item.path);
            if (!sec) return;
            const side: 'old' | 'new' = item.side === 'LEFT' ? 'old' : 'new';
            const at = side === 'old' ? sec.oldAt : sec.newAt;
            const r2v =
              side === 'old' ? sec.lineMap.oldRealToVirtual : sec.lineMap.newRealToVirtual;
            const vEnd = r2v.get(item.line) ?? 0;
            const vStart = item.startLine !== undefined ? (r2v.get(item.startLine) ?? vEnd) : vEnd;
            const { target, wsPath, area } = makeTargetForSection(sec);
            activeDraft.set({
              section: sec,
              wsPath,
              area,
              target,
              side,
              localStart: vStart,
              localEnd: vEnd,
              realStartLine: item.startLine ?? item.line,
              realEndLine: item.line,
              joinedEndLine: at + vEnd,
              excerpt: item.excerpt,
              hunkValid: true,
              editingPrDraftId: item.id,
              initialComment: item.body,
            });
          }}
          onRemove={() => props.reviewStore.removePrDraft(props.sessionId, key, item.id)}
        />
      );
    }

    if (ann.id.startsWith('pr-thread:')) {
      const threadId = Number(ann.id.slice('pr-thread:'.length));
      const thread = prThreads().find((t) => t.id === threadId);
      const detail = props.prDetail;
      const key = prKey();
      if (!thread || !detail || !key) return <View />;
      return (
        <GitHubThreadCard
          thread={thread}
          canPrompt={props.canPrompt()}
          onReply={async (body) => {
            try {
              const { reply } = await host.control('githubReplyComment', {
                sessionId: props.sessionId,
                repo: detail.repo,
                number: detail.number,
                commentId: thread.id,
                body,
              });
              const res = settingsValue(reply) as GitHubReplyCommentResult;
              if (res.kind === 'replied') {
                props.reviewStore.appendPrThreadReply(props.sessionId, key, thread.id, res.comment);
                return null;
              }
              return res.message ?? tr('Failed to post GitHub reply.');
            } catch (err) {
              return err instanceof Error ? err.message : tr('Failed to post GitHub reply.');
            }
          }}
          onAskAgent={(mode) => {
            props.deliverPrompt(formatGitHubThreadPrompt(detail.number, thread), mode);
          }}
        />
      );
    }

    return <View />;
  };

  const toggleAllCollapsed = (collapse: boolean) => {
    const next: Record<string, boolean> = {};
    for (const row of filteredFileRows()) {
      next[row.diffPath] = collapse;
      if (collapse) diffRef?.collapseFile(row.diffPath);
      else diffRef?.expandFile(row.diffPath);
    }
    patchStudio({ collapsedPaths: next });
  };

  const renderFileHeader = (file: DiffFile) => {
    const row = allFileRows().find((r) => r.diffPath === file.path);
    const base = basenameLabel(file.path);
    const dir =
      file.path.length > base.length ? file.path.slice(0, file.path.length - base.length) : '';
    const isViewed = () =>
      row
        ? props.reviewStore.isViewed(props.sessionId, row.sourceKey, row.pathKey, row.digest)
        : false;

    return (
      <View
        style={{
          height: 36,
          paddingHorizontal: 12,
          backgroundColor: C.card,
          borderTopWidth: 1,
          borderBottomWidth: file.collapsed ? 0 : 1,
          borderColor: C.line,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Button
          accessibilityLabel={file.path}
          tooltip={textTooltip(() => (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path))}
          onPress={() => {
            diffRef?.toggleFile(file.path);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            borderRadius: 4,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 8,
          }}
          hoverStyle={{ opacity: 0.85 }}
          focusStyle={quietFocusStyle()}
        >
          <DisclosureChevron open={!file.collapsed} size={14} color={C.muted} />
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
            <If when={Boolean(dir)}>
              <Text
                style={[
                  { ...codeTextStyle, fontSize: 12, color: C.muted, flexShrink: 2, minWidth: 0 },
                  { numberOfLines: 1 },
                ]}
              >
                {dir}
              </Text>
            </If>
            <Text
              style={[
                {
                  ...codeTextStyle,
                  fontSize: 12,
                  color: C.text,
                  fontWeight: '500',
                  flexShrink: 1,
                },
                { numberOfLines: 1 },
              ]}
            >
              {base}
            </Text>
            <If when={Boolean(file.oldPath)}>
              <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginLeft: 8 }}>
                {`← ${basenameLabel(file.oldPath!)}`}
              </Text>
            </If>
          </View>
        </Button>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <If when={file.added > 0 || file.deleted > 0}>
            <Text style={{ fontSize: 12, lineHeight: 16, color: C.success, fontWeight: '500' }}>
              {`+${formatCount(file.added)}`}
            </Text>
            <Text
              style={{
                fontSize: 12,
                lineHeight: 16,
                color: C.danger,
                fontWeight: '500',
                marginRight: 4,
              }}
            >
              {`-${formatCount(file.deleted)}`}
            </Text>
          </If>

          <If when={row !== undefined}>
            <Button
              accessibilityLabel={tr('Mark file as viewed')}
              tooltip={textTooltip(() => tr('Mark file as viewed'))}
              selected={isViewed()}
              onPress={() => {
                if (!row) return;
                const nextViewed = props.reviewStore.toggleViewed(
                  props.sessionId,
                  row.sourceKey,
                  row.pathKey,
                  row.digest,
                );
                if (!singleFileMode()) {
                  if (nextViewed) diffRef?.collapseFile(file.path);
                  else diffRef?.expandFile(file.path);
                  patchStudio({
                    collapsedPaths: { ...studio().collapsedPaths, [file.path]: nextViewed },
                  });
                }
              }}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: isViewed() ? `${C.success}22` : 'transparent',
              }}
              hoverStyle={{ backgroundColor: C.cardRaised }}
              focusStyle={quietFocusStyle()}
            >
              <Icon
                name={isViewed() ? 'check' : 'readOnly'}
                size={13}
                color={isViewed() ? C.success : C.muted}
              />
            </Button>
          </If>

          <If when={Boolean(row?.canOpenSource)}>
            <Button
              accessibilityLabel={tr('Open source file')}
              tooltip={textTooltip(() => tr('Open source file'))}
              onPress={() => {
                if (!row) return;
                props.openFile({
                  sessionId: props.sessionId,
                  path: row.wsPath,
                  parent: parentPathOf(row.wsPath),
                  title: row.diffPath,
                });
              }}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              hoverStyle={{ backgroundColor: C.cardRaised }}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="arrow" size={13} color={C.muted} />
            </Button>
          </If>
        </View>
      </View>
    );
  };

  const worktrees = (): readonly GitWorktreeEntry[] => revisions()?.worktrees ?? [];
  const currentWorktree = () => {
    const wt = activeWorktree();
    const list = worktrees();
    if (wt) return list.find((item) => item.path === wt) ?? list.find((item) => item.isCurrent);
    return list.find((item) => item.isCurrent) ?? list[0];
  };

  const sourceTabLabel = (tab: StudioSourceTab) =>
    tab === 'working' ? tr('Uncommitted') : tab === 'branch' ? tr('Branch') : tr('Commits');

  const commitSearch = signal('');

  const filteredBranches = computed(() => {
    const branches = revisions()?.branches ?? [];
    const q = branchSearch().trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  });

  const fileTree = computed(() =>
    pathTree(filteredFileRows(), (row) => row.wsPath, host.pathLabel),
  );
  const fileIndex = computed(
    () => new Map(filteredFileRows().map((row, index) => [row.pathKey, { row, index }])),
  );
  const foldedFolders = signal<string[]>([]);
  const foldedMatches = signal<string[]>([]);
  const filter = computed(() => studio().filterQuery.trim());
  effect(() => {
    void props.sessionId;
    scopeKey();
    foldedFolders.set([]);
  });
  effect(() => {
    filter();
    foldedMatches.set([]);
  });
  const folds = () => (filter() ? foldedMatches : foldedFolders);
  const expandedFolders = computed(() => {
    const closed = new Set(folds()());
    return fileTree().folders.filter((id) => !closed.has(id));
  });

  const filteredCommits = computed(() => {
    const commits = revisions()?.commits ?? [];
    const q = commitSearch().trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.oid.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q),
    );
  });

  const selectFileRow = (row: FileRowItem, index: number) => {
    if (singleFileMode()) {
      patchStudio({ activeFileIndex: index });
      return;
    }
    patchStudio({
      collapsedPaths: { ...studio().collapsedPaths, [row.diffPath]: false },
    });
    diffRef?.expandFile(row.diffPath);
    diffRef?.scrollToFile(row.diffPath);
  };

  const allCollapsed = () => {
    const rows = filteredFileRows();
    if (rows.length === 0) return false;
    const map = studio().collapsedPaths;
    return rows.every((r) => map[r.diffPath] === true);
  };

  return (
    <View
      onLayout={({ bounds }) => studioWidth.set(bounds.size.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: C.panel }}
    >
      {/* Top Sub-Header */}
      <View
        style={{
          minHeight: 36,
          flexShrink: 0,
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <If
          when={!isPrMode()}
          else={
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('{count} files', { count: allFileRows().length })}
              </Text>
              <If when={viewedCount() > 0}>
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                  {tr('{viewed} / {total} viewed', {
                    viewed: viewedCount(),
                    total: allFileRows().length,
                  })}
                </Text>
              </If>
            </View>
          }
        >
          {/* Workspace Git Source Selector + Stats + Worktree/Branch/Commit Context */}
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Popover
              open={sourceMenuOpen()}
              onOpenChange={({ open }) => sourceMenuOpen.set(open)}
              placement="bottom"
              align="start"
              offset={4}
              margin={8}
              style={{ flexShrink: 0 }}
              popupStyle={{ ...floatingStyle(), width: 168 }}
              trigger={
                <Button
                  accessibilityLabel={sourceTabLabel(sourceTab())}
                  style={{
                    height: 28,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    backgroundColor: C.card,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                >
                  <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
                    {sourceTabLabel(sourceTab())}
                  </Text>
                  <Icon name="down" size={12} color={C.muted} />
                </Button>
              }
            >
              <View style={{ gap: 2 }}>
                <Each of={['working', 'branch', 'commit'] as const} key={(tab) => tab}>
                  {(tab) => (
                    <Button
                      accessibilityLabel={sourceTabLabel(tab())}
                      onPress={() => {
                        sourceMenuOpen.set(false);
                        sourceTab.set(tab());
                      }}
                      style={menuRowStyle()}
                      hoverStyle={menuRowHoverStyle()}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon
                        name={
                          tab() === 'working'
                            ? 'diff'
                            : tab() === 'branch'
                              ? 'gitBranch'
                              : 'gitCommit'
                        }
                        size={14}
                        color={sourceTab() === tab() ? C.accentText : C.muted}
                      />
                      <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                        {sourceTabLabel(tab())}
                      </Text>
                      <If when={sourceTab() === tab()}>
                        <Icon name="check" size={14} color={C.accentText} />
                      </If>
                    </Button>
                  )}
                </Each>
              </View>
            </Popover>

            <If when={totalStats().added > 0 || totalStats().deleted > 0}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.success, fontWeight: '500' }}>
                  {`+${formatCount(totalStats().added)}`}
                </Text>
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.danger, fontWeight: '500' }}>
                  {`-${formatCount(totalStats().deleted)}`}
                </Text>
              </View>
            </If>

            {/* Context Pill: Worktree Switcher (working) / Base Branch (branch) / Commit (commit) */}
            <If when={sourceTab() === 'working' && worktrees().length > 1}>
              <WorktreePicker
                variant="pill"
                align="start"
                worktrees={worktrees}
                activeWorktree={activeWorktree}
                activeBranch={() => revisions()?.headBranch}
                onSelect={(path) => props.reviewStore.setActiveWorktree(props.sessionId, path)}
              />
            </If>

            <If when={sourceTab() === 'branch'}>
              <Popover
                open={contextMenuOpen()}
                onOpenChange={({ open }) => {
                  contextMenuOpen.set(open);
                  if (!open) branchSearch.set('');
                }}
                placement="bottom"
                align="start"
                offset={4}
                margin={8}
                style={{ minWidth: 0, flexShrink: 1 }}
                popupStyle={{
                  ...floatingStyle(),
                  width: 280,
                  maxHeight: Math.min(360, Math.max(180, windowSize().height - 32)),
                }}
                trigger={
                  <Button
                    accessibilityLabel={tr('Select base branch')}
                    style={{
                      maxWidth: '100%',
                      minWidth: 0,
                      height: 28,
                      paddingHorizontal: 8,
                      borderRadius: 8,
                      backgroundColor: C.card,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      gap: 4,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon name="gitBranch" size={13} color={C.secondary} />
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.secondary, flexShrink: 1, minWidth: 0 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {`${revisions()?.headBranch ?? 'HEAD'} → ${selectedBaseBranch() || tr('Select base branch')}`}
                    </Text>
                    <Icon name="down" size={12} color={C.muted} />
                  </Button>
                }
              >
                <View style={{ minHeight: 0, flexShrink: 1 }}>
                  <View style={{ ...menuRowStyle(), gap: 8, flexShrink: 0 }}>
                    <Icon name="search" size={14} color={C.muted} />
                    <Input
                      autoFocus
                      value={branchSearch()}
                      onChange={({ value }) => branchSearch.set(value)}
                      placeholder={tr('Filter branches…')}
                      accessibilityLabel={tr('Filter branches…')}
                      style={{
                        ...captionTextStyle,
                        flex: 1,
                        minWidth: 0,
                        color: C.text,
                        placeholderColor: C.muted,
                      }}
                    />
                  </View>
                  <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
                  <If
                    when={filteredBranches().length > 0}
                    else={
                      <View
                        style={{ paddingHorizontal: 12, paddingVertical: 12, alignItems: 'center' }}
                      >
                        <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                          {tr('No matching branches')}
                        </Text>
                      </View>
                    }
                  >
                    <Scroll
                      style={{
                        maxHeight: Math.min(280, Math.max(120, windowSize().height - 108)),
                        minHeight: 0,
                        flexShrink: 1,
                      }}
                    >
                      <View style={{ gap: 2, paddingVertical: 2 }}>
                        <Each of={filteredBranches()} key={(b) => b.name}>
                          {(b) => (
                            <Button
                              accessibilityLabel={b().name}
                              onPress={() => {
                                contextMenuOpen.set(false);
                                selectedBaseBranch.set(b().name);
                              }}
                              style={menuRowStyle()}
                              hoverStyle={menuRowHoverStyle()}
                              focusStyle={quietFocusStyle()}
                            >
                              <Icon
                                name="gitBranch"
                                size={14}
                                color={selectedBaseBranch() === b().name ? C.accentText : C.muted}
                              />
                              <Text
                                style={[
                                  { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
                                  { numberOfLines: 1 },
                                ]}
                              >
                                {b().name}
                              </Text>
                              <If when={selectedBaseBranch() === b().name}>
                                <Icon name="check" size={14} color={C.accentText} />
                              </If>
                            </Button>
                          )}
                        </Each>
                      </View>
                    </Scroll>
                  </If>
                </View>
              </Popover>
            </If>

            <If when={sourceTab() === 'commit'}>
              <Popover
                open={contextMenuOpen()}
                onOpenChange={({ open }) => {
                  contextMenuOpen.set(open);
                  if (!open) commitSearch.set('');
                }}
                placement="bottom"
                align="start"
                offset={4}
                margin={8}
                style={{ minWidth: 0, flexShrink: 1 }}
                popupStyle={{
                  ...floatingStyle(),
                  width: 340,
                  maxHeight: Math.min(380, Math.max(180, windowSize().height - 32)),
                }}
                trigger={
                  <Button
                    accessibilityLabel={tr('Select commit')}
                    style={{
                      maxWidth: '100%',
                      minWidth: 0,
                      height: 28,
                      paddingHorizontal: 8,
                      borderRadius: 8,
                      backgroundColor: C.card,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      gap: 4,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon name="gitCommit" size={13} color={C.secondary} />
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.secondary, flexShrink: 1, minWidth: 0 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {revisions()?.commits.find((c) => c.oid === selectedCommitOid())?.summary ||
                        selectedCommitOid().slice(0, 7) ||
                        tr('Select commit')}
                    </Text>
                    <Icon name="down" size={12} color={C.muted} />
                  </Button>
                }
              >
                <View style={{ minHeight: 0, flexShrink: 1 }}>
                  <View style={{ ...menuRowStyle(), gap: 8, flexShrink: 0 }}>
                    <Icon name="search" size={14} color={C.muted} />
                    <Input
                      autoFocus
                      value={commitSearch()}
                      onChange={({ value }) => commitSearch.set(value)}
                      placeholder={tr('Filter commits…')}
                      accessibilityLabel={tr('Filter commits…')}
                      style={{
                        ...captionTextStyle,
                        flex: 1,
                        minWidth: 0,
                        color: C.text,
                        placeholderColor: C.muted,
                      }}
                    />
                  </View>
                  <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
                  <If
                    when={filteredCommits().length > 0}
                    else={
                      <View
                        style={{ paddingHorizontal: 12, paddingVertical: 12, alignItems: 'center' }}
                      >
                        <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                          {tr('No matching commits')}
                        </Text>
                      </View>
                    }
                  >
                    <Scroll
                      style={{
                        maxHeight: Math.min(280, Math.max(120, windowSize().height - 108)),
                        minHeight: 0,
                        flexShrink: 1,
                      }}
                    >
                      <View style={{ gap: 2, paddingVertical: 2 }}>
                        <Each of={filteredCommits()} key={(c) => c.oid}>
                          {(c) => (
                            <Button
                              accessibilityLabel={c().summary || c().oid.slice(0, 7)}
                              onPress={() => {
                                contextMenuOpen.set(false);
                                selectedCommitOid.set(c().oid);
                              }}
                              style={menuRowStyle()}
                              hoverStyle={menuRowHoverStyle()}
                              focusStyle={quietFocusStyle()}
                            >
                              <Text
                                style={{
                                  ...codeTextStyle,
                                  fontSize: 12,
                                  color: C.muted,
                                  width: 56,
                                  flexShrink: 0,
                                }}
                              >
                                {c().oid.slice(0, 7)}
                              </Text>
                              <Text
                                style={[
                                  { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
                                  { numberOfLines: 1 },
                                ]}
                              >
                                {c().summary || tr('(no commit message)')}
                              </Text>
                            </Button>
                          )}
                        </Each>
                      </View>
                    </Scroll>
                  </If>
                </View>
              </Popover>
            </If>
          </View>
        </If>

        {/* Pending Agent Review Notes Pill */}
        <If when={sessionNotes().length > 0}>
          <Popover
            open={notesMenuOpen()}
            onOpenChange={({ open }) => notesMenuOpen.set(open)}
            placement="bottom"
            align="end"
            offset={4}
            margin={8}
            popupStyle={{ ...floatingStyle(), width: 220 }}
            trigger={
              <Button
                accessibilityLabel={tr('review.notes_count', { count: sessionNotes().length })}
                style={{
                  height: 28,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  backgroundColor: `${C.accent}22`,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                }}
                hoverStyle={{ opacity: 0.9 }}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="note" size={13} color={C.accentText} />
                <Text
                  style={{ fontSize: 12, lineHeight: 16, color: C.accentText, fontWeight: '500' }}
                >
                  {formatCount(sessionNotes().length)}
                </Text>
              </Button>
            }
          >
            <View style={{ gap: 2 }}>
              <If when={props.canPrompt()}>
                <Button
                  accessibilityLabel={tr('Send review')}
                  onPress={() => {
                    const batchText = formatReviewBatch(sessionNotes());
                    if (props.deliverPrompt(batchText, 'send')) {
                      props.reviewStore.clearNotes(props.sessionId);
                      notesMenuOpen.set(false);
                    }
                  }}
                  style={menuRowStyle()}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="send" size={14} color={C.accentText} />
                  <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Send review')}</Text>
                </Button>
                <Button
                  accessibilityLabel={tr('Add all to prompt')}
                  onPress={() => {
                    const batchText = formatReviewBatch(sessionNotes());
                    if (props.deliverPrompt(batchText, 'insert')) {
                      props.reviewStore.clearNotes(props.sessionId);
                      notesMenuOpen.set(false);
                    }
                  }}
                  style={menuRowStyle()}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="plus" size={14} color={C.secondary} />
                  <Text style={{ ...captionTextStyle, color: C.text }}>
                    {tr('Add all to prompt')}
                  </Text>
                </Button>
              </If>
              <Button
                accessibilityLabel={tr('Clear review notes')}
                onPress={() => {
                  props.reviewStore.clearNotes(props.sessionId);
                  notesMenuOpen.set(false);
                }}
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="trash" size={14} color={C.danger} />
                <Text style={{ ...captionTextStyle, color: C.danger }}>
                  {tr('Clear review notes')}
                </Text>
              </Button>
            </View>
          </Popover>
        </If>

        {/* Right Compact Control Capsule */}
        <View
          style={{
            height: 28,
            paddingHorizontal: 2,
            borderRadius: 8,
            backgroundColor: C.card,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            flexShrink: 0,
          }}
        >
          <Popover
            open={moreMenuOpen()}
            onOpenChange={({ open }) => moreMenuOpen.set(open)}
            placement="bottom"
            align="end"
            offset={4}
            margin={8}
            popupStyle={{ ...floatingStyle(), width: 208 }}
            trigger={
              <Button
                accessibilityLabel={tr('More')}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                hoverStyle={{ backgroundColor: C.cardRaised }}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="more" size={14} color={C.secondary} />
              </Button>
            }
          >
            <View style={{ gap: 2 }}>
              <Button
                accessibilityLabel={tr('Collapse all files')}
                onPress={() => {
                  moreMenuOpen.set(false);
                  toggleAllCollapsed(true);
                }}
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="compaction" size={14} color={C.muted} />
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Collapse all files')}
                </Text>
              </Button>
              <Button
                accessibilityLabel={tr('Expand all files')}
                onPress={() => {
                  moreMenuOpen.set(false);
                  toggleAllCollapsed(false);
                }}
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="expand" size={14} color={C.muted} />
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Expand all files')}</Text>
              </Button>
              <View style={menuSeparatorStyle()} />
              <Button
                accessibilityLabel={tr('Wrap lines')}
                onPress={() => {
                  patchStudio({ softWrap: !studio().softWrap });
                  moreMenuOpen.set(false);
                }}
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="wrap" size={14} color={studio().softWrap ? C.accentText : C.muted} />
                <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                  {tr('Wrap lines')}
                </Text>
                <If when={studio().softWrap}>
                  <Icon name="check" size={14} color={C.accentText} />
                </If>
              </Button>
              <Button
                accessibilityLabel={tr('Large diff — showing one file at a time')}
                onPress={() => {
                  patchStudio({ singleFileOverride: !singleFileMode() });
                  moreMenuOpen.set(false);
                }}
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="file" size={14} color={singleFileMode() ? C.accentText : C.muted} />
                <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                  {tr('Previous file').replace(/\s.*$/, '') ? '1 / N' : '1 / N'}
                </Text>
                <If when={singleFileMode()}>
                  <Icon name="check" size={14} color={C.accentText} />
                </If>
              </Button>
            </View>
          </Popover>

          <If when={!isPrMode()}>
            <Button
              accessibilityLabel={tr('Refresh')}
              tooltip={textTooltip(() => tr('Refresh'))}
              onPress={() => void refreshWorkspaceGit()}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              hoverStyle={{ backgroundColor: C.cardRaised }}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="refresh" size={13} color={C.secondary} />
            </Button>
          </If>

          <Button
            accessibilityLabel={
              studio().diffLayout === 'split' ? tr('Unified diff') : tr('Side-by-side diff')
            }
            tooltip={textTooltip(() =>
              studio().diffLayout === 'split' ? tr('Unified diff') : tr('Side-by-side diff'),
            )}
            selected={studio().diffLayout === 'split'}
            onPress={() =>
              patchStudio({
                diffLayout: studio().diffLayout === 'split' ? 'unified' : 'split',
              })
            }
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: studio().diffLayout === 'split' ? C.raised : 'transparent',
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon
              name="split"
              size={13}
              color={studio().diffLayout === 'split' ? C.text : C.secondary}
            />
          </Button>

          <Button
            accessibilityLabel={allCollapsed() ? tr('Expand all files') : tr('Collapse all files')}
            tooltip={textTooltip(() =>
              allCollapsed() ? tr('Expand all files') : tr('Collapse all files'),
            )}
            onPress={() => toggleAllCollapsed(!allCollapsed())}
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="compaction" size={13} color={C.secondary} />
          </Button>

          <Button
            accessibilityLabel={tr('Changed files')}
            tooltip={textTooltip(() => tr('Changed files'))}
            selected={fileTreeOpen()}
            onPress={() => patchStudio({ fileTreeOpen: !fileTreeOpen() })}
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: fileTreeOpen() ? C.raised : 'transparent',
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="panelRight" size={13} color={fileTreeOpen() ? C.text : C.secondary} />
          </Button>
        </View>
      </View>

      {/* Main Split Content: Multi-File Diff Stream + Collapsible Changed Files Tree */}
      <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <If
            when={!loading()}
            else={
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <LoadingState label={tr('Loading…')} />
              </View>
            }
          >
            <If
              when={!(Boolean(loadError()) && allFileRows().length === 0)}
              else={
                <RegionEmptyError
                  tone="danger"
                  icon="diff"
                  title={loadError()}
                  retry={() => void refreshWorkspaceGit()}
                />
              }
            >
              <If when={Boolean(loadError()) && allFileRows().length > 0}>
                <InlineCallout
                  tone="danger"
                  message={loadError()}
                  action={{
                    label: tr('Retry'),
                    primary: true,
                    onPress: () => void refreshWorkspaceGit(),
                  }}
                  style={{ marginHorizontal: 16, marginTop: 10, marginBottom: 4 }}
                />
              </If>
              <If
                when={allFileRows().length > 0}
                else={
                  /* Clean Empty State matching Codex Desktop */
                  <View
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      padding: 32,
                      gap: 12,
                    }}
                  >
                    <View
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 12,
                        backgroundColor: C.card,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="diff" size={20} color={C.muted} />
                    </View>
                    <Text style={{ ...bodyTextStyle, color: C.secondary, fontWeight: '500' }}>
                      {tr('No file changes yet')}
                    </Text>
                    <If
                      when={
                        !isPrMode() &&
                        sourceTab() === 'working' &&
                        Boolean(revisions()?.defaultBase || revisions()?.branches.length)
                      }
                    >
                      <Button
                        accessibilityLabel={tr('View branch diff')}
                        onPress={() => sourceTab.set('branch')}
                        style={{
                          height: 32,
                          paddingHorizontal: 12,
                          borderRadius: 16,
                          backgroundColor: C.card,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                        hoverStyle={{ backgroundColor: C.cardRaised }}
                        activeStyle={quietActiveStyle()}
                        focusStyle={quietFocusStyle()}
                      >
                        <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
                          {tr('View branch diff')}
                        </Text>
                      </Button>
                    </If>
                  </View>
                }
              >
                <If when={singleFileMode()}>
                  <View
                    style={{
                      height: 32,
                      paddingHorizontal: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: C.line,
                      backgroundColor: C.background,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted, flex: 1 }}>
                      {tr('Large diff — showing one file at a time')}
                    </Text>
                    <Button
                      accessibilityLabel={tr('Previous file')}
                      disabled={clampedFileIndex() <= 0}
                      onPress={() =>
                        patchStudio({ activeFileIndex: Math.max(0, clampedFileIndex() - 1) })
                      }
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 4,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hoverStyle={quietHoverStyle()}
                      focusStyle={quietFocusStyle()}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Icon name="back" size={13} color={C.secondary} />
                    </Button>
                    <Text style={{ fontSize: 12, lineHeight: 16, color: C.secondary }}>
                      {`${formatCount(clampedFileIndex() + 1)} / ${formatCount(filteredFileRows().length)}`}
                    </Text>
                    <Button
                      accessibilityLabel={tr('Next file')}
                      disabled={clampedFileIndex() + 1 >= filteredFileRows().length}
                      onPress={() =>
                        patchStudio({
                          activeFileIndex: Math.min(
                            filteredFileRows().length - 1,
                            clampedFileIndex() + 1,
                          ),
                        })
                      }
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 4,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hoverStyle={quietHoverStyle()}
                      focusStyle={quietFocusStyle()}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Icon name="right" size={13} color={C.secondary} />
                    </Button>
                  </View>
                </If>

                <If
                  when={displayedPatch().trim().length > 0}
                  else={
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        padding: 24,
                      }}
                    >
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {filteredFileRows().length === 0
                          ? tr('No matching changes.')
                          : tr('Diff is too large to display inline.')}
                      </Text>
                    </View>
                  }
                >
                  <DiffView
                    ref={(node) => {
                      diffRef = node ?? undefined;
                      if (diffRef) applyCollapseAndScrollState();
                    }}
                    patch={displayedPatch()}
                    layout={studio().diffLayout}
                    softWrap={studio().softWrap}
                    fontSize={13}
                    lineHeight={20}
                    renderFileHeader={renderFileHeader}
                    annotations={annotations()}
                    renderAnnotation={renderAnnotation}
                    renderAddAnnotation={(range) => (
                      <AddLineNoteButton onPress={() => openInlineDraftForRange(range)} />
                    )}
                    onLineNumberPress={({ line }) =>
                      openInlineDraftForRange({
                        side: line.side,
                        start: line.line,
                        end: line.line,
                      })
                    }
                    onFileToggle={({ file }) => {
                      patchStudio({
                        collapsedPaths: {
                          ...studio().collapsedPaths,
                          [file.path]: file.collapsed,
                        },
                      });
                    }}
                    onScroll={({ offset, contentSize }) => {
                      if (contentSize.height > 0) {
                        applyCollapseAndScrollState();
                        if (!singleFileMode()) {
                          patchStudio({ scrollOffset: offset.y });
                        }
                      }
                    }}
                    style={{ flex: 1, minHeight: 0 }}
                  />
                </If>
              </If>
            </If>
          </If>
        </View>

        {/* Right-Side Collapsible Changed Files Tree */}
        <If when={fileTreeOpen() && allFileRows().length > 0}>
          <View
            style={{
              width: 240,
              height: '100%',
              flexShrink: 0,
              minHeight: 0,
              overflow: 'hidden',
              borderLeftWidth: 1,
              borderLeftColor: C.line,
              backgroundColor: C.panel,
            }}
          >
            <View
              style={{
                paddingHorizontal: 12,
                paddingTop: 8,
                paddingBottom: 8,
                gap: 8,
                borderBottomWidth: 1,
                borderBottomColor: C.line,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text
                  style={{
                    fontSize: 12,
                    lineHeight: 16,
                    fontWeight: '500',
                    color: C.secondary,
                    flex: 1,
                  }}
                >
                  {tr('Changed files')}
                </Text>
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                  {viewedCount() > 0
                    ? `${formatCount(viewedCount())}/${formatCount(allFileRows().length)}`
                    : formatCount(allFileRows().length)}
                </Text>
              </View>
              <View
                style={{
                  height: 28,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  backgroundColor: C.card,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Icon name="search" size={12} color={C.muted} />
                <Input
                  value={studio().filterQuery}
                  onChange={({ value }) => patchStudio({ filterQuery: value, activeFileIndex: 0 })}
                  placeholder={tr('Filter files…')}
                  accessibilityLabel={tr('Filter files…')}
                  style={{
                    ...captionTextStyle,
                    flex: 1,
                    minWidth: 0,
                    color: C.text,
                  }}
                />
                <If when={studio().filterQuery.length > 0}>
                  <Button
                    accessibilityLabel={tr('Clear')}
                    onPress={() => patchStudio({ filterQuery: '', activeFileIndex: 0 })}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    hoverStyle={quietHoverStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon name="close" size={11} color={C.muted} />
                  </Button>
                </If>
              </View>
            </View>

            <NativeFileTree
              label={tr('Changed files')}
              items={fileTree().items}
              expanded={expandedFolders()}
              setExpanded={(ids) => {
                const open = new Set(ids);
                folds().set(fileTree().folders.filter((id) => !open.has(id)));
              }}
              selected={
                singleFileMode() ? filteredFileRows()[clampedFileIndex()]?.pathKey : undefined
              }
              open={(id) => {
                const file = fileIndex().get(id);
                if (file) selectFileRow(file.row, file.index);
              }}
              detail={(id) => {
                const row = () => fileIndex().get(id)?.row;
                const viewed = () => {
                  const file = row();
                  return (
                    file &&
                    props.reviewStore.isViewed(
                      props.sessionId,
                      file.sourceKey,
                      file.pathKey,
                      file.digest,
                    )
                  );
                };
                return (
                  <If when={!!row()}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <If when={viewed()}>
                        <Icon name="check" size={12} color={C.success} />
                      </If>
                      <If when={(row()?.added ?? 0) > 0}>
                        <Text style={{ fontSize: 11, color: C.success }}>
                          {`+${formatCount(row()?.added ?? 0)}`}
                        </Text>
                      </If>
                      <If when={(row()?.deleted ?? 0) > 0}>
                        <Text style={{ fontSize: 11, color: C.danger }}>
                          {`−${formatCount(row()?.deleted ?? 0)}`}
                        </Text>
                      </If>
                      <Text style={{ fontSize: 11, color: row()?.statusColor }}>
                        {gitMark(row()?.status)}
                      </Text>
                    </View>
                  </If>
                );
              }}
            />
          </View>
        </If>
      </View>
    </View>
  );
}
