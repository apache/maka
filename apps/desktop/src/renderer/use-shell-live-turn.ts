import type { SessionSummary } from '@maka/core/session';
import type { LiveTurnSnapshot } from './live-turn-snapshot.js';
import { MODEL_CONTINUING_DELAY_MS, MODEL_PROCESSING_DELAY_MS, RUNNING_STATUS_DELAY_MS, deriveModelWait, deriveTurnActive, type ModelWaitKind } from './model-wait-state.js';
import { useDelayedFlag } from './use-delayed-flag.js';

/**
 * Owns everything the SHELL derives from the active session's live turn: the
 * streaming/settled flags, the in-flight tool signal, and the two #646
 * turn-wait cues.
 *
 * #1985: this takes the low-entropy `LiveTurnSnapshot`, never the projection.
 * The streamed buffers themselves belong to the chat surface, which subscribes
 * to them directly — so a text delta changes nothing here and the shell, the
 * sidebar, and the composer all stay put while an answer streams.
 */
export function useShellLiveTurn(options: {
  liveTurn: LiveTurnSnapshot;
  /** Carries `runningTurnIds` — the authority on turns this renderer did not send. */
  activeSession: SessionSummary | undefined;
}): {
  activeStreamingLive: boolean;
  activeStreamingMessageId: string | undefined;
  hasInFlightLiveTools: boolean;
  hasLiveTurnContent: boolean;
  turnActive: boolean;
  showRunningStatus: boolean;
  showProcessingIndicator: boolean;
  showContinuingIndicator: boolean;
} {
  const { liveTurn, activeSession } = options;
  // `streamingMessageId` is present only once the last text step completed, so
  // its absence is exactly what "still streaming" means.
  const activeStreamingLive = liveTurn.hasStreamingText && liveTurn.streamingMessageId === undefined;

  // #646: the turn's phase drives both the Stop affordance and the two wait
  // cues. `phase` is armed at send with no lag and promoted to 'streamed' on
  // the first content event, which is what separates the connect-to-first-token
  // wait from the later step-to-step lulls; the rising-edge delays
  // (useDelayedFlag) suppress a flash on fast turns.
  //
  // Stop / composer lock: see `deriveTurnActive` for why its two witnesses are
  // ORed and never ANDed. Retiring a stale arm is `settledSessionTransientIds`'
  // job, which covers backgrounded sessions too.
  const turnActive = deriveTurnActive({
    turnPhase: liveTurn.phase,
    armedTurnId: liveTurn.turnId,
    runningTurnIds: activeSession?.runningTurnIds,
  });
  const modelWaitKind: ModelWaitKind = deriveModelWait({
    turnPhase: liveTurn.phase,
    hasStreamingText: liveTurn.hasStreamingText,
    hasThinkingText: liveTurn.hasThinkingText,
    hasInFlightTools: liveTurn.hasInFlightTools,
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
  // The chat transcript's own running status line. It rides `turnActive`, not
  // the wait kind: the two above ask "is the model between steps?", which is
  // the wrong question for a status meant to stay up for the whole turn. Same
  // rising-edge delay, for the same reason — a turn that finishes inside the
  // window never flashes it.
  const showRunningStatus = useDelayedFlag(turnActive, RUNNING_STATUS_DELAY_MS);

  return {
    activeStreamingLive,
    activeStreamingMessageId: liveTurn.streamingMessageId,
    hasInFlightLiveTools: liveTurn.hasInFlightTools,
    hasLiveTurnContent: liveTurn.hasStreamingText || liveTurn.hasThinkingText || liveTurn.hasLiveTools,
    turnActive,
    showRunningStatus,
    showProcessingIndicator,
    showContinuingIndicator,
  };
}
