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

import { cleanup, computed, effect, Scroll, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import type { AgentFileEntry, WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import type { WorkspacePullRequestTarget } from '../../../../packages/plugin-sdk/src/workspace-view.js';
import { useHost } from './host';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  basenameLabel,
  type GitHubPullSummary,
  type GitHubRepoRef,
  type GitRevisions,
  type GitWorktreeEntry,
  parentPathOf,
  type ReviewStore,
} from './reviewState';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  quietActiveStyle,
  quietFocusStyle,
  radius,
  textTooltip,
} from './ui';
import { orderWorktrees } from './WorktreePicker';
import type { WorkspaceFileTarget } from './workspaceFileState';

export function StageLaunchpad(props: {
  sessionId: string;
  reviewStore: ReviewStore;
  openTerminals(): void;
  openAgentTerminals(): void;
  openChanges(worktreePath?: string | null): void;
  openFiles(): void;
  openFile(target: WorkspaceFileTarget): void;
  openPullRequest(target: Omit<WorkspacePullRequestTarget, 'sessionId'>): void;
}) {
  const host = useHost();
  const query = signal('');
  const wide = signal(false);
  const revisions = signal<GitRevisions | null>(null);
  const githubRepo = signal<GitHubRepoRef | null>(null);
  const pulls = signal<GitHubPullSummary[]>([]);
  const fileResults = signal<AgentFileEntry[]>([]);
  let searchInput: { focus(): void } | null = null;
  let alive = true;
  let searchSeq = 0;
  let loadSeq = 0;
  cleanup(() => {
    alive = false;
    searchSeq += 1;
    loadSeq += 1;
  });

  effect(() => {
    const sid = props.sessionId;
    const wt = props.reviewStore.activeWorktree(sid);
    const seq = ++loadSeq;
    void (async () => {
      try {
        const rev = await host.query('agent', 'gitRevisions', {
          sessionId: sid,
          ...(wt ? { worktreePath: wt } : {}),
        });
        if (!alive || seq !== loadSeq) return;
        revisions.set(rev);
        const ghRemote =
          rev?.remotes.find(
            (r) => r.host.toLowerCase() === 'github.com' && r.remote === 'origin',
          ) ?? rev?.remotes.find((r) => r.host.toLowerCase() === 'github.com');
        if (!ghRemote) {
          githubRepo.set(null);
          pulls.set([]);
          return;
        }
        const repoRef: GitHubRepoRef = {
          host: ghRemote.host,
          owner: ghRemote.owner,
          repo: ghRemote.repo,
        };
        githubRepo.set(repoRef);
        const prRes = await host.query('agent', 'githubPullRequests', {
          sessionId: sid,
          repo: repoRef,
          state: 'all',
        });
        if (!alive || seq !== loadSeq) return;
        if (prRes.kind === 'ready') pulls.set(prRes.pulls.slice(0, 6));
      } catch {
        if (!alive || seq !== loadSeq) return;
      }
    })();
  });

  effect(() => {
    const q = query().trim();
    const sid = props.sessionId;
    const seq = ++searchSeq;
    if (!q || /^#?\d+$/.test(q)) {
      fileResults.set([]);
      return;
    }
    void (async () => {
      let sub: Awaited<ReturnType<typeof host.subscribe>> | null = null;
      try {
        sub = await host.subscribe('agent', 'fileCandidates', {
          target: { kind: 'session', sessionId: sid },
          directory: null,
          query: q,
        });
        const next = await sub.next();
        if (!alive || seq !== searchSeq) return;
        const files = (next?.entries ?? [])
          .filter((e: AgentFileEntry) => e.kind === 'file')
          .slice(0, 8);
        fileResults.set(files);
      } catch {
        if (alive && seq === searchSeq) fileResults.set([]);
      } finally {
        void sub?.close().catch(() => undefined);
      }
    })();
  });

  const parsedPrNumber = computed(() => {
    const m = /^#?(\d+)$/.exec(query().trim());
    return m ? Number(m[1]) : null;
  });

  const matchingPulls = computed(() => {
    const q = query().trim().toLowerCase();
    if (!q) return [];
    const stripped = q.startsWith('#') ? q.slice(1) : q;
    return pulls()
      .filter(
        (pr) =>
          String(pr.number).includes(stripped) ||
          pr.title.toLowerCase().includes(q) ||
          pr.headRef.toLowerCase().includes(q),
      )
      .slice(0, 5);
  });

  const matchingWorktrees = computed(() => {
    const q = query().trim().toLowerCase();
    if (!q) return [];
    return orderWorktrees(revisions()?.worktrees ?? [])
      .filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          (w.branch?.toLowerCase().includes(q) ?? false) ||
          w.path.toLowerCase().includes(q),
      )
      .slice(0, 5);
  });

  const submitSearch = () => {
    const prNum = parsedPrNumber();
    if (prNum !== null && prNum > 0) {
      const repo = githubRepo();
      props.openPullRequest({
        ...(repo ? { repo } : {}),
        number: prNum,
      });
      return;
    }
    const firstPr = matchingPulls()[0];
    if (firstPr) {
      const repo = githubRepo();
      props.openPullRequest({
        ...(repo ? { repo } : {}),
        number: firstPr.number,
        title: firstPr.title,
      });
      return;
    }
    const firstWt = matchingWorktrees()[0];
    if (firstWt) {
      props.openChanges(firstWt.isCurrent ? null : firstWt.path);
      return;
    }
    const firstFile = fileResults()[0];
    if (firstFile) {
      openFileEntry(firstFile.path);
    }
  };

  const openFileEntry = (path: WorkspacePath) => {
    const title = host.pathLabel(path);
    props.openFile({
      sessionId: props.sessionId,
      path,
      parent: parentPathOf(path),
      title,
    });
  };

  const worktrees = (): readonly GitWorktreeEntry[] => revisions()?.worktrees ?? [];

  const newCards = () => [
    {
      id: 'terminal',
      icon: 'terminal' as const,
      label: tr('Terminal'),
      action: props.openTerminals,
    },
    {
      id: 'agent-terminals',
      icon: 'app' as const,
      label: tr('Agent terminals'),
      action: props.openAgentTerminals,
    },
    {
      id: 'changes',
      icon: 'diff' as const,
      label: tr('Changes'),
      action: () => props.openChanges(),
    },
    {
      id: 'files',
      icon: 'folder' as const,
      label: tr('Files'),
      action: props.openFiles,
    },
  ];

  const hasSuggestions = () => pulls().length > 0 || worktrees().length > 1;

  return (
    <Scroll
      onLayout={({ bounds }) => wide.set(bounds.size.width >= 540)}
      style={{ flex: 1, minHeight: 0 }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 680,
          alignSelf: 'center',
          paddingHorizontal: 24,
          paddingTop: 32,
          paddingBottom: 96,
          gap: 24,
        }}
      >
        {/* Centered Pill Search Bar */}
        <View style={{ gap: 8 }}>
          <View
            style={{
              height: 36,
              borderRadius: 16,
              backgroundColor: C.card,
              paddingHorizontal: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <View
              role="button"
              accessibilityLabel={tr('Search files, PR #number, or branch…')}
              onPress={() => searchInput?.focus()}
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                borderRadius: radius(16),
              }}
            />
            <Icon name="search" size={14} color={C.muted} />
            <Input
              ref={(node) => {
                searchInput = node;
              }}
              value={query()}
              onChange={({ value }) => query.set(value)}
              onSubmit={submitSearch}
              placeholder={tr('Search files, PR #number, or branch…')}
              accessibilityLabel={tr('Search files, PR #number, or branch…')}
              style={{
                ...bodyTextStyle,
                flex: 1,
                minWidth: 0,
                color: C.text,
              }}
            />
            <If when={query().length > 0}>
              <Button
                accessibilityLabel={tr('Clear')}
                onPress={() => query.set('')}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                hoverStyle={{ backgroundColor: C.cardRaised }}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="close" size={12} color={C.muted} />
              </Button>
            </If>
          </View>

          {/* Instant Search Results */}
          <If
            when={
              query().trim().length > 0 &&
              (parsedPrNumber() !== null ||
                matchingPulls().length > 0 ||
                matchingWorktrees().length > 0 ||
                fileResults().length > 0)
            }
          >
            <View
              style={{
                borderRadius: radius(12),
                backgroundColor: C.card,
                padding: 4,
                gap: 2,
              }}
            >
              <If
                when={
                  parsedPrNumber() !== null &&
                  !matchingPulls().some((p) => p.number === parsedPrNumber())
                }
              >
                <Button
                  accessibilityLabel={`PR #${parsedPrNumber()}`}
                  onPress={() => {
                    const repo = githubRepo();
                    props.openPullRequest({
                      ...(repo ? { repo } : {}),
                      number: parsedPrNumber()!,
                    });
                  }}
                  style={{
                    minHeight: 32,
                    paddingHorizontal: 8,
                    borderRadius: radius(8),
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="pullRequest" size={14} color={C.accentText} />
                  <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                    {`PR #${parsedPrNumber()}`}
                  </Text>
                </Button>
              </If>

              <Each of={matchingPulls()} key={(pr) => pr.number}>
                {(pr) => (
                  <Button
                    accessibilityLabel={`${pr().title} #${pr().number}`}
                    onPress={() => {
                      const repo = githubRepo();
                      props.openPullRequest({
                        ...(repo ? { repo } : {}),
                        number: pr().number,
                        title: pr().title,
                      });
                    }}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 8,
                      borderRadius: radius(8),
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon
                      name="pullRequest"
                      size={14}
                      color={pr().state === 'closed' ? C.accentText : C.success}
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

              <Each of={matchingWorktrees()} key={(w) => `wt-q:${w.path}`}>
                {(w) => (
                  <Button
                    accessibilityLabel={w().name}
                    tooltip={textTooltip(() => w().path)}
                    onPress={() => props.openChanges(w().isCurrent ? null : w().path)}
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 8,
                      borderRadius: radius(8),
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon name="gitBranch" size={14} color={C.secondary} />
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.text, fontWeight: '500' },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {w().name}
                    </Text>
                    <If when={Boolean(w().branch)}>
                      <Text
                        style={[
                          { fontSize: 12, lineHeight: 16, color: C.muted, flex: 1, minWidth: 0 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {w().branch!}
                      </Text>
                    </If>
                  </Button>
                )}
              </Each>

              <Each of={fileResults()} key={(entry) => entry.path.bytesBase64}>
                {(entry) => {
                  const full = () => host.pathLabel(entry().path);
                  return (
                    <Button
                      accessibilityLabel={full()}
                      tooltip={textTooltip(full)}
                      onPress={() => openFileEntry(entry().path)}
                      style={{
                        minHeight: 32,
                        paddingHorizontal: 8,
                        borderRadius: radius(8),
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                      hoverStyle={{ backgroundColor: C.cardRaised }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon name="file" size={14} color={C.muted} />
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.text, fontWeight: '500' },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {basenameLabel(full())}
                      </Text>
                      <Text
                        style={[
                          { fontSize: 12, lineHeight: 16, color: C.muted, flex: 1, minWidth: 0 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {full()}
                      </Text>
                    </Button>
                  );
                }}
              </Each>
            </View>
          </If>
        </View>

        {/* New 4-Card Grid */}
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: C.muted }}>
            {tr('New')}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <Each of={newCards()} key={(card) => card.id}>
              {(card) => (
                <Button
                  accessibilityLabel={card().label}
                  onPress={card().action}
                  style={{
                    width: wide() ? '23.5%' : '48.5%',
                    flexGrow: 1,
                    height: 76,
                    padding: 12,
                    borderRadius: radius(12),
                    backgroundColor: C.card,
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  activeStyle={quietActiveStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name={card().icon} size={16} color={C.secondary} />
                  <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
                    {card().label}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </View>

        {/* Suggested Pull Requests & Linked Worktrees */}
        <If when={hasSuggestions()}>
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: C.muted }}>
              {tr('Suggested')}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Each of={pulls().slice(0, 4)} key={(pr) => `pr:${pr.number}`}>
                {(pr) => (
                  <Button
                    accessibilityLabel={`PR #${pr().number} ${pr().title}`}
                    tooltip={textTooltip(() => `#${pr().number} · ${pr().title}`)}
                    onPress={() => {
                      const repo = githubRepo();
                      props.openPullRequest({
                        ...(repo ? { repo } : {}),
                        number: pr().number,
                        title: pr().title,
                      });
                    }}
                    style={{
                      width: wide() ? '48.5%' : '100%',
                      flexGrow: 1,
                      minHeight: 76,
                      padding: 12,
                      borderRadius: radius(12),
                      backgroundColor: C.card,
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 8,
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    activeStyle={quietActiveStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Icon
                        name="pullRequest"
                        size={14}
                        color={
                          pr().draft ? C.muted : pr().state === 'closed' ? C.accentText : C.success
                        }
                      />
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {`PR #${pr().number}`}
                      </Text>
                    </View>
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.text, fontWeight: '500' },
                        { numberOfLines: 2 },
                      ]}
                    >
                      {pr().title}
                    </Text>
                  </Button>
                )}
              </Each>

              <If when={worktrees().length > 1}>
                <Each of={orderWorktrees(worktrees()).slice(0, 4)} key={(wt) => `wt:${wt.path}`}>
                  {(wt) => (
                    <Button
                      accessibilityLabel={wt().name}
                      tooltip={textTooltip(() => wt().path)}
                      onPress={() => props.openChanges(wt().isCurrent ? null : wt().path)}
                      style={{
                        width: wide() ? '48.5%' : '100%',
                        flexGrow: 1,
                        minHeight: 76,
                        padding: 12,
                        borderRadius: radius(12),
                        backgroundColor: C.card,
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 8,
                      }}
                      hoverStyle={{ backgroundColor: C.cardRaised }}
                      activeStyle={quietActiveStyle()}
                      focusStyle={quietFocusStyle()}
                    >
                      <View
                        style={{
                          width: '100%',
                          minWidth: 0,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <Icon name="gitBranch" size={14} color={C.secondary} />
                        <Text
                          style={[
                            { fontSize: 12, lineHeight: 16, color: C.muted, flex: 1, minWidth: 0 },
                            { numberOfLines: 1 },
                          ]}
                        >
                          {wt().branch || tr('Worktree reference')}
                        </Text>
                      </View>
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.text, fontWeight: '500', width: '100%' },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {wt().name}
                      </Text>
                    </Button>
                  )}
                </Each>
              </If>
            </View>
          </View>
        </If>
      </View>
    </Scroll>
  );
}
