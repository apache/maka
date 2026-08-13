import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { redactSecrets as displayRedactSecrets } from '@maka/core/display-redaction';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type GitReviewReadResult } from '@maka/core/git-review';
import { DiffCodePreview, useUiLocale } from '@maka/ui';
import { ICON_SIZE, GitBranch } from '@maka/ui/icons';
import { getDesktopConversationCopy } from './locales/conversation-copy';

const REVIEW_FILE_PAGE_SIZE = 20;
const REVIEW_DIFF_LINE_CAP = 500;
const REVIEW_SKELETON_ROWS = [0, 1, 2, 3] as const;

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
  const copy = getDesktopConversationCopy(locale).reviewPanel;
  const [gitResult, setGitResult] = useState<GitReviewReadResult | null>(null);
  const [loading, setLoading] = useState(false);
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
        source: 'branch',
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
  }, [copy.loadFailed, locale, props.sessionId]);

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
    const refreshAfterExternalChange = () => {
      if (document.visibilityState === 'hidden') return;
      void load();
    };
    window.addEventListener('focus', refreshAfterExternalChange);
    document.addEventListener('visibilitychange', refreshAfterExternalChange);
    void load();
    return () => {
      revisionRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshAfterExternalChange);
      document.removeEventListener('visibilitychange', refreshAfterExternalChange);
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
  const empty = !loading && !error && !sourceError && gitFiles.length === 0;
  useEffect(() => {
    setVisibleFileCount(REVIEW_FILE_PAGE_SIZE);
  }, [gitSnapshot?.revision]);

  return (
    <Section
      variant="transparent"
      padding={4}
      className="maka-session-review-panel"
      role="region"
      aria-label={copy.ariaLabel}
      aria-busy={loading || undefined}
    >
      <VStack gap={3} align="stretch" width="100%">
        {loading && gitResult === null ? (
          <VStack
            gap={2}
            align="stretch"
            aria-hidden="true"
          >
            <Skeleton width="42%" height={16} radius="rounded" index={0} />
            <div className="maka-session-review-loading-list">
              {REVIEW_SKELETON_ROWS.map((index) => (
                <Skeleton key={index} width="100%" height={36} radius={0} index={index + 1} />
              ))}
            </div>
          </VStack>
        ) : null}
        {gitSnapshot && gitFiles.length > 0 ? (
          <VStack gap={1} align="start" className="maka-session-review-summary">
            <Text type="label">{copy.changedFiles(stats.files)}</Text>
            <HStack gap={3} align="center">
              <Text
                type="supporting"
                hasTabularNumbers
                className="maka-session-review-additions"
              >
                {copy.addedLines(stats.additions)}
              </Text>
              <Text
                type="supporting"
                hasTabularNumbers
                className="maka-session-review-deletions"
              >
                {copy.deletedLines(stats.deletions)}
              </Text>
            </HStack>
          </VStack>
        ) : null}
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
        {sourceError ? (
          <Banner
            status="error"
            title={sourceError}
            endContent={
              <Button
                variant="ghost"
                size="sm"
                label={copy.retry}
                isLoading={loading}
                onClick={() => void load()}
              />
            }
          />
        ) : null}
        {gitSnapshot?.truncated ? (
          <Banner status="info" title={copy.truncated} />
        ) : null}
        {empty ? (
          /* Panel empty (DESIGN.md §10 tier 2): the whole panel is empty, so it
             carries icon and description, not the compact form. */
          (<EmptyState
            icon={<GitBranch size={ICON_SIZE.empty} aria-hidden />}
            title={copy.empty}
            description={copy.emptyHelp}
          />)
        ) : null}
        {gitFiles.length > 0 ? (
          <div className="maka-session-review-list">
            <CollapsibleGroup
              key={gitSnapshot?.revision}
              type="single"
              hasDividers
              density="compact"
              role="list"
              aria-label={copy.changedFiles(gitFiles.length)}
            >
              {visibleGitFiles.map((file) => {
                const preview = boundedDiff(file.diff);
                return (
                  <Collapsible
                    key={`${gitSnapshot?.revision}:${file.path}`}
                    value={file.path}
                    className="maka-session-review-file"
                    role="listitem"
                    trigger={
                      <HStack
                        as="span"
                        gap={2}
                        align="center"
                        justify="between"
                        width="100%"
                        className="maka-session-review-file-trigger"
                      >
                        <Text
                          type="code"
                          maxLines={1}
                          className="maka-session-review-file-path"
                        >
                          {file.path}
                        </Text>
                        <HStack
                          as="span"
                          gap={2}
                          align="center"
                          className="maka-session-review-file-stats"
                        >
                          {file.additions > 0 ? (
                            <Text
                              type="supporting"
                              hasTabularNumbers
                              className="maka-session-review-additions"
                            >
                              {copy.added(file.additions)}
                            </Text>
                          ) : null}
                          {file.deletions > 0 ? (
                            <Text
                              type="supporting"
                              hasTabularNumbers
                              className="maka-session-review-deletions"
                            >
                              {copy.deleted(file.deletions)}
                            </Text>
                          ) : null}
                        </HStack>
                      </HStack>
                    }
                  >
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
      </VStack>
    </Section>
  );
}
