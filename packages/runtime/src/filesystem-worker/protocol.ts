import { z } from 'zod';
import { validateSandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';

// v5 adds the provider-native single-file ApplyPatch operation.
export const FILESYSTEM_WORKER_PROTOCOL_VERSION = 5 as const;

const path = z.string().min(1).max(4096);
const cwd = z.string().min(1).max(4096);

const OperationBoundarySchema = z
  .object({
    filesystem: z
      .object({
        entries: z
          .array(
            z
              .object({
                path,
                access: z.enum(['read', 'write']),
                scope: z.enum(['exact', 'subtree']),
              })
              .strict(),
          )
          .max(32),
      })
      .strict()
      .optional(),
    network: z
      .object({ enabled: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    const validation = validateSandboxBoundaryExpansion(profile);
    if (!validation.ok) context.addIssue({ code: 'custom', message: validation.message });
  });

export const FilesystemWorkerTargetSchema = z
  .object({
    enforcementPath: path,
    access: z.enum(['read', 'write']),
    scope: z.enum(['exact', 'subtree']),
    targetType: z.enum(['file', 'directory', 'symlink', 'other', 'missing']),
  })
  .strict();

export const FilesystemWorkerOperationSchema = z.union([
  z
    .object({
      kind: z.literal('read'),
      cwd,
      path,
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('write'), cwd, path, content: z.string() }).strict(),
  z
    .object({
      kind: z.literal('apply_patch'),
      cwd,
      path,
      action: z.enum(['create', 'update']),
      diff: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('apply_patch'), cwd, path, action: z.literal('delete') }).strict(),
  z
    .object({
      kind: z.literal('edit'),
      cwd,
      path,
      oldString: z.string(),
      newString: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('format_json'),
      cwd,
      path,
      sortKeys: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('glob'),
      cwd,
      path,
      pattern: z.string().min(1),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('grep'),
      cwd,
      path,
      pattern: z.string(),
      glob: z.string().min(1).optional(),
      maxCountPerFile: z.number().int().positive(),
      limit: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
]);

export const FilesystemWorkerRequestSchema = z
  .object({
    version: z.literal(FILESYSTEM_WORKER_PROTOCOL_VERSION),
    requestId: z.string().min(1).max(256),
    operation: FilesystemWorkerOperationSchema,
    operationBoundary: OperationBoundarySchema,
    expectedTarget: FilesystemWorkerTargetSchema,
  })
  .strict();

export const FilesystemWorkerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), content: z.string() }).strict(),
  z
    .object({
      kind: z.literal('read_image'),
      base64: z.string(),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('write'),
      ok: z.literal(true),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      diff: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('apply_patch'), ok: z.literal(true), path: z.string() }).strict(),
  z
    .object({
      kind: z.literal('edit'),
      ok: z.literal(true),
      path: z.string(),
      replacements: z.literal(1),
      matchedVia: z.enum(['exact', 'line-trimmed', 'whitespace', 'escape']),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      diff: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('format_json'),
      ok: z.boolean(),
      valid: z.boolean(),
      path: z.string(),
      error: z.string().optional(),
      bytesBefore: z.number().int().nonnegative(),
      bytesAfter: z.number().int().nonnegative().optional(),
      byteDelta: z.number().int(),
      changed: z.boolean(),
      diff: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('glob'), files: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('grep'), matches: z.array(z.string()) }).strict(),
]);

export const FilesystemWorkerErrorCodeSchema = z.enum([
  'invalid_request',
  'path_denied',
  'path_changed',
  'not_found',
  'edit_conflict',
  'grep_unavailable',
  'sandbox_denied',
  'filesystem_denied',
  'filesystem_error',
]);

export const FilesystemWorkerResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      version: z.literal(FILESYSTEM_WORKER_PROTOCOL_VERSION),
      requestId: z.string().min(1).max(256),
      ok: z.literal(true),
      result: FilesystemWorkerResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(FILESYSTEM_WORKER_PROTOCOL_VERSION),
      requestId: z.string().min(1).max(256),
      ok: z.literal(false),
      error: z
        .object({
          code: FilesystemWorkerErrorCodeSchema,
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export type FilesystemWorkerOperation = z.infer<typeof FilesystemWorkerOperationSchema>;

export function operationUsesDirectoryEntry(operation: FilesystemWorkerOperation): boolean {
  return (
    operation.kind === 'apply_patch' &&
    (operation.action === 'create' || operation.action === 'delete')
  );
}
export type FilesystemWorkerTarget = z.infer<typeof FilesystemWorkerTargetSchema>;
export type FilesystemWorkerRequest = z.infer<typeof FilesystemWorkerRequestSchema>;
export type FilesystemWorkerResult = z.infer<typeof FilesystemWorkerResultSchema>;
export type FilesystemWorkerErrorCode = z.infer<typeof FilesystemWorkerErrorCodeSchema>;
export type FilesystemWorkerResponse = z.infer<typeof FilesystemWorkerResponseSchema>;

export function parseFilesystemWorkerResponse(input: unknown): FilesystemWorkerResponse {
  return FilesystemWorkerResponseSchema.parse(input);
}
