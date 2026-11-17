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
  cleanup,
  computed,
  effect,
  inputAction,
  List,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  windowSize,
} from 'nsh';
import {
  Button,
  DiffView,
  Input,
  Popover,
  type DiffFile,
  type DiffStats,
  type DiffViewRef,
} from 'nsh/base';
import type {
  GitArea,
  GitStatus,
  GitStatusEntry,
} from '../../../../packages/plugin-sdk/src/index.js';
import { ChoiceIndicator } from '../../../../products/maka/workbench/app/ChoiceIndicator';
import {
  type CurrentDiffTarget,
  gitAreaLabel,
} from '../../../../products/maka/workbench/app/CurrentDiff';
import {
  currentDiffTargetKey,
  resolveDiffSourceKey,
  workspacePathFromUtf8,
} from '../../../../products/maka/workbench/app/currentDiffState';
import { useHost } from '../../../../products/maka/workbench/app/host';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  formatPrKey,
  type GitCompare,
  type GitCompareSpec,
  type GitHubAuthStatus,
  type GitHubPullDetail,
  type GitHubPullDetailResult,
  type GitHubPullFileStatus,
  type GitHubPullRequestsResult,
  type GitHubPullStateFilter,
  type GitHubPullSummary,
  type GitHubRepoRef,
  type GitHubReviewEvent,
  type GitHubSubmitReviewResult,
  type GitHubTokenResult,
  type GitRevisions,
  type GitWorkspaceDiff,
  type ReviewNavItem,
  type ReviewStore,
} from '../../../../products/maka/workbench/app/reviewState';
import { settingsValue } from '../../../../products/maka/workbench/app/settingsOperations';
import { errorText, renderText, type UiText } from '../../../../products/maka/workbench/app/text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  floatingStyle,
  menuLabelStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from '../../../../products/maka/workbench/app/ui';

type SourceTab = 'working' | 'branch' | 'commit' | 'pr';

const changeKindLabel: Record<GitStatusEntry['kind'], string> = {
  get added() {
    return tr('added');
  },
  get modified() {
    return tr('modified');
  },
  get deleted() {
    return tr('deleted');
  },
  get type_changed() {
    return tr('type changed');
  },
  get conflicted() {
    return tr('conflicted');
  },
};

const prStatusLabel = (status: GitHubPullFileStatus): string => {
  switch (status) {
    case 'added':
      return tr('added');
    case 'modified':
    case 'changed':
      return tr('modified');
    case 'removed':
      return tr('deleted');
    case 'renamed':
      return tr('renamed');
    case 'copied':
      return tr('copied');
  }
};

const changeKindColor = (kind: GitStatusEntry['kind'] | GitHubPullFileStatus) =>
  kind === 'added'
    ? C.success
    : kind === 'deleted' || kind === 'removed' || kind === 'conflicted'
      ? C.danger
      : C.secondary;

const formatHeadLabel = (head: string): string =>
  /^[0-9a-f]{40,64}$/i.test(head) ? head.slice(0, 7) : head;

const tokenSourceLabel = (auth: GitHubAuthStatus | null): string => {
  if (!auth || !auth.authenticated) return tr('Unauthenticated (public repositories only)');
  switch (auth.tokenSource) {
    case 'manual':
      return tr('Authenticated via personal token');
    case 'env':
      return tr('Authenticated via environment token');
    case 'hosts_file':
      return tr('Authenticated via GitHub CLI config');
    case 'netrc':
      return tr('Authenticated via .netrc');
    case 'gh_cli':
      return tr('Authenticated via GitHub CLI');
    default:
      return tr('Authenticated');
  }
};

type WorkingState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: GitStatus | null }
  | { kind: 'error'; message: UiText };

type CompareState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; compare: GitCompare | null }
  | { kind: 'error'; message: UiText };

type AllDiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; diff: GitWorkspaceDiff | null }
  | { kind: 'error'; message: UiText };

type PrListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: GitHubPullRequestsResult }
  | { kind: 'error'; message: UiText };

type PrDetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: GitHubPullDetailResult }
  | { kind: 'error'; message: UiText };

type UnifiedRow = {
  id: string;
  pathLabel: string;
  secondaryLabel: string;
  kindColor: string;
  kindText: string;
  additions?: number;
  deletions?: number;
  threadCount: number;
  pendingCount: number;
  sourceKey: string;
  pathKey: string;
  digest: string;
  target: CurrentDiffTarget;
};

export function WorkspaceChanges(props: {
  sessionId: string;
  reviewStore?: ReviewStore;
  openDiff(target: CurrentDiffTarget): void;
  openFile?(pathLabel: string): void;
}) {
  const host = useHost();
  const initialCache = untracked(() => props.reviewStore?.changesViewCache(props.sessionId));
  const sourceTab = signal<SourceTab>(initialCache?.sourceTab ?? 'working');
  const mode = signal<'list' | 'review-all'>(initialCache?.mode ?? 'list');
  const layout = signal<'split' | 'unified'>('unified');
  const softWrap = signal(false);
  const stats = signal<DiffStats>({ added: 0, deleted: 0, hunks: 0 });

  const workingState = signal<WorkingState>({ kind: 'loading' });
  const workingAllDiff = signal<AllDiffState>({ kind: 'idle' });
  const areaFilter = signal<'all' | GitArea>(initialCache?.areaFilter ?? 'all');

  const revisions = signal<GitRevisions | null>(initialCache?.revisions ?? null);
  const selectedBaseBranch = signal<string>(initialCache?.selectedBaseBranch ?? '');
  const selectedCommitOid = signal<string>(initialCache?.selectedCommitOid ?? '');
  const branchMenuOpen = signal(false);
  const branchQuery = signal('');
  const commitMenuOpen = signal(false);
  const compareState = signal<CompareState>({ kind: 'idle' });

  const selectedRepo = signal<GitHubRepoRef | null>(initialCache?.selectedRepo ?? null);
  const prStateFilter = signal<GitHubPullStateFilter>(initialCache?.prStateFilter ?? 'open');
  const prListState = signal<PrListState>(
    initialCache?.prListResult
      ? { kind: 'ready', result: initialCache.prListResult }
      : { kind: 'idle' },
  );
  const selectedPrNumber = signal<number | null>(initialCache?.selectedPrNumber ?? null);
  const prDetailState = signal<PrDetailState>(
    initialCache?.prDetailEntry &&
      initialCache.prDetailEntry.number === initialCache.selectedPrNumber &&
      (!initialCache.mode ||
        initialCache.mode !== 'review-all' ||
        initialCache.prDetailEntry.includePatch)
      ? { kind: 'ready', result: initialCache.prDetailEntry.result }
      : { kind: 'idle' },
  );
  const prMenuOpen = signal(false);
  const prJumpInput = signal('');

  const tokenPopoverOpen = signal(false);
  const tokenDraft = signal('');
  const tokenSaving = signal(false);
  const tokenError = signal('');

  const reviewPopoverOpen = signal(false);
  const reviewEvent = signal<GitHubReviewEvent>('comment');
  const reviewBody = signal('');
  const reviewSubmitting = signal(false);
  const reviewFeedback = signal<{
    tone: 'error' | 'warning' | 'success';
    text: string;
  } | null>(null);

  let diffRef: DiffViewRef | undefined;
  let alive = true;
  let workingGen = 0;
  let workingDiffGen = 0;
  let compareGen = 0;
  let prListGen = 0;
  let prDetailGen = 0;

  cleanup(() => {
    alive = false;
    workingGen += 1;
    workingDiffGen += 1;
    compareGen += 1;
    prListGen += 1;
    prDetailGen += 1;
  });

  const loadWorkingDiff = async (sessionId: string, area: 'all' | GitArea) => {
    if (!alive || sessionId !== props.sessionId) return;
    const req = ++workingDiffGen;
    workingAllDiff.set({ kind: 'loading' });
    try {
      const diff: GitWorkspaceDiff | null = await host.query('agent', 'gitWorkspaceDiff', {
        sessionId,
        ...(area === 'all' ? {} : { area }),
      });
      if (alive && req === workingDiffGen && props.sessionId === sessionId) {
        workingAllDiff.set({ kind: 'ready', diff });
      }
    } catch (reason) {
      if (alive && req === workingDiffGen && props.sessionId === sessionId) {
        workingAllDiff.set({
          kind: 'error',
          message: errorText(reason, 'Could not read file changes.'),
        });
      }
    }
  };

  const repoCacheKey = (repo: GitHubRepoRef | null) =>
    repo ? `${repo.host}/${repo.owner}/${repo.repo}` : '';

  const loadPrList = async (
    sessionId: string,
    repo: GitHubRepoRef | null,
    stateFilter: GitHubPullStateFilter,
    headBranch: string | null,
    forceLoading = false,
  ) => {
    if (!alive || sessionId !== props.sessionId) return;
    const req = ++prListGen;
    if (forceLoading || prListState().kind !== 'ready') {
      prListState.set({ kind: 'loading' });
    }
    try {
      const result: GitHubPullRequestsResult = await host.query('agent', 'githubPullRequests', {
        sessionId,
        ...(repo ? { repo } : {}),
        state: stateFilter,
        ...(headBranch ? { headBranch } : {}),
      });
      if (!alive || req !== prListGen || props.sessionId !== sessionId) return;
      prListState.set({ kind: 'ready', result });
      props.reviewStore?.patchChangesViewCache(sessionId, {
        prListResult: result,
      });
      if (result.kind === 'ready') {
        if (!selectedRepo()) selectedRepo.set(result.repo);
        if (selectedPrNumber() === null) {
          const autoPick = result.currentBranchPr ?? result.pulls[0]?.number ?? null;
          if (autoPick !== null) selectedPrNumber.set(autoPick);
        }
      }
    } catch (reason) {
      if (alive && req === prListGen && props.sessionId === sessionId) {
        prListState.set({
          kind: 'error',
          message: errorText(reason, 'Could not load GitHub pull requests.'),
        });
      }
    }
  };

  const loadPrDetail = async (
    sessionId: string,
    repo: GitHubRepoRef | null,
    number: number,
    includePatch: boolean,
    forceLoading = false,
  ) => {
    if (!alive || sessionId !== props.sessionId || number <= 0) return;
    const req = ++prDetailGen;
    const cur = prDetailState();
    const sameNumber =
      cur.kind === 'ready' && cur.result.kind === 'ready' && cur.result.detail.number === number;
    if (forceLoading || !sameNumber) {
      prDetailState.set({ kind: 'loading' });
    }
    try {
      const result: GitHubPullDetailResult = await host.query('agent', 'githubPullRequestDetail', {
        sessionId,
        ...(repo ? { repo } : {}),
        number,
        includePatch,
      });
      if (!alive || req !== prDetailGen || props.sessionId !== sessionId) return;
      prDetailState.set({ kind: 'ready', result });
      if (props.reviewStore) {
        props.reviewStore.patchChangesViewCache(sessionId, {
          prDetailEntry: {
            repoKey: repoCacheKey(repo),
            number,
            includePatch,
            result,
          },
        });
        if (result.kind === 'ready') {
          const key = formatPrKey(result.detail.repo, result.detail.number);
          props.reviewStore.setPrThreads(sessionId, key, result.detail.threads);
        }
      }
    } catch (reason) {
      if (alive && req === prDetailGen && props.sessionId === sessionId) {
        prDetailState.set({
          kind: 'error',
          message: errorText(reason, 'Could not load pull request details.'),
        });
      }
    }
  };

  const loadCompare = async (sessionId: string, spec: GitCompareSpec, includePatch: boolean) => {
    if (!alive || sessionId !== props.sessionId) return;
    const req = ++compareGen;
    compareState.set({ kind: 'loading' });
    try {
      const compare: GitCompare | null = await host.query('agent', 'gitCompare', {
        sessionId,
        spec,
        includePatch,
      });
      if (alive && req === compareGen && props.sessionId === sessionId) {
        compareState.set({ kind: 'ready', compare });
      }
    } catch (reason) {
      if (alive && req === compareGen && props.sessionId === sessionId) {
        compareState.set({
          kind: 'error',
          message: errorText(reason, 'Could not compare Git revisions.'),
        });
      }
    }
  };

  const refreshAll = async (sessionId: string) => {
    if (!alive || sessionId !== props.sessionId) return;
    const req = ++workingGen;
    if (workingState().kind !== 'ready') {
      workingState.set({ kind: 'loading' });
    }
    try {
      const [status, rev] = await Promise.all([
        host.query('agent', 'gitStatus', { sessionId }),
        host.query('agent', 'gitRevisions', { sessionId }).catch(() => null),
      ]);
      if (!alive || req !== workingGen || props.sessionId !== sessionId) return;
      workingState.set({ kind: 'ready', status });
      revisions.set(rev);
      props.reviewStore?.patchChangesViewCache(sessionId, { revisions: rev });

      if (rev) {
        if (!selectedBaseBranch() && rev.defaultBase) {
          selectedBaseBranch.set(rev.defaultBase);
        } else if (!selectedBaseBranch() && rev.branches[0]) {
          selectedBaseBranch.set(rev.branches[0].name);
        }
        if (!selectedCommitOid() && rev.commits[0]) {
          selectedCommitOid.set(rev.commits[0].oid);
        }
        if (rev.remotes.length > 0 && prListState().kind === 'idle') {
          const initialRepo = selectedRepo() ?? {
            host: rev.remotes[0]!.host,
            owner: rev.remotes[0]!.owner,
            repo: rev.remotes[0]!.repo,
          };
          selectedRepo.set(initialRepo);
          void loadPrList(sessionId, initialRepo, prStateFilter(), rev.headBranch);
        }
      }

      const tab = sourceTab();
      if (tab === 'working' && mode() === 'review-all') {
        void loadWorkingDiff(sessionId, areaFilter());
      } else if (tab === 'branch' && selectedBaseBranch()) {
        void loadCompare(
          sessionId,
          { kind: 'branch', base: selectedBaseBranch() },
          mode() === 'review-all',
        );
      } else if (tab === 'commit' && selectedCommitOid()) {
        void loadCompare(
          sessionId,
          { kind: 'commit', oid: selectedCommitOid() },
          mode() === 'review-all',
        );
      } else if (tab === 'pr') {
        await loadPrList(sessionId, selectedRepo(), prStateFilter(), rev?.headBranch ?? null);
        const num = selectedPrNumber();
        if (num !== null) {
          void loadPrDetail(sessionId, selectedRepo(), num, mode() === 'review-all');
        }
      }
    } catch (reason) {
      if (alive && req === workingGen && props.sessionId === sessionId) {
        workingState.set({
          kind: 'error',
          message: errorText(reason, 'Could not read file changes.'),
        });
      }
    }
  };

  effect(() => {
    const sessionId = props.sessionId;
    untracked(() => {
      const saved = props.reviewStore?.changesViewCache(sessionId);
      sourceTab.set(saved?.sourceTab ?? 'working');
      mode.set(saved?.mode ?? 'list');
      areaFilter.set(saved?.areaFilter ?? 'all');
      revisions.set(saved?.revisions ?? null);
      selectedBaseBranch.set(saved?.selectedBaseBranch ?? '');
      selectedCommitOid.set(saved?.selectedCommitOid ?? '');
      selectedRepo.set(saved?.selectedRepo ?? null);
      prStateFilter.set(saved?.prStateFilter ?? 'open');
      selectedPrNumber.set(saved?.selectedPrNumber ?? null);
      prListState.set(
        saved?.prListResult ? { kind: 'ready', result: saved.prListResult } : { kind: 'idle' },
      );
      prDetailState.set(
        saved?.prDetailEntry &&
          saved.prDetailEntry.number === saved.selectedPrNumber &&
          (saved.mode !== 'review-all' || saved.prDetailEntry.includePatch)
          ? { kind: 'ready', result: saved.prDetailEntry.result }
          : { kind: 'idle' },
      );
      compareState.set({ kind: 'idle' });
      void refreshAll(sessionId);
    });
  });

  effect(() => {
    const tab = sourceTab();
    const curMode = mode();
    const area = areaFilter();
    const base = selectedBaseBranch();
    const commitOid = selectedCommitOid();
    const prNum = selectedPrNumber();
    const repo = selectedRepo();
    const prFilter = prStateFilter();
    const sessionId = props.sessionId;

    untracked(() => {
      props.reviewStore?.patchChangesViewCache(sessionId, {
        sourceTab: tab,
        mode: curMode,
        areaFilter: area,
        selectedBaseBranch: base,
        selectedCommitOid: commitOid,
        selectedRepo: repo,
        prStateFilter: prFilter,
        selectedPrNumber: prNum,
      });

      if (tab === 'working') {
        if (curMode === 'review-all') void loadWorkingDiff(sessionId, area);
      } else if (tab === 'branch') {
        if (base) {
          void loadCompare(sessionId, { kind: 'branch', base }, curMode === 'review-all');
        }
      } else if (tab === 'commit') {
        if (commitOid) {
          void loadCompare(sessionId, { kind: 'commit', oid: commitOid }, curMode === 'review-all');
        }
      } else if (tab === 'pr') {
        if (prListState().kind === 'idle') {
          void loadPrList(sessionId, repo, prFilter, revisions()?.headBranch ?? null);
        }
        if (prNum !== null) {
          const curDet = prDetailState();
          const alreadyLoaded =
            curDet.kind === 'ready' &&
            curDet.result.kind === 'ready' &&
            curDet.result.detail.number === prNum &&
            (curMode !== 'review-all' || curDet.result.detail.patch !== null);
          if (!alreadyLoaded) {
            void loadPrDetail(sessionId, repo, prNum, curMode === 'review-all');
          }
        }
      }
    });
  });

  const status = () => {
    const cur = workingState();
    return cur.kind === 'ready' ? cur.status : null;
  };
  const workingEntries = () => status()?.entries ?? [];
  const filteredWorkingEntries = computed(() => {
    const filter = areaFilter();
    return filter === 'all' ? workingEntries() : workingEntries().filter((e) => e.area === filter);
  });

  const activePrListReady = () => {
    const cur = prListState();
    return cur.kind === 'ready' && cur.result.kind === 'ready' ? cur.result : null;
  };

  const detectedBranchPr = () => activePrListReady()?.currentBranchPr ?? null;

  const activePrAuth = (): GitHubAuthStatus | null => {
    const detail = prDetail();
    if (detail) return detail.auth;
    const dState = prDetailState();
    if (dState.kind === 'ready' && dState.result.kind !== 'ready') return dState.result.auth;
    const lState = prListState();
    if (lState.kind === 'ready') {
      if (lState.result.kind === 'ready') return lState.result.auth;
      if (lState.result.kind === 'unauthorized' || lState.result.kind === 'error')
        return lState.result.auth;
    }
    return selectedRepo()
      ? { host: selectedRepo()!.host, authenticated: false, tokenSource: null }
      : null;
  };

  const availableRemotes = (): GitHubRepoRef[] => {
    const lState = prListState();
    if (lState.kind === 'ready') return lState.result.remotes;
    return (
      revisions()?.remotes.map((r) => ({
        host: r.host,
        owner: r.owner,
        repo: r.repo,
      })) ?? []
    );
  };

  const prDetail = (): GitHubPullDetail | null => {
    const cur = prDetailState();
    return cur.kind === 'ready' && cur.result.kind === 'ready' ? cur.result.detail : null;
  };

  const activePrKey = () => {
    const detail = prDetail();
    return detail ? formatPrKey(detail.repo, detail.number) : null;
  };

  const pendingPrComments = computed(() => {
    const key = activePrKey();
    if (!key || !props.reviewStore) return [];
    return props.reviewStore.prDrafts(props.sessionId, key);
  });

  const filteredBranches = computed(() => {
    const list = revisions()?.branches ?? [];
    const q = branchQuery().trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  });

  const selectedCommitSummary = computed(() => {
    const oid = selectedCommitOid();
    const list = revisions()?.commits ?? [];
    return list.find((c) => c.oid === oid) ?? list[0] ?? null;
  });

  const activeRows = computed<UnifiedRow[]>(() => {
    const tab = sourceTab();
    const sessionId = props.sessionId;
    if (tab === 'working') {
      const head = status()?.head ?? 'unborn';
      return filteredWorkingEntries().map((entry) => {
        const pathLabel = host.pathLabel(entry.path);
        const digest = `${head}:${entry.area}:${entry.kind}`;
        const target: CurrentDiffTarget = {
          sessionId,
          area: entry.area,
          source: { kind: 'working', area: entry.area },
          path: entry.path,
          title: pathLabel,
        };
        return {
          id: `working:${entry.area}:${entry.path.bytesBase64}`,
          pathLabel,
          secondaryLabel: gitAreaLabel[entry.area],
          kindColor: changeKindColor(entry.kind),
          kindText: changeKindLabel[entry.kind],
          threadCount: 0,
          pendingCount: 0,
          sourceKey: resolveDiffSourceKey(target),
          pathKey: entry.path.bytesBase64,
          digest,
          target,
        };
      });
    }

    if (tab === 'branch' || tab === 'commit') {
      const cmpState = compareState();
      const cmp = cmpState.kind === 'ready' ? cmpState.compare : null;
      if (!cmp) return [];
      const spec: GitCompareSpec =
        tab === 'branch'
          ? { kind: 'branch', base: selectedBaseBranch() }
          : { kind: 'commit', oid: selectedCommitOid() };
      const label =
        tab === 'branch' ? `${selectedBaseBranch()}…HEAD` : formatHeadLabel(selectedCommitOid());
      return cmp.entries.map((entry) => {
        const pathLabel = host.pathLabel(entry.path);
        const target: CurrentDiffTarget = {
          sessionId,
          source: { kind: 'compare', spec, label },
          digest: entry.digest,
          path: entry.path,
          title: pathLabel,
        };
        return {
          id: `compare:${label}:${entry.path.bytesBase64}`,
          pathLabel,
          secondaryLabel: '',
          kindColor: changeKindColor(entry.kind),
          kindText: changeKindLabel[entry.kind],
          threadCount: 0,
          pendingCount: 0,
          sourceKey: resolveDiffSourceKey(target),
          pathKey: entry.path.bytesBase64,
          digest: entry.digest,
          target,
        };
      });
    }

    const detail = prDetail();
    if (!detail) return [];
    const key = formatPrKey(detail.repo, detail.number);
    const liveThreads = props.reviewStore?.prThreads(sessionId, key) ?? detail.threads;
    const drafts = props.reviewStore?.prDrafts(sessionId, key) ?? [];

    return detail.files.map((file) => {
      const wsPath = workspacePathFromUtf8(file.path);
      const target: CurrentDiffTarget = {
        sessionId,
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
      const threadCount = liveThreads.filter((t) => t.path === file.path).length;
      const pendingCount = drafts.filter((d) => d.path === file.path).length;
      return {
        id: `pr:${detail.number}:${file.path}`,
        pathLabel: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
        secondaryLabel: '',
        kindColor: changeKindColor(file.status),
        kindText: prStatusLabel(file.status),
        additions: file.additions,
        deletions: file.deletions,
        threadCount,
        pendingCount,
        sourceKey: resolveDiffSourceKey(target),
        pathKey: wsPath.bytesBase64,
        digest: file.digest,
        target,
      };
    });
  });

  const viewedCount = computed(() => {
    const store = props.reviewStore;
    if (!store) return 0;
    return activeRows().filter((r) =>
      store.isViewed(props.sessionId, r.sourceKey, r.pathKey, r.digest),
    ).length;
  });

  const syncQueueAndOpen = (target: CurrentDiffTarget) => {
    if (!alive || target.sessionId !== props.sessionId) return;
    if (props.reviewStore) {
      const items: ReviewNavItem[] = activeRows().map((r) => ({
        key: currentDiffTargetKey(r.target),
        title: r.target.title,
        sourceKey: r.sourceKey,
        pathKey: r.pathKey,
        digest: r.digest,
        target: r.target,
      }));
      props.reviewStore.setReviewQueue(props.sessionId, items);
    }
    props.openDiff(target);
  };

  const openDiffByPathLabel = (pathLabel: string) => {
    const match = activeRows().find(
      (r) => r.target.title === pathLabel || r.pathLabel === pathLabel,
    );
    if (match) syncQueueAndOpen(match.target);
    else props.openFile?.(pathLabel);
  };

  const activeCombinedDiff = computed<{
    loading: boolean;
    error: string;
    diff: GitWorkspaceDiff | null;
  }>(() => {
    const tab = sourceTab();
    if (tab === 'working') {
      const s = workingAllDiff();
      if (s.kind === 'loading' || s.kind === 'idle')
        return { loading: true, error: '', diff: null };
      if (s.kind === 'error') return { loading: false, error: renderText(s.message), diff: null };
      return { loading: false, error: '', diff: s.diff };
    }
    if (tab === 'branch' || tab === 'commit') {
      const s = compareState();
      if (s.kind === 'loading' || s.kind === 'idle')
        return { loading: true, error: '', diff: null };
      if (s.kind === 'error') return { loading: false, error: renderText(s.message), diff: null };
      return { loading: false, error: '', diff: s.compare?.patch ?? null };
    }
    const s = prDetailState();
    if (s.kind === 'loading' || s.kind === 'idle') return { loading: true, error: '', diff: null };
    if (s.kind === 'error') return { loading: false, error: renderText(s.message), diff: null };
    if (s.result.kind !== 'ready') return { loading: false, error: '', diff: null };
    return { loading: false, error: '', diff: s.result.detail.patch };
  });

  const saveToken = async () => {
    const hostName = selectedRepo()?.host ?? 'github.com';
    const secret = tokenDraft().trim();
    if (!secret || tokenSaving()) return;
    tokenSaving.set(true);
    tokenError.set('');
    try {
      const { reply } = await host.settingsMutation(
        'agent',
        'saveGitHubToken',
        { host: hostName },
        secret,
      );
      const res = settingsValue(reply) as GitHubTokenResult;
      if (res.kind === 'invalid_token') {
        tokenError.set(tr('Invalid token format.'));
      } else {
        tokenDraft.set('');
        tokenPopoverOpen.set(false);
        await loadPrList(
          props.sessionId,
          selectedRepo(),
          prStateFilter(),
          revisions()?.headBranch ?? null,
        );
        const num = selectedPrNumber();
        if (num !== null) {
          void loadPrDetail(props.sessionId, selectedRepo(), num, mode() === 'review-all');
        }
      }
    } catch (err) {
      tokenError.set(err instanceof Error ? err.message : tr('Could not save GitHub token.'));
    } finally {
      tokenSaving.set(false);
    }
  };

  const clearManualToken = async () => {
    const hostName = selectedRepo()?.host ?? 'github.com';
    if (tokenSaving()) return;
    tokenSaving.set(true);
    tokenError.set('');
    try {
      const { reply } = await host.settingsMutation('agent', 'deleteGitHubToken', {
        host: hostName,
      });
      settingsValue(reply);
      tokenPopoverOpen.set(false);
      await loadPrList(
        props.sessionId,
        selectedRepo(),
        prStateFilter(),
        revisions()?.headBranch ?? null,
      );
      const num = selectedPrNumber();
      if (num !== null) {
        void loadPrDetail(props.sessionId, selectedRepo(), num, mode() === 'review-all');
      }
    } catch (err) {
      tokenError.set(err instanceof Error ? err.message : tr('Could not remove GitHub token.'));
    } finally {
      tokenSaving.set(false);
    }
  };

  const submitPrReview = async () => {
    const detail = prDetail();
    const key = activePrKey();
    if (!detail || !key || reviewSubmitting()) return;
    reviewSubmitting.set(true);
    reviewFeedback.set(null);
    try {
      const drafts = pendingPrComments();
      const { reply } = await host.control('githubSubmitReview', {
        sessionId: props.sessionId,
        repo: detail.repo,
        number: detail.number,
        expectedHeadSha: detail.headSha,
        event: reviewEvent(),
        body: reviewBody(),
        comments: drafts.map((d) => ({
          path: d.path,
          side: d.side,
          line: d.line,
          ...(d.startLine !== undefined ? { startLine: d.startLine } : {}),
          ...(d.startSide !== undefined ? { startSide: d.startSide } : {}),
          body: d.body,
        })),
      });
      const res = settingsValue(reply) as GitHubSubmitReviewResult;
      if (res.kind === 'submitted') {
        props.reviewStore?.clearPrDrafts(props.sessionId, key);
        reviewBody.set('');
        reviewPopoverOpen.set(false);
        void loadPrDetail(props.sessionId, detail.repo, detail.number, mode() === 'review-all');
      } else if (res.kind === 'stale_head') {
        reviewFeedback.set({
          tone: 'warning',
          text: tr(
            'Pull request head moved to {sha}. Refresh the diff before submitting your comments.',
            { sha: formatHeadLabel(res.actualHeadSha) },
          ),
        });
      } else {
        reviewFeedback.set({ tone: 'error', text: res.message });
      }
    } catch (err) {
      reviewFeedback.set({
        tone: 'error',
        text: err instanceof Error ? err.message : tr('Could not submit GitHub review.'),
      });
    } finally {
      reviewSubmitting.set(false);
    }
  };

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      {/* Top Bar: 4-Way Source Switcher + File List / Review All + Refresh */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <View
          role="tablist"
          style={{
            flexDirection: 'row',
            backgroundColor: C.card,
            padding: 2,
            borderRadius: 8,
            gap: 2,
          }}
        >
          <Button
            role="tab"
            selected={sourceTab() === 'working'}
            onPress={() => sourceTab.set('working')}
            style={{
              minHeight: 28,
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: sourceTab() === 'working' ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: sourceTab() === 'working' ? C.text : C.secondary,
                fontWeight: sourceTab() === 'working' ? '500' : '400',
              }}
            >
              {tr('Uncommitted')}
            </Text>
            <If when={workingEntries().length > 0}>
              <Text style={{ ...captionTextStyle, fontSize: 11, color: C.muted }}>
                {workingEntries().length}
              </Text>
            </If>
          </Button>

          <Button
            role="tab"
            selected={sourceTab() === 'branch'}
            onPress={() => sourceTab.set('branch')}
            style={{
              minHeight: 28,
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 6,
              justifyContent: 'center',
              backgroundColor: sourceTab() === 'branch' ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: sourceTab() === 'branch' ? C.text : C.secondary,
                fontWeight: sourceTab() === 'branch' ? '500' : '400',
              }}
            >
              {tr('Branch')}
            </Text>
          </Button>

          <Button
            role="tab"
            selected={sourceTab() === 'commit'}
            onPress={() => sourceTab.set('commit')}
            style={{
              minHeight: 28,
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 6,
              justifyContent: 'center',
              backgroundColor: sourceTab() === 'commit' ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: sourceTab() === 'commit' ? C.text : C.secondary,
                fontWeight: sourceTab() === 'commit' ? '500' : '400',
              }}
            >
              {tr('Commits')}
            </Text>
          </Button>

          <Button
            role="tab"
            selected={sourceTab() === 'pr'}
            onPress={() => sourceTab.set('pr')}
            style={{
              minHeight: 28,
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: sourceTab() === 'pr' ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: sourceTab() === 'pr' ? C.text : C.secondary,
                fontWeight: sourceTab() === 'pr' ? '500' : '400',
              }}
            >
              {tr('PR')}
            </Text>
            <If when={detectedBranchPr() !== null}>
              <Text style={{ ...captionTextStyle, fontSize: 11, color: C.accent }}>
                #{detectedBranchPr()}
              </Text>
            </If>
          </Button>
        </View>

        <View style={{ flex: 1 }} />

        <If when={activeRows().length > 0 || mode() === 'review-all'}>
          <View
            role="tablist"
            style={{
              flexDirection: 'row',
              backgroundColor: C.card,
              padding: 2,
              borderRadius: 8,
              gap: 2,
            }}
          >
            <Button
              role="tab"
              selected={mode() === 'list'}
              onPress={() => mode.set('list')}
              style={{
                minHeight: 28,
                height: 28,
                paddingHorizontal: 8,
                borderRadius: 6,
                justifyContent: 'center',
                backgroundColor: mode() === 'list' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: mode() === 'list' ? C.text : C.secondary,
                }}
              >
                {tr('File list')}
              </Text>
            </Button>
            <Button
              role="tab"
              selected={mode() === 'review-all'}
              onPress={() => mode.set('review-all')}
              style={{
                minHeight: 28,
                height: 28,
                paddingHorizontal: 8,
                borderRadius: 6,
                justifyContent: 'center',
                backgroundColor: mode() === 'review-all' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: mode() === 'review-all' ? C.text : C.secondary,
                }}
              >
                {tr('Review all')}
              </Text>
            </Button>
          </View>
        </If>

        <Button
          accessibilityLabel={tr('Refresh current changes')}
          onPress={inputAction(refreshAll, props.sessionId)}
          tooltip={textTooltip(() => tr('Refresh current changes'))}
          style={{
            ...controlStyle,
            width: 32,
            minHeight: 32,
            paddingHorizontal: 8,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="refresh" color={C.muted} />
        </Button>
      </View>

      {/* Source-Specific Context Bar */}
      <If when={sourceTab() === 'working' && status() !== null}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <Text style={[{ ...captionTextStyle, color: C.secondary }, { numberOfLines: 1 }]}>
            {revisions()?.headBranch ??
              (status()!.head ? formatHeadLabel(status()!.head!) : tr('Unborn HEAD'))}
          </Text>
          <If when={workingEntries().length > 0}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                flexWrap: 'wrap',
              }}
            >
              <Each of={['all', 'worktree', 'staged', 'untracked'] as const} key={(a) => a}>
                {(area) => (
                  <Button
                    selected={areaFilter() === area()}
                    onPress={() => areaFilter.set(area())}
                    style={{
                      height: 24,
                      paddingHorizontal: 8,
                      borderRadius: 6,
                      justifyContent: 'center',
                      backgroundColor: areaFilter() === area() ? C.cardRaised : C.card,
                    }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <Text
                      style={{
                        ...captionTextStyle,
                        fontSize: 12,
                        color: areaFilter() === area() ? C.text : C.muted,
                      }}
                    >
                      {area() === 'all' ? tr('All') : gitAreaLabel[area() as GitArea]}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
          <View style={{ flex: 1 }} />
          <If when={props.reviewStore !== undefined && activeRows().length > 0}>
            <Text style={{ ...captionTextStyle, fontSize: 12, color: C.muted }}>
              {tr('{viewed} / {total} viewed', {
                viewed: viewedCount(),
                total: activeRows().length,
              })}
            </Text>
          </If>
        </View>
      </If>

      <If when={sourceTab() === 'branch' && revisions() !== null}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <Popover
            open={branchMenuOpen()}
            onOpenChange={({ open }) => branchMenuOpen.set(open)}
            placement="bottom"
            align="start"
            offset={6}
            margin={8}
            popupStyle={{
              ...floatingStyle(),
              width: 300,
              maxHeight: Math.min(360, Math.max(180, windowSize().height - 64)),
              gap: 4,
            }}
            trigger={
              <Button
                accessibilityLabel={tr('Select base branch')}
                style={{
                  ...controlStyle,
                  minHeight: 28,
                  height: 28,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: C.card,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Icon name="fork" size={13} color={C.secondary} />
                <Text
                  style={[{ ...codeTextStyle, fontSize: 12, color: C.text }, { numberOfLines: 1 }]}
                >
                  {selectedBaseBranch() || tr('Select base branch')}
                </Text>
                <Icon name="down" size={13} color={C.muted} />
              </Button>
            }
          >
            <View style={{ padding: 4, gap: 4 }}>
              <Input
                value={branchQuery()}
                onChange={({ value }) => branchQuery.set(value)}
                placeholder={tr('Filter branches…')}
                accessibilityLabel={tr('Filter branches…')}
                style={{
                  ...captionTextStyle,
                  height: 28,
                  paddingHorizontal: 8,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: C.line,
                  backgroundColor: C.card,
                  color: C.text,
                }}
              />
              <Scroll style={{ maxHeight: 260 }}>
                <View style={{ gap: 2 }}>
                  <Each of={filteredBranches()} key={(b) => `${b.remote ? 'r' : 'l'}:${b.name}`}>
                    {(branch) => (
                      <Button
                        onPress={() => {
                          selectedBaseBranch.set(branch().name);
                          branchMenuOpen.set(false);
                        }}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={menuRowHoverStyle()}
                      >
                        <ChoiceIndicator
                          kind="radio"
                          checked={selectedBaseBranch() === branch().name}
                        />
                        <Text
                          style={[
                            {
                              ...codeTextStyle,
                              fontSize: 12,
                              flex: 1,
                              color: C.text,
                            },
                            { numberOfLines: 1 },
                          ]}
                        >
                          {branch().name}
                        </Text>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 11,
                            color: C.muted,
                          }}
                        >
                          {formatHeadLabel(branch().oid)}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
              </Scroll>
            </View>
          </Popover>

          <Text style={{ ...captionTextStyle, color: C.muted }}>←</Text>
          <Text
            style={[{ ...codeTextStyle, fontSize: 12, color: C.secondary }, { numberOfLines: 1 }]}
          >
            {revisions()!.headBranch ??
              (revisions()!.headOid ? formatHeadLabel(revisions()!.headOid!) : 'HEAD')}
          </Text>
          <View style={{ flex: 1 }} />
          <If when={activeRows().length > 0}>
            <Text style={{ ...captionTextStyle, fontSize: 12, color: C.muted }}>
              {props.reviewStore
                ? tr('{viewed} / {total} viewed', {
                    viewed: viewedCount(),
                    total: activeRows().length,
                  })
                : tr('{count} files', { count: activeRows().length })}
            </Text>
          </If>
        </View>
      </If>

      <If when={sourceTab() === 'commit' && revisions() !== null}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <Popover
            open={commitMenuOpen()}
            onOpenChange={({ open }) => commitMenuOpen.set(open)}
            placement="bottom"
            align="start"
            offset={6}
            margin={8}
            style={{ flex: 1, minWidth: 160 }}
            popupStyle={{
              ...floatingStyle(),
              width: 400,
              maxHeight: Math.min(380, Math.max(180, windowSize().height - 64)),
            }}
            trigger={
              <Button
                accessibilityLabel={tr('Select commit')}
                style={{
                  ...controlStyle,
                  minHeight: 28,
                  height: 28,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: C.card,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ ...codeTextStyle, fontSize: 12, color: C.accent }}>
                  {selectedCommitSummary()?.shortOid ?? tr('Commits')}
                </Text>
                <Text
                  style={[{ ...captionTextStyle, flex: 1, color: C.text }, { numberOfLines: 1 }]}
                >
                  {selectedCommitSummary()?.summary ?? tr('Select a commit')}
                </Text>
                <Icon name="down" size={13} color={C.muted} />
              </Button>
            }
          >
            <Scroll style={{ maxHeight: 330 }}>
              <View style={{ gap: 2 }}>
                <Each of={revisions()!.commits} key={(c) => c.oid}>
                  {(commit) => (
                    <Button
                      onPress={() => {
                        selectedCommitOid.set(commit().oid);
                        commitMenuOpen.set(false);
                      }}
                      style={menuRowStyle()}
                      hoverStyle={menuRowHoverStyle()}
                      focusStyle={menuRowHoverStyle()}
                    >
                      <ChoiceIndicator
                        kind="radio"
                        checked={selectedCommitOid() === commit().oid}
                      />
                      <Text
                        style={{
                          ...codeTextStyle,
                          fontSize: 12,
                          color: C.accent,
                        }}
                      >
                        {commit().shortOid}
                      </Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}
                        >
                          {commit().summary || tr('(no commit message)')}
                        </Text>
                        <Text
                          style={[
                            {
                              ...captionTextStyle,
                              fontSize: 11,
                              color: C.muted,
                            },
                            { numberOfLines: 1 },
                          ]}
                        >
                          {commit().author}
                        </Text>
                      </View>
                    </Button>
                  )}
                </Each>
              </View>
            </Scroll>
          </Popover>

          <If when={activeRows().length > 0 && props.reviewStore !== undefined}>
            <Text style={{ ...captionTextStyle, fontSize: 12, color: C.muted }}>
              {tr('{viewed} / {total} viewed', {
                viewed: viewedCount(),
                total: activeRows().length,
              })}
            </Text>
          </If>
        </View>
      </If>

      {/* GitHub PR Picker + Auth + PR Metadata + Submit Review */}
      <If when={sourceTab() === 'pr'}>
        <View style={{ gap: 8 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <Popover
              open={prMenuOpen()}
              onOpenChange={({ open }) => prMenuOpen.set(open)}
              placement="bottom"
              align="start"
              offset={6}
              margin={8}
              style={{ flex: 1, minWidth: 160 }}
              popupStyle={{
                ...floatingStyle(),
                width: 420,
                maxHeight: Math.min(420, Math.max(200, windowSize().height - 64)),
              }}
              trigger={
                <Button
                  accessibilityLabel={tr('Select pull request')}
                  style={{
                    ...controlStyle,
                    minHeight: 28,
                    height: 28,
                    paddingHorizontal: 10,
                    borderRadius: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    backgroundColor: C.card,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Text style={{ ...codeTextStyle, fontSize: 12, color: C.accent }}>
                    {selectedPrNumber() !== null ? `#${selectedPrNumber()}` : 'PR'}
                  </Text>
                  <Text
                    style={[{ ...captionTextStyle, flex: 1, color: C.text }, { numberOfLines: 1 }]}
                  >
                    {prDetail()?.title ??
                      activePrListReady()?.pulls.find((p) => p.number === selectedPrNumber())
                        ?.title ??
                      tr('Select pull request')}
                  </Text>
                  <Icon name="down" size={13} color={C.muted} />
                </Button>
              }
            >
              <View style={{ padding: 4, gap: 6 }}>
                <If when={availableRemotes().length > 1}>
                  <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                    <Each of={availableRemotes()} key={(r) => `${r.host}/${r.owner}/${r.repo}`}>
                      {(remote) => {
                        const isSelected = () =>
                          selectedRepo()?.host === remote().host &&
                          selectedRepo()?.owner === remote().owner &&
                          selectedRepo()?.repo === remote().repo;
                        return (
                          <Button
                            selected={isSelected()}
                            onPress={() => {
                              selectedRepo.set(remote());
                              selectedPrNumber.set(null);
                              void loadPrList(
                                props.sessionId,
                                remote(),
                                prStateFilter(),
                                revisions()?.headBranch ?? null,
                              );
                            }}
                            style={{
                              height: 24,
                              paddingHorizontal: 8,
                              borderRadius: 6,
                              justifyContent: 'center',
                              backgroundColor: isSelected() ? C.cardRaised : C.card,
                            }}
                            hoverStyle={controlHoverStyle()}
                            focusStyle={controlFocusStyle()}
                          >
                            <Text
                              style={{
                                ...captionTextStyle,
                                fontSize: 12,
                                color: isSelected() ? C.text : C.muted,
                              }}
                            >
                              {remote().owner}/{remote().repo}
                            </Text>
                          </Button>
                        );
                      }}
                    </Each>
                  </View>
                </If>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Each of={['open', 'closed', 'all'] as const} key={(s) => s}>
                    {(st) => (
                      <Button
                        selected={prStateFilter() === st()}
                        onPress={() => {
                          prStateFilter.set(st());
                          void loadPrList(
                            props.sessionId,
                            selectedRepo(),
                            st(),
                            revisions()?.headBranch ?? null,
                          );
                        }}
                        style={{
                          height: 24,
                          paddingHorizontal: 8,
                          borderRadius: 6,
                          justifyContent: 'center',
                          backgroundColor: prStateFilter() === st() ? C.cardRaised : C.card,
                        }}
                        hoverStyle={controlHoverStyle()}
                        focusStyle={controlFocusStyle()}
                      >
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 12,
                            color: prStateFilter() === st() ? C.text : C.muted,
                          }}
                        >
                          {st() === 'open'
                            ? tr('Open')
                            : st() === 'closed'
                              ? tr('Closed')
                              : tr('All')}
                        </Text>
                      </Button>
                    )}
                  </Each>
                  <View style={{ flex: 1 }} />
                  <Input
                    value={prJumpInput()}
                    onChange={({ value }) => prJumpInput.set(value)}
                    onSubmit={() => {
                      const n = Number(prJumpInput().replace(/^#/, '').trim());
                      if (Number.isInteger(n) && n > 0) {
                        selectedPrNumber.set(n);
                        prJumpInput.set('');
                        prMenuOpen.set(false);
                      }
                    }}
                    placeholder="#123"
                    accessibilityLabel={tr('Jump to pull request number')}
                    style={{
                      ...codeTextStyle,
                      fontSize: 12,
                      width: 76,
                      height: 24,
                      paddingHorizontal: 6,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: C.line,
                      backgroundColor: C.card,
                      color: C.text,
                    }}
                  />
                </View>

                <View style={menuSeparatorStyle()} />

                <Scroll style={{ maxHeight: 280 }}>
                  <View style={{ gap: 2 }}>
                    <Each
                      of={activePrListReady()?.pulls ?? []}
                      key={(p: GitHubPullSummary) => String(p.number)}
                    >
                      {(pr) => (
                        <Button
                          onPress={() => {
                            selectedPrNumber.set(pr().number);
                            prMenuOpen.set(false);
                          }}
                          style={menuRowStyle()}
                          hoverStyle={menuRowHoverStyle()}
                          focusStyle={menuRowHoverStyle()}
                        >
                          <ChoiceIndicator
                            kind="radio"
                            checked={selectedPrNumber() === pr().number}
                          />
                          <Text
                            style={{
                              ...codeTextStyle,
                              fontSize: 12,
                              color:
                                pr().state === 'open'
                                  ? pr().draft
                                    ? C.muted
                                    : C.success
                                  : C.secondary,
                            }}
                          >
                            #{pr().number}
                          </Text>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text
                              style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}
                            >
                              {pr().title}
                            </Text>
                            <Text
                              style={[
                                {
                                  ...captionTextStyle,
                                  fontSize: 11,
                                  color: C.muted,
                                },
                                { numberOfLines: 1 },
                              ]}
                            >
                              @{pr().author} · {pr().baseRef} ← {pr().headRef}
                            </Text>
                          </View>
                        </Button>
                      )}
                    </Each>
                  </View>
                </Scroll>
              </View>
            </Popover>

            <Popover
              open={tokenPopoverOpen()}
              onOpenChange={({ open }) => {
                tokenPopoverOpen.set(open);
                if (!open) tokenError.set('');
              }}
              placement="bottom"
              align="end"
              offset={6}
              margin={8}
              popupStyle={{
                ...floatingStyle(),
                width: 320,
                padding: 10,
                gap: 8,
              }}
              trigger={
                <Button
                  accessibilityLabel={tr('GitHub authentication')}
                  tooltip={textTooltip(() =>
                    tokenPopoverOpen() ? undefined : tokenSourceLabel(activePrAuth()),
                  )}
                  style={{
                    ...controlStyle,
                    minHeight: 28,
                    height: 28,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    backgroundColor: C.card,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Icon
                    name="lock"
                    size={13}
                    color={activePrAuth()?.authenticated ? C.success : C.muted}
                  />
                  <Text
                    style={{
                      ...captionTextStyle,
                      fontSize: 12,
                      color: C.secondary,
                    }}
                  >
                    {tr('Token')}
                  </Text>
                </Button>
              }
            >
              <Text style={menuLabelStyle()}>{selectedRepo()?.host ?? 'github.com'}</Text>
              <Text
                style={{
                  ...captionTextStyle,
                  paddingHorizontal: 8,
                  color: C.secondary,
                }}
              >
                {tokenSourceLabel(activePrAuth())}
              </Text>
              <Input
                value={tokenDraft()}
                onChange={({ value }) => tokenDraft.set(value)}
                onSubmit={() => void saveToken()}
                placeholder="ghp_… / github_pat_…"
                accessibilityLabel={tr('Personal access token')}
                style={{
                  ...codeTextStyle,
                  fontSize: 12,
                  height: 30,
                  marginHorizontal: 4,
                  paddingHorizontal: 8,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: C.line,
                  backgroundColor: C.card,
                  color: C.text,
                }}
              />
              <If when={tokenError().length > 0}>
                <Text
                  style={{
                    ...captionTextStyle,
                    paddingHorizontal: 8,
                    color: C.danger,
                  }}
                >
                  {tokenError()}
                </Text>
              </If>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  gap: 6,
                }}
              >
                <If when={activePrAuth()?.tokenSource === 'manual'}>
                  <Button
                    disabled={tokenSaving()}
                    onPress={() => void clearManualToken()}
                    style={{
                      ...controlStyle,
                      minHeight: 28,
                      height: 28,
                      paddingHorizontal: 8,
                    }}
                    hoverStyle={quietHoverStyle()}
                    focusStyle={quietFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={{ ...captionTextStyle, color: C.danger }}>
                      {tr('Remove token')}
                    </Text>
                  </Button>
                </If>
                <Button
                  disabled={!tokenDraft().trim() || tokenSaving()}
                  onPress={() => void saveToken()}
                  style={{
                    ...controlStyle,
                    minHeight: 28,
                    height: 28,
                    paddingHorizontal: 10,
                    backgroundColor: C.accent,
                  }}
                  hoverStyle={{ opacity: 0.9 }}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: C.chrome,
                      fontWeight: '500',
                    }}
                  >
                    {tr('Save token')}
                  </Text>
                </Button>
              </View>
            </Popover>
          </View>

          {/* Active PR Metadata & Submit Review Card */}
          <If when={prDetail() !== null}>
            <View
              style={{
                borderRadius: 8,
                backgroundColor: C.card,
                padding: 10,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: C.cardRaised,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      lineHeight: 14,
                      fontWeight: '500',
                      color: prDetail()!.merged
                        ? C.accent
                        : prDetail()!.state === 'open'
                          ? prDetail()!.draft
                            ? C.muted
                            : C.success
                          : C.danger,
                    }}
                  >
                    {prDetail()!.merged
                      ? tr('Merged')
                      : prDetail()!.draft
                        ? tr('Draft')
                        : prDetail()!.state === 'open'
                          ? tr('Open')
                          : tr('Closed')}
                  </Text>
                </View>
                <Text
                  style={[
                    {
                      ...captionTextStyle,
                      flex: 1,
                      color: C.text,
                      fontWeight: '500',
                    },
                    { numberOfLines: 1 },
                  ]}
                >
                  {prDetail()!.title}
                </Text>
                <Text style={{ ...captionTextStyle, fontSize: 12, color: C.muted }}>
                  @{prDetail()!.author}
                </Text>
              </View>

              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <Text
                  style={[
                    { ...codeTextStyle, fontSize: 11, color: C.secondary },
                    { numberOfLines: 1 },
                  ]}
                >
                  {prDetail()!.baseRef} ← {prDetail()!.headRef}
                </Text>
                <Text
                  style={{
                    ...captionTextStyle,
                    fontSize: 12,
                    color: C.success,
                  }}
                >
                  +{prDetail()!.additions}
                </Text>
                <Text style={{ ...captionTextStyle, fontSize: 12, color: C.danger }}>
                  −{prDetail()!.deletions}
                </Text>
                <If when={prDetail()!.threads.length > 0}>
                  <Text
                    style={{
                      ...captionTextStyle,
                      fontSize: 12,
                      color: C.muted,
                    }}
                  >
                    {tr('{count} threads', {
                      count: prDetail()!.threads.length,
                    })}
                  </Text>
                </If>
                <If when={props.reviewStore !== undefined && activeRows().length > 0}>
                  <Text
                    style={{
                      ...captionTextStyle,
                      fontSize: 12,
                      color: C.muted,
                    }}
                  >
                    {tr('{viewed} / {total} viewed', {
                      viewed: viewedCount(),
                      total: activeRows().length,
                    })}
                  </Text>
                </If>
                <View style={{ flex: 1 }} />

                <Popover
                  open={reviewPopoverOpen()}
                  onOpenChange={({ open }) => {
                    reviewPopoverOpen.set(open);
                    if (!open) reviewFeedback.set(null);
                  }}
                  placement="bottom"
                  align="end"
                  offset={6}
                  margin={8}
                  popupStyle={{
                    ...floatingStyle(),
                    width: 340,
                    padding: 10,
                    gap: 8,
                  }}
                  trigger={
                    <Button
                      accessibilityLabel={tr('Submit review')}
                      style={{
                        ...controlStyle,
                        minHeight: 28,
                        height: 28,
                        paddingHorizontal: 10,
                        borderRadius: 6,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        backgroundColor: pendingPrComments().length > 0 ? C.accent : C.cardRaised,
                      }}
                      hoverStyle={
                        pendingPrComments().length > 0 ? { opacity: 0.9 } : controlHoverStyle()
                      }
                      focusStyle={controlFocusStyle()}
                    >
                      <Text
                        style={{
                          ...captionTextStyle,
                          fontSize: 12,
                          fontWeight: '500',
                          color: pendingPrComments().length > 0 ? C.chrome : C.text,
                        }}
                      >
                        {pendingPrComments().length > 0
                          ? tr('Submit review ({count})', {
                              count: pendingPrComments().length,
                            })
                          : tr('Submit review')}
                      </Text>
                    </Button>
                  }
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Text
                      style={{
                        ...captionTextStyle,
                        flex: 1,
                        color: C.text,
                        fontWeight: '500',
                      }}
                    >
                      PR #{prDetail()!.number}
                    </Text>
                    <Text style={{ ...codeTextStyle, fontSize: 11, color: C.muted }}>
                      {formatHeadLabel(prDetail()!.headSha)}
                    </Text>
                  </View>
                  <If when={pendingPrComments().length > 0}>
                    <Text
                      style={{
                        ...captionTextStyle,
                        fontSize: 12,
                        color: C.accent,
                      }}
                    >
                      {pendingPrComments().length === 1
                        ? tr('1 pending inline comment will be published.')
                        : tr('{count} pending inline comments will be published.', {
                            count: pendingPrComments().length,
                          })}
                    </Text>
                  </If>
                  <Input
                    multiline
                    value={reviewBody()}
                    onChange={({ value }) => reviewBody.set(value)}
                    submitBehavior="newline"
                    placeholder={tr('Leave a review summary…')}
                    accessibilityLabel={tr('Leave a review summary…')}
                    style={{
                      ...bodyTextStyle,
                      minHeight: 68,
                      maxHeight: 160,
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: C.line,
                      backgroundColor: C.card,
                      color: C.text,
                    }}
                  />
                  <View style={{ gap: 2 }}>
                    <Each of={['comment', 'approve', 'request_changes'] as const} key={(e) => e}>
                      {(ev) => (
                        <Button
                          onPress={() => reviewEvent.set(ev())}
                          style={{
                            ...menuRowStyle(),
                            minHeight: 28,
                            paddingVertical: 4,
                          }}
                          hoverStyle={menuRowHoverStyle()}
                          focusStyle={menuRowHoverStyle()}
                        >
                          <ChoiceIndicator kind="radio" checked={reviewEvent() === ev()} />
                          <Text style={{ ...captionTextStyle, color: C.text }}>
                            {ev() === 'comment'
                              ? tr('Comment')
                              : ev() === 'approve'
                                ? tr('Approve')
                                : tr('Request changes')}
                          </Text>
                        </Button>
                      )}
                    </Each>
                  </View>

                  <If when={reviewFeedback() !== null}>
                    <Text
                      style={{
                        ...captionTextStyle,
                        color:
                          reviewFeedback()!.tone === 'error'
                            ? C.danger
                            : reviewFeedback()!.tone === 'warning'
                              ? C.warning
                              : C.success,
                      }}
                    >
                      {reviewFeedback()!.text}
                    </Text>
                  </If>

                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'flex-end',
                      gap: 6,
                    }}
                  >
                    <Button
                      disabled={reviewSubmitting()}
                      onPress={() => reviewPopoverOpen.set(false)}
                      style={{
                        ...controlStyle,
                        minHeight: 28,
                        height: 28,
                        paddingHorizontal: 8,
                      }}
                      hoverStyle={quietHoverStyle()}
                      focusStyle={quietFocusStyle()}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Cancel')}</Text>
                    </Button>
                    <Button
                      disabled={reviewSubmitting()}
                      onPress={() => void submitPrReview()}
                      style={{
                        ...controlStyle,
                        minHeight: 28,
                        height: 28,
                        paddingHorizontal: 10,
                        backgroundColor: C.accent,
                      }}
                      hoverStyle={{ opacity: 0.9 }}
                      focusStyle={controlFocusStyle()}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Text
                        style={{
                          ...captionTextStyle,
                          color: C.chrome,
                          fontWeight: '500',
                        }}
                      >
                        {reviewSubmitting() ? tr('Submitting…') : tr('Submit review')}
                      </Text>
                    </Button>
                  </View>
                </Popover>
              </View>
            </View>
          </If>
        </View>
      </If>

      {/* Review-All Toolbar */}
      <If when={mode() === 'review-all' && activeCombinedDiff().diff !== null}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <Text style={{ ...captionTextStyle, color: C.success }}>+{stats().added}</Text>
          <Text style={{ ...captionTextStyle, color: C.danger }}>−{stats().deleted}</Text>
          <View style={{ flex: 1 }} />
          <View
            role="tablist"
            style={{
              flexDirection: 'row',
              backgroundColor: C.card,
              padding: 2,
              borderRadius: 6,
              gap: 2,
            }}
          >
            <Button
              role="tab"
              selected={layout() === 'split'}
              onPress={() => layout.set('split')}
              style={{
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 4,
                justifyContent: 'center',
                backgroundColor: layout() === 'split' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  fontSize: 12,
                  color: layout() === 'split' ? C.text : C.secondary,
                }}
              >
                {tr('Split')}
              </Text>
            </Button>
            <Button
              role="tab"
              selected={layout() === 'unified'}
              onPress={() => layout.set('unified')}
              style={{
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 4,
                justifyContent: 'center',
                backgroundColor: layout() === 'unified' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  fontSize: 12,
                  color: layout() === 'unified' ? C.text : C.secondary,
                }}
              >
                {tr('Unified')}
              </Text>
            </Button>
          </View>
          <Button
            accessibilityLabel={tr('Previous change')}
            tooltip={textTooltip(() => tr('Previous change'))}
            disabled={stats().hunks === 0}
            onPress={() => diffRef?.previousHunk()}
            style={{
              ...controlStyle,
              width: 24,
              minHeight: 24,
              paddingHorizontal: 4,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="up" size={13} color={C.secondary} />
          </Button>
          <Button
            accessibilityLabel={tr('Next change')}
            tooltip={textTooltip(() => tr('Next change'))}
            disabled={stats().hunks === 0}
            onPress={() => diffRef?.nextHunk()}
            style={{
              ...controlStyle,
              width: 24,
              minHeight: 24,
              paddingHorizontal: 4,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="down" size={13} color={C.secondary} />
          </Button>
          <Button
            accessibilityLabel={tr('Wrap lines')}
            tooltip={textTooltip(() => tr('Wrap lines'))}
            selected={softWrap()}
            onPress={() => softWrap.set(!softWrap())}
            style={{
              ...controlStyle,
              width: 24,
              minHeight: 24,
              paddingHorizontal: 4,
              alignItems: 'center',
              backgroundColor: softWrap() ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name={softWrap() ? 'wrap' : 'nowrap'} size={13} color={C.secondary} />
          </Button>
        </View>
      </If>

      {/* Status / Error / Empty States per Source */}
      <If when={workingState().kind === 'loading'}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading current changes…')}</Text>
      </If>

      <If when={workingState().kind === 'error'}>
        <View
          style={{
            flex: 1,
            minHeight: 0,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Text
            style={[
              { ...bodyTextStyle, color: C.secondary, textAlign: 'center' },
              { userSelect: 'text' },
            ]}
          >
            {workingState().kind === 'error'
              ? renderText((workingState() as Extract<WorkingState, { kind: 'error' }>).message)
              : ''}
          </Text>
          <Button
            onPress={inputAction(refreshAll, props.sessionId)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.accent }}>
              {tr('Retry current changes')}
            </Text>
          </Button>
        </View>
      </If>

      <If when={workingState().kind === 'ready' && status() === null}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Not a Git workspace.')}</Text>
      </If>

      {/* Main Content Area when Workspace is a Valid Git Repo */}
      <If when={workingState().kind === 'ready' && status() !== null}>
        <If
          when={
            (sourceTab() === 'branch' || sourceTab() === 'commit') &&
            compareState().kind === 'loading' &&
            mode() === 'list'
          }
        >
          <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading current diff…')}</Text>
        </If>

        <If
          when={
            (sourceTab() === 'branch' || sourceTab() === 'commit') &&
            compareState().kind === 'error'
          }
        >
          <Text style={{ ...bodyTextStyle, color: C.danger }}>
            {compareState().kind === 'error'
              ? renderText((compareState() as Extract<CompareState, { kind: 'error' }>).message)
              : ''}
          </Text>
        </If>

        <If when={sourceTab() === 'pr'}>
          <If
            when={
              prListState().kind === 'loading' ||
              (selectedPrNumber() !== null &&
                prDetailState().kind === 'loading' &&
                mode() === 'list')
            }
          >
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {tr('Loading GitHub pull requests…')}
            </Text>
          </If>
          <If
            when={
              prListState().kind === 'ready' &&
              (prListState() as Extract<PrListState, { kind: 'ready' }>).result.kind === 'no_remote'
            }
          >
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {tr('No GitHub remote found in this repository.')}
            </Text>
          </If>
          <If
            when={
              (prListState().kind === 'ready' &&
                ((prListState() as Extract<PrListState, { kind: 'ready' }>).result.kind ===
                  'unauthorized' ||
                  (prListState() as Extract<PrListState, { kind: 'ready' }>).result.kind ===
                    'error')) ||
              (prDetailState().kind === 'ready' &&
                (prDetailState() as Extract<PrDetailState, { kind: 'ready' }>).result.kind !==
                  'ready')
            }
          >
            <View
              style={{
                padding: 10,
                borderRadius: 8,
                backgroundColor: C.card,
                gap: 6,
              }}
            >
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                {(() => {
                  const d = prDetailState();
                  if (d.kind === 'ready' && d.result.kind !== 'ready') {
                    if (d.result.kind === 'not_found')
                      return tr('Pull request #{number} was not found.', {
                        number: d.result.number,
                      });
                    return d.result.message;
                  }
                  const l = prListState();
                  if (
                    l.kind === 'ready' &&
                    (l.result.kind === 'unauthorized' || l.result.kind === 'error')
                  ) {
                    return l.result.message;
                  }
                  return '';
                })()}
              </Text>
              <Button
                onPress={() => tokenPopoverOpen.set(true)}
                style={{
                  ...controlStyle,
                  alignSelf: 'flex-start',
                  minHeight: 28,
                  height: 28,
                  paddingHorizontal: 10,
                  backgroundColor: C.cardRaised,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ ...captionTextStyle, color: C.accent }}>
                  {tr('Configure GitHub token')}
                </Text>
              </Button>
            </View>
          </If>
        </If>

        {/* File List Mode */}
        <If
          when={
            mode() === 'list' &&
            !(
              (sourceTab() === 'branch' || sourceTab() === 'commit') &&
              compareState().kind === 'loading'
            ) &&
            !(
              sourceTab() === 'pr' &&
              (prListState().kind === 'loading' ||
                (selectedPrNumber() !== null && prDetailState().kind === 'loading') ||
                (prListState().kind === 'ready' &&
                  (prListState() as Extract<PrListState, { kind: 'ready' }>).result.kind !==
                    'ready'))
            )
          }
        >
          <List
            accessibilityLabel={tr('Current workspace changes')}
            each={activeRows()}
            keyExtractor={(row: UnifiedRow) => row.id}
            estimatedItemSize={44}
            style={{ flex: 1, minHeight: 0 }}
            empty={
              <Text style={{ ...bodyTextStyle, color: C.muted }}>
                {sourceTab() === 'pr'
                  ? selectedPrNumber() === null
                    ? tr('No open pull requests.')
                    : tr('No changed files in this pull request.')
                  : tr('No current changes.')}
              </Text>
            }
          >
            {(row) => {
              const isRowViewed = () =>
                Boolean(
                  props.reviewStore?.isViewed(
                    props.sessionId,
                    row().sourceKey,
                    row().pathKey,
                    row().digest,
                  ),
                );
              return (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 4,
                    borderRadius: 8,
                    backgroundColor: C.card,
                    paddingHorizontal: 6,
                    paddingVertical: 4,
                    gap: 4,
                  }}
                >
                  <If when={props.reviewStore !== undefined}>
                    <Button
                      accessibilityLabel={tr('Mark file as viewed')}
                      tooltip={textTooltip(() => tr('Viewed'))}
                      selected={isRowViewed()}
                      onPress={() =>
                        props.reviewStore?.toggleViewed(
                          props.sessionId,
                          row().sourceKey,
                          row().pathKey,
                          row().digest,
                        )
                      }
                      style={{
                        ...controlStyle,
                        width: 26,
                        minHeight: 26,
                        paddingHorizontal: 4,
                        paddingVertical: 4,
                        borderRadius: 6,
                        alignItems: 'center',
                      }}
                      hoverStyle={quietHoverStyle()}
                      focusStyle={quietFocusStyle()}
                    >
                      <ChoiceIndicator kind="checkbox" checked={isRowViewed()} />
                    </Button>
                  </If>

                  <Button
                    accessibilityLabel={row().pathLabel}
                    onPress={() => syncQueueAndOpen(row().target)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      paddingVertical: 2,
                      paddingHorizontal: 4,
                      borderRadius: 6,
                      gap: 2,
                      opacity: isRowViewed() ? 0.65 : 1,
                    }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <Text
                        style={[
                          {
                            ...codeTextStyle,
                            flex: 1,
                            minWidth: 0,
                            color: C.text,
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {row().pathLabel}
                      </Text>
                      <If when={row().pendingCount > 0}>
                        <View
                          style={{
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                            borderRadius: 4,
                            backgroundColor: C.accent,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 11,
                              lineHeight: 14,
                              color: C.chrome,
                            }}
                          >
                            +{row().pendingCount}
                          </Text>
                        </View>
                      </If>
                      <If when={row().threadCount > 0}>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 3,
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                            borderRadius: 4,
                            backgroundColor: C.cardRaised,
                          }}
                        >
                          <Icon name="conversation" size={11} color={C.secondary} />
                          <Text
                            style={{
                              fontSize: 11,
                              lineHeight: 14,
                              color: C.secondary,
                            }}
                          >
                            {row().threadCount}
                          </Text>
                        </View>
                      </If>
                    </View>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <Text
                        style={{
                          ...captionTextStyle,
                          fontSize: 12,
                          color: row().kindColor,
                        }}
                      >
                        {row().kindText}
                      </Text>
                      <If when={row().secondaryLabel.length > 0}>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 12,
                            color: C.muted,
                          }}
                        >
                          {row().secondaryLabel}
                        </Text>
                      </If>
                      <If when={row().additions !== undefined || row().deletions !== undefined}>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 12,
                            color: C.success,
                          }}
                        >
                          +{row().additions ?? 0}
                        </Text>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 12,
                            color: C.danger,
                          }}
                        >
                          −{row().deletions ?? 0}
                        </Text>
                      </If>
                    </View>
                  </Button>
                </View>
              );
            }}
          </List>
        </If>

        {/* Review All Multi-File Unified Diff Mode */}
        <If when={mode() === 'review-all'}>
          <If when={activeCombinedDiff().loading}>
            <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading current diff…')}</Text>
          </If>
          <If when={activeCombinedDiff().error.length > 0}>
            <Text style={{ ...bodyTextStyle, color: C.danger }}>{activeCombinedDiff().error}</Text>
          </If>
          <If
            when={
              !activeCombinedDiff().loading &&
              activeCombinedDiff().error.length === 0 &&
              (!activeCombinedDiff().diff || activeCombinedDiff().diff!.patch.trim().length === 0)
            }
          >
            <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('No current changes.')}</Text>
          </If>
          <If
            when={
              !activeCombinedDiff().loading &&
              Boolean(activeCombinedDiff().diff?.patch.trim().length)
            }
          >
            <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
              <If
                when={Boolean(
                  activeCombinedDiff().diff &&
                    (activeCombinedDiff().diff!.truncated ||
                      activeCombinedDiff().diff!.skippedFiles > 0),
                )}
              >
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {activeCombinedDiff().diff?.truncated
                    ? tr('Diff truncated; {count} binary or large files omitted.', {
                        count: activeCombinedDiff().diff!.skippedFiles,
                      })
                    : tr('{count} non-text files omitted.', {
                        count: activeCombinedDiff().diff?.skippedFiles ?? 0,
                      })}
                </Text>
              </If>
              <View
                style={{
                  flex: 1,
                  minHeight: 0,
                  borderRadius: 8,
                  overflow: 'hidden',
                  backgroundColor: C.card,
                }}
              >
                <DiffView
                  ref={(node) => {
                    diffRef = node;
                  }}
                  patch={activeCombinedDiff().diff?.patch ?? ''}
                  layout={layout()}
                  inline="wordAlt"
                  indicators="bars"
                  lineNumbers
                  softWrap={softWrap()}
                  fontSize={codeTextStyle.fontSize}
                  lineHeight={codeTextStyle.lineHeight}
                  onStatsChange={({ stats: next }) => stats.set(next)}
                  renderFileHeader={(file: DiffFile) => (
                    <View
                      style={{
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        paddingHorizontal: 8,
                      }}
                    >
                      <Button
                        accessibilityLabel={tr('Annotate {path}', {
                          path: file.path,
                        })}
                        onPress={() => {
                          if (file.path) openDiffByPathLabel(file.path);
                        }}
                        style={{
                          flex: 1,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingVertical: 4,
                          paddingHorizontal: 6,
                          borderRadius: 4,
                        }}
                        hoverStyle={controlHoverStyle()}
                        focusStyle={controlFocusStyle()}
                      >
                        <Icon name="code" size={13} color={C.secondary} />
                        <Text
                          style={[
                            {
                              ...codeTextStyle,
                              fontSize: 12,
                              flex: 1,
                              color: C.text,
                              fontWeight: '500',
                            },
                            { numberOfLines: 1 },
                          ]}
                        >
                          {file.path}
                        </Text>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 12,
                            color: C.success,
                          }}
                        >
                          +{file.added}
                        </Text>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 12,
                            color: C.danger,
                          }}
                        >
                          −{file.deleted}
                        </Text>
                        <Text
                          style={{
                            ...captionTextStyle,
                            fontSize: 11,
                            color: C.accent,
                          }}
                        >
                          {tr('Annotate')}
                        </Text>
                      </Button>
                    </View>
                  )}
                  style={{ flex: 1, minHeight: 0 }}
                />
              </View>
            </View>
          </If>
        </If>
      </If>
    </View>
  );
}
