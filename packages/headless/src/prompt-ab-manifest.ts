import { createHash } from 'node:crypto';
import { ensureAbRunManifest, buildAbRunManifest } from './ab-manifest.js';
import type { PromptAbRunManifest, PromptAbRunManifestInput } from './prompt-ab-types.js';

export function buildPromptAbRunManifest(input: PromptAbRunManifestInput): PromptAbRunManifest {
  const promptManifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.prompt_ab.run_manifest.v1' as const,
    baselinePromptHash: input.baselinePromptHash,
    candidatePromptHash: input.candidatePromptHash,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: [...input.evaluationTaskIds],
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds ? [...input.candidateTaskIds] : undefined,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
    nonInferiorityMargin: input.nonInferiorityMargin,
  });
  const genericManifest = buildAbRunManifest({
    experimentKind: 'prompt',
    arms: [
      {
        id: 'maka-baseline',
        kind: 'prompt',
        fingerprint: input.baselinePromptHash,
        metadata: {
          provider: input.provider,
          baseUrl: input.baseUrl,
          model: input.model,
        },
      },
      {
        id: 'candidate',
        kind: 'prompt',
        fingerprint: input.candidatePromptHash,
        metadata: {
          provider: input.provider,
          baseUrl: input.baseUrl,
          model: input.model,
        },
      },
    ],
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: input.evaluationTaskIds,
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
    nonInferiorityMargin: input.nonInferiorityMargin,
  });
  return {
    ...promptManifestWithoutFingerprint,
    experimentKind: 'prompt',
    arms: genericManifest.arms as PromptAbRunManifest['arms'],
    fingerprint: `sha256:${createHash('sha256').update(canonicalJson(promptManifestWithoutFingerprint)).digest('hex')}`,
  };
}

export async function ensurePromptAbRunManifest(
  path: string,
  manifest: PromptAbRunManifest,
): Promise<PromptAbRunManifest> {
  try {
    const resumed = await ensureAbRunManifest(path, manifest);
    return {
      ...resumed,
      experimentKind: 'prompt',
      arms: manifest.arms,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('A/B run manifest does not match existing run id:')
    ) {
      throw new Error(
        error.message
          .replace('A/B run manifest', 'prompt A/B run manifest')
          .replace('Use a new run id', 'Use a new MAKA_PROMPT_AB_RUN_ID'),
      );
    }
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
