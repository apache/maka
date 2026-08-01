import type { FixedPromptTaskWalEvent, FixedPromptWalEvent } from './fixed-prompt-wal-types.js';
import { PROMPT_REWARD_HACK_QUARANTINE_REASON } from './prompt-acceptance-policy.js';
import { validateRsiControllerAttribution } from './rsi-controller-attribution.js';

export type PromptStructuralSmokeFailure =
  | 'minimum_rounds_not_met'
  | 'multiple_runs_present'
  | 'task_evidence_missing'
  | 'cost_ceiling_exceeded'
  | 'plumbing_failures_present'
  | 'reward_hack_scan_missing'
  | 'reward_hack_quarantine_present'
  | 'rsi_attribution_missing'
  | 'rsi_attribution_malformed'
  | 'rsi_attribution_task_scope_invalid';

export interface PromptStructuralSmokeReportInput {
  events: readonly FixedPromptWalEvent[];
  minimumRounds?: number;
  costCeilingUsd?: number;
  requireRsiR2Evidence?: boolean;
}

export interface PromptStructuralSmokeReport {
  schemaVersion: 'maka.prompt_structural_smoke.v1';
  status: 'pass' | 'fail';
  minimumRounds: number;
  observedRounds: number;
  decisions: {
    keep: number;
    discard: number;
  };
  taskEvents: {
    completed: number;
    infraFailed: number;
    plumbingFailed: number;
  };
  quarantineCount: number;
  roundsWithoutTaskEvidence: string[];
  roundsWithoutRsiAttribution: string[];
  roundsWithMalformedRsiAttribution: string[];
  roundsWithOutOfScopeRsiAttribution: string[];
  totalCostUsd: number;
  costCeilingUsd?: number;
  failures: PromptStructuralSmokeFailure[];
}

export function promptStructuralSmokeReport(
  input: PromptStructuralSmokeReportInput,
): PromptStructuralSmokeReport {
  const minimumRounds = input.minimumRounds ?? 10;
  const decisionEvents = input.events.filter((event) => event.type === 'prompt_candidate_decided');
  const taskEvents = input.events.filter(isTaskWalEvent);
  const completedTaskEvents = taskEvents.filter((event) => event.type === 'task_completed');
  const observedRounds = new Set(decisionEvents.map((event) => event.roundId)).size;
  const observedRunCount = new Set(decisionEvents.map((event) => event.runId)).size;
  const roundsWithoutTaskEvidence = roundsWithoutPriorTaskEvidence(input.events).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const roundsWithoutRsiAttribution = input.requireRsiR2Evidence
    ? roundsWithoutPostDecisionRsiAttribution(input.events).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
    : [];
  const roundsWithMalformedRsiAttribution = input.requireRsiR2Evidence
    ? malformedRsiAttributionRounds(input.events).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
    : [];
  const roundsWithOutOfScopeRsiAttribution = input.requireRsiR2Evidence
    ? outOfScopeRsiAttributionRounds(input.events).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
    : [];
  const quarantineCount = decisionEvents.filter((event) => isQuarantineDecision(event)).length;
  const totalCostUsd = roundCost(
    sum(
      taskEvents.map((event) => ('tokenSummary' in event ? (event.tokenSummary?.costUsd ?? 0) : 0)),
    ),
  );
  const failures: PromptStructuralSmokeFailure[] = [];
  if (observedRounds < minimumRounds) failures.push('minimum_rounds_not_met');
  if (observedRunCount > 1) failures.push('multiple_runs_present');
  if (roundsWithoutTaskEvidence.length > 0) failures.push('task_evidence_missing');
  if (input.costCeilingUsd !== undefined && totalCostUsd >= input.costCeilingUsd) {
    failures.push('cost_ceiling_exceeded');
  }
  if (taskEvents.some((event) => event.type === 'task_plumbing_failed')) {
    failures.push('plumbing_failures_present');
  }
  if (quarantineCount > 0) failures.push('reward_hack_quarantine_present');
  if (roundsWithoutRsiAttribution.length > 0) failures.push('rsi_attribution_missing');
  if (roundsWithMalformedRsiAttribution.length > 0) failures.push('rsi_attribution_malformed');
  if (roundsWithOutOfScopeRsiAttribution.length > 0)
    failures.push('rsi_attribution_task_scope_invalid');

  return {
    schemaVersion: 'maka.prompt_structural_smoke.v1',
    status: failures.length === 0 ? 'pass' : 'fail',
    minimumRounds,
    observedRounds,
    decisions: {
      keep: decisionEvents.filter((event) => event.decision === 'keep').length,
      discard: decisionEvents.filter((event) => event.decision === 'discard').length,
    },
    taskEvents: {
      completed: completedTaskEvents.length,
      infraFailed: taskEvents.filter((event) => event.type === 'task_infra_failed').length,
      plumbingFailed: taskEvents.filter((event) => event.type === 'task_plumbing_failed').length,
    },
    quarantineCount,
    roundsWithoutTaskEvidence,
    roundsWithoutRsiAttribution,
    roundsWithMalformedRsiAttribution,
    roundsWithOutOfScopeRsiAttribution,
    totalCostUsd,
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    failures,
  };
}

function promptCandidateCommitsByCandidateKey(
  events: readonly FixedPromptWalEvent[],
): Map<string, Extract<FixedPromptWalEvent, { type: 'prompt_candidate_committed' }>> {
  const commits = new Map<
    string,
    Extract<FixedPromptWalEvent, { type: 'prompt_candidate_committed' }>
  >();
  for (const event of events) {
    if (event.type === 'prompt_candidate_committed')
      commits.set(candidateEvidenceKey(event), event);
  }
  return commits;
}

export function renderPromptStructuralSmokeMarkdown(report: PromptStructuralSmokeReport): string {
  const lines = [
    '# Prompt Structural Smoke',
    '',
    `- status: ${report.status}`,
    `- rounds: ${report.observedRounds} / ${report.minimumRounds}`,
    `- decisions: keep=${report.decisions.keep}, discard=${report.decisions.discard}`,
    `- task_events: ${taskEventsSummary(report)}`,
    `- rounds_without_task_evidence: ${report.roundsWithoutTaskEvidence.length}`,
    `- reward_hack_quarantine: ${report.quarantineCount}`,
    `- cost_usd: ${report.totalCostUsd}${costCeilingSuffix(report)}`,
    '',
  ];
  if (report.failures.length > 0) {
    lines.push('## failures', '', ...report.failures.map((failure) => `- ${failure}`), '');
  }
  return `${lines.join('\n')}\n`;
}

function isTaskWalEvent(event: FixedPromptWalEvent): event is FixedPromptTaskWalEvent {
  return (
    event.type === 'task_completed' ||
    event.type === 'task_infra_failed' ||
    event.type === 'task_budget_exhausted' ||
    event.type === 'task_plumbing_failed'
  );
}

function roundEvidenceKey(event: { runId: string; roundId: string }): string {
  return `${event.runId}\0${event.roundId}`;
}

function roundsWithoutPriorTaskEvidence(events: readonly FixedPromptWalEvent[]): string[] {
  const candidatePromptHashes = new Map<string, string>();
  const candidateKeysByRoundAndPromptHash = new Map<string, Set<string>>();
  const taskEvidenceCandidates = new Set<string>();
  const missingRounds = new Map<string, string>();
  for (const event of events) {
    const roundKey = roundEvidenceKey(event);
    if (event.type === 'prompt_candidate_committed') {
      const candidateKey = candidateEvidenceKey(event);
      candidatePromptHashes.set(candidateKey, event.promptHash);
      const roundPromptHashKey = roundPromptHashEvidenceKey(event, event.promptHash);
      const candidateKeys =
        candidateKeysByRoundAndPromptHash.get(roundPromptHashKey) ?? new Set<string>();
      candidateKeys.add(candidateKey);
      candidateKeysByRoundAndPromptHash.set(roundPromptHashKey, candidateKeys);
    }
    if (event.type === 'task_completed' && event.promptHash !== undefined) {
      const candidateKeys = candidateKeysByRoundAndPromptHash.get(
        roundPromptHashEvidenceKey(event, event.promptHash),
      );
      for (const candidateKey of candidateKeys ?? []) {
        taskEvidenceCandidates.add(candidateKey);
      }
    }
    if (event.type === 'prompt_candidate_decided') {
      const candidateKey = decisionCandidateEvidenceKey(event);
      if (!candidatePromptHashes.has(candidateKey) || !taskEvidenceCandidates.has(candidateKey)) {
        missingRounds.set(roundKey, event.roundId);
      }
    }
  }
  return [...missingRounds.values()];
}

function roundsWithoutPostDecisionRsiAttribution(events: readonly FixedPromptWalEvent[]): string[] {
  const attributedCandidates = new Set<string>();
  const missingRounds = new Map<string, string>();
  events.forEach((event, index) => {
    if (event.type === 'rsi_controller_attribution') {
      attributedCandidates.add(attributionCandidateEvidenceKey(event));
    }
    if (event.type === 'prompt_candidate_decided') {
      const candidateKey = decisionCandidateEvidenceKey(event);
      const hasLaterAttribution = hasPostDecisionAttributionBeforeNextCandidate(
        events,
        index,
        candidateKey,
      );
      if (!hasLaterAttribution || attributedCandidates.has(candidateKey)) {
        missingRounds.set(roundEvidenceKey(event), event.roundId);
      }
    }
  });
  return [...missingRounds.values()];
}

function hasPostDecisionAttributionBeforeNextCandidate(
  events: readonly FixedPromptWalEvent[],
  decisionIndex: number,
  candidateKey: string,
): boolean {
  for (const later of events.slice(decisionIndex + 1)) {
    if (
      later.type === 'rsi_controller_attribution' &&
      attributionCandidateEvidenceKey(later) === candidateKey
    ) {
      return true;
    }
    if (later.type === 'prompt_candidate_committed') return false;
  }
  return false;
}

function malformedRsiAttributionRounds(events: readonly FixedPromptWalEvent[]): string[] {
  const commits = promptCandidateCommitsByCandidateKey(events);
  const decisions = promptCandidateDecisionsByCandidateKey(events);
  const rounds = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'rsi_controller_attribution') continue;
    const candidateKey = attributionCandidateEvidenceKey(event);
    const commit = commits.get(candidateKey);
    const decision = decisions.get(candidateKey);
    if (
      !commit ||
      !decision ||
      event.heldInTaskSetHash !== commit.heldInTaskSetHash ||
      event.candidateRationaleHash !== commit.candidateRationaleHash ||
      validateRsiControllerAttribution({
        attribution: event,
        candidateRationale: commit.candidateRationale,
        heldInTaskIds: commit.heldInTaskIds,
        decision,
      }).malformed
    ) {
      rounds.set(roundEvidenceKey(event), event.roundId);
    }
  }
  return [...rounds.values()];
}

function promptCandidateDecisionsByCandidateKey(
  events: readonly FixedPromptWalEvent[],
): Map<string, Extract<FixedPromptWalEvent, { type: 'prompt_candidate_decided' }>> {
  const decisions = new Map<
    string,
    Extract<FixedPromptWalEvent, { type: 'prompt_candidate_decided' }>
  >();
  for (const event of events) {
    if (event.type === 'prompt_candidate_decided')
      decisions.set(decisionCandidateEvidenceKey(event), event);
  }
  return decisions;
}

function outOfScopeRsiAttributionRounds(events: readonly FixedPromptWalEvent[]): string[] {
  const commits = promptCandidateCommitsByCandidateKey(events);
  const decisions = promptCandidateDecisionsByCandidateKey(events);
  const rounds = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'rsi_controller_attribution') continue;
    const commit = commits.get(attributionCandidateEvidenceKey(event));
    const decision = decisions.get(attributionCandidateEvidenceKey(event));
    if (!commit || !decision) continue;
    if (
      validateRsiControllerAttribution({
        attribution: event,
        candidateRationale: commit.candidateRationale,
        heldInTaskIds: commit.heldInTaskIds,
        decision,
      }).outOfScope
    ) {
      rounds.set(roundEvidenceKey(event), event.roundId);
    }
  }
  return [...rounds.values()];
}

function candidateEvidenceKey(event: {
  runId: string;
  roundId: string;
  commitSha: string;
}): string {
  return `${event.runId}\0${event.roundId}\0${event.commitSha}`;
}

function decisionCandidateEvidenceKey(event: {
  runId: string;
  roundId: string;
  candidateCommitSha: string;
}): string {
  return `${event.runId}\0${event.roundId}\0${event.candidateCommitSha}`;
}

function attributionCandidateEvidenceKey(event: {
  runId: string;
  roundId: string;
  candidateCommitSha: string;
}): string {
  return `${event.runId}\0${event.roundId}\0${event.candidateCommitSha}`;
}

function roundPromptHashEvidenceKey(
  event: { runId: string; roundId: string },
  promptHash: string,
): string {
  return `${roundEvidenceKey(event)}\0${promptHash}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isQuarantineDecision(event: { reason: string; rewardHackScan?: unknown }): boolean {
  return (
    event.reason === PROMPT_REWARD_HACK_QUARANTINE_REASON ||
    (event.rewardHackScan !== undefined && !isCleanRewardHackScan(event.rewardHackScan))
  );
}

function isCleanRewardHackScan(scan: unknown): boolean {
  return (
    typeof scan === 'object' && scan !== null && 'decision' in scan && scan.decision === 'clean'
  );
}

function taskEventsSummary(report: PromptStructuralSmokeReport): string {
  return [
    `completed=${report.taskEvents.completed}`,
    `infra_failed=${report.taskEvents.infraFailed}`,
    `plumbing_failed=${report.taskEvents.plumbingFailed}`,
  ].join(', ');
}

function costCeilingSuffix(report: PromptStructuralSmokeReport): string {
  return report.costCeilingUsd === undefined ? '' : ` / ${report.costCeilingUsd}`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
