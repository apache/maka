import { createHash } from 'node:crypto';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { buildAbRunManifest, buildRunManifestFingerprint } from './ab-manifest.js';
import type { AbRunManifest } from './ab-types.js';
import type { HarnessOracleAnnotation } from './harness-oracle-registry.js';
import type { HarnessAgentId } from './harness-agent-registry.js';

export type HarnessAbArmId = HarnessAgentId;

export const HARNESS_AB_PAIR_CONCURRENCY = 2;
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
// leaderboard tasks; the repo tree at this commit carries exactly those 113
// task dirs plus 4 metadata entries: README.md, dataset.toml, manifest.json,
// manifest.schema.json).
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

/** Full 113-task DeepSWE v1.1 leaderboard set (the `tasks` rows of
 * https://deepswe.datacurve.ai/artifacts/v1.1/tasks.json), equal to every task
 * dir in the pinned repo tree at DEEP_SWE_REVISION. This is the leaderboard-
 * comparable suite; deep-swe-1.1 remains the 30-task discriminative subset. */
export const DEEP_SWE_FULL_TASK_IDS = [
  'abs-module-cache-flags',
  'abs-stepped-slices',
  'actionlint-action-pinning-lint',
  'adaptix-name-mapping-aliases',
  'aiomonitor-task-snapshots-diff',
  'anko-default-function-arguments',
  'anko-typed-variable-bindings',
  'arcane-drift-detection-baselines',
  'arktype-json-schema-refs-dependencies',
  'awilix-async-container-initialization',
  'bandit-incremental-cache-control',
  'bandit-interprocedural-taint-checks',
  'bandit-structured-nosec-directives',
  'boa-hierarchical-evaluation-cancellation',
  'cattrs-partial-structuring-recovery',
  'clack-async-autocomplete-options',
  'claude-code-by-agents-recursive-delegation',
  'cliffy-config-file-parsing',
  'csstree-shorthand-expansion-compression',
  'dasel-html-document-format',
  'dateutil-rfc5545-timezone-interop',
  'drizzle-orm-window-function-builders',
  'dynamodb-toolbox-conditional-attribute-requirements',
  'dynamodb-toolbox-lazy-recursive-schemas',
  'effect-sse-httpapi-streaming',
  'eicrud-keyset-pagination-cursor',
  'etree-xml-diff-patch',
  'expr-try-catch-errors',
  'fastapi-deprecation-response-headers',
  'fastapi-implicit-head-options',
  'fd-deterministic-multi-key-sorting',
  'geo-shapeindex-serialization',
  'go-critic-doc-link-checker',
  'go-genai-streamed-function-args',
  'go-git-worktree-merge-conflicts',
  'goreleaser-retry-publish-auditing',
  'gql-incremental-graphql-delivery',
  'happy-dom-abort-pending-body-reads',
  'happy-dom-deterministic-intersectionobserver',
  'helm-array-merge-strategies',
  'helm-unified-manifest-stream',
  'httpx-deterministic-cookie-store',
  'httpx-multipart-response-parsing',
  'httpx-streaming-json-iteration',
  'igel-persist-feature-schema',
  'ink-grid-box-layout',
  'ipython-session-bundle-replay',
  'katex-multicolumn-array-spans',
  'kcp-go-multiplexed-kcp-streams',
  'kea-atomic-signal-selectors',
  'kgateway-consistent-hash-policy',
  'kombu-single-active-consumer-priority',
  'kombu-virtual-queue-dead-lettering',
  'koota-composite-trait-aspects',
  'koota-deferred-mutation-buffer',
  'koota-entity-snapshot-rollback',
  'koota-pair-relation-tracking',
  'koota-query-predicates',
  'kysely-window-grouping-helpers',
  'langchain-request-coalescing',
  'mashumaro-flattened-dataclass-fields',
  'meriyah-explicit-resource-declarations',
  'mnamer-daemon-watch-lifecycle',
  'mobly-grouped-test-barriers',
  'narwhals-rolling-window-suite',
  'numba-stencil-boundary-modes',
  'obsidian-linter-auto-table-of-contents',
  'obsidian-linter-link-format-conversion',
  'obsidian-linter-scoped-ignore-markers',
  'ofetch-per-origin-circuit-breaker',
  'onedump-dump-encryption-pipeline',
  'opa-rego-rule-profiling',
  'opa-template-string-reconstruction',
  'optique-conditional-option-dependencies',
  'oxvg-structural-selector-preservation',
  'participle-grammar-conflict-analysis',
  'pebble-durability-wait-apis',
  'pest-character-class-coalescing',
  'prometheus-transactional-reload-status',
  'prometheus-typed-label-sorting',
  'psd-tools-blend-range-api',
  'pwntools-tube-multiplexing',
  'python-statemachine-state-data-scoping',
  'query-persist-restored-query-state',
  'quill-shared-toolbar-focus',
  'returns-validated-error-accumulation',
  'scc-bounded-memory-spilling',
  'scriggo-method-declarations',
  'skrub-duration-encoding',
  'sql-formatter-bigquery-pipe-formatting',
  'sqlfmt-create-table-ddl-formatting',
  'sqlite-utils-safe-import-checkpoints',
  'superjson-error-stack-serialization',
  'task-task-graph-export',
  'tengo-callable-instance-isolation',
  'tengo-destructuring-bindings',
  'termenv-preserve-ansi-resets',
  'testem-bail-on-test-failure',
  'testem-per-launcher-reports',
  'textual-kitty-key-phases',
  'textual-richlog-follow-state',
  'tomlkit-toml-table-converters',
  'true-myth-iterable-collection-combinators',
  'ts-pattern-match-each',
  'updo-policy-alerting',
  'valibot-recursive-schema-composition',
  'vitest-duration-sharding',
  'vulture-persistent-analysis-cache',
  'wasmi-trap-coredumps',
  'wazero-multi-module-snapshots',
  'yaegi-go-embed-directives',
  'yjs-map-conflict-detection',
  'ytt-jsonpath-query-api',
] as const;

/** fingerprintFixedPromptTaskTree over all 113 task dirs at DEEP_SWE_REVISION
 * — freezes the exact task bytes under comparison. */
export const DEEP_SWE_FULL_TASK_TREE_FINGERPRINT =
  'sha256:973091a18c2045494bab4c4d5732170ebeb222227a16516cfdf08fda56b1fd82';

export function assertDeepSweFullTaskSet(taskIds: readonly string[]): void {
  const actual = new Set(taskIds);
  const expected = new Set<string>(DEEP_SWE_FULL_TASK_IDS);
  const missing = DEEP_SWE_FULL_TASK_IDS.filter((taskId) => !actual.has(taskId));
  const unexpected = [...actual].filter((taskId) => !expected.has(taskId)).sort();
  if (
    taskIds.length === DEEP_SWE_FULL_TASK_IDS.length &&
    actual.size === expected.size &&
    missing.length === 0 &&
    unexpected.length === 0
  ) {
    return;
  }
  throw new Error(
    `DeepSWE full-113 task set mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`,
  );
}

export function assertDeepSweFullTaskTreeFingerprint(actual: string): void {
  if (actual !== DEEP_SWE_FULL_TASK_TREE_FINGERPRINT) {
    throw new Error(
      `DeepSWE full-113 task tree fingerprint mismatch; expected ${DEEP_SWE_FULL_TASK_TREE_FINGERPRINT}, found ${actual}`,
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
    cacheWrite?: number;
    output: number;
    source: string;
  };
  arms: readonly HarnessAbArmInput[];
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
  if (input.arms.length < 2) throw new Error('harness manifest requires at least two arms');
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
    })),
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
    maxConcurrentAttempts: pairConcurrency * (armExecution === 'parallel' ? input.arms.length : 1),
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
