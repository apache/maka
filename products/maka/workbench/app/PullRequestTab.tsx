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
import { Clipboard, cleanup, computed, effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, Input, Popover, TextView } from 'nsh/base';
import { ChangesStudio } from './ChangesStudio';
import { useHost } from './host';
import { Icon } from './Icon';
import { LoadingState } from './Loading';
import { tr } from './locale';
import { settingsValue } from './settingsOperations';
import {
  formatPrKey,
  type GitHubPullDetail,
  type GitHubPullDetailResult,
  type GitHubReplyCommentResult,
  type GitHubRepoRef,
  type GitHubReviewEvent,
  type GitHubSubmitReviewResult,
  type GitHubTokenResult,
  type ReviewStore,
} from './reviewState';
import { errorText, renderText } from './text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlStyle,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';
import type { WorkspaceFileTarget } from './workspaceFileState';

function formatShortDate(iso: string): string {
  if (!iso) return '';
  const idx = iso.indexOf('T');
  return idx > 0 ? iso.slice(0, idx) : iso;
}

export function PullRequestTab(props: {
  sessionId: string;
  repo?: GitHubRepoRef;
  number: number;
  reviewStore: ReviewStore;
  canPrompt(): boolean;
  deliverPrompt(text: string, mode: 'insert' | 'send'): boolean;
  openFile(target: WorkspaceFileTarget): void;
  onTitleResolved?(title: string): void;
}) {
  const host = useHost();
  const subTab = signal<'summary' | 'changes'>('summary');
  const detailState = signal<
    | { kind: 'loading' }
    | { kind: 'ready'; result: GitHubPullDetailResult }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const wide = signal(true);
  const focusFilePath = signal<string | null>(null);

  const reviewMenuOpen = signal(false);
  const reviewEvent = signal<GitHubReviewEvent>('comment');
  const reviewBody = signal('');
  const reviewSubmitting = signal(false);
  const reviewFeedback = signal('');

  const tokenMenuOpen = signal(false);
  const tokenDraft = signal('');
  const tokenSaving = signal(false);
  const tokenError = signal('');

  const commentDraft = signal('');
  const commentSubmitting = signal(false);
  const commentError = signal('');
  const copiedLink = signal(false);

  let alive = true;
  let loadSeq = 0;
  cleanup(() => {
    alive = false;
    loadSeq += 1;
  });

  const loadDetail = async (forceLoading = false) => {
    const seq = ++loadSeq;
    if (detailState().kind !== 'loading' && (forceLoading || detailState().kind !== 'ready')) {
      detailState.set({ kind: 'loading' });
    }
    try {
      const result = await host.query('agent', 'githubPullRequestDetail', {
        sessionId: props.sessionId,
        ...(props.repo ? { repo: props.repo } : {}),
        number: props.number,
        includePatch: true,
      });
      if (!alive || seq !== loadSeq) return;
      detailState.set({ kind: 'ready', result });
      if (result.kind === 'ready') {
        const key = formatPrKey(result.detail.repo, result.detail.number);
        props.reviewStore.setPrThreads(props.sessionId, key, result.detail.threads);
        props.onTitleResolved?.(`#${result.detail.number} ${result.detail.title}`);
      }
    } catch (reason) {
      if (!alive || seq !== loadSeq) return;
      detailState.set({
        kind: 'error',
        message: renderText(errorText(reason, 'Could not load pull request details.')),
      });
    }
  };

  effect(() => {
    void props.sessionId;
    void props.number;
    void props.repo?.host;
    void props.repo?.owner;
    void props.repo?.repo;
    untracked(() => {
      void loadDetail();
    });
  });

  const detail = (): GitHubPullDetail | null => {
    const cur = detailState();
    return cur.kind === 'ready' && cur.result.kind === 'ready' ? cur.result.detail : null;
  };

  const authStatus = () => {
    const cur = detailState();
    if (cur.kind !== 'ready') return null;
    return cur.result.kind === 'ready' ? cur.result.detail.auth : cur.result.auth;
  };

  const prKey = () => {
    const d = detail();
    return d ? formatPrKey(d.repo, d.number) : '';
  };

  const pendingDrafts = computed(() => {
    const key = prKey();
    return key ? props.reviewStore.prDrafts(props.sessionId, key) : [];
  });

  const reviewers = computed(() => {
    const d = detail();
    if (!d) return [];
    const authors = new Set<string>();
    for (const thread of d.threads) {
      for (const c of thread.comments) {
        if (c.author && c.author !== d.author) authors.add(c.author);
      }
    }
    for (const c of d.issueComments) {
      if (c.author && c.author !== d.author) authors.add(c.author);
    }
    return [...authors];
  });

  const activityItems = computed(() => {
    const d = detail();
    if (!d) return [];
    type Item =
      | { kind: 'issue-comment'; id: string; createdAt: string; author: string; body: string }
      | {
          kind: 'thread';
          id: string;
          createdAt: string;
          author: string;
          path: string;
          line: number | null;
          body: string;
          replyCount: number;
        };
    const items: Item[] = [];
    for (const ic of d.issueComments) {
      items.push({
        kind: 'issue-comment',
        id: `ic:${ic.id}`,
        createdAt: ic.createdAt,
        author: ic.author,
        body: ic.body,
      });
    }
    for (const thread of d.threads) {
      const first = thread.comments[0];
      if (!first) continue;
      items.push({
        kind: 'thread',
        id: `th:${thread.id}`,
        createdAt: first.createdAt,
        author: first.author,
        path: thread.path,
        line: thread.line,
        body: first.body,
        replyCount: Math.max(0, thread.comments.length - 1),
      });
    }
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return items;
  });

  const submitReview = async () => {
    const d = detail();
    const key = prKey();
    if (!d || !key || reviewSubmitting()) return;
    reviewSubmitting.set(true);
    reviewFeedback.set('');
    try {
      const drafts = pendingDrafts();
      const { reply } = await host.control('githubSubmitReview', {
        sessionId: props.sessionId,
        repo: d.repo,
        number: d.number,
        expectedHeadSha: d.headSha,
        event: reviewEvent(),
        body: reviewBody(),
        comments: drafts.map((item) => ({
          path: item.path,
          side: item.side,
          line: item.line,
          ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
          ...(item.startSide !== undefined ? { startSide: item.startSide } : {}),
          body: item.body,
        })),
      });
      const res = settingsValue(reply) as GitHubSubmitReviewResult;
      if (res.kind === 'submitted') {
        props.reviewStore.clearPrDrafts(props.sessionId, key);
        reviewBody.set('');
        reviewMenuOpen.set(false);
        await loadDetail(false);
      } else if (res.kind === 'stale_head') {
        reviewFeedback.set(
          tr(
            'Pull request head moved to {sha}. Refresh the diff before submitting your comments.',
            {
              sha: res.actualHeadSha.slice(0, 7),
            },
          ),
        );
      } else {
        reviewFeedback.set(res.message || tr('Could not submit GitHub review.'));
      }
    } catch (err) {
      reviewFeedback.set(
        err instanceof Error ? err.message : tr('Could not submit GitHub review.'),
      );
    } finally {
      if (alive) reviewSubmitting.set(false);
    }
  };

  const submitGeneralComment = async () => {
    const d = detail();
    const text = commentDraft().trim();
    if (!d || !text || commentSubmitting()) return;
    commentSubmitting.set(true);
    commentError.set('');
    try {
      const { reply } = await host.control('githubCommentPullRequest', {
        sessionId: props.sessionId,
        repo: d.repo,
        number: d.number,
        body: text,
      });
      const res = settingsValue(reply) as GitHubReplyCommentResult;
      if (res.kind === 'replied') {
        commentDraft.set('');
        await loadDetail(false);
      } else {
        commentError.set(res.message || tr('Could not post GitHub comment.'));
      }
    } catch (err) {
      commentError.set(err instanceof Error ? err.message : tr('Could not post GitHub comment.'));
    } finally {
      if (alive) commentSubmitting.set(false);
    }
  };

  const saveToken = async () => {
    const hostName = detail()?.repo.host ?? props.repo?.host ?? 'github.com';
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
        tokenMenuOpen.set(false);
        await loadDetail(true);
      }
    } catch (err) {
      tokenError.set(err instanceof Error ? err.message : tr('Could not save GitHub token.'));
    } finally {
      if (alive) tokenSaving.set(false);
    }
  };

  const removeToken = async () => {
    const hostName = detail()?.repo.host ?? props.repo?.host ?? 'github.com';
    if (tokenSaving()) return;
    tokenSaving.set(true);
    tokenError.set('');
    try {
      const { reply } = await host.settingsMutation('agent', 'deleteGitHubToken', {
        host: hostName,
      });
      settingsValue(reply);
      tokenMenuOpen.set(false);
      await loadDetail(true);
    } catch (err) {
      tokenError.set(err instanceof Error ? err.message : tr('Could not remove GitHub token.'));
    } finally {
      if (alive) tokenSaving.set(false);
    }
  };

  const copyPrUrl = async () => {
    const url = detail()?.htmlUrl;
    if (!url) return;
    try {
      await Clipboard.writeText(url);
      copiedLink.set(true);
    } catch {
      // Ignore clipboard failure
    }
  };

  const statusBadge = (d: GitHubPullDetail) => {
    if (d.merged) return { label: tr('Merged'), color: C.accent };
    if (d.state === 'closed') return { label: tr('Closed'), color: C.danger };
    if (d.draft) return { label: tr('Draft'), color: C.muted };
    return { label: tr('Open'), color: C.success };
  };

  const errorDetailText = () => {
    const s = detailState();
    if (s.kind === 'error') return s.message;
    if (s.kind === 'ready' && s.result.kind !== 'ready') {
      if (s.result.kind === 'not_found')
        return tr('Pull request #{number} was not found.', { number: String(props.number) });
      return s.result.message;
    }
    return '';
  };

  return (
    <View
      onLayout={({ bounds }) => wide.set(bounds.size.width >= 720)}
      style={{ flex: 1, minHeight: 0, backgroundColor: C.panel }}
    >
      {/* Top Sub-Header: [Summary | Changes +added -deleted] ... [Submit Review] [Token] [Copy Link] [Open on GitHub] [Refresh] */}
      <View
        style={{
          minHeight: 36,
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <View
          role="tablist"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}
        >
          <Button
            role="tab"
            accessibilityLabel={tr('Summary')}
            selected={subTab() === 'summary'}
            onPress={() => subTab.set('summary')}
            style={{
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: subTab() === 'summary' ? C.card : 'transparent',
              justifyContent: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: subTab() === 'summary' ? C.text : C.secondary,
                fontWeight: subTab() === 'summary' ? '500' : undefined,
              }}
            >
              {tr('Summary')}
            </Text>
          </Button>

          <Button
            role="tab"
            accessibilityLabel={tr('Changes')}
            selected={subTab() === 'changes'}
            onPress={() => subTab.set('changes')}
            style={{
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: subTab() === 'changes' ? C.card : 'transparent',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: subTab() === 'changes' ? C.text : C.secondary,
                fontWeight: subTab() === 'changes' ? '500' : undefined,
              }}
            >
              {tr('Changes')}
            </Text>
            <If when={detail() !== null}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.success, fontWeight: '500' }}>
                  {`+${formatCount(detail()!.additions)}`}
                </Text>
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.danger, fontWeight: '500' }}>
                  {`-${formatCount(detail()!.deletions)}`}
                </Text>
              </View>
            </If>
          </Button>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {/* Submit Review Popover */}
          <If when={detail() !== null}>
            <Popover
              open={reviewMenuOpen()}
              onOpenChange={({ open }) => reviewMenuOpen.set(open)}
              placement="bottom"
              align="end"
              offset={4}
              margin={8}
              popupStyle={{ ...floatingStyle(), width: 320, padding: 12, gap: 12 }}
              trigger={
                <Button
                  accessibilityLabel={
                    pendingDrafts().length > 0
                      ? tr('Submit review ({count})', { count: pendingDrafts().length })
                      : tr('Submit review')
                  }
                  style={{
                    height: 28,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    backgroundColor: pendingDrafts().length > 0 ? C.accent : C.card,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  hoverStyle={{ opacity: 0.9 }}
                  focusStyle={quietFocusStyle()}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: pendingDrafts().length > 0 ? C.chrome : C.text,
                      fontWeight: '500',
                    }}
                  >
                    {pendingDrafts().length > 0
                      ? tr('Submit review ({count})', { count: pendingDrafts().length })
                      : tr('Submit review')}
                  </Text>
                  <Icon
                    name="down"
                    size={12}
                    color={pendingDrafts().length > 0 ? C.chrome : C.muted}
                  />
                </Button>
              }
            >
              <View style={{ gap: 8 }}>
                <Input
                  multiline
                  value={reviewBody()}
                  onChange={({ value }) => reviewBody.set(value)}
                  placeholder={tr('Leave a review summary…')}
                  accessibilityLabel={tr('Leave a review summary…')}
                  style={{
                    ...bodyTextStyle,
                    minHeight: 72,
                    maxHeight: 140,
                    padding: 8,
                    borderRadius: 8,
                    backgroundColor: C.background,
                    borderWidth: 1,
                    borderColor: C.line,
                    color: C.text,
                  }}
                />
                <If when={pendingDrafts().length > 0}>
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                    {tr('pr.pending_inline_comments', { count: pendingDrafts().length })}
                  </Text>
                </If>
                <View style={{ gap: 2 }}>
                  <Each
                    of={
                      [
                        { id: 'comment', label: tr('Comment') },
                        { id: 'approve', label: tr('Approve') },
                        { id: 'request_changes', label: tr('Request changes') },
                      ] as const
                    }
                    key={(ev) => ev.id}
                  >
                    {(ev) => (
                      <Button
                        accessibilityLabel={ev().label}
                        onPress={() => reviewEvent.set(ev().id)}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={quietFocusStyle()}
                      >
                        <Icon
                          name={reviewEvent() === ev().id ? 'statusRecorded' : 'statusPending'}
                          size={14}
                          color={reviewEvent() === ev().id ? C.accent : C.muted}
                        />
                        <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                          {ev().label}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
                <If when={Boolean(reviewFeedback())}>
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.danger }}>
                    {reviewFeedback()}
                  </Text>
                </If>
                <Button
                  accessibilityLabel={tr('Submit review')}
                  disabled={
                    reviewSubmitting() ||
                    (reviewEvent() !== 'approve' &&
                      reviewBody().trim().length === 0 &&
                      pendingDrafts().length === 0)
                  }
                  onPress={() => void submitReview()}
                  style={{
                    height: 32,
                    borderRadius: 8,
                    backgroundColor: C.accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  hoverStyle={{ opacity: 0.9 }}
                  focusStyle={quietFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.chrome, fontWeight: '500' }}>
                    {reviewSubmitting() ? tr('Submitting…') : tr('Submit review')}
                  </Text>
                </Button>
              </View>
            </Popover>
          </If>

          {/* Compact Action Capsule: Token, Copy Link, Open on GitHub, Refresh */}
          <View
            style={{
              height: 28,
              paddingHorizontal: 2,
              borderRadius: 8,
              backgroundColor: C.card,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Popover
              open={tokenMenuOpen()}
              onOpenChange={({ open }) => tokenMenuOpen.set(open)}
              placement="bottom"
              align="end"
              offset={4}
              margin={8}
              popupStyle={{ ...floatingStyle(), width: 280, padding: 12, gap: 8 }}
              trigger={
                <Button
                  accessibilityLabel={tr('Configure GitHub token')}
                  tooltip={textTooltip(() => tr('Configure GitHub token'))}
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
                  <Icon
                    name="lock"
                    size={13}
                    color={authStatus()?.authenticated ? C.success : C.muted}
                  />
                </Button>
              }
            >
              <View style={{ gap: 8 }}>
                <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
                  {tr('GitHub authentication')}
                </Text>
                <Input
                  value={tokenDraft()}
                  onChange={({ value }) => tokenDraft.set(value)}
                  placeholder={tr('Personal access token')}
                  accessibilityLabel={tr('Personal access token')}
                  style={{
                    ...captionTextStyle,
                    height: 32,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    backgroundColor: C.background,
                    borderWidth: 1,
                    borderColor: C.line,
                    color: C.text,
                  }}
                />
                <If when={Boolean(tokenError())}>
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.danger }}>
                    {tokenError()}
                  </Text>
                </If>
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                  <If when={authStatus()?.tokenSource === 'manual'}>
                    <Button
                      accessibilityLabel={tr('Remove token')}
                      onPress={() => void removeToken()}
                      style={{
                        height: 28,
                        paddingHorizontal: 8,
                        borderRadius: 8,
                        backgroundColor: C.raised,
                        justifyContent: 'center',
                      }}
                      hoverStyle={{ backgroundColor: C.cardRaised }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Text style={{ ...captionTextStyle, color: C.danger }}>
                        {tr('Remove token')}
                      </Text>
                    </Button>
                  </If>
                  <Button
                    accessibilityLabel={tr('Save token')}
                    disabled={!tokenDraft().trim() || tokenSaving()}
                    onPress={() => void saveToken()}
                    style={{
                      height: 28,
                      paddingHorizontal: 12,
                      borderRadius: 8,
                      backgroundColor: C.accent,
                      justifyContent: 'center',
                    }}
                    hoverStyle={{ opacity: 0.9 }}
                    focusStyle={quietFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={{ ...captionTextStyle, color: C.chrome, fontWeight: '500' }}>
                      {tr('Save token')}
                    </Text>
                  </Button>
                </View>
              </View>
            </Popover>

            <If when={Boolean(detail()?.htmlUrl)}>
              <Button
                accessibilityLabel={tr('Copy link')}
                tooltip={textTooltip(() => (copiedLink() ? tr('Copied') : tr('Copy link')))}
                onPress={() => void copyPrUrl()}
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
                <Icon
                  name={copiedLink() ? 'check' : 'link'}
                  size={13}
                  color={copiedLink() ? C.success : C.secondary}
                />
              </Button>

              <Button
                accessibilityLabel={tr('Open on GitHub')}
                tooltip={textTooltip(() => tr('Open on GitHub'))}
                onPress={() => {
                  const url = detail()?.htmlUrl;
                  if (url) void host.openBrowser(url);
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
                <Icon name="arrow" size={13} color={C.secondary} />
              </Button>
            </If>

            <Button
              accessibilityLabel={tr('Refresh')}
              tooltip={textTooltip(() => tr('Refresh'))}
              onPress={() => void loadDetail(true)}
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
          </View>
        </View>
      </View>

      {/* Body */}
      <If
        when={detailState().kind !== 'loading'}
        else={
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <LoadingState label={tr('Loading…')} />
          </View>
        }
      >
        <If
          when={detail() !== null}
          else={
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 24,
                gap: 12,
              }}
            >
              <Text style={{ ...bodyTextStyle, color: C.secondary, textAlign: 'center' }}>
                {errorDetailText()}
              </Text>
            </View>
          }
        >
          <If
            when={subTab() === 'summary'}
            else={
              <ChangesStudio
                sessionId={props.sessionId}
                reviewStore={props.reviewStore}
                canPrompt={props.canPrompt}
                deliverPrompt={props.deliverPrompt}
                openFile={props.openFile}
                prDetail={detail()!}
                focusFilePath={focusFilePath()}
                onFocusFileHandled={() => focusFilePath.set(null)}
              />
            }
          >
            <Scroll style={{ flex: 1, minHeight: 0 }}>
              <View
                style={{
                  width: '100%',
                  maxWidth: 960,
                  alignSelf: 'center',
                  paddingHorizontal: 24,
                  paddingTop: 24,
                  paddingBottom: 96,
                  flexDirection: wide() ? 'row' : 'column',
                  gap: 32,
                }}
              >
                {/* Left Main PR Summary + Markdown Body + Activity + Comment Box */}
                <View style={{ flex: 1, minWidth: 0, gap: 24 }}>
                  <View style={{ gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View
                        style={{
                          height: 24,
                          paddingHorizontal: 8,
                          borderRadius: 12,
                          backgroundColor: `${statusBadge(detail()!).color}22`,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Icon name="pullRequest" size={12} color={statusBadge(detail()!).color} />
                        <Text
                          style={{
                            fontSize: 12,
                            lineHeight: 16,
                            fontWeight: '500',
                            color: statusBadge(detail()!).color,
                          }}
                        >
                          {statusBadge(detail()!).label}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {`${detail()!.repo.repo} #${detail()!.number}`}
                      </Text>
                    </View>

                    <Text
                      style={[
                        {
                          fontSize: 22,
                          lineHeight: 28,
                          fontWeight: '600',
                          color: C.text,
                        },
                        { userSelect: 'text' },
                      ]}
                    >
                      {detail()!.title}
                    </Text>

                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <Icon name="user" size={13} color={C.muted} />
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.secondary }}>
                        {detail()!.author}
                      </Text>
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>·</Text>
                      <Text style={{ ...codeTextStyle, fontSize: 12, color: C.muted }}>
                        {`${detail()!.headRef} → ${detail()!.baseRef}`}
                      </Text>
                    </View>
                  </View>

                  {/* PR Markdown Description */}
                  <If when={Boolean(detail()!.body.trim())}>
                    <View style={{ gap: 8 }}>
                      <TextView selectable markdown={detail()!.body} />
                    </View>
                  </If>

                  <View style={{ height: 1, backgroundColor: C.line }} />

                  {/* Activity Timeline */}
                  <View style={{ gap: 12 }}>
                    <Text
                      style={{
                        fontSize: 14,
                        lineHeight: 20,
                        fontWeight: '600',
                        color: C.text,
                      }}
                    >
                      {tr('Activity')}
                    </Text>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Icon name="pullRequest" size={14} color={C.success} />
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.secondary }}>
                        {`${detail()!.author} ${tr('opened this pull request')}`}
                      </Text>
                    </View>

                    <Each of={activityItems()} key={(item) => item.id}>
                      {(item) => {
                        const entry = item();
                        if (entry.kind === 'issue-comment') {
                          return (
                            <View
                              style={{
                                padding: 12,
                                borderRadius: 12,
                                backgroundColor: C.card,
                                gap: 8,
                              }}
                            >
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Icon name="user" size={13} color={C.muted} />
                                <Text
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 16,
                                    fontWeight: '500',
                                    color: C.text,
                                    flex: 1,
                                  }}
                                >
                                  {entry.author}
                                </Text>
                                <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                                  {formatShortDate(entry.createdAt)}
                                </Text>
                              </View>
                              <TextView selectable markdown={entry.body} />
                            </View>
                          );
                        }
                        return (
                          <Button
                            accessibilityLabel={entry.path}
                            onPress={() => {
                              focusFilePath.set(entry.path);
                              subTab.set('changes');
                            }}
                            style={{
                              padding: 12,
                              borderRadius: 12,
                              backgroundColor: C.card,
                              alignItems: 'stretch',
                              gap: 8,
                            }}
                            hoverStyle={{ backgroundColor: C.cardRaised }}
                            focusStyle={quietFocusStyle()}
                          >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Icon name="conversation" size={13} color={C.accent} />
                              <Text
                                style={{
                                  fontSize: 12,
                                  lineHeight: 16,
                                  fontWeight: '500',
                                  color: C.text,
                                }}
                              >
                                {entry.author}
                              </Text>
                              <Text
                                style={[
                                  {
                                    ...codeTextStyle,
                                    fontSize: 12,
                                    color: C.muted,
                                    flex: 1,
                                    minWidth: 0,
                                  },
                                  { numberOfLines: 1 },
                                ]}
                              >
                                {`${entry.path}${entry.line ? `:${entry.line}` : ''}`}
                              </Text>
                              <Icon name="arrow" size={12} color={C.muted} />
                            </View>
                            <Text
                              style={[
                                { ...captionTextStyle, color: C.secondary },
                                { numberOfLines: 3 },
                              ]}
                            >
                              {entry.body}
                            </Text>
                          </Button>
                        );
                      }}
                    </Each>

                    {/* General PR Comment Box */}
                    <View
                      style={{
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: C.card,
                        gap: 8,
                      }}
                    >
                      <Input
                        multiline
                        value={commentDraft()}
                        onChange={({ value }) => {
                          commentError.set('');
                          commentDraft.set(value);
                        }}
                        placeholder={tr('Leave a comment…')}
                        accessibilityLabel={tr('Leave a comment…')}
                        style={{
                          ...bodyTextStyle,
                          minHeight: 56,
                          maxHeight: 160,
                          color: C.text,
                        }}
                      />
                      <If when={Boolean(commentError())}>
                        <Text style={{ fontSize: 12, lineHeight: 16, color: C.danger }}>
                          {commentError()}
                        </Text>
                      </If>
                      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                        <Button
                          accessibilityLabel={tr('Comment')}
                          disabled={!commentDraft().trim() || commentSubmitting()}
                          onPress={() => void submitGeneralComment()}
                          style={{
                            ...controlStyle,
                            minHeight: 28,
                            height: 28,
                            paddingHorizontal: 12,
                            borderRadius: 16,
                            backgroundColor: C.accent,
                          }}
                          hoverStyle={{ opacity: 0.9 }}
                          focusStyle={quietFocusStyle()}
                          disabledStyle={controlDisabledStyle}
                        >
                          <Text style={{ ...captionTextStyle, color: C.chrome, fontWeight: '500' }}>
                            {commentSubmitting() ? tr('Submitting…') : tr('Comment')}
                          </Text>
                        </Button>
                      </View>
                    </View>
                  </View>
                </View>

                {/* Right Metadata Column on Wide Stage */}
                <If when={wide()}>
                  <View style={{ width: 184, flexShrink: 0, gap: 16 }}>
                    <View style={{ gap: 4 }}>
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {reviewers().length === 0 ? tr('No reviewers') : 'Reviewers'}
                      </Text>
                      <Each of={reviewers()} key={(login) => login}>
                        {(login) => (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Icon name="user" size={12} color={C.secondary} />
                            <Text style={{ fontSize: 12, lineHeight: 16, color: C.text }}>
                              {login()}
                            </Text>
                          </View>
                        )}
                      </Each>
                    </View>
                    <View style={{ height: 1, backgroundColor: C.line }} />
                    <View style={{ gap: 4 }}>
                      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {tr('No checks reported')}
                      </Text>
                      <Text style={{ ...codeTextStyle, fontSize: 12, color: C.muted }}>
                        {detail()!.headSha.slice(0, 7)}
                      </Text>
                    </View>
                  </View>
                </If>
              </View>
            </Scroll>
          </If>
        </If>
      </If>
    </View>
  );
}
