import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Section } from '@astryxdesign/core/Section';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import {
  countDiffLineStats,
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  type GitReviewMutationAction,
  type GitReviewReadResult,
  type GitReviewSource,
  type StoredMessage,
} from '@maka/core';
import { ToolResultPreview, useToast, useUiLocale } from '@maka/ui';
import {
  Check,
  GitBranch,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
} from '@maka/ui/icons';
import { getDesktopConversationCopy } from './locales/conversation-copy';

type ReviewSource = GitReviewSource | 'last-turn';
const REVIEW_FILE_PAGE_SIZE = 20;

type FileDiffMessage = Extract<StoredMessage, { type: 'tool_result' }> & {
  content: Extract<
    Extract<StoredMessage, { type: 'tool_result' }>['content'],
    { kind: 'file_diff' }
  >;
};

function fileDiffMessages(messages: readonly StoredMessage[]): FileDiffMessage[] {
  return messages.filter(
    (message): message is FileDiffMessage =>
      message.type === 'tool_result' && message.content.kind === 'file_diff',
  );
}

function latestFileDiffTurn(messages: readonly StoredMessage[]): FileDiffMessage[] {
  const diffs = fileDiffMessages(messages);
  const turnId = diffs.at(-1)?.turnId;
  return turnId ? diffs.filter((message) => message.turnId === turnId) : [];
}

export function SessionReviewPanel(props: {
  sessionId: string;
  active: boolean;
}) {
  const locale = useUiLocale();
  const toast = useToast();
  const copy = getDesktopConversationCopy(locale).reviewPanel;
  const [source, setSource] = useState<ReviewSource>('branch');
  const [baseBranch, setBaseBranch] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [gitResult, setGitResult] = useState<GitReviewReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [visibleFileCount, setVisibleFileCount] = useState(REVIEW_FILE_PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextMessages = await window.maka.sessions.readMessages(props.sessionId);
      const nextGit =
        source === 'last-turn'
          ? null
          : await window.maka.gitReview.read({
              sessionId: props.sessionId,
              source,
              ...(source === 'branch' && baseBranch ? { baseBranch } : {}),
            });
      if (revision !== revisionRef.current) return;
      setMessages(nextMessages);
      setGitResult(nextGit);
      if (
        source === 'branch' &&
        nextGit?.ok === false &&
        (nextGit.reason === 'not_git_repository' ||
          nextGit.reason === 'workspace_unavailable') &&
        latestFileDiffTurn(nextMessages).length > 0
      ) {
        setSource('last-turn');
      }
    } catch (nextError) {
      if (revision === revisionRef.current) {
        setError(
          locale === 'zh'
            ? generalizedErrorMessageChinese(nextError, copy.loadFailed)
            : generalizedErrorMessage(nextError, copy.loadFailed),
        );
      }
    } finally {
      if (revision === revisionRef.current) setLoading(false);
    }
  }, [baseBranch, copy.loadFailed, locale, props.sessionId, source]);

  useEffect(() => {
    setBaseBranch(undefined);
  }, [props.sessionId]);

  useEffect(() => {
    if (!props.active) return;
    let timer: number | undefined;
    const unsubscribe = window.maka.sessions.subscribeEvents(
      props.sessionId,
      (event) => {
        if (event.type !== 'tool_result' && event.type !== 'complete') return;
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => void load(), 250);
      },
    );
    void load();
    return () => {
      revisionRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load, props.active, props.sessionId]);

  const lastTurnDiffs = useMemo(
    () => latestFileDiffTurn(messages).reverse(),
    [messages],
  );
  const gitSnapshot = gitResult?.ok ? gitResult.snapshot : null;
  const gitFiles = gitSnapshot?.files ?? [];
  const visibleGitFiles = gitFiles.slice(0, visibleFileCount);
  const remainingGitFiles = Math.max(0, gitFiles.length - visibleGitFiles.length);
  const stats =
    source === 'last-turn'
      ? lastTurnDiffs.reduce(
          (total, message) => {
            const next = countDiffLineStats(message.content.diff);
            return {
              files: total.files + 1,
              additions: total.additions + next.additions,
              deletions: total.deletions + next.deletions,
            };
          },
          { files: 0, additions: 0, deletions: 0 },
        )
      : {
          files: gitFiles.length,
          additions: gitSnapshot?.additions ?? 0,
          deletions: gitSnapshot?.deletions ?? 0,
        };
  const sourceError =
    source === 'last-turn' || gitResult?.ok !== false
      ? null
      : gitResult.reason === 'not_git_repository'
        ? copy.notGitRepository
        : gitResult.reason === 'workspace_unavailable'
          ? copy.workspaceUnavailable
        : gitResult.reason === 'unborn_repository'
          ? copy.unbornRepository
          : gitResult.reason === 'invalid_base_branch'
            ? copy.invalidBaseBranch
          : copy.gitFailed;
  const comparison =
    source === 'branch' &&
    gitSnapshot?.baseBranch &&
    gitSnapshot.currentBranch
      ? gitSnapshot.baseBranch === gitSnapshot.currentBranch
        ? copy.workingTree(gitSnapshot.currentBranch)
        : copy.comparison(gitSnapshot.baseBranch, gitSnapshot.currentBranch)
      : null;
  const mutationSource =
    source === 'unstaged' || source === 'staged' ? source : null;
  const mutationAction =
    mutationSource === 'unstaged'
      ? ('stage' as const)
      : mutationSource === 'staged'
        ? ('unstage' as const)
        : null;
  const empty =
    !loading &&
    !error &&
    !sourceError &&
    (source === 'last-turn' ? lastTurnDiffs.length === 0 : gitFiles.length === 0);

  const mutateFile = async (
    path: string,
    action: GitReviewMutationAction | null = mutationAction,
  ) => {
    if (!gitSnapshot || !mutationSource || !action || pendingPath) return;
    setPendingPath(path);
    setError(null);
    try {
      const result = await window.maka.gitReview.mutate({
        sessionId: props.sessionId,
        source: mutationSource,
        revision: gitSnapshot.revision,
        path,
        action,
      });
      if (!result.ok) {
        if (result.reason === 'stale_snapshot') {
          await load();
          setError(copy.snapshotChanged);
        } else {
          setError(copy.mutationFailed);
        }
        return;
      }
      setGitResult(result.review);
    } catch (nextError) {
      setError(
        locale === 'zh'
          ? generalizedErrorMessageChinese(nextError, copy.mutationFailed)
          : generalizedErrorMessage(nextError, copy.mutationFailed),
      );
    } finally {
      setPendingPath(null);
    }
  };

  const revertFile = async (path: string) => {
    const confirmed = await toast.confirm({
      title: copy.revertTitle,
      description: copy.revertDescription(path),
      confirmLabel: copy.revertConfirm,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (confirmed) await mutateFile(path, 'revert');
  };

  useEffect(() => {
    setVisibleFileCount(REVIEW_FILE_PAGE_SIZE);
  }, [gitSnapshot?.revision, source]);

  return (
    <Section
      variant="transparent"
      padding={0}
      className="maka-session-review-panel"
      aria-label={copy.ariaLabel}
      aria-busy={loading || undefined}
    >
      <Toolbar
        size="sm"
        label={copy.ariaLabel}
        className="maka-session-review-toolbar"
        startContent={
          <div className="maka-session-review-source">
            <SegmentedControl
              value={source}
              onChange={(value) => setSource(value as ReviewSource)}
              label={copy.sourceLabel}
              size="sm"
            >
              <SegmentedControlItem value="branch" label={copy.branchSource} />
              <SegmentedControlItem value="unstaged" label={copy.unstagedSource} />
              <SegmentedControlItem value="staged" label={copy.stagedSource} />
              <SegmentedControlItem value="last-turn" label={copy.lastTurnSource} />
            </SegmentedControl>
          </div>
        }
        endContent={
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            label={copy.refresh}
            icon={<RotateCw size={14} aria-hidden />}
            isLoading={loading}
            onClick={() => void load()}
          />
        }
      />
      <div className="maka-session-review-summary">
        <span>{copy.summary(stats.files, stats.additions, stats.deletions)}</span>
        {source === 'branch' &&
        gitSnapshot &&
        gitSnapshot.baseBranchOptions.length > 0 ? (
          <DropdownMenu
            button={{
              label: comparison ?? copy.branchSource,
              variant: 'ghost',
              size: 'sm',
            }}
            alignment="end"
            items={gitSnapshot.baseBranchOptions.map((branch) => ({
              label: branch,
              icon:
                branch === gitSnapshot.baseBranch ? (
                  <Check size={14} aria-hidden />
                ) : undefined,
              onClick: () => setBaseBranch(branch),
            }))}
          />
        ) : comparison ? (
          <span>{comparison}</span>
        ) : null}
      </div>
      {error ? (
        <Banner
          status="error"
          title={error}
          endContent={
            <Button variant="ghost" size="sm" label={copy.retry} onClick={() => void load()} />
          }
        />
      ) : null}
      {sourceError ? (
        <EmptyState
          isCompact
          icon={<GitBranch size={20} aria-hidden />}
          title={sourceError}
        />
      ) : null}
      {gitSnapshot?.truncated ? (
        <Banner status="info" title={copy.truncated} />
      ) : null}
      {empty ? (
        <EmptyState
          isCompact
          icon={<GitBranch size={20} aria-hidden />}
          title={copy.empty}
        />
      ) : null}
      {source === 'last-turn' && lastTurnDiffs.length > 0 ? (
        <div className="maka-session-review-list">
          {lastTurnDiffs.map((message) => (
            <ToolResultPreview key={message.id} content={message.content} />
          ))}
        </div>
      ) : null}
      {source !== 'last-turn' && gitFiles.length > 0 ? (
        <div className="maka-session-review-list">
          {visibleGitFiles.map((file) => (
            <ToolResultPreview
              key={`${gitSnapshot?.revision}:${file.path}`}
              fileDiffActions={
                mutationAction ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      label={
                        mutationAction === 'stage'
                          ? copy.stageFile
                          : copy.unstageFile
                      }
                      icon={
                        mutationAction === 'stage'
                          ? <Plus size={14} aria-hidden />
                          : <Minus size={14} aria-hidden />
                      }
                      isLoading={pendingPath === file.path}
                      isDisabled={pendingPath !== null}
                      onClick={() => void mutateFile(file.path)}
                    />
                    {mutationAction === 'stage' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        label={copy.revertFile}
                        icon={<RotateCcw size={14} aria-hidden />}
                        isDisabled={pendingPath !== null}
                        onClick={() => void revertFile(file.path)}
                      />
                    ) : null}
                  </>
                ) : undefined
              }
              content={{
                kind: 'file_diff',
                paths: [file.path],
                diff: file.diff,
              }}
            />
          ))}
          {remainingGitFiles > 0 ? (
            <div className="maka-session-review-more">
              <Button
                variant="ghost"
                size="sm"
                label={copy.showMore(remainingGitFiles)}
                onClick={() =>
                  setVisibleFileCount((current) =>
                    Math.min(gitFiles.length, current + REVIEW_FILE_PAGE_SIZE),
                  )
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
