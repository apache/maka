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
import { cleanup, effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, Popover } from 'nsh/base';
import type { AgentSession } from '../../../../packages/plugin-sdk/src/index.js';
import type {
  WorkspacePullRequestTarget,
  WorkspaceSourceItem,
} from '../../../../packages/plugin-sdk/src/workspace-view.js';
import { type AnswerSource, AnswerSourceList } from './AnswerSources';
import { useHost } from './host';
import { Icon } from './Icon';
import { tr } from './locale';
import { createText, errorText } from './text';
import {
  basenameLabel,
  type GitHubPullSummary,
  type GitHubRepoRef,
  type GitRevisions,
  type GitWorktreeEntry,
} from './reviewState';
import {
  C,
  captionTextStyle,
  controlStyle,
  floatingShadow,
  floatingStyle,
  lineWidth,
  menuRowHoverStyle,
  menuRowStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  radius,
  textTooltip,
} from './ui';
import { compactHomePath, WorktreePicker } from './WorktreePicker';

function countPatchLines(patch: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
  }
  return { added, deleted };
}

export function SessionInspector(props: {
  sessionId: string;
  workspacePath?: string;
  floating: boolean;
  activeWorktree?(): string | null;
  selectWorktree?(worktreePath: string | null): void;
  sources?(): readonly WorkspaceSourceItem[];
  answerSources(): readonly AnswerSource[];
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  childSessions(): readonly AgentSession[];
  openChanges?(worktreePath?: string | null): void;
  openFiles?(): void;
  openLaunchpad?(): void;
  openPullRequest?(target: Omit<WorkspacePullRequestTarget, 'sessionId'>): void;
  openChildSession?(sessionId: string): void;
}) {
  const host = useHost();
  const revisions = signal<GitRevisions | null>(null);
  const diffStats = signal<{ files: number; added: number; deleted: number } | null>(null);
  const changesError = createText();
  const repositoryError = createText();
  const pulls = signal<GitHubPullSummary[]>([]);
  const githubRepo = signal<GitHubRepoRef | null>(null);
  const repoMenuOpen = signal(false);
  const subagentsExpanded = signal(false);
  const scrollY = signal(0);
  const viewportHeight = signal(0);
  const contentHeight = signal(0);
  let alive = true;
  let loadSeq = 0;
  cleanup(() => {
    alive = false;
    loadSeq += 1;
  });

  const selectedWorktree = () => props.activeWorktree?.() ?? null;
  const effectivePath = () => selectedWorktree() ?? props.workspacePath ?? '';

  const refreshGit = async () => {
    const seq = ++loadSeq;
    changesError.set('');
    repositoryError.set('');
    if (!props.workspacePath) {
      revisions.set(null);
      diffStats.set(null);
      pulls.set([]);
      githubRepo.set(null);
      return;
    }
    const wt = selectedWorktree();
    const input = { sessionId: props.sessionId, ...(wt ? { worktreePath: wt } : {}) };
    const current = () => alive && seq === loadSeq;

    const loadChanges = async () => {
      const [st, wsDiff] = await Promise.all([
        host.query('agent', 'gitStatus', input),
        host.query('agent', 'gitWorkspaceDiff', input),
      ]);
      if (!current()) return;
      if (wsDiff || st) {
        const counts = wsDiff ? countPatchLines(wsDiff.patch) : { added: 0, deleted: 0 };
        diffStats.set({
          files: st?.entries.length ?? 0,
          added: counts.added,
          deleted: counts.deleted,
        });
      } else {
        diffStats.set(null);
      }
    };

    const loadRepository = async () => {
      const rev = await host.query('agent', 'gitRevisions', input).catch((reason) => {
        if (current()) repositoryError.set(errorText(reason, 'Workspace is unavailable'));
        return null;
      });
      if (!current()) return;
      revisions.set(rev);
      const ghRemote =
        rev?.remotes.find((r) => r.host.toLowerCase() === 'github.com' && r.remote === 'origin') ??
        rev?.remotes.find((r) => r.host.toLowerCase() === 'github.com');
      if (ghRemote) {
        const repoRef: GitHubRepoRef = {
          host: ghRemote.host,
          owner: ghRemote.owner,
          repo: ghRemote.repo,
        };
        githubRepo.set(repoRef);
        const prRes = await host.query('agent', 'githubPullRequests', {
          sessionId: input.sessionId,
          repo: repoRef,
          state: 'open',
        });
        if (!current()) return;
        if (prRes.kind === 'ready') {
          const headBranch = rev?.headBranch ?? null;
          const sorted = [...prRes.pulls].sort((a, b) => {
            const aMatch = headBranch !== null && a.headRef === headBranch ? 0 : 1;
            const bMatch = headBranch !== null && b.headRef === headBranch ? 0 : 1;
            return aMatch - bMatch;
          });
          pulls.set(sorted.slice(0, 5));
        } else {
          pulls.set([]);
        }
      } else {
        githubRepo.set(null);
        pulls.set([]);
      }
    };

    await Promise.all([
      loadRepository().catch((reason) => {
        if (!current()) return;
        pulls.set([]);
        repositoryError.set(errorText(reason, 'Could not load GitHub pull requests.'));
      }),
      loadChanges().catch((reason) => {
        if (!current()) return;
        diffStats.set(null);
        changesError.set(errorText(reason, 'Could not read file changes.'));
      }),
    ]);
  };

  effect(() => {
    void props.workspacePath;
    void selectedWorktree();
    untracked(() => {
      void refreshGit();
    });
  });

  const worktrees = (): readonly GitWorktreeEntry[] => revisions()?.worktrees ?? [];
  const currentWorktreeEntry = () => {
    const list = worktrees();
    const sel = selectedWorktree();
    if (sel) return list.find((w) => w.path === sel) ?? list.find((w) => w.isCurrent) ?? null;
    return list.find((w) => w.isCurrent) ?? list[0] ?? null;
  };
  const repoLabel = () => {
    const gh = githubRepo();
    if (gh) return gh.repo;
    const mainWt = worktrees().find((w) => w.isMain);
    if (mainWt) return mainWt.name;
    return basenameLabel(effectivePath()) || tr('Files');
  };
  const children = () => {
    const raw = props.childSessions();
    return [...raw].sort((a, b) => {
      const aRun = a.activity !== 'idle' ? 0 : 1;
      const bRun = b.activity !== 'idle' ? 0 : 1;
      return aRun - bRun;
    });
  };
  const visibleChildren = () => (subagentsExpanded() ? children() : children().slice(0, 6));
  const runningChildren = () => children().filter((item) => item.activity !== 'idle').length;
  const openSources = () => props.sources?.() ?? [];

  const showScrollbar = () => viewportHeight() > 48 && contentHeight() > viewportHeight() + 2;
  const thumbMetrics = () => {
    const vh = viewportHeight();
    const ch = contentHeight();
    const track = Math.max(16, vh - 12);
    const height = Math.max(24, Math.round((vh / Math.max(1, ch)) * track));
    const maxScroll = Math.max(1, ch - vh);
    const ratio = Math.max(0, Math.min(1, scrollY() / maxScroll));
    const top = 6 + Math.round(ratio * Math.max(0, track - height));
    return { top, height };
  };

  const sectionTitleStyle = {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500' as const,
    color: C.muted,
  };
  const divider = () => (
    <View style={{ height: 1, backgroundColor: C.line, marginHorizontal: 12 }} />
  );

  return (
    <View
      accessibilityLabel={tr('Session details')}
      onLayout={({ bounds }) => viewportHeight.set(bounds.size.height)}
      style={{
        position: 'relative',
        width: 272,
        maxHeight: '100%',
        flexShrink: 1,
        minHeight: 0,
        marginTop: props.floating ? 4 : 8,
        marginBottom: 12,
        marginRight: 12,
        borderRadius: radius(12),
        backgroundColor: props.floating ? C.floating : C.card,
        ...(props.floating
          ? {
              borderWidth: lineWidth(),
              borderColor: C.line,
              boxShadow: floatingShadow(`0 8px 24px ${C.shadow}`),
            }
          : {}),
        overflow: 'hidden',
      }}
    >
      <Scroll
        onScroll={({ offset }) => scrollY.set(offset.y)}
        style={{ flexShrink: 1, minHeight: 0 }}
      >
        <View
          onLayout={({ bounds }) => contentHeight.set(bounds.size.height)}
          style={{ paddingVertical: 4 }}
        >
          <If when={props.answerSources().length > 0}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
              <Text style={sectionTitleStyle}>{tr('Answer sources')}</Text>
              <AnswerSourceList sources={props.answerSources} openLink={props.openLink} />
            </View>
            {divider()}
          </If>
          {/* 1. Worktree reference & switcher */}
          <If when={Boolean(effectivePath())}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ ...sectionTitleStyle, flex: 1 }}>{tr('Worktree reference')}</Text>
                <Button
                  accessibilityLabel={tr('Refresh')}
                  tooltip={textTooltip(() => tr('Refresh'))}
                  onPress={() => void refreshGit()}
                  style={{
                    ...controlStyle(),
                    width: 24,
                    minHeight: 24,
                    height: 24,
                    paddingHorizontal: 0,
                    paddingVertical: 0,
                    alignItems: 'center',
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="refresh" size={12} color={C.muted} />
                </Button>
              </View>
              <If when={Boolean(repositoryError())}>
                <Text style={captionTextStyle}>{repositoryError()}</Text>
              </If>
              <If
                when={worktrees().length > 1 && props.selectWorktree !== undefined}
                else={
                  <View style={{ gap: 4, minWidth: 0 }}>
                    <Text
                      tooltip={textTooltip(() => effectivePath())}
                      style={[
                        { fontSize: 12, lineHeight: 16, color: C.text, minWidth: 0 },
                        { numberOfLines: 1, userSelect: 'text' },
                      ]}
                    >
                      {compactHomePath(effectivePath())}
                    </Text>
                    <Text
                      style={[
                        { fontSize: 12, lineHeight: 16, color: C.muted, minWidth: 0 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {currentWorktreeEntry()?.isMain === false
                        ? tr('Linked checkout')
                        : tr('Main checkout')}
                      {revisions()?.headBranch ? ` · ${revisions()!.headBranch}` : ''}
                    </Text>
                  </View>
                }
              >
                <WorktreePicker
                  variant="card"
                  align="end"
                  worktrees={worktrees}
                  activeWorktree={selectedWorktree}
                  activeBranch={() => revisions()?.headBranch}
                  onSelect={(path) => props.selectWorktree?.(path)}
                />
                <Text
                  tooltip={textTooltip(() => effectivePath())}
                  style={[
                    { fontSize: 12, lineHeight: 16, color: C.muted, minWidth: 0 },
                    { numberOfLines: 1, userSelect: 'text' },
                  ]}
                >
                  {compactHomePath(effectivePath())}
                </Text>
              </If>
            </View>
            {divider()}
          </If>

          {/* 2. Repository & Changes */}
          <If when={Boolean(effectivePath()) && props.openChanges !== undefined}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <Text style={{ ...sectionTitleStyle, flex: 1 }}>{repoLabel()}</Text>
                <Popover
                  open={repoMenuOpen()}
                  onOpenChange={({ open }) => repoMenuOpen.set(open)}
                  placement="bottom"
                  align="end"
                  offset={4}
                  margin={8}
                  popupStyle={{ ...floatingStyle(), width: 184 }}
                  trigger={
                    <Button
                      accessibilityLabel={tr('More')}
                      style={{
                        ...controlStyle(),
                        width: 24,
                        minHeight: 24,
                        height: 24,
                        paddingHorizontal: 0,
                        paddingVertical: 0,
                        alignItems: 'center',
                      }}
                      hoverStyle={{ backgroundColor: C.cardRaised }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon name="more" size={14} color={C.muted} />
                    </Button>
                  }
                >
                  <View style={{ gap: 2 }}>
                    <If when={props.openFiles !== undefined}>
                      <Button
                        accessibilityLabel={tr('Browse files')}
                        onPress={() => {
                          repoMenuOpen.set(false);
                          props.openFiles?.();
                        }}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={quietFocusStyle()}
                      >
                        <Icon name="folder" size={14} color={C.muted} />
                        <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Files')}</Text>
                      </Button>
                    </If>
                    <If when={props.openLaunchpad !== undefined}>
                      <Button
                        accessibilityLabel={tr('New tab')}
                        onPress={() => {
                          repoMenuOpen.set(false);
                          props.openLaunchpad?.();
                        }}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={quietFocusStyle()}
                      >
                        <Icon name="globe" size={14} color={C.muted} />
                        <Text style={{ ...captionTextStyle, color: C.text }}>{tr('New tab')}</Text>
                      </Button>
                    </If>
                  </View>
                </Popover>
              </View>

              <Button
                accessibilityLabel={tr('Review workspace changes')}
                onPress={() => props.openChanges?.(selectedWorktree())}
                style={{
                  minHeight: 32,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  marginHorizontal: -8,
                  borderRadius: radius(8),
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
                hoverStyle={{ backgroundColor: C.cardRaised }}
                activeStyle={quietActiveStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="diff" size={14} color={C.muted} />
                <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>{tr('Changes')}</Text>
                <If
                  when={
                    diffStats() !== null && (diffStats()!.added > 0 || diffStats()!.deleted > 0)
                  }
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text
                      style={{ fontSize: 12, lineHeight: 16, color: C.success, fontWeight: '500' }}
                    >
                      {`+${formatCount(diffStats()!.added)}`}
                    </Text>
                    <Text
                      style={{ fontSize: 12, lineHeight: 16, color: C.danger, fontWeight: '500' }}
                    >
                      {`-${formatCount(diffStats()!.deleted)}`}
                    </Text>
                  </View>
                </If>
                <If
                  when={
                    diffStats() !== null &&
                    diffStats()!.added === 0 &&
                    diffStats()!.deleted === 0 &&
                    diffStats()!.files > 0
                  }
                >
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                    {tr('{count} files', { count: diffStats()!.files })}
                  </Text>
                </If>
              </Button>
              <If when={Boolean(changesError())}>
                <Text style={captionTextStyle}>{changesError()}</Text>
              </If>
            </View>
            {divider()}
          </If>

          {/* 3. Pull requests */}
          <If when={githubRepo() !== null && props.openPullRequest !== undefined}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
              <Text style={{ ...sectionTitleStyle, marginBottom: 4 }}>{tr('Pull requests')}</Text>
              <If
                when={pulls().length > 0}
                else={
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                    {tr('No open pull requests.')}
                  </Text>
                }
              >
                <Each of={pulls()} key={(pr) => pr.number}>
                  {(pr) => (
                    <Button
                      accessibilityLabel={`${pr().title} #${pr().number}`}
                      tooltip={textTooltip(() => `#${pr().number} · ${pr().title}`)}
                      onPress={() =>
                        props.openPullRequest?.({
                          ...(githubRepo() ? { repo: githubRepo()! } : {}),
                          number: pr().number,
                          title: pr().title,
                        })
                      }
                      style={{
                        minHeight: 32,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        marginHorizontal: -8,
                        borderRadius: radius(8),
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                      hoverStyle={{ backgroundColor: C.cardRaised }}
                      activeStyle={quietActiveStyle()}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon
                        name="pullRequest"
                        size={14}
                        color={
                          pr().draft ? C.muted : pr().state === 'closed' ? C.accentText : C.success
                        }
                      />
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {pr().title}
                      </Text>
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {`#${pr().number}`}
                      </Text>
                    </Button>
                  )}
                </Each>
              </If>
            </View>
            {divider()}
          </If>

          {/* 4. Subagents */}
          <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
              }}
            >
              <Text style={{ ...sectionTitleStyle, flex: 1 }}>{tr('Subagents')}</Text>
              <If when={children().length > 6 && subagentsExpanded()}>
                <Button
                  accessibilityLabel={tr('Show fewer project conversations')}
                  onPress={() => subagentsExpanded.set(false)}
                  style={{
                    minHeight: 20,
                    height: 20,
                    paddingHorizontal: 6,
                    borderRadius: radius(4),
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 2,
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                >
                  <Text style={{ fontSize: 11, lineHeight: 16, color: C.muted }}>
                    {tr('Show fewer project conversations')}
                  </Text>
                  <Icon name="up" size={11} color={C.muted} />
                </Button>
              </If>
              <If when={children().length > 0}>
                <Text
                  style={{
                    fontSize: 12,
                    lineHeight: 16,
                    color: runningChildren() > 0 ? C.accentText : C.muted,
                  }}
                >
                  {runningChildren() > 0
                    ? tr('{count} running', { count: runningChildren() })
                    : tr('{count} completed', { count: children().length })}
                </Text>
              </If>
            </View>
            <If
              when={children().length > 0}
              else={
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                  {tr('No subagents')}
                </Text>
              }
            >
              <Each of={visibleChildren()} key={(child) => child.id}>
                {(child) => (
                  <Button
                    accessibilityLabel={child().title || tr('Untitled conversation')}
                    onPress={() => props.openChildSession?.(child().id)}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      marginHorizontal: -8,
                      borderRadius: radius(8),
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    activeStyle={quietActiveStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon
                      name={child().activity !== 'idle' ? 'statusRecorded' : 'statusSuccess'}
                      size={14}
                      color={child().activity !== 'idle' ? C.accentText : C.success}
                    />
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {child().title || tr('Untitled conversation')}
                    </Text>
                  </Button>
                )}
              </Each>
              <If when={children().length > 6 && !subagentsExpanded()}>
                <Button
                  accessibilityLabel={tr('Show all ({count})', { count: children().length })}
                  onPress={() => subagentsExpanded.set(true)}
                  style={{
                    minHeight: 28,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    marginHorizontal: -8,
                    borderRadius: radius(8),
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                >
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                    {subagentsExpanded()
                      ? tr('Show fewer project conversations')
                      : tr('Show all ({count})', { count: children().length })}
                  </Text>
                  <Icon name={subagentsExpanded() ? 'up' : 'down'} size={12} color={C.muted} />
                </Button>
              </If>
            </If>
          </View>

          {divider()}

          {/* Open workspace tabs */}
          <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
              }}
            >
              <Text style={{ ...sectionTitleStyle, flex: 1 }}>{tr('Open tabs')}</Text>
              <If when={props.openFiles !== undefined}>
                <Button
                  accessibilityLabel={tr('Browse files')}
                  tooltip={textTooltip(() => tr('Browse files'))}
                  onPress={() => props.openFiles?.()}
                  style={{
                    ...controlStyle(),
                    width: 24,
                    minHeight: 24,
                    height: 24,
                    paddingHorizontal: 0,
                    paddingVertical: 0,
                    alignItems: 'center',
                  }}
                  hoverStyle={quietHoverStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="plus" size={14} color={C.muted} />
                </Button>
              </If>
            </View>
            <If
              when={openSources().length > 0}
              else={
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                  {tr('No open files')}
                </Text>
              }
            >
              <Each of={openSources().slice(0, 6)} key={(item) => item.id}>
                {(item) => (
                  <Button
                    accessibilityLabel={item().title}
                    tooltip={textTooltip(() => item().detail || item().title)}
                    onPress={() => item().select()}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      marginHorizontal: -8,
                      borderRadius: radius(8),
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    activeStyle={quietActiveStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon
                      name={
                        item().kind === 'pr'
                          ? 'pullRequest'
                          : item().kind === 'diff'
                            ? 'diff'
                            : item().kind === 'image'
                              ? 'image'
                              : 'file'
                      }
                      size={14}
                      color={C.muted}
                    />
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {item().title}
                    </Text>
                  </Button>
                )}
              </Each>
            </If>
            <If when={props.openFiles !== undefined}>
              <Button
                accessibilityLabel={tr('View all')}
                onPress={() => props.openFiles?.()}
                style={{
                  minHeight: 28,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  marginHorizontal: -8,
                  borderRadius: radius(8),
                  flexDirection: 'row',
                  alignItems: 'center',
                }}
                hoverStyle={{ backgroundColor: C.cardRaised }}
                focusStyle={quietFocusStyle()}
              >
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                  {tr('View all')}
                </Text>
              </Button>
            </If>
          </View>
        </View>
      </Scroll>
      <If when={showScrollbar()}>
        <View
          style={[
            {
              position: 'absolute',
              right: 2,
              top: thumbMetrics().top,
              width: 3,
              height: thumbMetrics().height,
              borderRadius: 2,
              backgroundColor: `${C.muted}75`,
            },
            { pointerEvents: 'none' },
          ]}
        />
      </If>
    </View>
  );
}
