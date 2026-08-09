import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  DropdownMenu,
  type DropdownMenuOption,
} from '@astryxdesign/core/DropdownMenu';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import {
  displayRedactSecrets,
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  type GitReviewMutationAction,
  type GitReviewReadResult,
  type GitReviewSource,
} from '@maka/core';
import { DiffCodePreview, useToast, useUiLocale } from '@maka/ui';
import { ICON_SIZE, Check, GitBranch, RotateCw } from '@maka/ui/icons';
import { getDesktopConversationCopy } from './locales/conversation-copy';

const REVIEW_FILE_PAGE_SIZE = 20;
const REVIEW_DIFF_LINE_CAP = 500;

function boundedDiff(diff: string) {
  const lines = displayRedactSecrets(diff).split('\n');
  if (lines.length <= REVIEW_DIFF_LINE_CAP) {
    return { body: lines.join('\n'), hiddenLines: 0 };
  }
  return {
    body: lines.slice(0, REVIEW_DIFF_LINE_CAP).join('\n'),
    hiddenLines: lines.length - REVIEW_DIFF_LINE_CAP,
  };
}

export function SessionReviewPanel(props: {
  sessionId: string;
  active: boolean;
}) {
  const locale = useUiLocale();
  const toast = useToast();
  const copy = getDesktopConversationCopy(locale).reviewPanel;
  const [source, setSource] = useState<GitReviewSource>('branch');
  const [baseBranch, setBaseBranch] = useState<string | undefined>(undefined);
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
      const nextGit = await window.maka.gitReview.read({
        sessionId: props.sessionId,
        source,
        ...(source === 'branch' && baseBranch ? { baseBranch } : {}),
      });
      if (revision !== revisionRef.current) return;
      setGitResult(nextGit);
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

  const gitSnapshot = gitResult?.ok ? gitResult.snapshot : null;
  const gitFiles = gitSnapshot?.files ?? [];
  const visibleGitFiles = gitFiles.slice(0, visibleFileCount);
  const remainingGitFiles = Math.max(0, gitFiles.length - visibleGitFiles.length);
  const stats = {
    files: gitFiles.length,
    additions: gitSnapshot?.additions ?? 0,
    deletions: gitSnapshot?.deletions ?? 0,
  };
  const sourceError =
    gitResult?.ok !== false
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
    gitFiles.length === 0;
  const sourceLabel =
    source === 'branch'
      ? gitSnapshot?.baseBranch
        ? `${copy.branchSource} · ${gitSnapshot.baseBranch}`
        : copy.branchSource
      : source === 'unstaged'
        ? copy.unstagedSource
        : copy.stagedSource;
  const sourceItems: DropdownMenuOption[] = [
    {
      type: 'section',
      title: copy.sourceLabel,
      items: (['branch', 'unstaged', 'staged'] as const).map((value) => ({
        label:
          value === 'branch'
            ? copy.branchSource
            : value === 'unstaged'
              ? copy.unstagedSource
              : copy.stagedSource,
        icon:
          source === value ? <Check size={ICON_SIZE.control} aria-hidden /> : undefined,
        onClick: () => setSource(value),
      })),
    },
    ...(source === 'branch' && gitSnapshot?.baseBranchOptions.length
      ? [
          {
            type: 'section' as const,
            title: copy.compareWith,
            items: gitSnapshot.baseBranchOptions.map((branch) => ({
              label: branch,
              icon:
                branch === gitSnapshot.baseBranch ? (
                  <Check size={ICON_SIZE.control} aria-hidden />
                ) : undefined,
              onClick: () => setBaseBranch(branch),
            })),
          },
        ]
      : []),
  ];

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
      <div className="maka-session-review-header">
        <div className="maka-session-review-scope">
          <DropdownMenu
            button={{ label: sourceLabel, variant: 'ghost', size: 'sm' }}
            items={sourceItems}
          />
        </div>
        <Text
          type="supporting"
          color="secondary"
          hasTabularNumbers
          className="maka-session-review-stats"
        >
          {copy.summary(stats.files, stats.additions, stats.deletions)}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          label={copy.refresh}
          icon={<RotateCw size={ICON_SIZE.control} aria-hidden />}
          isLoading={loading}
          onClick={() => void load()}
        />
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
      {/* A source that cannot be read is a failure, not an absence — it takes
          the same Banner the load error above does, not an EmptyState. */}
      {sourceError ? <Banner status="error" title={sourceError} /> : null}
      {gitSnapshot?.truncated ? (
        <Banner status="info" title={copy.truncated} />
      ) : null}
      {empty ? (
        /* Panel empty (DESIGN.md §10 tier 2): the whole panel is empty, so it
           carries icon and description, not the compact form. */
        <EmptyState
          icon={<GitBranch size={ICON_SIZE.empty} aria-hidden />}
          title={copy.empty}
          description={copy.emptyHelp}
        />
      ) : null}
      {gitFiles.length > 0 ? (
        <div className="maka-session-review-list">
          <CollapsibleGroup
            key={gitSnapshot?.revision}
            type="single"
            defaultValue={visibleGitFiles[0]?.path}
            hasDividers
            density="compact"
          >
            {visibleGitFiles.map((file) => {
              const preview = boundedDiff(file.diff);
              return (
                <Collapsible
                  key={`${gitSnapshot?.revision}:${file.path}`}
                  value={file.path}
                  trigger={
                    <div className="maka-session-review-file-trigger">
                      <Text
                        type="code"
                        maxLines={1}
                        className="maka-session-review-file-path"
                      >
                        {file.path}
                      </Text>
                      <Text
                        type="supporting"
                        color="secondary"
                        hasTabularNumbers
                        className="maka-session-review-file-stats"
                      >
                        <span className="maka-session-review-additions">
                          +{file.additions}
                        </span>{' '}
                        <span className="maka-session-review-deletions">
                          -{file.deletions}
                        </span>
                      </Text>
                    </div>
                  }
                >
                  {mutationAction ? (
                    <div className="maka-session-review-file-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        label={
                          mutationAction === 'stage'
                            ? copy.stageFile
                            : copy.unstageFile
                        }
                        isLoading={pendingPath === file.path}
                        isDisabled={pendingPath !== null}
                        onClick={() => void mutateFile(file.path)}
                      />
                      {mutationAction === 'stage' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          label={copy.revertFile}
                          isDisabled={pendingPath !== null}
                          onClick={() => void revertFile(file.path)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <DiffCodePreview
                    diff={preview.body}
                    paths={[file.path]}
                    className="maka-session-review-diff"
                  />
                  {preview.hiddenLines > 0 ? (
                    <Text type="supporting" color="secondary" display="block">
                      {copy.hiddenLines(preview.hiddenLines)}
                    </Text>
                  ) : null}
                </Collapsible>
              );
            })}
          </CollapsibleGroup>
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
