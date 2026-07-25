import type { ComponentProps, ReactNode } from 'react';
import {
  isDeepResearchSession,
  type LlmConnection,
  type OnboardingState,
  type ProviderType,
  type SettingsSection,
} from '@maka/core';
import { Alert, AlertAction, AlertDescription, AlertTitle, ChatView, useUiLocale } from '@maka/ui';
import { OnboardingHero } from './OnboardingHero';
import type { SessionHealthNoticeView } from './use-shell-chat-model';
import { getShellCopy } from './locales/shell-copy';
import { useDeepResearchRun } from './use-deep-research-run';

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
  'deepResearchRun' | 'emptyOverride'
> {
  sessionHealthNotice?: SessionHealthNoticeView;
  showOnboardingHero: boolean;
  onboardingState: OnboardingState | undefined;
  isOnboardingLoading: boolean;
  onOpenSettings: (section?: SettingsSection) => void;
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  connections: LlmConnection[];
  onRefreshConnections: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}

export function ChatMessageSurface({
  sessionHealthNotice,
  showOnboardingHero,
  onboardingState,
  isOnboardingLoading,
  onOpenSettings,
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
  const activeSession = chatViewRest.activeSession;
  const deepResearchRun = useDeepResearchRun(
    activeSession?.id,
    isDeepResearchSession(activeSession?.labels),
  );
  const emptyOverride: ReactNode =
    showOnboardingHero && onboardingState ? (
      <div className="maka-onboarding-surface">
        <OnboardingHero
          state={onboardingState}
          onOpenSettings={onOpenSettings}
          onAddProvider={onAddProvider}
          onBrowseProviders={onBrowseProviders}
          connections={connections}
          onRefreshConnections={onRefreshConnections}
          onSkip={onSkip}
        />
      </div>
    ) : isOnboardingLoading ? (
      // @kenji review: render a no-op skeleton while the
      // first snapshot resolves so EmptyChatHero doesn't
      // flash. Use an aria-busy live region so screen
      // readers know something is loading.
      <div
        className="maka-onboarding-loading"
        role="status"
        aria-busy="true"
        aria-label={copy.loading}
      />
    ) : undefined;

  return (
    <>
      <ChatView
        {...chatViewRest}
        deepResearchRun={deepResearchRun}
        emptyOverride={emptyOverride}
      />
      {sessionHealthNotice && (
        <div className="maka-session-health-notice">
          <Alert
            className="maka-session-health-notice-alert"
            variant={sessionHealthNotice.tone === 'destructive' ? 'error' : sessionHealthNotice.tone === 'warning' ? 'warning' : 'info'}
            role="status"
            aria-label={sessionHealthNotice.tooltip ?? sessionHealthNotice.label}
            title={sessionHealthNotice.tooltip}
          >
            <AlertTitle>{sessionHealthNotice.label}</AlertTitle>
            {sessionHealthNotice.tooltip ? (
              <AlertDescription>{sessionHealthNotice.tooltip}</AlertDescription>
            ) : null}
            <AlertAction>
              <button
                type="button"
                className="maka-session-health-notice-action"
                onClick={sessionHealthNotice.onClick}
              >
                {goToModelsLabel}
              </button>
            </AlertAction>
          </Alert>
        </div>
      )}
    </>
  );
}
