import type { ToolResultArchiveReadResult } from './tool-result-archive.js';

export const TOOL_RESULT_ARCHIVE_RESOURCE_PROTOCOL = 'maka:';
export const TOOL_RESULT_ARCHIVE_RESOURCE_HOST = 'archive';
export const TOOL_RESULT_ARCHIVE_DEFAULT_LIMIT = 4_000;
export const TOOL_RESULT_ARCHIVE_MAX_LIMIT = 6_000;
export const TOOL_RESULT_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
export const TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS = 7_500;

const ARCHIVE_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_MANIFEST_ITEMS = 100;
const MAX_METADATA_STRING_CHARS = 160;
const MANIFEST_RESPONSE_RESERVE_CHARS = 600;

export type ToolResultArchiveResourceOperation = 'inspect' | 'read' | 'query';

export interface ToolResultArchiveResourceIdentity {
  artifactId: string;
  bodySha256: string;
  originalBytes: number;
}

export interface ToolResultArchiveResourceReadInput extends ToolResultArchiveResourceIdentity {
  sessionId: string;
  maxBytes: number;
}

export interface ToolResultArchiveResourceReader {
  readArchivedToolResultResource(
    input: ToolResultArchiveResourceReadInput,
  ): Promise<ToolResultArchiveReadResult> | ToolResultArchiveReadResult;
}

export interface ToolResultArchiveResourceRequest {
  ref: string;
  operation?: ToolResultArchiveResourceOperation;
  offset?: number;
  limit?: number;
  itemId?: string;
}

export function buildToolResultArchiveResourceRef(
  input: ToolResultArchiveResourceIdentity,
): string {
  const artifactId = encodeURIComponent(input.artifactId);
  const sha256 = encodeURIComponent(input.bodySha256);
  return `maka://archive/${artifactId}?sha256=${sha256}&bytes=${input.originalBytes}`;
}

export function parseToolResultArchiveResourceRef(
  ref: string,
): ToolResultArchiveResourceIdentity | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  if (
    url.protocol !== TOOL_RESULT_ARCHIVE_RESOURCE_PROTOCOL ||
    url.hostname !== TOOL_RESULT_ARCHIVE_RESOURCE_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 1 || url.hash) return null;
  let artifactId: string;
  try {
    artifactId = decodeURIComponent(pathParts[0] ?? '');
  } catch {
    return null;
  }
  const queryKeys = [...url.searchParams.keys()];
  if (
    queryKeys.length !== 2 ||
    queryKeys.filter((key) => key === 'sha256').length !== 1 ||
    queryKeys.filter((key) => key === 'bytes').length !== 1
  ) {
    return null;
  }
  const bodySha256 = url.searchParams.get('sha256') ?? '';
  const bytesText = url.searchParams.get('bytes') ?? '';
  if (
    !ARCHIVE_ARTIFACT_ID_PATTERN.test(artifactId) ||
    !/^[a-f0-9]{64}$/i.test(bodySha256) ||
    !/^[1-9]\d*$/.test(bytesText)
  ) {
    return null;
  }
  const originalBytes = Number(bytesText);
  if (!Number.isSafeInteger(originalBytes) || originalBytes <= 0) return null;
  return { artifactId, bodySha256, originalBytes };
}

export async function readToolResultArchiveResource(
  reader: ToolResultArchiveResourceReader,
  sessionId: string,
  request: ToolResultArchiveResourceRequest,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const identity = parseToolResultArchiveResourceRef(request.ref);
  if (!identity) {
    return archiveFailure(request.ref, 'invalid_ref');
  }
  if (identity.originalBytes > TOOL_RESULT_ARCHIVE_MAX_BYTES) {
    return archiveFailure(request.ref, 'too_large', {
      originalBytes: identity.originalBytes,
      maxBytes: TOOL_RESULT_ARCHIVE_MAX_BYTES,
    });
  }
  if (abortSignal?.aborted) throw new Error('ArchiveRead aborted');

  const read = await Promise.resolve(
    reader.readArchivedToolResultResource({
      ...identity,
      sessionId,
      maxBytes: identity.originalBytes,
    }),
  );
  if (!read.ok) return archiveFailure(request.ref, read.reason);
  if (abortSignal?.aborted) throw new Error('ArchiveRead aborted');

  const operation = request.operation ?? 'inspect';
  const limit = normalizeLimit(request.limit);
  const offset = normalizeOffset(request.offset);
  if (operation === 'read') {
    return pagedContent({
      ref: request.ref,
      operation,
      content: read.serializedResult,
      offset,
      limit,
    });
  }

  const parsed = deserializeArchive(read.serializedResult);
  if (operation === 'query') {
    return queryArchiveItem(request.ref, parsed, request.itemId, offset, limit);
  }
  return inspectArchive(request.ref, identity, parsed);
}

export const TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS =
  'This result is archived but still readable. Call ArchiveRead with the provided ref and operation "inspect"; use operation "query" with itemId for one structured item, or operation "read" with offset/limit for a bounded page. Do not use Glob to find the archive.';

function inspectArchive(
  ref: string,
  identity: ToolResultArchiveResourceIdentity,
  value: unknown,
): unknown {
  const base = {
    ok: true,
    kind: 'tool_result_archive',
    operation: 'inspect',
    ref,
    artifactId: identity.artifactId,
    originalBytes: identity.originalBytes,
  };
  if (isRecord(value)) {
    const items = Array.isArray(value.items) ? value.items : undefined;
    const manifestItems = items ? fitManifestItems(base, items) : undefined;
    const result = {
      ...base,
      valueType: 'object',
      keys: Object.keys(value)
        .slice(0, 25)
        .map((key) => boundedString(key)),
      ...(typeof value.kind === 'string' ? { archivedKind: boundedString(value.kind) } : {}),
      ...(typeof value.status === 'string' ? { status: boundedString(value.status) } : {}),
      ...(items
        ? {
            itemCount: items.length,
            items: manifestItems!,
            queryHint:
              'Call ArchiveRead with operation "query" and one of the listed itemId values.',
          }
        : {}),
      readHint: 'Call ArchiveRead with operation "read", offset, and limit for raw JSON pages.',
    };
    return {
      ...result,
      ...(items && manifestItems && manifestItems.length < items.length
        ? { itemsTruncated: true, listedItemCount: manifestItems.length }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    return {
      ...base,
      valueType: 'array',
      itemCount: value.length,
      readHint: 'Call ArchiveRead with operation "read", offset, and limit for raw JSON pages.',
    };
  }
  return {
    ...base,
    valueType: value === null ? 'null' : typeof value,
    readHint: 'Call ArchiveRead with operation "read", offset, and limit for content pages.',
  };
}

function queryArchiveItem(
  ref: string,
  value: unknown,
  itemId: string | undefined,
  offset: number,
  limit: number,
): unknown {
  if (!itemId) return archiveFailure(ref, 'item_id_required');
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : undefined;
  if (!items) return archiveFailure(ref, 'not_queryable');
  const item = items.find(
    (candidate) =>
      isRecord(candidate) && String(candidate.itemId ?? candidate.item_id ?? '') === itemId,
  );
  if (!isRecord(item)) {
    return archiveFailure(ref, 'item_not_found', {
      itemId,
      availableItemIds: items
        .map((candidate) =>
          isRecord(candidate)
            ? boundedString(String(candidate.itemId ?? candidate.item_id ?? ''))
            : '',
        )
        .filter(Boolean)
        .slice(0, 25),
    });
  }
  const content =
    typeof item.summary === 'string'
      ? item.summary
      : typeof item.result === 'string'
        ? item.result
        : JSON.stringify(item);
  return pagedContent({
    ref,
    operation: 'query',
    content,
    offset,
    limit,
    extra: {
      itemId,
      item: inspectItem(item),
    },
  });
}

function pagedContent(input: {
  ref: string;
  operation: 'read' | 'query';
  content: string;
  offset: number;
  limit: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const offset = Math.min(input.offset, input.content.length);
  const requestedEnd = Math.min(input.content.length, offset + input.limit);
  const buildPage = (end: number): Record<string, unknown> => ({
    ok: true,
    kind: 'tool_result_archive',
    operation: input.operation,
    ref: input.ref,
    offset,
    limit: end - offset,
    totalChars: input.content.length,
    nextOffset: end < input.content.length ? end : null,
    hasMore: end < input.content.length,
    content: input.content.slice(offset, end),
    ...(input.extra ?? {}),
  });
  let low = offset;
  let high = requestedEnd;
  while (low < high) {
    const candidateEnd = Math.ceil((low + high) / 2);
    if (JSON.stringify(buildPage(candidateEnd)).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS) {
      low = candidateEnd;
    } else {
      high = candidateEnd - 1;
    }
  }
  return buildPage(low);
}

function inspectItem(value: unknown): unknown {
  if (!isRecord(value)) return { valueType: value === null ? 'null' : typeof value };
  return {
    ...(typeof value.itemId === 'string' ? { itemId: boundedString(value.itemId) } : {}),
    ...(typeof value.item_id === 'string' ? { itemId: boundedString(value.item_id) } : {}),
    ...(typeof value.index === 'number' ? { index: value.index } : {}),
    ...(typeof value.started === 'boolean' ? { started: value.started } : {}),
    ...(typeof value.status === 'string' ? { status: boundedString(value.status) } : {}),
    ...(typeof value.profile === 'string' ? { profile: boundedString(value.profile) } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: boundedString(value.agentId) } : {}),
    ...(typeof value.agentName === 'string' ? { agentName: boundedString(value.agentName) } : {}),
    ...(typeof value.childSessionId === 'string'
      ? { childSessionId: boundedString(value.childSessionId) }
      : {}),
    ...(typeof value.turnId === 'string' ? { turnId: boundedString(value.turnId) } : {}),
    ...(typeof value.runId === 'string' ? { runId: boundedString(value.runId) } : {}),
    ...(typeof value.resumedFromRunId === 'string'
      ? { resumedFromRunId: boundedString(value.resumedFromRunId) }
      : {}),
    ...(Array.isArray(value.artifactIds)
      ? {
          artifactIds: value.artifactIds
            .filter((artifactId): artifactId is string => typeof artifactId === 'string')
            .slice(0, 8)
            .map(boundedString),
          artifactCount: value.artifactIds.length,
        }
      : {}),
    ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    ...(typeof value.failureClass === 'string'
      ? { failureClass: boundedString(value.failureClass) }
      : {}),
    ...(typeof value.summary === 'string' ? { summaryChars: value.summary.length } : {}),
    ...(typeof value.result === 'string' ? { resultChars: value.result.length } : {}),
  };
}

function fitManifestItems(base: Record<string, unknown>, items: readonly unknown[]): unknown[] {
  const fitted: unknown[] = [];
  for (const candidate of items.slice(0, MAX_MANIFEST_ITEMS)) {
    const projected = inspectItem(candidate);
    const next = [...fitted, projected];
    if (
      JSON.stringify({
        ...base,
        items: next,
      }).length >
      TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS - MANIFEST_RESPONSE_RESERVE_CHARS
    ) {
      break;
    }
    fitted.push(projected);
  }
  return fitted;
}

function boundedString(value: string): string {
  return value.length <= MAX_METADATA_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_METADATA_STRING_CHARS - 1)}…`;
}

function deserializeArchive(serialized: string): unknown {
  if (serialized === 'undefined') return undefined;
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return TOOL_RESULT_ARCHIVE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(TOOL_RESULT_ARCHIVE_MAX_LIMIT, Math.floor(value as number)));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function archiveFailure(ref: string, reason: string, detail?: Record<string, unknown>): unknown {
  return {
    ok: false,
    kind: 'tool_result_archive',
    ref,
    reason,
    ...(detail ?? {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
