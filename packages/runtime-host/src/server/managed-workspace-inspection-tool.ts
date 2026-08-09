import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { MakaTool } from '@maka/runtime';
import type {
  ManagedWorkspaceReadOnlyOperation,
  ManagedWorkspaceReadOnlyResult,
} from '@maka/storage/managed-workspace-owner';
import type { RuntimeHostWorkspaceExecutionComposition } from './workspace-execution-composition.js';

const INSPECTION_PATH_MAX_CHARS = 4_096;
const INSPECTION_PATTERN_MAX_CHARS = 4_096;
const INSPECTION_RESULT_MAX_BYTES = 64 * 1024;
const INSPECTION_LIMIT_MAX = 256;
const GREP_TIMEOUT_MAX_MS = 120_000;

const boundedPath = z.string().min(1).max(INSPECTION_PATH_MAX_CHARS);
const boundedPattern = z.string().min(1).max(INSPECTION_PATTERN_MAX_CHARS);
const boundedLimit = z.number().int().positive().max(INSPECTION_LIMIT_MAX).optional();

const managedWorkspaceInspectionInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('read'),
      path: boundedPath,
      offset: z.number().int().nonnegative().optional(),
      limit: boundedLimit,
    })
    .strict(),
  z
    .object({
      kind: z.literal('glob'),
      path: boundedPath,
      pattern: boundedPattern,
      limit: boundedLimit,
    })
    .strict(),
  z
    .object({
      kind: z.literal('grep'),
      path: boundedPath,
      pattern: boundedPattern,
      glob: z.string().max(INSPECTION_PATTERN_MAX_CHARS).optional(),
      maxCountPerFile: z.number().int().positive().max(INSPECTION_LIMIT_MAX).optional(),
      limit: boundedLimit,
      timeoutMs: z.number().int().positive().max(GREP_TIMEOUT_MAX_MS).optional(),
    })
    .strict(),
]);

export type ManagedWorkspaceInspectionToolInput = z.infer<
  typeof managedWorkspaceInspectionInputSchema
>;

export interface ManagedWorkspaceInspectionToolResult {
  readonly kind: 'managed_workspace_inspection_v1';
  readonly result: ManagedWorkspaceReadOnlyResult;
}

export interface ManagedWorkspaceInspectionToolDependencies {
  readonly canonicalizeSourceRoot?: (cwd: string) => Promise<string>;
}

/**
 * First production consumer of the M1 managed-workspace read profile.
 *
 * The model supplies only a bounded read operation. Session cwd, managed
 * identity, dependency provisioning, and the owner-bound execution profile
 * remain Host-owned and cannot be replaced with an attached checkout path.
 */
export function createManagedWorkspaceInspectionTool(
  workspaceExecution: RuntimeHostWorkspaceExecutionComposition,
  dependencies: ManagedWorkspaceInspectionToolDependencies = {},
): MakaTool<ManagedWorkspaceInspectionToolInput, ManagedWorkspaceInspectionToolResult> {
  const canonicalizeSourceRoot = dependencies.canonicalizeSourceRoot ?? realpath;
  return {
    name: 'ManagedWorkspaceInspect',
    displayName: 'Inspect isolated workspace',
    description:
      'Read or search the project in a Maka-owned isolated Git workspace with its verified dependency environment. ' +
      'Use this for dependency-aware inspection that must not read from or modify the current checkout. ' +
      'This tool is read-only and supports only Read, Glob, and Grep operations.',
    parameters: managedWorkspaceInspectionInputSchema,
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    executionSemantics: 'exclusive_step',
    impl: async (input, context) => {
      context.abortSignal.throwIfAborted();
      const sourceRoot = await canonicalizeSourceRoot(context.cwd);
      context.abortSignal.throwIfAborted();
      const identity = managedInspectionIdentity(sourceRoot, context.sessionId);
      const profile = await workspaceExecution.openManagedWorkspace(
        { ...identity, sourceRoot },
        {
          provisioning: 'dependency_environment_v1',
          abortSignal: context.abortSignal,
        },
      );
      context.abortSignal.throwIfAborted();
      const result = await workspaceExecution.executeReadOnly(
        profile,
        toReadOnlyOperation(input),
        context.abortSignal,
      );
      assertBoundedInspectionResult(result);
      return Object.freeze({ kind: 'managed_workspace_inspection_v1', result });
    },
  };
}

function toReadOnlyOperation(
  input: ManagedWorkspaceInspectionToolInput,
): ManagedWorkspaceReadOnlyOperation {
  if (input.kind !== 'grep') return Object.freeze({ ...input });
  return Object.freeze({
    ...input,
    maxCountPerFile: input.maxCountPerFile ?? 32,
    limit: input.limit ?? 64,
    timeoutMs: input.timeoutMs ?? 120_000,
  });
}

function managedInspectionIdentity(sourceRoot: string, sessionId: string) {
  const sourceIdentity = domainDigest('source', sourceRoot);
  const sessionIdentity = domainDigest('session', sourceRoot, sessionId);
  return Object.freeze({
    repositoryId: `repository_${sourceIdentity}`,
    workspaceId: `workspace_${sessionIdentity}`,
    workspaceEpochId: `epoch_${domainDigest('epoch', sourceRoot, sessionId)}`,
    workspaceInstanceId: `instance_${domainDigest('instance', sourceRoot, sessionId)}`,
  });
}

function domainDigest(domain: string, ...values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(`maka-managed-inspection-${domain}-v1\0`, 'utf8');
  for (const value of values) {
    hash.update(value, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex').slice(0, 32);
}

function assertBoundedInspectionResult(result: ManagedWorkspaceReadOnlyResult): void {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > INSPECTION_RESULT_MAX_BYTES) {
    throw new Error(
      'Managed workspace inspection result exceeds the bounded tool response; narrow the read or search.',
    );
  }
}
