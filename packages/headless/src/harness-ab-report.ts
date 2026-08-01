import type { AbComparisonSummary, AbTokenCostSummary } from './ab-types.js';
import type {
  HarnessOracleAnnotation,
  HarnessOracleAnnotationState,
} from './harness-oracle-registry.js';
import type { HarnessAbRunManifest } from './harness-ab-manifest.js';

export interface HarnessAbArmEffectiveness {
  armId: string;
  passed: number;
  evaluated: number;
  /** passed / evaluated over the arm's OWN valid cells (arm-local denominator):
   * each arm's rate covers the cells that arm actually executed. Since v4 the
   * top-level effectiveness fields use this basis; the shared paired-sample
   * comparison lives in pairedCandidateMinusBaseline and nonBudgetConditional.
   * Runs with unilateral infra gaps therefore score differently from v3,
   * where every rate shared the paired denominator. */
  passRate: number | null;
}

export interface HarnessAbArmBudgetExhaustion {
  armId: string;
  exhausted: number;
  evaluated: number;
  rate: number | null;
}

export interface HarnessAbArmEconomy {
  armId: string;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  tokensPerMetered: number | null;
  costPerMeteredUsd: number | null;
  costPerPassUsd: number | null;
}

export interface HarnessAbReport {
  schemaVersion: 'maka.harness_ab.report.v4';
  runId: string;
  billingMode: 'metered' | 'account-plan';
  runStatus: 'completed' | 'completed_with_gaps' | 'incomplete' | 'stopped';
  stopReason?: NonNullable<AbComparisonSummary['stopReason']>;
  taskCount: number;
  coverage: {
    scheduledCells: number;
    attemptedCells: number;
    modelScoredCells: number;
    infraFailedCells: number;
    unscoredCells: number;
    missingFinalUsageCells: number;
  };
  effectiveness: {
    metric: 'end-to-end-pass@1';
    pairedEvaluated: number;
    baseline: HarnessAbArmEffectiveness;
    candidate: HarnessAbArmEffectiveness;
    /** Delta of the arm-local pass rates (candidate.passRate -
     * baseline.passRate); denominators may differ between arms. */
    candidateMinusBaseline: number | null;
    /** Delta over the shared paired sample only (v3's candidateMinusBaseline
     * basis): both arms are scored on exactly the tasks both evaluated. */
    pairedCandidateMinusBaseline: number | null;
    candidateWins: number;
    baselineWins: number;
    ties: number;
    nonBudgetConditional: {
      /** Diagnostic decomposition over pairs where NEITHER arm exhausted its
       * budget: a budget-killed cell is the harness's own cap firing, not
       * model-failure evidence. Disclosure only — never the headline. */
      pairedEvaluated: number;
      excludedBudgetPairs: number;
      baseline: HarnessAbArmEffectiveness;
      candidate: HarnessAbArmEffectiveness;
      candidateMinusBaseline: number | null;
    };
    budgetExhaustion: {
      baseline: HarnessAbArmBudgetExhaustion;
      candidate: HarnessAbArmBudgetExhaustion;
      candidateMinusBaseline: number | null;
    };
  };
  economy: {
    basis: 'cache-aware-api-equivalent-usd' | 'account-plan-recorded-usd';
    pairedMetered: number;
    missingUsagePairs: number;
    baseline: HarnessAbArmEconomy;
    candidate: HarnessAbArmEconomy;
  };
  execution?: {
    arms: [{ armId: string; placement: string }, { armId: string; placement: string }];
  };
  oracleEvidence?: {
    snapshotFingerprint?: string;
    stateCounts: Partial<Record<HarnessOracleAnnotationState, number>>;
    annotations: HarnessOracleAnnotation[];
    warnings: string[];
  };
}

export interface HarnessAbOracleEvidenceReportInput {
  snapshotFingerprint?: string;
  annotations: readonly HarnessOracleAnnotation[];
  warnings: readonly string[];
}

export function buildHarnessAbReport(
  summary: AbComparisonSummary,
  oracleEvidence?: HarnessAbOracleEvidenceReportInput,
  billingMode: HarnessAbReport['billingMode'] = 'metered',
  manifest?: Pick<HarnessAbRunManifest, 'arms'>,
): HarnessAbReport {
  const coverage = {
    scheduledCells: summary.baseline.attempts + summary.candidate.attempts,
    attemptedCells: summary.baseline.observed + summary.candidate.observed,
    modelScoredCells: summary.baseline.valid + summary.candidate.valid,
    infraFailedCells: summary.baseline.infraFailed + summary.candidate.infraFailed,
    unscoredCells:
      summary.baseline.observed +
      summary.candidate.observed -
      summary.baseline.valid -
      summary.candidate.valid,
    missingFinalUsageCells:
      summary.baseline.missingFinalUsage + summary.candidate.missingFinalUsage,
  };
  const runStatus = summary.stopReason
    ? 'stopped'
    : coverage.attemptedCells < coverage.scheduledCells
      ? 'incomplete'
      : coverage.unscoredCells > 0 || coverage.missingFinalUsageCells > 0
        ? 'completed_with_gaps'
        : 'completed';
  const execution = manifestExecution(manifest);
  return {
    schemaVersion: 'maka.harness_ab.report.v4',
    runId: summary.runId,
    billingMode,
    runStatus,
    ...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
    taskCount: summary.taskCount,
    coverage,
    effectiveness: {
      metric: 'end-to-end-pass@1',
      pairedEvaluated: summary.pairedAttempts.evaluatedPairs,
      baseline: pairedArmEffectiveness(
        summary.baselineArmId,
        summary.baseline.passed,
        summary.baseline.valid,
      ),
      candidate: pairedArmEffectiveness(
        summary.candidateArmId,
        summary.candidate.passed,
        summary.candidate.valid,
      ),
      candidateMinusBaseline: nullableDelta(summary.candidate.passRate, summary.baseline.passRate),
      pairedCandidateMinusBaseline: summary.passRateDelta,
      candidateWins: summary.pairedAttempts.wins,
      baselineWins: summary.pairedAttempts.losses,
      ties: summary.pairedAttempts.ties,
      nonBudgetConditional: {
        pairedEvaluated: summary.pairedAttempts.nonBudgetEvaluatedPairs,
        excludedBudgetPairs: summary.pairedAttempts.budgetExcludedPairIds.length,
        baseline: pairedArmEffectiveness(
          summary.baselineArmId,
          summary.pairedAttempts.baselineNonBudgetPassed,
          summary.pairedAttempts.nonBudgetEvaluatedPairs,
        ),
        candidate: pairedArmEffectiveness(
          summary.candidateArmId,
          summary.pairedAttempts.candidateNonBudgetPassed,
          summary.pairedAttempts.nonBudgetEvaluatedPairs,
        ),
        candidateMinusBaseline: divide(
          summary.pairedAttempts.candidateNonBudgetPassed -
            summary.pairedAttempts.baselineNonBudgetPassed,
          summary.pairedAttempts.nonBudgetEvaluatedPairs,
        ),
      },
      budgetExhaustion: {
        baseline: armBudgetExhaustion(
          summary.baselineArmId,
          summary.baseline.budgetExhausted,
          summary.baseline.valid,
        ),
        candidate: armBudgetExhaustion(
          summary.candidateArmId,
          summary.candidate.budgetExhausted,
          summary.candidate.valid,
        ),
        candidateMinusBaseline: nullableDelta(
          divide(summary.candidate.budgetExhausted, summary.candidate.valid),
          divide(summary.baseline.budgetExhausted, summary.baseline.valid),
        ),
      },
    },
    economy: {
      basis:
        billingMode === 'account-plan'
          ? 'account-plan-recorded-usd'
          : 'cache-aware-api-equivalent-usd',
      pairedMetered: summary.pairedAttempts.fullyMeteredPairs,
      missingUsagePairs: summary.pairedAttempts.missingUsagePairIds.length,
      baseline: armEconomy(
        summary.baselineArmId,
        summary.pairedAttempts.baselineTokenCostSummary,
        summary.pairedAttempts.fullyMeteredPairs,
        summary.pairedAttempts.baselineMeteredPassed,
      ),
      candidate: armEconomy(
        summary.candidateArmId,
        summary.pairedAttempts.candidateTokenCostSummary,
        summary.pairedAttempts.fullyMeteredPairs,
        summary.pairedAttempts.candidateMeteredPassed,
      ),
    },
    ...(execution ? { execution } : {}),
    ...(oracleEvidence
      ? {
          oracleEvidence: {
            ...(oracleEvidence.snapshotFingerprint
              ? { snapshotFingerprint: oracleEvidence.snapshotFingerprint }
              : {}),
            stateCounts: countOracleStates(oracleEvidence.annotations),
            annotations: oracleEvidence.annotations.map((annotation) => ({ ...annotation })),
            warnings: [...oracleEvidence.warnings],
          },
        }
      : {}),
  };
}

export function renderHarnessAbReportCsv(report: HarnessAbReport): string {
  const baselineEffectiveness = report.effectiveness.baseline;
  const candidateEffectiveness = report.effectiveness.candidate;
  const baselineEconomy = report.economy.baseline;
  const candidateEconomy = report.economy.candidate;
  const rows: Array<[string, string, string, number | null, string, number | null, number | null]> =
    [
      [
        'effectiveness',
        'end_to_end_pass_at_1',
        baselineEffectiveness.armId,
        baselineEffectiveness.passRate,
        candidateEffectiveness.armId,
        candidateEffectiveness.passRate,
        report.effectiveness.candidateMinusBaseline,
      ],
      [
        'diagnostic',
        'non_budget_conditional_pass_rate',
        report.effectiveness.nonBudgetConditional.baseline.armId,
        report.effectiveness.nonBudgetConditional.baseline.passRate,
        report.effectiveness.nonBudgetConditional.candidate.armId,
        report.effectiveness.nonBudgetConditional.candidate.passRate,
        report.effectiveness.nonBudgetConditional.candidateMinusBaseline,
      ],
      [
        'diagnostic',
        'budget_exhaustion_rate',
        report.effectiveness.budgetExhaustion.baseline.armId,
        report.effectiveness.budgetExhaustion.baseline.rate,
        report.effectiveness.budgetExhaustion.candidate.armId,
        report.effectiveness.budgetExhaustion.candidate.rate,
        report.effectiveness.budgetExhaustion.candidateMinusBaseline,
      ],
      [
        'effectiveness',
        'passed',
        baselineEffectiveness.armId,
        baselineEffectiveness.passed,
        candidateEffectiveness.armId,
        candidateEffectiveness.passed,
        candidateEffectiveness.passed - baselineEffectiveness.passed,
      ],
      [
        'economy',
        'input_tokens',
        baselineEconomy.armId,
        baselineEconomy.inputTokens,
        candidateEconomy.armId,
        candidateEconomy.inputTokens,
        candidateEconomy.inputTokens - baselineEconomy.inputTokens,
      ],
      [
        'economy',
        'cached_input_tokens',
        baselineEconomy.armId,
        baselineEconomy.cachedInputTokens,
        candidateEconomy.armId,
        candidateEconomy.cachedInputTokens,
        candidateEconomy.cachedInputTokens - baselineEconomy.cachedInputTokens,
      ],
      [
        'economy',
        'uncached_input_tokens',
        baselineEconomy.armId,
        baselineEconomy.uncachedInputTokens,
        candidateEconomy.armId,
        candidateEconomy.uncachedInputTokens,
        candidateEconomy.uncachedInputTokens - baselineEconomy.uncachedInputTokens,
      ],
      [
        'economy',
        'output_tokens',
        baselineEconomy.armId,
        baselineEconomy.outputTokens,
        candidateEconomy.armId,
        candidateEconomy.outputTokens,
        candidateEconomy.outputTokens - baselineEconomy.outputTokens,
      ],
      [
        'economy',
        'total_tokens',
        baselineEconomy.armId,
        baselineEconomy.totalTokens,
        candidateEconomy.armId,
        candidateEconomy.totalTokens,
        candidateEconomy.totalTokens - baselineEconomy.totalTokens,
      ],
      [
        'economy',
        'recorded_cost_usd',
        baselineEconomy.armId,
        baselineEconomy.costUsd,
        candidateEconomy.armId,
        candidateEconomy.costUsd,
        candidateEconomy.costUsd - baselineEconomy.costUsd,
      ],
      [
        'economy',
        'tokens_per_metered',
        baselineEconomy.armId,
        baselineEconomy.tokensPerMetered,
        candidateEconomy.armId,
        candidateEconomy.tokensPerMetered,
        nullableDelta(candidateEconomy.tokensPerMetered, baselineEconomy.tokensPerMetered),
      ],
      [
        'economy',
        'cost_per_metered_usd',
        baselineEconomy.armId,
        baselineEconomy.costPerMeteredUsd,
        candidateEconomy.armId,
        candidateEconomy.costPerMeteredUsd,
        nullableDelta(candidateEconomy.costPerMeteredUsd, baselineEconomy.costPerMeteredUsd),
      ],
      [
        'economy',
        'cost_per_pass_usd',
        baselineEconomy.armId,
        baselineEconomy.costPerPassUsd,
        candidateEconomy.armId,
        candidateEconomy.costPerPassUsd,
        nullableDelta(candidateEconomy.costPerPassUsd, baselineEconomy.costPerPassUsd),
      ],
    ];
  return (
    [
      'run_status,stop_reason,billing_mode,economy_basis,scheduled_cells,attempted_cells,model_scored_cells,infra_failed_cells,unscored_cells,missing_final_usage_cells,paired_evaluated,paired_non_budget_evaluated,budget_excluded_pairs,paired_metered,missing_usage_pairs,axis,metric,baseline_arm,baseline_value,candidate_arm,candidate_value,candidate_minus_baseline',
      ...rows.map((row) =>
        [
          report.runStatus,
          report.stopReason ?? '',
          report.billingMode,
          report.economy.basis,
          report.coverage.scheduledCells,
          report.coverage.attemptedCells,
          report.coverage.modelScoredCells,
          report.coverage.infraFailedCells,
          report.coverage.unscoredCells,
          report.coverage.missingFinalUsageCells,
          report.effectiveness.pairedEvaluated,
          report.effectiveness.nonBudgetConditional.pairedEvaluated,
          report.effectiveness.nonBudgetConditional.excludedBudgetPairs,
          report.economy.pairedMetered,
          report.economy.missingUsagePairs,
          ...row,
        ]
          .map(csvCell)
          .join(','),
      ),
    ].join('\n') + '\n'
  );
}

export function renderHarnessAbReportMarkdown(report: HarnessAbReport): string {
  const { baseline: baselineEffectiveness, candidate: candidateEffectiveness } =
    report.effectiveness;
  const { baseline: baselineEconomy, candidate: candidateEconomy } = report.economy;
  return [
    `# ${baselineEffectiveness.armId} vs ${candidateEffectiveness.armId} — Harness Comparison`,
    '',
    `Status: ${report.runStatus}${report.stopReason ? ` (${report.stopReason})` : ''}.`,
    '',
    `Run: ${report.runId}; tasks: ${report.taskCount}; paired evaluated: ${report.effectiveness.pairedEvaluated}.`,
    ...executionPlacementMarkdown(report),
    `Cell coverage: ${report.coverage.attemptedCells}/${report.coverage.scheduledCells} attempted; ${report.coverage.modelScoredCells} model-scored; ${report.coverage.unscoredCells} unscored (including ${report.coverage.infraFailedCells} infra-failed); ${report.coverage.missingFinalUsageCells} missing final usage.`,
    `Economy coverage: fully metered pairs: ${report.economy.pairedMetered}; missing usage: ${report.economy.missingUsagePairs}.`,
    ...oracleEvidenceMarkdown(report),
    '',
    '## Effectiveness',
    '',
    '| Metric | ' +
      baselineEffectiveness.armId +
      ' | ' +
      candidateEffectiveness.armId +
      ' | Candidate − baseline |',
    '| --- | ---: | ---: | ---: |',
    `| End-to-end Pass@1 | ${rate(baselineEffectiveness.passRate)} (${baselineEffectiveness.passed}/${baselineEffectiveness.evaluated}) | ${rate(candidateEffectiveness.passRate)} (${candidateEffectiveness.passed}/${candidateEffectiveness.evaluated}) | ${rate(report.effectiveness.candidateMinusBaseline)} |`,
    `| Non-budget Conditional Pass Rate | ${rate(report.effectiveness.nonBudgetConditional.baseline.passRate)} (${report.effectiveness.nonBudgetConditional.baseline.passed}/${report.effectiveness.nonBudgetConditional.pairedEvaluated}) | ${rate(report.effectiveness.nonBudgetConditional.candidate.passRate)} (${report.effectiveness.nonBudgetConditional.candidate.passed}/${report.effectiveness.nonBudgetConditional.pairedEvaluated}) | ${rate(report.effectiveness.nonBudgetConditional.candidateMinusBaseline)} |`,
    `| Budget Exhaustion Rate | ${rate(report.effectiveness.budgetExhaustion.baseline.rate)} (${report.effectiveness.budgetExhaustion.baseline.exhausted}/${report.effectiveness.budgetExhaustion.baseline.evaluated}) | ${rate(report.effectiveness.budgetExhaustion.candidate.rate)} (${report.effectiveness.budgetExhaustion.candidate.exhausted}/${report.effectiveness.budgetExhaustion.candidate.evaluated}) | ${rate(report.effectiveness.budgetExhaustion.candidateMinusBaseline)} |`,
    `| Paired outcomes | — | wins ${report.effectiveness.candidateWins}, losses ${report.effectiveness.baselineWins}, ties ${report.effectiveness.ties} | — |`,
    '',
    `The formal paired End-to-end Pass@1 delta is ${rate(report.effectiveness.pairedCandidateMinusBaseline)} across ${report.effectiveness.pairedEvaluated} evaluated pairs; it remains the A/B conclusion input. Non-budget Conditional Pass Rate is diagnostic only and excludes the entire pair when either arm is budget-exhausted (${report.effectiveness.nonBudgetConditional.excludedBudgetPairs} pairs excluded), preserving one shared paired denominator. It helps distinguish solution-quality differences from inference-service speed and Agent turnover efficiency.`,
    '',
    '## Economy',
    '',
    '| Metric | ' + baselineEconomy.armId + ' | ' + candidateEconomy.armId + ' |',
    '| --- | ---: | ---: |',
    `| Total tokens | ${baselineEconomy.totalTokens} | ${candidateEconomy.totalTokens} |`,
    `| Cached input tokens | ${baselineEconomy.cachedInputTokens} | ${candidateEconomy.cachedInputTokens} |`,
    `| Uncached input tokens | ${baselineEconomy.uncachedInputTokens} | ${candidateEconomy.uncachedInputTokens} |`,
    `| Output tokens | ${baselineEconomy.outputTokens} | ${candidateEconomy.outputTokens} |`,
    `| Recorded cost (USD) | ${baselineEconomy.costUsd} | ${candidateEconomy.costUsd} |`,
    `| Cost per fully metered task (USD) | ${value(baselineEconomy.costPerMeteredUsd)} | ${value(candidateEconomy.costPerMeteredUsd)} |`,
    `| Cost per pass (USD) | ${value(baselineEconomy.costPerPassUsd)} | ${value(candidateEconomy.costPerPassUsd)} |`,
    '',
    '## Interpretation boundary',
    '',
    report.billingMode === 'account-plan'
      ? 'No composite score: effectiveness and economy are reported as separate axes. Recorded cost is zero under the frozen account-plan billing profile; real token usage remains the economy measure.'
      : 'No composite score: effectiveness and economy are reported as separate axes. Recorded cost is a cache-aware API-equivalent estimate from the frozen pricing profile.',
    '',
  ].join('\n');
}

function manifestExecution(
  manifest: Pick<HarnessAbRunManifest, 'arms'> | undefined,
): HarnessAbReport['execution'] {
  if (!manifest) return undefined;
  const placements = manifest.arms.map((arm) => {
    const config = recordValue(arm.metadata?.config);
    const execution = recordValue(config?.execution);
    const placement = execution?.placement;
    return typeof placement === 'string' && placement.trim().length > 0
      ? { armId: arm.id, placement }
      : undefined;
  });
  if (placements.every((placement) => placement === undefined)) return undefined;
  if (placements.some((placement) => placement === undefined)) {
    throw new Error('harness report execution placement must be declared for both arms');
  }
  return { arms: placements as NonNullable<HarnessAbReport['execution']>['arms'] };
}

function executionPlacementMarkdown(report: HarnessAbReport): string[] {
  if (!report.execution) return [];
  return [
    `Execution placement: ${report.execution.arms
      .map((arm) => `${arm.armId}=${arm.placement}`)
      .join('; ')}.`,
  ];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countOracleStates(
  annotations: readonly HarnessOracleAnnotation[],
): Partial<Record<HarnessOracleAnnotationState, number>> {
  const counts: Partial<Record<HarnessOracleAnnotationState, number>> = {};
  for (const annotation of annotations)
    counts[annotation.state] = (counts[annotation.state] ?? 0) + 1;
  return counts;
}

function oracleEvidenceMarkdown(report: HarnessAbReport): string[] {
  if (!report.oracleEvidence) return [];
  const order: readonly HarnessOracleAnnotationState[] = [
    'passed',
    'failed',
    'timed_out',
    'infra_failed',
    'stale',
    'missing',
  ];
  const summary = order
    .filter((state) => report.oracleEvidence?.stateCounts[state] !== undefined)
    .map((state) => `${state} ${report.oracleEvidence?.stateCounts[state]}`)
    .join(', ');
  return [
    `Oracle evidence: ${summary || 'none'}.`,
    ...report.oracleEvidence.warnings.map((warning) => `Warning: ${warning}`),
  ];
}

export function assertHarnessAbReportCompleted(report: HarnessAbReport): void {
  if (report.runStatus === 'stopped') {
    throw new Error(`harness A/B stopped: ${report.stopReason ?? 'unknown_reason'}`);
  }
  if (report.runStatus === 'incomplete') {
    throw new Error(
      `harness A/B incomplete: ${report.coverage.attemptedCells}/${report.coverage.scheduledCells} scheduled cells attempted`,
    );
  }
  if (report.runStatus === 'completed_with_gaps') {
    throw new Error(
      `harness A/B completed with gaps: ${report.coverage.unscoredCells} unscored cells; ${report.coverage.missingFinalUsageCells} missing final usage`,
    );
  }
}

function pairedArmEffectiveness(
  armId: string,
  passed: number,
  evaluated: number,
): HarnessAbArmEffectiveness {
  return { armId, passed, evaluated, passRate: divide(passed, evaluated) };
}

function armBudgetExhaustion(
  armId: string,
  exhausted: number,
  evaluated: number,
): HarnessAbArmBudgetExhaustion {
  return { armId, exhausted, evaluated, rate: divide(exhausted, evaluated) };
}

function armEconomy(
  armId: string,
  tokens: AbTokenCostSummary,
  evaluated: number,
  passed: number,
): HarnessAbArmEconomy {
  return {
    armId,
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cacheHitInput,
    uncachedInputTokens: tokens.cacheMissInput,
    outputTokens: tokens.output,
    totalTokens: tokens.total,
    costUsd: tokens.costUsd,
    tokensPerMetered: divide(tokens.total, evaluated),
    costPerMeteredUsd: divide(tokens.costUsd, evaluated),
    costPerPassUsd: divide(tokens.costUsd, passed),
  };
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function nullableDelta(candidate: number | null, baseline: number | null): number | null {
  return candidate === null || baseline === null ? null : candidate - baseline;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rate(input: number | null): string {
  return input === null ? 'n/a' : `${Math.round(input * 10_000) / 100}%`;
}

function value(input: number | null): string {
  return input === null ? 'n/a' : String(input);
}
