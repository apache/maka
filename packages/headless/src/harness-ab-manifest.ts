import { createHash } from 'node:crypto';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { buildAbRunManifest, buildRunManifestFingerprint } from './ab-manifest.js';
import type { AbRunManifest } from './ab-types.js';
import type { HarnessOracleAnnotation } from './harness-oracle-registry.js';

export type HarnessAbArmId = 'maka' | 'opencode' | 'kimi-code' | 'codex';

export const HARNESS_AB_PAIR_CONCURRENCY = 2;
export const HARNESS_AB_MAX_CONCURRENT_ATTEMPTS = HARNESS_AB_PAIR_CONCURRENCY * 2;
export const HARNESS_MAKA_CONTEXT_BUDGET = {
  activeToolResultPrune: {
    enabled: true,
    maxCurrentResultEstimatedTokens: 2048,
    minStepNumber: 1,
  },
  staleToolResultPrune: {
    enabled: true,
    maxResultEstimatedTokens: 2048,
    minRecentTurnsFull: 0,
  },
  semanticCompact: {
    enabled: false,
  },
} as const;

// Authoritative snapshot: https://github.com/harbor-framework/terminal-bench-2-1
export const TERMINAL_BENCH_2_1_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';
export const TERMINAL_BENCH_2_1_TASK_TREE_FINGERPRINT =
  'sha256:456826aa4c47ed309716c964c96d2a3acc998764ebc84f3e8449c807d74bd4e7';
export const TERMINAL_BENCH_2_1_TASK_IDS = [
  'adaptive-rejection-sampler',
  'bn-fit-modify',
  'break-filter-js-from-html',
  'build-cython-ext',
  'build-pmars',
  'build-pov-ray',
  'caffe-cifar-10',
  'cancel-async-tasks',
  'chess-best-move',
  'circuit-fibsqrt',
  'cobol-modernization',
  'code-from-image',
  'compile-compcert',
  'configure-git-webserver',
  'constraints-scheduling',
  'count-dataset-tokens',
  'crack-7z-hash',
  'custom-memory-heap-crash',
  'db-wal-recovery',
  'distribution-search',
  'dna-assembly',
  'dna-insert',
  'extract-elf',
  'extract-moves-from-video',
  'feal-differential-cryptanalysis',
  'feal-linear-cryptanalysis',
  'filter-js-from-html',
  'financial-document-processor',
  'fix-code-vulnerability',
  'fix-git',
  'fix-ocaml-gc',
  'gcode-to-text',
  'git-leak-recovery',
  'git-multibranch',
  'gpt2-codegolf',
  'headless-terminal',
  'hf-model-inference',
  'install-windows-3.11',
  'kv-store-grpc',
  'large-scale-text-editing',
  'largest-eigenval',
  'llm-inference-batching-scheduler',
  'log-summary-date-ranges',
  'mailman',
  'make-doom-for-mips',
  'make-mips-interpreter',
  'mcmc-sampling-stan',
  'merge-diff-arc-agi-task',
  'model-extraction-relu-logits',
  'modernize-scientific-stack',
  'mteb-leaderboard',
  'mteb-retrieve',
  'multi-source-data-merger',
  'nginx-request-logging',
  'openssl-selfsigned-cert',
  'overfull-hbox',
  'password-recovery',
  'path-tracing',
  'path-tracing-reverse',
  'polyglot-c-py',
  'polyglot-rust-c',
  'portfolio-optimization',
  'protein-assembly',
  'prove-plus-comm',
  'pypi-server',
  'pytorch-model-cli',
  'pytorch-model-recovery',
  'qemu-alpine-ssh',
  'qemu-startup',
  'query-optimize',
  'raman-fitting',
  'regex-chess',
  'regex-log',
  'reshard-c4-data',
  'rstan-to-pystan',
  'sam-cell-seg',
  'sanitize-git-repo',
  'schemelike-metacircular-eval',
  'sparql-university',
  'sqlite-db-truncate',
  'sqlite-with-gcov',
  'torch-pipeline-parallelism',
  'torch-tensor-parallelism',
  'train-fasttext',
  'tune-mjcf',
  'video-processing',
  'vulnerable-secret',
  'winning-avg-corewars',
  'write-compressor',
] as const;

// Authoritative snapshot: https://github.com/datacurve-ai/deep-swe (113 scored
// leaderboard tasks; the repo tree at this commit carries 117 task dirs).
export const DEEP_SWE_REVISION = '6db64a40f3318d8659238ff34a8cc4b491c49205';

/** 30-task discriminative subset for DeepSWE harness A/Bs (issue #1343).
 * Selected from the public v1.1 leaderboard artifacts
 * (https://deepswe.datacurve.ai/artifacts/v1.1/{trials,tasks}.json) against the
 * `mini_swe_agent_kimi_k3_max` reference config (4 seeds/task): 11 tasks at
 * seed pass rate 0.25 and 17 at 0.50 maximize per-task discrimination, plus
 * one all-fail and one all-pass anchor to catch harness-level regressions. */
export const DEEP_SWE_SUBSET_30_TASK_IDS = [
  // K3 mini-swe-agent seed pass rate 0.25:
  'clack-async-autocomplete-options',
  'httpx-streaming-json-iteration',
  'kea-atomic-signal-selectors',
  'kombu-single-active-consumer-priority',
  'koota-query-predicates',
  'langchain-request-coalescing',
  'onedump-dump-encryption-pipeline',
  'pwntools-tube-multiplexing',
  'quill-shared-toolbar-focus',
  'sqlfmt-create-table-ddl-formatting',
  'termenv-preserve-ansi-resets',
  // K3 mini-swe-agent seed pass rate 0.50:
  'arktype-json-schema-refs-dependencies',
  'csstree-shorthand-expansion-compression',
  'dateutil-rfc5545-timezone-interop',
  'dynamodb-toolbox-lazy-recursive-schemas',
  'go-critic-doc-link-checker',
  'ink-grid-box-layout',
  'koota-pair-relation-tracking',
  'mashumaro-flattened-dataclass-fields',
  'mobly-grouped-test-barriers',
  'ofetch-per-origin-circuit-breaker',
  'optique-conditional-option-dependencies',
  'oxvg-structural-selector-preservation',
  'participle-grammar-conflict-analysis',
  'psd-tools-blend-range-api',
  'scc-bounded-memory-spilling',
  'testem-bail-on-test-failure',
  'yaegi-go-embed-directives',
  // Anchors: K3 all-fail / all-pass.
  'claude-code-by-agents-recursive-delegation',
  'dasel-html-document-format',
] as const;

/** fingerprintFixedPromptTaskTree over the 30 subset task dirs at
 * DEEP_SWE_REVISION — freezes the exact task bytes under comparison. */
export const DEEP_SWE_SUBSET_30_TASK_TREE_FINGERPRINT =
  'sha256:508aedcbe69ebdf6e9253c2eef9ba2575e9db9a25f899eaf0760d29459e843ba';

export function assertDeepSweSubset30TaskTreeFingerprint(actual: string): void {
  if (actual !== DEEP_SWE_SUBSET_30_TASK_TREE_FINGERPRINT) {
    throw new Error(
      `DeepSWE subset-30 task tree fingerprint mismatch; expected ${DEEP_SWE_SUBSET_30_TASK_TREE_FINGERPRINT}, found ${actual}`,
    );
  }
}

export function assertTerminalBench21TaskSet(taskIds: readonly string[]): void {
  const actual = new Set(taskIds);
  const expected = new Set<string>(TERMINAL_BENCH_2_1_TASK_IDS);
  const missing = TERMINAL_BENCH_2_1_TASK_IDS.filter((taskId) => !actual.has(taskId));
  const unexpected = [...actual].filter((taskId) => !expected.has(taskId)).sort();
  if (
    taskIds.length === TERMINAL_BENCH_2_1_TASK_IDS.length &&
    actual.size === expected.size &&
    missing.length === 0 &&
    unexpected.length === 0
  ) {
    return;
  }
  throw new Error(
    `Terminal-Bench 2.1 task set mismatch; expected ${expected.size} unique tasks, found ${actual.size}; missing: ${previewIds(missing)}; unexpected: ${previewIds(unexpected)}`,
  );
}

export function assertTerminalBench21TaskTreeFingerprint(actual: string): void {
  if (actual !== TERMINAL_BENCH_2_1_TASK_TREE_FINGERPRINT) {
    throw new Error(
      `Terminal-Bench 2.1 task tree fingerprint mismatch; expected ${TERMINAL_BENCH_2_1_TASK_TREE_FINGERPRINT}, found ${actual}`,
    );
  }
}

export interface HarnessAbArmInput {
  id: HarnessAbArmId;
  version: string;
  config: Record<string, unknown>;
}

export interface HarnessAbRunManifestInput {
  benchmark: {
    dataset: 'terminal-bench' | 'deep-swe';
    version: '2.1' | '1.1';
    revision: string;
    /** Present only for Pier benchmarks: the frozen executor identity whose
     * version the toolchain fingerprint also hashes. Absent for Harbor
     * benchmarks so existing Terminal-Bench manifests stay byte-identical. */
    executor?: { id: 'pier'; version: string };
    timeoutPolicy: 'task-native';
    timeoutMultiplier: 1;
    /** Maka-only Pier agent-phase tail reserved for artifact settlement. */
    agentSettlementGraceSec?: number;
    outerTimeoutGraceSec: number;
  };
  taskIds: readonly string[];
  orderSeed: string;
  pilotTaskCount: number;
  model: {
    provider: string;
    id: string;
    reasoningEffort: ThinkingLevel;
    credentialIdentity?: {
      connectionSlug: string;
      accountIdHash: string;
    };
  };
  pricing: {
    currency: 'USD';
    unit: 'per_1m_tokens';
    input: number;
    cachedInput: number;
    output: number;
    source: string;
  };
  arms: readonly [HarnessAbArmInput, HarnessAbArmInput];
  taskBudgetSec: null;
  harborTimeoutMs: null;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
  pairConcurrency?: number;
  armExecution?: 'parallel' | 'sequential';
  oracleEvidence?: {
    registryUrl?: string;
    expectedSnapshotFingerprint?: string;
    resolvedSnapshotFingerprint?: string;
    annotations: readonly HarnessOracleAnnotation[];
    warnings: readonly string[];
  };
}

export type HarnessAbRunManifest = AbRunManifest & {
  experimentKind: 'harness';
  metadata: {
    benchmark: HarnessAbRunManifestInput['benchmark'];
    metric: 'pass@1';
    execution: {
      armExecution: 'parallel' | 'sequential';
    };
    order: {
      algorithm: 'sha256-rank-v1';
      seed: string;
      pilotTaskCount: number;
    };
    model: HarnessAbRunManifestInput['model'];
    pricing: HarnessAbRunManifestInput['pricing'];
    qualification?: {
      agent: 'oracle';
      evidenceFingerprint: string;
      verifierPolicyFingerprint: string;
      inspectedTaskIds: readonly string[];
    };
    oracleEvidence?: NonNullable<HarnessAbRunManifestInput['oracleEvidence']>;
  };
  pilotTaskIds: string[];
};

export function deterministicHarnessTaskOrder(taskIds: readonly string[], seed: string): string[] {
  if (seed.length === 0) throw new Error('harness task order seed must not be empty');
  const unique = new Set<string>();
  for (const taskId of taskIds) {
    if (unique.has(taskId)) throw new Error(`duplicate harness task id: ${taskId}`);
    unique.add(taskId);
  }
  return [...unique].sort((left, right) => {
    const rankDelta = taskRank(seed, left).localeCompare(taskRank(seed, right));
    return rankDelta || left.localeCompare(right);
  });
}

export function buildHarnessAbRunManifest(input: HarnessAbRunManifestInput): HarnessAbRunManifest {
  const evaluationTaskIds = deterministicHarnessTaskOrder(input.taskIds, input.orderSeed);
  const pairConcurrency = input.pairConcurrency ?? HARNESS_AB_PAIR_CONCURRENCY;
  const armExecution = input.armExecution ?? 'parallel';
  if (!Number.isSafeInteger(pairConcurrency) || pairConcurrency < 1) {
    throw new Error('pairConcurrency must be a positive integer');
  }
  if (
    !Number.isSafeInteger(input.pilotTaskCount) ||
    input.pilotTaskCount < 1 ||
    input.pilotTaskCount > evaluationTaskIds.length
  ) {
    throw new Error(`pilotTaskCount must be between 1 and ${evaluationTaskIds.length}`);
  }
  const metadata: HarnessAbRunManifest['metadata'] = {
    benchmark: { ...input.benchmark },
    metric: 'pass@1',
    execution: { armExecution },
    order: {
      algorithm: 'sha256-rank-v1',
      seed: input.orderSeed,
      pilotTaskCount: input.pilotTaskCount,
    },
    model: { ...input.model },
    pricing: { ...input.pricing },
    ...(input.oracleEvidence
      ? {
          oracleEvidence: {
            ...input.oracleEvidence,
            annotations: input.oracleEvidence.annotations.map((annotation) => ({ ...annotation })),
            warnings: [...input.oracleEvidence.warnings],
          },
        }
      : {}),
  };
  const manifest = buildAbRunManifest({
    experimentKind: 'harness',
    arms: input.arms.map((arm) => ({
      id: arm.id,
      kind: 'harness' as const,
      fingerprint: buildRunManifestFingerprint({ version: arm.version, config: arm.config }),
      metadata: { version: arm.version, config: arm.config },
    })) as unknown as [HarnessAbRunManifest['arms'][number], HarnessAbRunManifest['arms'][number]],
    metadata,
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds,
    pilotTaskIds: evaluationTaskIds.slice(0, input.pilotTaskCount),
    reps: 1,
    candidateLimit: null,
    maxConcurrency: pairConcurrency,
    maxConcurrentAttempts: pairConcurrency * (armExecution === 'parallel' ? 2 : 1),
    selectionMode: 'explicit',
  });
  return manifest as HarnessAbRunManifest;
}

export function buildHarnessAbResumeFingerprint(manifest: HarnessAbRunManifest): string {
  const { fingerprint: _fingerprint, metadata, ...body } = manifest;
  const { oracleEvidence: _oracleEvidence, ...identityMetadata } = metadata;
  return buildRunManifestFingerprint({ ...body, metadata: identityMetadata });
}

function taskRank(seed: string, taskId: string): string {
  return createHash('sha256').update(seed).update('\0').update(taskId).digest('hex');
}

function previewIds(taskIds: readonly string[]): string {
  return taskIds.length === 0 ? 'none' : taskIds.slice(0, 5).join(', ');
}
