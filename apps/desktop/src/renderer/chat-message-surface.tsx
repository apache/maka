import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { isDeepResearchSession } from '@maka/core/explore-agent';
import { type LlmConnection, type ProviderType } from '@maka/core/llm-connections';
import { type OnboardingState } from '@maka/core/onboarding';
import { type SettingsSection } from '@maka/core/settings';
import { Skeleton } from '@astryxdesign/core';
import {
  Banner,
  Button,
  ChatView,
  useUiLocale,
  type LiveContentActivationSnapshot,
  type LiveTurnProjection,
} from '@maka/ui';
import { OnboardingHero } from './onboarding-hero';
import type { AppShellSessionUiState, AppShellSessionUiStateController } from './app-shell-session-ui-state';
import type { SessionHealthNoticeView } from './use-shell-chat-model';
import type { WorkspaceReadinessRecovery } from './workspace-readiness-recovery';
import type { TaskReadinessNotice } from './task-readiness-notice';
import { getShellCopy } from './locales/shell-copy';
import { selectLiveTurn } from './use-app-shell-session-ui-reads';
import { useAppShellSessionUiSelector } from './use-app-shell-session-ui-selector';
import { useDeepResearchRun } from './use-deep-research-run';

const selectShellRunRecord = (state: AppShellSessionUiState, sessionId: string | undefined) =>
  sessionId ? state.shellRunUpdatesBySession[sessionId] : undefined;

/**
 * The sessions-section message surface (issue #1043): ChatView plus the
 * session-health notice that sits above the composer. The setup hero
 * (OnboardingHero) is constructed here from the onboarding snapshot so
 * AppShell only forwards the orchestration callbacks.
 *
 * AppShell renders this as the `sessions` branch of the section switch, so it
 * is conditionally mounted - the always-mounted Composer lives in a separate
 * region and is not affected by this surface mounting or unmounting.
 */
interface ChatMessageSurfaceProps extends Omit<
  ComponentProps<typeof ChatView>,
  | 'deepResearchRun'
  | 'emptyOverride'
  | 'initialLiveContentSnapshot'
  | 'liveTurn'
  | 'shellRunUpdates'
> {
  /**
   * #1985: the live projection and the shell-run records are the only session
   * UI state that changes per streamed token, and this surface is their only
   * renderer. It subscribes to them here rather than taking them as props, so
   * a delta never reaches AppShell and re-renders the sidebar and composer.
   */
  sessionUiController: AppShellSessionUiStateController;
  /** The shell's selected session. Not derived from `activeSession`, which the shell substitutes for an unsaved chat. */
  activeSessionId: string | undefined;
  /** Advances after Runtime Host has seeded the active session's current live projection. */
  liveContentSeedRevision: number;
  sessionHealthNotice?: SessionHealthNoticeView;
  workspaceReadinessRecovery?: WorkspaceReadinessRecovery;
  taskReadinessNotice?: TaskReadinessNotice;
  onTaskReadinessAction?: () => void;
  showOnboardingHero: boolean;
  onboardingState: OnboardingState | undefined;
  isOnboardingLoading: boolean;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenConnectionDetail: (connectionSlug: string) => void;
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  connections: LlmConnection[];
  onRefreshConnections: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}

function captureLiveContent(
  liveTurn: LiveTurnProjection | undefined,
): LiveContentActivationSnapshot | undefined {
  if (!liveTurn) return undefined;
  return {
    turnId: liveTurn.turnId,
    entries: new Map(liveTurn.steps.flatMap((step) => [
      ...(step.thinking?.text ? [[`thinking:${step.stepId}`, step.thinking.text] as const] : []),
      ...(step.text?.text ? [[`text:${step.stepId}`, step.text.text] as const] : []),
    ])),
  };
}

export function ChatMessageSurface({
  sessionUiController,
  activeSessionId,
  liveContentSeedRevision,
  sessionHealthNotice,
  workspaceReadinessRecovery,
  taskReadinessNotice,
  onTaskReadinessAction,
  showOnboardingHero,
  onboardingState,
  isOnboardingLoading,
  onOpenSettings,
  onOpenConnectionDetail,
  onAddProvider,
  onBrowseProviders,
  connections,
  onRefreshConnections,
  onSkip,
  ...chatViewRest
}: ChatMessageSurfaceProps) {
  const copy = getShellCopy(useUiLocale()).app;
  // Every session-health-notice CTA routes to 设置 · 模型 (U1); this is the
  // action button's visible label.
  const goToModelsLabel = copy.goToModels;
  const handleWorkspaceRecovery = () => {
    const target = workspaceReadinessRecovery?.target;
    if (!target) return;
    switch (target.kind) {
      case 'provider_catalog':
        onBrowseProviders();
        return;
      case 'models':
        onOpenSettings('models');
        return;
      case 'connection':
        onOpenConnectionDetail(target.connectionSlug);
        return;
    }
  };
  const activeSession = chatViewRest.activeSession;
  const deepResearchRun = useDeepResearchRun(
    activeSession?.id,
    isDeepResearchSession(activeSession?.labels),
  );
  const liveTurn = useAppShellSessionUiSelector(sessionUiController, selectLiveTurn, activeSessionId);
  const [activation, setActivation] = useState(() => ({
    sessionId: activeSessionId,
    seedRevision: liveContentSeedRevision,
    initialLiveContent: captureLiveContent(liveTurn),
  }));
  if (
    activation.sessionId !== activeSessionId
    || activation.seedRevision !== liveContentSeedRevision
  ) {
    setActivation({
      sessionId: activeSessionId,
      seedRevision: liveContentSeedRevision,
      initialLiveContent: captureLiveContent(liveTurn),
    });
  } else if (
    activation.initialLiveContent
    && (
      !liveTurn
      || liveTurn.terminal
      || liveTurn.turnId !== activation.initialLiveContent.turnId
    )
  ) {
    setActivation({
      sessionId: activeSessionId,
      seedRevision: liveContentSeedRevision,
      initialLiveContent: undefined,
    });
  }
  // Select the raw per-session record: its identity is the store's own, so a
  // change to any OTHER map cannot rebuild the array. Deriving it in the
  // selector would need a comparator to say the same thing, and would still
  // recompute once per store change.
  const shellRunUpdateRecord = useAppShellSessionUiSelector(
    sessionUiController,
    selectShellRunRecord,
    activeSessionId,
  );
  const shellRunUpdates = useMemo(
    () => Object.values(shellRunUpdateRecord ?? {}),
    [shellRunUpdateRecord],
  );
  const emptyOverride: ReactNode =
    showOnboardingHero && onboardingState ? (
      <div className="maka-onboarding-surface" data-maka-contract="onboarding-surface">
        <OnboardingHero
          state={onboardingState}
          onOpenSettings={onOpenSettings}
          onOpenConnectionDetail={onOpenConnectionDetail}
          onAddProvider={onAddProvider}
          onBrowseProviders={onBrowseProviders}
          connections={connections}
          onRefreshConnections={onRefreshConnections}
          onSkip={onSkip}
        />
      </div>
    ) : isOnboardingLoading ? (
      // Blocks EmptyChatHero from flashing while the first snapshot resolves.
      // Astryx Skeleton bars (DESIGN.md §10) in the ready card's own frame —
      // the hand-drawn static ::before/::after bars this replaces never pulsed,
      // so the first screen a new user saw read as frozen.
      (<div
        className="maka-onboarding-loading"
        role="status"
        aria-busy="true"
        aria-label={copy.loading}
      >
        <Skeleton width="52%" height={16} radius="rounded" index={0} />
        <Skeleton width="78%" height={12} radius="rounded" index={1} />
      </div>)
    ) : undefined;

  return (
    <>
      <ChatView
        {...chatViewRest}
        liveTurn={liveTurn}
        initialLiveContentSnapshot={activation.sessionId === activeSessionId
          ? activation.initialLiveContent
          : captureLiveContent(liveTurn)}
        shellRunUpdates={shellRunUpdates}
        deepResearchRun={deepResearchRun}
        emptyOverride={emptyOverride}
      />
      {taskReadinessNotice && (
        <div className="maka-workspace-readiness-notice">
          <Banner
            status={taskReadinessNotice.tone === 'destructive' ? 'error' : 'warning'}
            className="maka-workspace-readiness-notice-alert"
            role="status"
            title={taskReadinessNotice.title}
            description={taskReadinessNotice.description}
            endContent={onTaskReadinessAction ? <Button
              label={taskReadinessNotice.actionLabel}
              variant="ghost"
              size="sm"
              onClick={onTaskReadinessAction}
            /> : undefined} />
        </div>
      )}
      {workspaceReadinessRecovery && (
        <div className="maka-workspace-readiness-notice">
          <Banner
            status={workspaceReadinessRecovery.tone === 'destructive' ? 'error' : 'warning'}
            className="maka-workspace-readiness-notice-alert"
            role="status"
            title={workspaceReadinessRecovery.title}
            description={workspaceReadinessRecovery.description}
            endContent={<Button
              label={workspaceReadinessRecovery.actionLabel}
              variant="ghost"
              size="sm"
              onClick={handleWorkspaceRecovery}
            />} />
        </div>
      )}
      {sessionHealthNotice && (
        <div className="maka-session-health-notice">
          <Banner
            status={sessionHealthNotice.tone === 'destructive' ? 'error' : sessionHealthNotice.tone === 'warning' ? 'warning' : 'info'}
            className="maka-session-health-notice-alert"
            role="status"
            aria-label={sessionHealthNotice.tooltip ?? sessionHealthNotice.label}
            title={sessionHealthNotice.label}
            description={sessionHealthNotice.tooltip}
            endContent={<Button
              label={goToModelsLabel}
              variant="ghost"
              size="sm"
              onClick={sessionHealthNotice.onClick}
            />} />
        </div>
      )}
    </>
  );
}
