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

import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { type LlmConnection, type ProviderType } from '@maka/core/llm-connections';
import { type OnboardingState } from '@maka/core/onboarding';
import { type SettingsSection } from '@maka/core/settings';
import {
  ChatView,
  ChatViewGoalProjectionConsumer,
  useUiLocale,
  type LiveTurnProjection,
} from '@maka/ui';
import { OnboardingHero } from './onboarding-hero';
import type { SessionHealthNoticeView, SessionUiReads } from './features/conversation/index.js';
import type { WorkspaceReadinessRecovery } from './workspace-readiness-recovery';
import { getShellCopy } from './locales/shell-copy';
import { StagedQuoteChatView, TaskReadinessNoticeConsumer } from './features/conversation/index.js';
import { useExternalStoreSelector } from './application/contracts/session-catalog/use-external-store-selector.js';
import { ChatRecoveryNotice, SessionHealthRecoveryNotice } from './chat-recovery-notice';

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
  | 'emptyOverride'
  | 'initialLiveContentSnapshot'
  | 'liveTurns'
  | 'shellRunUpdates'
  | 'goalIndicator'
  | 'conversationItems'
  | 'handleRef'
  | 'pendingQuotes'
  | 'onQuoteAnnotationSubmit'
  | 'onReadAttachmentBytes'
  | 'onResolveImageDelivery'
> {
  /**
   * #1985: the live projection and the shell-run records are the only session
   * UI state that changes per streamed token, and this surface is their only
   * renderer. It subscribes to them here rather than taking them as props, so
   * a delta never reaches AppShell and re-renders the sidebar and composer.
   */
  sessionUiReads: Pick<SessionUiReads, 'liveTurns' | 'shellRuns'>;
  /** The shell's selected session. Not derived from `activeSession`, which the shell substitutes for an unsaved chat. */
  activeSessionId: string | undefined;
  visible?: boolean;
  /** Identifies the active session observation whose seed is visible. */
  liveContentSeedGeneration: number;
  sessionHealthNotice?: SessionHealthNoticeView;
  sessionHealthModelPickerAvailable: boolean;
  workspaceReadinessRecovery?: WorkspaceReadinessRecovery;
  showOnboardingHero: boolean;
  onboardingState: OnboardingState | undefined;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenConnectionDetail: (connectionSlug: string) => void;
  onAddProvider: (providerType: ProviderType) => void;
  onBrowseProviders: () => void;
  connections: LlmConnection[];
  onRefreshConnections: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}

function captureLiveContent(liveTurn: LiveTurnProjection | undefined) {
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
  sessionUiReads,
  visible = true,
  activeSessionId,
  liveContentSeedGeneration,
  sessionHealthNotice,
  sessionHealthModelPickerAvailable,
  workspaceReadinessRecovery,
  showOnboardingHero,
  onboardingState,
  onOpenSettings,
  onOpenConnectionDetail,
  onAddProvider,
  onBrowseProviders,
  connections,
  onRefreshConnections,
  onSkip,
  ...chatViewRest
}: ChatMessageSurfaceProps) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).app;
  // Configuration notices share the Settings label; identity recovery supplies
  // its own label because it opens the composer's connection-and-model picker.
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
  const liveTurns = useExternalStoreSelector(sessionUiReads.liveTurns, activeSessionId, visible);
  const liveTurn = liveTurns?.find((turn) => turn.turnId === chatViewRest.activeTurn?.turnId) ?? liveTurns?.at(-1);
  const seededLiveTurns = liveContentSeedGeneration > 0 ? liveTurns : undefined;
  const [activation, setActivation] = useState(() => ({
    sessionId: activeSessionId,
    seedGeneration: liveContentSeedGeneration,
    initialLiveContent: liveContentSeedGeneration > 0 ? captureLiveContent(liveTurn) : undefined,
  }));
  if (
    activation.sessionId !== activeSessionId
    || activation.seedGeneration !== liveContentSeedGeneration
  ) {
    setActivation({
      sessionId: activeSessionId,
      seedGeneration: liveContentSeedGeneration,
      initialLiveContent: liveContentSeedGeneration > 0 ? captureLiveContent(liveTurn) : undefined,
    });
  } else if (
    activation.initialLiveContent
    && (
      !seededLiveTurns?.some((turn) => turn.turnId === activation.initialLiveContent?.turnId && !turn.terminal)
    )
  ) {
    setActivation({
      sessionId: activeSessionId,
      seedGeneration: liveContentSeedGeneration,
      initialLiveContent: undefined,
    });
  }
  // Select the raw per-session record: its identity is the store's own, so a
  // change to any OTHER map cannot rebuild the array. Deriving it in the
  // selector would need a comparator to say the same thing, and would still
  // recompute once per store change.
  const shellRunUpdateRecord = useExternalStoreSelector(sessionUiReads.shellRuns, activeSessionId, visible);
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
    ) : undefined;

  return (
    <>
      <ChatViewGoalProjectionConsumer>
        {(goalProjection) => (
          <StagedQuoteChatView
            {...chatViewRest}
            liveTurns={seededLiveTurns}
              // Every branch above reseeds `sessionId` to `activeSessionId`, and a
            // render-phase setState re-runs this body before anything commits, so
            // the activation reaching the DOM is always this session's.
            initialLiveContentSnapshot={activation.initialLiveContent}
            shellRunUpdates={shellRunUpdates}
            emptyOverride={emptyOverride}
            goalIndicator={goalProjection.goalIndicator}
          />
        )}
      </ChatViewGoalProjectionConsumer>
      <TaskReadinessNoticeConsumer surface={ChatRecoveryNotice} />
      {workspaceReadinessRecovery && (
        <ChatRecoveryNotice
          status={workspaceReadinessRecovery.tone === 'destructive' ? 'error' : 'warning'}
          title={workspaceReadinessRecovery.title}
          description={workspaceReadinessRecovery.description}
          actionLabel={workspaceReadinessRecovery.actionLabel}
          onAction={handleWorkspaceRecovery}
        />
      )}
      {sessionHealthNotice && (
        <SessionHealthRecoveryNotice
          notice={sessionHealthNotice}
          fallbackActionLabel={goToModelsLabel}
          modelPickerAvailable={sessionHealthModelPickerAvailable}
        />
      )}
    </>
  );
}
