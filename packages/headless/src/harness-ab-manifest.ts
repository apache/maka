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

/**
 * Which task set a run is, and that the tasks still are what they were.
 *
 * The data these check against does not live here. A graded arm runs out of
 * this package's build output, so a benchmark's revision, upstream URL and
 * task list compiled into a shipped module are readable from inside the
 * container being scored — in the #1970 run an arm read the pinned revision
 * out of the mount, fetched the reference solution at that exact revision,
 * and recorded a pass that measured retrieval. The identity lives in
 * `harbor/benchmark-identity.json`, which nothing in the container mounts;
 * only the host-side entrypoints load it and pass it in.
 */
export function assertFrozenTaskSet(
  label: string,
  expected: readonly string[],
  taskIds: readonly string[],
): void {
  const actual = new Set(taskIds);
  const expectedSet = new Set(expected);
  const missing = expected.filter((taskId) => !actual.has(taskId));
  const unexpected = [...actual].filter((taskId) => !expectedSet.has(taskId)).sort();
  if (
    taskIds.length === expected.length &&
    actual.size === expectedSet.size &&
    missing.length === 0 &&
    unexpected.length === 0
  ) {
    return;
  }
  throw new Error(
    `${label} task set mismatch; expected ${expectedSet.size} unique tasks, found ${actual.size}; missing: ${previewIds(missing)}; unexpected: ${previewIds(unexpected)}`,
  );
}

export function assertFrozenTaskTreeFingerprint(
  label: string,
  expected: string,
  actual: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${label} task tree fingerprint mismatch; expected ${expected}, found ${actual}`,
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
