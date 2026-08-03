import { useMemo } from 'react';
import type { SessionSummary, ShellRunUpdate } from '@maka/core';
import type { LiveTurnProjection, ToolActivityItem } from '@maka/ui';
import type { ShellRunUpdatesBySession } from './shell-run-update-state';
import { hasInFlightToolActivity } from './session-event-health';
import { MODEL_CONTINUING_DELAY_MS, MODEL_PROCESSING_DELAY_MS, deriveModelWait, deriveTurnActive, type ModelWaitKind } from './model-wait-state';
import { useDelayedFlag } from './use-delayed-flag';

/**
 * Owns everything the chat surface derives from the live-turn projection of the
 * active session: the streaming/thinking text slices, the per-session streaming
 * pulse set, the in-flight tool signal, and the two #646 turn-wait indicators.
 *
 * Pure move out of AppShell — `activeLiveTurn` itself stays in AppShell (a
 * source-slice contract pins its declaration there) and is passed in, while the
 * memos keep their exact dependency arrays so `activeShellRunUpdates`,
 * `streamingSessionIds`, `liveTools`, and `hasInFlightLiveTools` retain their
 * referential-stability behavior. The rising-edge delays (`useDelayedFlag`)
 * suppress a flash on fast turns / quick step hops exactly as before.
 */
export function useShellLiveTurn(options: {
  activeId: string | undefined;
  /** Carries `runningTurnId` — the authority on a turn this renderer did not send. */
  activeSession: SessionSummary | undefined;
  activeLiveTurn: LiveTurnProjection | undefined;
  liveTurnBySession: Record<string, LiveTurnProjection>;
  shellRunUpdatesBySession: ShellRunUpdatesBySession;
}): {
  activeShellRunUpdates: ShellRunUpdate[];
  activeStreaming: string;
  activeStreamingComplete: boolean;
  activeStreamingLive: boolean;
  activeStreamingMessageId: string | undefined;
  activeThinking: string;
  streamingSessionIds: Set<string>;
  liveTools: ToolActivityItem[];
  hasInFlightLiveTools: boolean;
  turnActive: boolean;
  showProcessingIndicator: boolean;
  showContinuingIndicator: boolean;
} {
  const { activeId, activeSession, activeLiveTurn, liveTurnBySession, shellRunUpdatesBySession } = options;
  const activeShellRunUpdates = useMemo(
    () => activeId ? Object.values(shellRunUpdatesBySession[activeId] ?? {}) : [],
    [activeId, shellRunUpdatesBySession],
  );
  const activeTextStep = [...(activeLiveTurn?.steps ?? [])].reverse().find((step) => step.text);
  const activeThinkingStep = [...(activeLiveTurn?.steps ?? [])].reverse().find((step) => step.thinking);
  const activeStreaming = activeTextStep?.text?.text ?? '';
  const activeStreamingComplete = activeTextStep?.text?.complete === true;
  const activeStreamingLive = activeStreaming.length > 0 && !activeStreamingComplete;
  const activeStreamingMessageId = activeStreamingComplete ? activeTextStep?.stepId : undefined;
  const activeThinking = activeThinkingStep?.thinking?.text ?? '';
  // Set of session ids with a live streaming delta — drives the sidebar
  // pulse indicator. Recomputed on every live projection change; cheap
  // since the underlying map only has at most a handful of entries.
  const streamingSessionIds = useMemo(
    () => new Set(Object.entries(liveTurnBySession).flatMap(([id, projection]) => (
      projection.steps.some((step) => step.text?.text && !step.text.complete) ? [id] : []
    ))),
    [liveTurnBySession],
  );
  const liveTools = useMemo(() => activeLiveTurn?.steps.flatMap((step) => step.tools) ?? [], [activeLiveTurn]);
  const hasInFlightLiveTools = useMemo(() => hasInFlightToolActivity(liveTools), [liveTools]);

  // #646: the turn's phase drives both the Stop affordance and the two wait
  // cues. `turnPhase` is armed at send with no lag and promoted to 'streamed'
  // on the first content event, which is what separates the
  // connect-to-first-token wait from the later step-to-step lulls; the
  // rising-edge delays (useDelayedFlag) suppress a flash on fast turns.
  //
  // Stop / composer lock: see `deriveTurnActive` for why its two witnesses are
  // ORed and never ANDed. Retiring a stale arm is `settledSessionTransientIds`'
  // job, which covers backgrounded sessions too.
  const activeTurnPhase = activeLiveTurn?.terminal ? undefined : activeLiveTurn?.phase;
  const turnActive = deriveTurnActive({
    turnPhase: activeTurnPhase,
    armedTurnId: activeLiveTurn?.turnId,
    runningTurnId: activeSession?.runningTurnId,
  });
  const modelWaitKind: ModelWaitKind = deriveModelWait({
    turnPhase: activeTurnPhase,
    streamingText: activeStreaming,
    thinkingText: activeThinking,
    hasInFlightTools: hasInFlightLiveTools,
  });
  // The prominent "正在处理…" first-token indicator (turn head only).
  const showProcessingIndicator = useDelayedFlag(
    modelWaitKind === 'processing',
    MODEL_PROCESSING_DELAY_MS,
  );
  // The calm "继续中…" hint for a mid-turn step-to-step lull (after content).
  const showContinuingIndicator = useDelayedFlag(
    modelWaitKind === 'continuing',
    MODEL_CONTINUING_DELAY_MS,
  );

  return {
    activeShellRunUpdates,
    activeStreaming,
    activeStreamingComplete,
    activeStreamingLive,
    activeStreamingMessageId,
    activeThinking,
    streamingSessionIds,
    liveTools,
    hasInFlightLiveTools,
    turnActive,
    showProcessingIndicator,
    showContinuingIndicator,
  };
}
