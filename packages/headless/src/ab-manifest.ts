import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AbRunManifest, AbRunManifestInput } from './ab-types.js';
import { publishFileExclusively } from './immutable-file.js';

export function buildAbRunManifest(input: AbRunManifestInput): AbRunManifest {
  const manifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.ab.run_manifest.v1' as const,
    experimentKind: input.experimentKind,
    metadata: input.metadata,
    arms: input.arms.map((arm) =>
      withoutUndefined({
        id: arm.id,
        kind: arm.kind,
        fingerprint: arm.fingerprint,
        metadata: arm.metadata,
      }),
    ),
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: [...input.evaluationTaskIds],
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    maxConcurrentAttempts: input.maxConcurrentAttempts,
    observedCostStopUsd: input.observedCostStopUsd,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds ? [...input.candidateTaskIds] : undefined,
    pilotTaskIds: input.pilotTaskIds ? [...input.pilotTaskIds] : undefined,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
    nonInferiorityMargin: input.nonInferiorityMargin,
  });
  return {
    ...manifestWithoutFingerprint,
    fingerprint: buildRunManifestFingerprint(manifestWithoutFingerprint),
  };
}

export function buildRunManifestFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export async function ensureAbRunManifest(
  path: string,
  manifest: AbRunManifest,
): Promise<AbRunManifest>;
export async function ensureAbRunManifest<T extends { fingerprint: string }>(
  path: string,
  manifest: T,
): Promise<T>;
export async function ensureAbRunManifest<T extends { fingerprint: string }>(
  path: string,
  manifest: T,
): Promise<T> {
  let existing = await readAbRunManifest<T>(path);
  if (existing === null) {
    if (await publishFileExclusively(path, `${JSON.stringify(manifest, null, 2)}\n`)) {
      return manifest;
    }
    existing = await readAbRunManifest<T>(path);
    if (existing === null)
      throw new Error('concurrent A/B run manifest disappeared after publication');
  }
  if (existing.fingerprint !== manifest.fingerprint) {
    throw new Error(
      `A/B run manifest does not match existing run id: existing ${existing.fingerprint ?? 'missing'}, current ${manifest.fingerprint}. Use a new run id or restore the original run config.`,
    );
  }
  return existing;
}

export async function readAbRunManifest<T extends { fingerprint: string }>(
  path: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const existing = JSON.parse(raw) as T;
  if (hasFullBodyFingerprint(existing)) {
    const { fingerprint: existingFingerprint, ...existingBody } = existing;
    const recomputedFingerprint = buildRunManifestFingerprint(existingBody);
    if (existingFingerprint !== recomputedFingerprint) {
      throw new Error(
        `stored A/B run manifest fingerprint is invalid: stored ${existingFingerprint ?? 'missing'}, recomputed ${recomputedFingerprint}`,
      );
    }
  }
  return existing;
}

function hasFullBodyFingerprint(
  value: unknown,
): value is { schemaVersion: string; fingerprint: string } {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value)) return false;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return schemaVersion === 'maka.ab.run_manifest.v1';
}

/**
 * Deterministic JSON serializer shared across `@maka/headless`: drops `undefined`
 * object fields and recursively sorts object keys, so that two logically equal
 * objects always serialize to the same bytes. Arrays preserve order (order is
 * semantically meaningful). Every resume-identity and integrity fingerprint in
 * the package goes through here via `buildRunManifestFingerprint`, so that
 * canonicalization never drifts across call sites.
 *
 * Note: `harness-oracle-policy.ts` keeps its own `JSON.stringify`-based
 * `fingerprintValue` for the execution-policy fingerprint, deliberately not
 * canonicalized (its inputs are a single frozen `as const` object).
 */
export function canonicalJson(value: unknown): string {
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
