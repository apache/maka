import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildRunManifestFingerprint } from './ab-manifest.js';
import type { FixedPromptTask } from './fixed-prompt-controller.js';
import { fingerprintFixedPromptTask } from './fixed-prompt-task-source.js';
import {
  HARBOR_ORACLE_MAX_ATTEMPTS,
  type HarnessOracleTaskResult,
} from './harness-oracle-policy.js';

export class HarnessOracleAuditExecutionError extends Error {
  constructor(readonly status: 'timed_out' | 'infra_failed') {
    super(`Oracle audit execution ${status}`);
    this.name = 'HarnessOracleAuditExecutionError';
  }
}

export interface HarnessOracleQualificationIdentity {
  taskFingerprint: string;
  executionPolicyFingerprint: string;
  environmentFingerprint: string;
}

export interface HarnessOracleRegistryEntry {
  schemaVersion: 1;
  taskId: string;
  qualificationKey: string;
  identity: HarnessOracleQualificationIdentity;
  execution: {
    status: 'completed' | 'timed_out' | 'infra_failed';
  };
  oracle: HarnessOracleTaskResult | null;
  executionProvenance: HarnessOracleExecutionProvenance;
  fingerprint: string;
}

export interface HarnessOracleWorkflowProvenance {
  issuer: 'github-actions';
  repository: string;
  workflow: string;
  commitSha: string;
  runId: string;
  runAttempt: string;
}

export interface HarnessOracleExecutionProvenance extends HarnessOracleWorkflowProvenance {
  runtime: {
    nodeVersion: string;
    harborVersion: string;
    dockerVersion: string;
    dockerBuildxVersion: string;
  };
}

export interface HarnessOracleRegistrySnapshot {
  schemaVersion: 1;
  taskIds: string[];
  entries: HarnessOracleRegistryEntry[];
  provenance: HarnessOracleWorkflowProvenance;
  fingerprint: string;
}

export interface HarnessOracleAuditTask {
  task: FixedPromptTask;
  identity: HarnessOracleQualificationIdentity;
  resolvedEnvironment?: {
    platform: string;
    baseImages: HarnessOracleResolvedBaseImage[];
  };
}

export interface HarnessOracleResolvedBaseImage {
  reference: string;
  digest: string;
}

export interface AuditHarnessOracleRegistryInput {
  tasks: readonly HarnessOracleAuditTask[];
  provenance: HarnessOracleExecutionProvenance;
  runOracle: (task: FixedPromptTask) => Promise<HarnessOracleTaskResult>;
}

export interface HarnessOracleAuditResult {
  snapshot: HarnessOracleRegistrySnapshot;
}

export interface HarnessOracleAuditPlan {
  missingTaskIds: string[];
  reusedEntries: HarnessOracleRegistryEntry[];
}

export interface BuildHarnessOracleRegistrySnapshotInput {
  tasks: readonly {
    taskId: string;
    identity: HarnessOracleQualificationIdentity;
  }[];
  entries: readonly HarnessOracleRegistryEntry[];
  provenance: HarnessOracleRegistrySnapshot['provenance'];
}

export interface LoadHarnessOracleRegistrySnapshotInput {
  url: string;
  expectedFingerprint: string;
  signal?: AbortSignal;
  fetch?: (
    url: string | URL,
    init?: { signal?: AbortSignal },
  ) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
}

export interface HarnessOracleEnvironmentIdentityInput {
  environment: 'docker';
  platform: string;
  baseImages: readonly {
    reference: string;
    digest: string;
  }[];
}

export interface BuildHarnessOracleAuditTasksInput {
  tasks: readonly FixedPromptTask[];
  executionPolicyFingerprint: string;
  environment: 'docker';
  platform: string;
  resolveBaseImageDigest: (reference: string, platform: string) => Promise<string>;
}

export type HarnessOracleAnnotationState =
  | 'missing'
  | 'stale'
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'infra_failed';

export interface HarnessOracleAnnotation {
  taskId: string;
  state: HarnessOracleAnnotationState;
  qualificationKey?: string;
  evidenceFingerprint?: string;
}

export async function auditHarnessOracleRegistry(
  input: AuditHarnessOracleRegistryInput,
): Promise<HarnessOracleAuditResult> {
  const entries: HarnessOracleRegistryEntry[] = [];
  for (const { task, identity } of input.tasks) {
    const qualificationKey = qualificationKeyFor(task.id, identity);
    let execution: HarnessOracleRegistryEntry['execution'];
    let oracle: HarnessOracleTaskResult | null;
    try {
      oracle = await input.runOracle(task);
      execution = { status: 'completed' };
    } catch (error) {
      if (!(error instanceof HarnessOracleAuditExecutionError)) throw error;
      oracle = null;
      execution = { status: error.status };
    }
    entries.push(
      withFingerprint({
        schemaVersion: 1 as const,
        taskId: task.id,
        qualificationKey,
        identity: { ...identity },
        execution,
        oracle,
        executionProvenance: cloneExecutionProvenance(input.provenance),
      }),
    );
  }
  const snapshot = buildHarnessOracleRegistrySnapshot({
    tasks: input.tasks.map(({ task, identity }) => ({ taskId: task.id, identity })),
    entries,
    provenance: input.provenance,
  });
  return { snapshot };
}

export function buildHarnessOracleRegistrySnapshot(
  input: BuildHarnessOracleRegistrySnapshotInput,
): HarnessOracleRegistrySnapshot {
  const entriesByTaskId = new Map(input.entries.map((entry) => [entry.taskId, entry]));
  const taskIds = input.tasks.map(({ taskId }) => taskId);
  const entries = input.tasks.map(({ taskId }) => entriesByTaskId.get(taskId));
  if (
    new Set(taskIds).size !== taskIds.length ||
    input.entries.length !== taskIds.length ||
    entriesByTaskId.size !== input.entries.length ||
    entries.some(
      (entry, index) =>
        !entry ||
        !registryEntryIsValid(entry, taskIds[index]) ||
        entry.qualificationKey !==
          qualificationKeyFor(taskIds[index]!, input.tasks[index]!.identity),
    )
  )
    throw new Error('Oracle registry snapshot requires exactly one matching entry per task');
  return withFingerprint({
    schemaVersion: 1 as const,
    taskIds,
    entries: entries as HarnessOracleRegistryEntry[],
    provenance: cloneWorkflowProvenance(input.provenance),
  });
}

export function planHarnessOracleRegistryAudit(
  tasks: readonly HarnessOracleAuditTask[],
  existingSnapshot: HarnessOracleRegistrySnapshot | null,
): HarnessOracleAuditPlan {
  if (existingSnapshot) assertSnapshotFingerprint(existingSnapshot);
  const existingByKey = new Map(
    (existingSnapshot?.entries ?? []).map((entry) => [entry.qualificationKey, entry]),
  );
  const missingTaskIds: string[] = [];
  const reusedEntries: HarnessOracleRegistryEntry[] = [];
  for (const { task, identity } of tasks) {
    const existing = existingByKey.get(qualificationKeyFor(task.id, identity));
    if (existing) reusedEntries.push(existing);
    else missingTaskIds.push(task.id);
  }
  return { missingTaskIds, reusedEntries };
}

export function buildHarnessOracleEnvironmentFingerprint(
  input: HarnessOracleEnvironmentIdentityInput,
): string {
  const baseImages = [...input.baseImages]
    .map((image) => ({ ...image }))
    .sort((left, right) => left.reference.localeCompare(right.reference));
  if (
    input.platform.length === 0 ||
    new Set(baseImages.map((image) => image.reference)).size !== baseImages.length ||
    baseImages.some((image) => image.reference.length === 0 || image.digest.length === 0)
  )
    throw new Error('Oracle environment identity is malformed');
  return buildRunManifestFingerprint({
    schemaVersion: 1,
    environment: input.environment,
    platform: input.platform,
    baseImages,
  });
}

export async function buildHarnessOracleAuditTasks(
  input: BuildHarnessOracleAuditTasksInput,
): Promise<HarnessOracleAuditTask[]> {
  return Promise.all(
    input.tasks.map(async (task) => {
      const taskFingerprint = await fingerprintFixedPromptTask(task);
      const references = await discoverHarnessOracleBaseImages(task);
      const baseImages = await Promise.all(
        references.map(async (reference) => ({
          reference,
          digest: await input.resolveBaseImageDigest(reference, input.platform),
        })),
      );
      return {
        task,
        resolvedEnvironment: {
          platform: input.platform,
          baseImages,
        },
        identity: {
          taskFingerprint,
          executionPolicyFingerprint: input.executionPolicyFingerprint,
          environmentFingerprint: buildHarnessOracleEnvironmentFingerprint({
            environment: input.environment,
            platform: input.platform,
            baseImages,
          }),
        },
      };
    }),
  );
}

export async function pinHarnessOracleTaskEnvironment(
  task: FixedPromptTask,
  baseImages: readonly HarnessOracleResolvedBaseImage[],
  destinationRoot: string,
): Promise<FixedPromptTask> {
  if (basename(task.id) !== task.id) throw new Error(`Oracle task id is unsafe: ${task.id}`);
  const destination = join(destinationRoot, task.id);
  await mkdir(destinationRoot, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(task.path, destination, { recursive: true, errorOnExist: true });
  const dockerfilePath = join(destination, 'environment', 'Dockerfile');
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  const digestsByReference = new Map(baseImages.map((image) => [image.reference, image.digest]));
  const pinnedDockerfile = dockerfile.replace(
    /^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)(.*)$/gim,
    (line, prefix: string, reference: string, suffix: string) => {
      if (reference === 'scratch') return line;
      const digest = digestsByReference.get(reference);
      if (!digest) throw new Error(`Oracle environment has no resolved digest for ${reference}`);
      const image = reference.split('@', 1)[0];
      return `${prefix}${image}@${digest}${suffix}`;
    },
  );
  await writeFile(dockerfilePath, pinnedDockerfile, 'utf8');
  return { ...task, path: destination };
}

export async function discoverHarnessOracleBaseImages(task: FixedPromptTask): Promise<string[]> {
  const dockerfile = await readFile(join(task.path, 'environment', 'Dockerfile'), 'utf8');
  const references = new Set<string>();
  for (const line of dockerfile.split(/\r?\n/)) {
    const reference = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i)?.[1];
    if (!reference) continue;
    if (reference.includes('$')) {
      throw new Error(
        `Oracle environment identity cannot resolve variable base image for task ${task.id}`,
      );
    }
    if (reference !== 'scratch') references.add(reference);
  }
  return [...references].sort();
}

export function resolveHarnessOracleAnnotations(
  tasks: readonly HarnessOracleAuditTask[],
  snapshot: HarnessOracleRegistrySnapshot | null,
): HarnessOracleAnnotation[] {
  if (snapshot) assertSnapshotFingerprint(snapshot);
  const entriesByTaskId = new Map((snapshot?.entries ?? []).map((entry) => [entry.taskId, entry]));
  return tasks.map(({ task, identity }) => {
    const qualificationKey = qualificationKeyFor(task.id, identity);
    const entry = entriesByTaskId.get(task.id);
    if (!entry) return { taskId: task.id, state: 'missing', qualificationKey };
    if (entry.qualificationKey !== qualificationKey) {
      return {
        taskId: task.id,
        state: 'stale',
        qualificationKey,
        evidenceFingerprint: entry.fingerprint,
      };
    }
    return {
      taskId: task.id,
      state: annotationState(entry),
      qualificationKey,
      evidenceFingerprint: entry.fingerprint,
    };
  });
}

export async function loadHarnessOracleRegistrySnapshot(
  input: LoadHarnessOracleRegistrySnapshotInput,
): Promise<HarnessOracleRegistrySnapshot> {
  const response = await (input.fetch ?? globalThis.fetch)(input.url, { signal: input.signal });
  if (!response.ok) {
    throw new Error(`Oracle registry download failed with HTTP ${response.status}`);
  }
  const snapshot = parseHarnessOracleRegistrySnapshot(await response.json());
  if (snapshot.fingerprint !== input.expectedFingerprint) {
    throw new Error('Oracle registry snapshot fingerprint does not match the pinned profile');
  }
  return snapshot;
}

export function parseHarnessOracleRegistrySnapshot(value: unknown): HarnessOracleRegistrySnapshot {
  if (!registrySnapshotShapeIsValid(value)) {
    throw new Error('Oracle registry snapshot is malformed');
  }
  const snapshot = value as unknown as HarnessOracleRegistrySnapshot;
  assertSnapshotFingerprint(snapshot);
  return snapshot;
}

export function fingerprintHarnessOracleDocument(value: unknown): string {
  return buildRunManifestFingerprint(value);
}

function annotationState(entry: HarnessOracleRegistryEntry): HarnessOracleAnnotationState {
  if (entry.execution.status === 'timed_out') return 'timed_out';
  if (entry.execution.status === 'infra_failed') return 'infra_failed';
  if (entry.oracle?.outcome === 'passed') return 'passed';
  if (entry.oracle?.outcome === 'candidate_timeout') return 'timed_out';
  return 'failed';
}

function qualificationKeyFor(taskId: string, identity: HarnessOracleQualificationIdentity): string {
  return buildRunManifestFingerprint({ schemaVersion: 1, taskId, identity });
}

function assertSnapshotFingerprint(snapshot: HarnessOracleRegistrySnapshot): void {
  const { fingerprint, ...body } = snapshot;
  if (fingerprint !== buildRunManifestFingerprint(body)) {
    throw new Error('Oracle registry snapshot fingerprint is invalid');
  }
  if (
    snapshot.schemaVersion !== 1 ||
    new Set(snapshot.taskIds).size !== snapshot.taskIds.length ||
    snapshot.entries.length !== snapshot.taskIds.length ||
    snapshot.entries.some((entry, index) => !registryEntryIsValid(entry, snapshot.taskIds[index]))
  ) {
    throw new Error('Oracle registry entry is malformed');
  }
}

function registrySnapshotShapeIsValid(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.taskIds) ||
    value.taskIds.some((taskId) => typeof taskId !== 'string') ||
    !Array.isArray(value.entries) ||
    !isRecord(value.provenance) ||
    !workflowProvenanceIsValid(value.provenance)
  )
    return false;
  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      entry.schemaVersion === 1 &&
      typeof entry.taskId === 'string' &&
      typeof entry.qualificationKey === 'string' &&
      typeof entry.fingerprint === 'string' &&
      isRecord(entry.identity) &&
      typeof entry.identity.taskFingerprint === 'string' &&
      typeof entry.identity.executionPolicyFingerprint === 'string' &&
      typeof entry.identity.environmentFingerprint === 'string' &&
      isRecord(entry.execution) &&
      typeof entry.execution.status === 'string' &&
      isRecord(entry.executionProvenance) &&
      executionProvenanceIsValid(entry.executionProvenance) &&
      (entry.oracle === null ||
        (isRecord(entry.oracle) &&
          typeof entry.oracle.outcome === 'string' &&
          typeof entry.oracle.reward === 'number' &&
          typeof entry.oracle.attempts === 'number')),
  );
}

function registryEntryIsValid(
  entry: HarnessOracleRegistryEntry,
  expectedTaskId: string | undefined,
): boolean {
  if (
    entry.schemaVersion !== 1 ||
    entry.taskId !== expectedTaskId ||
    entry.fingerprint !== buildRunManifestFingerprint(withoutFingerprint(entry)) ||
    entry.qualificationKey !== qualificationKeyFor(entry.taskId, entry.identity) ||
    !qualificationIdentityIsValid(entry.identity) ||
    !executionProvenanceIsValid(entry.executionProvenance)
  )
    return false;
  if (entry.execution.status !== 'completed') {
    return (
      (entry.execution.status === 'timed_out' || entry.execution.status === 'infra_failed') &&
      entry.oracle === null
    );
  }
  const oracle = entry.oracle;
  if (
    oracle === null ||
    !Number.isSafeInteger(oracle.attempts) ||
    oracle.attempts < 1 ||
    oracle.attempts > HARBOR_ORACLE_MAX_ATTEMPTS ||
    !Number.isFinite(oracle.reward)
  )
    return false;
  if (oracle.outcome === 'passed') return oracle.reward > 0;
  return (
    (oracle.outcome === 'failed' || oracle.outcome === 'candidate_timeout') && oracle.reward === 0
  );
}

function qualificationIdentityIsValid(identity: HarnessOracleQualificationIdentity): boolean {
  return [
    identity.taskFingerprint,
    identity.executionPolicyFingerprint,
    identity.environmentFingerprint,
  ].every((value) => typeof value === 'string' && value.length > 0);
}

function workflowProvenanceIsValid(value: Record<string, unknown>): boolean {
  return (
    value.issuer === 'github-actions' &&
    typeof value.repository === 'string' &&
    typeof value.workflow === 'string' &&
    typeof value.commitSha === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.runAttempt === 'string'
  );
}

function executionProvenanceIsValid(
  value: HarnessOracleExecutionProvenance | Record<string, unknown>,
): boolean {
  if (!workflowProvenanceIsValid(value as Record<string, unknown>) || !isRecord(value.runtime))
    return false;
  return (
    typeof value.runtime.nodeVersion === 'string' &&
    typeof value.runtime.harborVersion === 'string' &&
    typeof value.runtime.dockerVersion === 'string' &&
    typeof value.runtime.dockerBuildxVersion === 'string'
  );
}

function cloneWorkflowProvenance(
  value: HarnessOracleWorkflowProvenance,
): HarnessOracleWorkflowProvenance {
  return {
    issuer: value.issuer,
    repository: value.repository,
    workflow: value.workflow,
    commitSha: value.commitSha,
    runId: value.runId,
    runAttempt: value.runAttempt,
  };
}

function cloneExecutionProvenance(
  value: HarnessOracleExecutionProvenance,
): HarnessOracleExecutionProvenance {
  return { ...cloneWorkflowProvenance(value), runtime: { ...value.runtime } };
}

function withoutFingerprint<T extends { fingerprint: string }>(value: T): Omit<T, 'fingerprint'> {
  const { fingerprint: _fingerprint, ...body } = value;
  return body;
}

function withFingerprint<T extends Record<string, unknown>>(body: T): T & { fingerprint: string } {
  return { ...body, fingerprint: buildRunManifestFingerprint(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
