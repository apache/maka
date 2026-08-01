import { isDeepStrictEqual } from 'node:util';
import type { FixedPromptControllerResult } from './fixed-prompt-controller.js';
import type {
  FixedPromptWalEvent,
  PromptCandidateCommittedEvent,
  PromptCandidateDecisionEvent,
  RsiControllerAttributionEvent,
} from './fixed-prompt-wal-types.js';
import type { PromptAcceptanceResult } from './prompt-acceptance-policy.js';
import {
  assertCandidateMatchesStableTaskSet,
  matchesRun,
  readPromptHashAtCommit,
  type PromptOptimizationReplayState,
} from './prompt-optimization-replay-state.js';
import {
  replayControllerSweep,
  replayRequiredControllerSweep,
} from './prompt-optimization-replay-sweeps.js';
import { validateRsiControllerAttribution } from './rsi-controller-attribution.js';

export interface ReplayedPromptDecisionRound {
  decision: PromptCandidateDecisionEvent;
  sampling: FixedPromptControllerResult | undefined;
  executedHeldIn: FixedPromptControllerResult;
  executedHeldOut: FixedPromptControllerResult | undefined;
  heldIn: FixedPromptControllerResult;
  heldOut: FixedPromptControllerResult | undefined;
  attribution: RsiControllerAttributionEvent;
}

export function assertReplayedDecisionMatchesResult(
  decision: PromptCandidateDecisionEvent,
  result: PromptAcceptanceResult,
): void {
  const replayedDecision = {
    decision: result.decision,
    reason: result.reason,
    candidateCommitSha: result.candidateCommitSha,
    previousLastKeptCommitSha: result.previousLastKeptCommitSha,
    lastKeptCommitSha: result.lastKeptCommitSha,
    previousHeldInReferencePassEligibleRate: result.previousHeldInReferencePassEligibleRate,
    heldInReferencePassEligibleRate: result.heldInReferencePassEligibleRate,
    originalCommitSha: result.originalCommitSha,
    originalHeldOutPassEligibleRate: result.originalHeldOutPassEligibleRate,
    heldInPassRateNoiseBand: result.heldInPassRateNoiseBand,
    heldOutPassRateNoiseBand: result.heldOutPassRateNoiseBand,
    rewardHackScan: result.rewardHackScan,
    samplingPromptHash: result.samplingPromptHash,
    metrics: result.metrics,
  };
  const persistedDecision = {
    decision: decision.decision,
    reason: decision.reason,
    candidateCommitSha: decision.candidateCommitSha,
    previousLastKeptCommitSha: decision.previousLastKeptCommitSha,
    lastKeptCommitSha: decision.lastKeptCommitSha,
    previousHeldInReferencePassEligibleRate: decision.previousHeldInReferencePassEligibleRate,
    heldInReferencePassEligibleRate: decision.heldInReferencePassEligibleRate,
    originalCommitSha: decision.originalCommitSha,
    originalHeldOutPassEligibleRate: decision.originalHeldOutPassEligibleRate,
    heldInPassRateNoiseBand: decision.heldInPassRateNoiseBand,
    heldOutPassRateNoiseBand: decision.heldOutPassRateNoiseBand,
    rewardHackScan: decision.rewardHackScan,
    samplingPromptHash: decision.samplingPromptHash,
    metrics: decision.metrics,
  };
  if (
    !isDeepStrictEqual(persistedDecision, replayedDecision) &&
    !isLegacyRewardHackReportOnlyMismatch(persistedDecision, replayedDecision)
  ) {
    throw new Error(`RSI WAL replay decision mismatch for ${decision.roundId}`);
  }
}

function isLegacyRewardHackReportOnlyMismatch(
  persistedDecision: Record<string, unknown>,
  replayedDecision: Record<string, unknown>,
): boolean {
  const { rewardHackScan: persistedScan, ...persistedWithoutScan } = persistedDecision;
  const { rewardHackScan: replayedScan, ...replayedWithoutScan } = replayedDecision;
  return (
    isDeepStrictEqual(persistedWithoutScan, replayedWithoutScan) &&
    isVerifierPatternQuarantine(persistedScan) &&
    isCleanRewardHackScan(replayedScan)
  );
}

function isVerifierPatternQuarantine(scan: unknown): boolean {
  return isRecord(scan) && scan.decision === 'quarantine' && scan.reason === 'verifier_pattern';
}

function isCleanRewardHackScan(scan: unknown): boolean {
  return isRecord(scan) && scan.decision === 'clean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function replayPromptDecisionRound(input: {
  events: readonly FixedPromptWalEvent[];
  state: PromptOptimizationReplayState;
  runId: string;
  roundId: string;
  heldInTaskIds: readonly string[];
  heldOutTaskIds: readonly string[];
  executedHeldInTaskIds?: readonly string[];
  executedHeldOutTaskIds?: readonly string[];
  resumeFingerprint?: string;
  promptRepoDir?: string;
  systemPromptGitPath?: string;
  heldInResultsTsvPath: string;
  heldOutResultsTsvPath: string;
}): Promise<ReplayedPromptDecisionRound | undefined> {
  const decision = input.state.decisionByRoundId.get(input.roundId);
  if (!decision) return undefined;
  const candidate = input.state.candidateByRoundId.get(input.roundId);
  if (!candidate) {
    throw new Error(`RSI WAL replay missing candidate commit for decided ${input.roundId}`);
  }
  assertCandidateMatchesStableTaskSet(candidate, input.heldInTaskIds);
  if (!decision.rewardHackScan) {
    throw new Error(`RSI WAL replay missing reward-hack scan evidence for ${input.roundId}`);
  }
  const attribution = replayDecisionAttribution({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    candidate,
    decision,
  });
  const sampling = decision.samplingPromptHash
    ? await awaitReplaySampling(input, decision)
    : undefined;
  const heldIn = replayRequiredControllerSweep({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    taskIds: input.heldInTaskIds,
    expectedPromptHash: candidate.promptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldInResultsTsvPath,
    missingEvidenceMessage: `RSI WAL replay missing held-in task evidence for ${input.roundId}`,
  });
  const heldOut = replayControllerSweep({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    taskIds: input.heldOutTaskIds,
    expectedPromptHash: candidate.promptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldOutResultsTsvPath,
  });
  const executedHeldIn = replayRequiredControllerSweep({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    taskIds: input.executedHeldInTaskIds ?? input.heldInTaskIds,
    expectedPromptHash: candidate.promptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldInResultsTsvPath,
    missingEvidenceMessage: `RSI WAL replay missing executed held-in task evidence for ${input.roundId}`,
  });
  const executedHeldOut = replayControllerSweep({
    events: input.events,
    runId: input.runId,
    roundId: input.roundId,
    taskIds: input.executedHeldOutTaskIds ?? input.heldOutTaskIds,
    expectedPromptHash: candidate.promptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldOutResultsTsvPath,
  });
  return {
    decision,
    sampling,
    executedHeldIn,
    executedHeldOut,
    heldIn,
    heldOut,
    attribution,
  };
}

async function awaitReplaySampling(
  input: {
    events: readonly FixedPromptWalEvent[];
    state: PromptOptimizationReplayState;
    runId: string;
    roundId: string;
    heldInTaskIds: readonly string[];
    executedHeldInTaskIds?: readonly string[];
    resumeFingerprint?: string;
    promptRepoDir?: string;
    systemPromptGitPath?: string;
    heldInResultsTsvPath: string;
  },
  decision: PromptCandidateDecisionEvent,
): Promise<FixedPromptControllerResult> {
  const samplingPromptHash = decision.samplingPromptHash;
  if (!samplingPromptHash) {
    throw new Error(`RSI WAL replay missing sampling prompt hash for ${input.roundId}`);
  }
  if (input.promptRepoDir && input.systemPromptGitPath) {
    const expectedPromptHash = await readPromptHashAtCommit({
      promptRepoDir: input.promptRepoDir,
      commitSha: decision.previousLastKeptCommitSha,
      systemPromptGitPath: input.systemPromptGitPath,
    });
    if (expectedPromptHash !== samplingPromptHash) {
      throw new Error(`RSI WAL replay sampling prompt hash mismatch for ${input.roundId}`);
    }
  }
  const candidateIndex = input.events.findIndex(
    (event) => event === input.state.candidateByRoundId.get(input.roundId),
  );
  if (candidateIndex < 0) {
    throw new Error(`RSI WAL replay missing candidate event for ${input.roundId}`);
  }
  return replayRequiredControllerSweep({
    // Sampling is a pre-candidate control arm. Evidence written after the
    // candidate commit must not be accepted merely because it precedes the
    // decision event.
    events: input.events.slice(0, candidateIndex),
    runId: input.runId,
    roundId: `sampling-${input.roundId.slice('round-'.length)}`,
    taskIds: input.executedHeldInTaskIds ?? input.heldInTaskIds,
    expectedPromptHash: samplingPromptHash,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    resultsTsvPath: input.heldInResultsTsvPath,
    missingEvidenceMessage: `RSI WAL replay missing sampling baseline evidence for ${input.roundId}`,
  });
}

function replayDecisionAttribution(input: {
  events: readonly FixedPromptWalEvent[];
  runId: string;
  roundId: string;
  candidate: PromptCandidateCommittedEvent;
  decision: PromptCandidateDecisionEvent;
}): RsiControllerAttributionEvent {
  const decisionIndex = input.events.findIndex((event) => event === input.decision);
  if (decisionIndex < 0) {
    throw new Error(`RSI WAL replay missing decision event for ${input.roundId}`);
  }
  const preDecisionAttribution = input.events
    .slice(0, decisionIndex)
    .find((event) => attributionMatchesRound(event, input.runId, input.roundId));
  if (preDecisionAttribution) {
    throw new Error(`RSI WAL replay found RSI attribution before decision for ${input.roundId}`);
  }

  let attribution: RsiControllerAttributionEvent | undefined;
  for (const event of input.events.slice(decisionIndex + 1)) {
    if (!matchesRun(event, input.runId)) continue;
    if (event.type === 'prompt_candidate_committed') break;
    if (event.type !== 'rsi_controller_attribution' || event.roundId !== input.roundId) continue;
    assertAttributionMatchesCandidate(event, input.candidate, input.roundId);
    if (attribution) {
      throw new Error(`RSI WAL replay found duplicate RSI attribution for ${input.roundId}`);
    }
    attribution = event;
  }
  if (!attribution) {
    throw new Error(
      `RSI WAL replay missing post-decision RSI attribution evidence for ${input.roundId}`,
    );
  }
  const attributionValidation = validateRsiControllerAttribution({
    attribution,
    candidateRationale: input.candidate.candidateRationale,
    heldInTaskIds: input.candidate.heldInTaskIds,
    decision: input.decision,
  });
  if (attributionValidation.malformed || attributionValidation.outOfScope) {
    throw new Error(`RSI WAL replay invalid RSI attribution evidence for ${input.roundId}`);
  }
  return attribution;
}

function attributionMatchesRound(
  event: FixedPromptWalEvent,
  runId: string,
  roundId: string,
): event is RsiControllerAttributionEvent {
  return (
    event.type === 'rsi_controller_attribution' &&
    event.runId === runId &&
    event.roundId === roundId
  );
}

function assertAttributionMatchesCandidate(
  event: RsiControllerAttributionEvent,
  candidate: PromptCandidateCommittedEvent,
  roundId: string,
): void {
  if (event.candidateCommitSha !== candidate.commitSha) {
    throw new Error(`RSI WAL replay found attribution candidate mismatch for ${roundId}`);
  }
  if (event.heldInTaskSetHash !== candidate.heldInTaskSetHash) {
    throw new Error(`RSI WAL replay found attribution task-set mismatch for ${roundId}`);
  }
  if (event.candidateRationaleHash !== candidate.candidateRationaleHash) {
    throw new Error(`RSI WAL replay found attribution rationale mismatch for ${roundId}`);
  }
}
