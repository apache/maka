import {
  DAILY_REVIEW_ARCHIVE_STATUSES,
  DAILY_REVIEW_RANGES,
  isDailyReviewExecuteTime,
  normalizeDailyReviewArchive,
  normalizeDailyReviewConfig,
  type DailyReviewArchive,
  type DailyReviewArchiveSummary,
  type DailyReviewConfig,
  type DailyReviewRange,
  type DailyReviewSummary,
} from '@maka/core/daily-review';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const DAILY_REVIEW_PAGE_MAX_ITEMS = 32;
export const DAILY_REVIEW_RESULT_MAX_BYTES = 64 * 1024;
export const DAILY_REVIEW_MODEL_KEY_MAX_BYTES = 1024;
export const DAILY_REVIEW_OFFSET_DAYS_MAX = 3_650;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [...QUERY_ERRORS, 'operation_conflict'] as const;

export type DailyReviewQueryInput =
  | { readonly kind: 'config' }
  | {
      readonly kind: 'summary';
      readonly range: DailyReviewRange;
      readonly offsetDays: number;
    }
  | {
      readonly kind: 'archives';
      readonly offset: number;
      readonly limit: number;
    }
  | { readonly kind: 'archive'; readonly archiveId: string };

export type DailyReviewQueryResult =
  | {
      readonly kind: 'config';
      readonly revision: number;
      readonly config: DailyReviewConfig;
    }
  | { readonly kind: 'summary'; readonly summary: DailyReviewSummary }
  | {
      readonly kind: 'archives';
      readonly archives: readonly DailyReviewArchiveSummary[];
      readonly offset: number;
      readonly total: number;
      readonly nextOffset: number | null;
    }
  | { readonly kind: 'archive'; readonly archive: DailyReviewArchive | null };

export type DailyReviewMutateInput =
  | {
      readonly kind: 'update_config';
      readonly expectedRevision: number;
      readonly config: DailyReviewConfig;
    }
  | {
      readonly kind: 'run';
      readonly range: DailyReviewRange;
      readonly offsetDays: number;
      readonly modelKeyOverride: string;
      readonly replaceExisting: boolean;
    }
  | { readonly kind: 'delete'; readonly archiveId: string };

export type DailyReviewMutateResult =
  | {
      readonly kind: 'config_committed' | 'config_unchanged';
      readonly revision: number;
      readonly config: DailyReviewConfig;
    }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly kind: 'archive'; readonly archive: DailyReviewArchive }
  | {
      readonly kind: 'deleted';
      readonly archiveId: string;
      readonly deleted: boolean;
    };

export const DAILY_REVIEW_OPERATION_SPECS = {
  'daily-review.query': defineOperation<
    DailyReviewQueryInput,
    DailyReviewQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeDailyReviewQueryInput,
    decodeOutput: decodeDailyReviewQueryResult,
  }),
  'daily-review.mutate': defineOperation<
    DailyReviewMutateInput,
    DailyReviewMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeDailyReviewMutateInput,
    decodeOutput: decodeDailyReviewMutateResult,
  }),
} as const;

export function decodeDailyReviewQueryInput(value: unknown): DailyReviewQueryInput {
  const record = requireRecord(value, 'Daily Review query input');
  switch (record.kind) {
    case 'config':
      requireExactRecord(record, 'Daily Review config query input', ['kind']);
      return { kind: 'config' };
    case 'summary': {
      const input = requireExactRecord(record, 'Daily Review summary query input', [
        'kind',
        'range',
        'offsetDays',
      ]);
      return {
        kind: 'summary',
        range: requireRange(input.range),
        offsetDays: requireOffsetDays(input.offsetDays),
      };
    }
    case 'archives': {
      const input = requireExactRecord(record, 'Daily Review archives query input', [
        'kind',
        'offset',
        'limit',
      ]);
      const limit = requireCount(input.limit, 'Daily Review page limit');
      if (limit === 0 || limit > DAILY_REVIEW_PAGE_MAX_ITEMS) {
        throw invalidProtocolFrame('Daily Review page limit is out of range');
      }
      return {
        kind: 'archives',
        offset: requireCount(input.offset, 'Daily Review page offset'),
        limit,
      };
    }
    case 'archive': {
      const input = requireExactRecord(record, 'Daily Review archive query input', [
        'kind',
        'archiveId',
      ]);
      return { kind: 'archive', archiveId: requireArchiveId(input.archiveId) };
    }
    default:
      throw invalidProtocolFrame('Invalid Daily Review query kind');
  }
}

export function decodeDailyReviewQueryResult(value: unknown): DailyReviewQueryResult {
  const record = requireRecord(value, 'Daily Review query result');
  let result: DailyReviewQueryResult;
  switch (record.kind) {
    case 'config': {
      const output = requireExactRecord(record, 'Daily Review config query result', [
        'kind',
        'revision',
        'config',
      ]);
      result = {
        kind: 'config',
        revision: requireCount(output.revision, 'Daily Review revision'),
        config: requireConfig(output.config),
      };
      break;
    }
    case 'summary': {
      const output = requireExactRecord(record, 'Daily Review summary query result', [
        'kind',
        'summary',
      ]);
      result = { kind: 'summary', summary: requireSummary(output.summary) };
      break;
    }
    case 'archives': {
      const output = requireExactRecord(record, 'Daily Review archives query result', [
        'kind',
        'archives',
        'offset',
        'total',
        'nextOffset',
      ]);
      if (!Array.isArray(output.archives) || output.archives.length > DAILY_REVIEW_PAGE_MAX_ITEMS) {
        throw invalidProtocolFrame('Daily Review archive page exceeds item limit');
      }
      const offset = requireCount(output.offset, 'Daily Review page offset');
      const total = requireCount(output.total, 'Daily Review archive total');
      const nextOffset =
        output.nextOffset === null
          ? null
          : requireCount(output.nextOffset, 'Daily Review next offset');
      if (nextOffset !== null && (nextOffset <= offset || nextOffset > total)) {
        throw invalidProtocolFrame('Invalid Daily Review archive page bounds');
      }
      result = {
        kind: 'archives',
        archives: output.archives.map(requireArchiveSummary),
        offset,
        total,
        nextOffset,
      };
      break;
    }
    case 'archive': {
      const output = requireExactRecord(record, 'Daily Review archive query result', [
        'kind',
        'archive',
      ]);
      result = {
        kind: 'archive',
        archive: output.archive === null ? null : requireArchive(output.archive),
      };
      break;
    }
    default:
      throw invalidProtocolFrame('Invalid Daily Review query result kind');
  }
  requireEncodedByteLimit(result, 'Daily Review query result', DAILY_REVIEW_RESULT_MAX_BYTES);
  return result;
}

export function decodeDailyReviewMutateInput(value: unknown): DailyReviewMutateInput {
  const record = requireRecord(value, 'Daily Review mutation input');
  if (record.kind === 'update_config') {
    const input = requireExactRecord(record, 'Daily Review config mutation input', [
      'kind',
      'expectedRevision',
      'config',
    ]);
    return {
      kind: 'update_config',
      expectedRevision: requireCount(input.expectedRevision, 'Daily Review expected revision'),
      config: requireConfig(input.config),
    };
  }
  if (record.kind === 'run') {
    const input = requireExactRecord(record, 'Daily Review run input', [
      'kind',
      'range',
      'offsetDays',
      'modelKeyOverride',
      'replaceExisting',
    ]);
    if (typeof input.replaceExisting !== 'boolean') {
      throw invalidProtocolFrame('Invalid Daily Review replaceExisting flag');
    }
    return {
      kind: 'run',
      range: requireRange(input.range),
      offsetDays: requireOffsetDays(input.offsetDays),
      modelKeyOverride: requireModelKey(input.modelKeyOverride),
      replaceExisting: input.replaceExisting,
    };
  }
  if (record.kind === 'delete') {
    const input = requireExactRecord(record, 'Daily Review delete input', ['kind', 'archiveId']);
    return { kind: 'delete', archiveId: requireArchiveId(input.archiveId) };
  }
  throw invalidProtocolFrame('Invalid Daily Review mutation kind');
}

export function decodeDailyReviewMutateResult(value: unknown): DailyReviewMutateResult {
  const record = requireRecord(value, 'Daily Review mutation result');
  let result: DailyReviewMutateResult;
  if (record.kind === 'config_committed' || record.kind === 'config_unchanged') {
    const output = requireExactRecord(record, 'Daily Review config mutation result', [
      'kind',
      'revision',
      'config',
    ]);
    result = {
      kind: record.kind,
      revision: requireCount(output.revision, 'Daily Review revision'),
      config: requireConfig(output.config),
    };
  } else if (record.kind === 'revision_conflict') {
    const output = requireExactRecord(record, 'Daily Review revision conflict result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    result = {
      kind: 'revision_conflict',
      expectedRevision: requireCount(output.expectedRevision, 'Daily Review expected revision'),
      actualRevision: requireCount(output.actualRevision, 'Daily Review actual revision'),
    };
  } else if (record.kind === 'archive') {
    const output = requireExactRecord(record, 'Daily Review run result', ['kind', 'archive']);
    result = { kind: 'archive', archive: requireArchive(output.archive) };
  } else if (record.kind === 'deleted') {
    const output = requireExactRecord(record, 'Daily Review delete result', [
      'kind',
      'archiveId',
      'deleted',
    ]);
    if (typeof output.deleted !== 'boolean') {
      throw invalidProtocolFrame('Invalid Daily Review delete result');
    }
    result = {
      kind: 'deleted',
      archiveId: requireArchiveId(output.archiveId),
      deleted: output.deleted,
    };
  } else {
    throw invalidProtocolFrame('Invalid Daily Review mutation result kind');
  }
  requireEncodedByteLimit(result, 'Daily Review mutation result', DAILY_REVIEW_RESULT_MAX_BYTES);
  return result;
}

function requireRange(value: unknown): DailyReviewRange {
  if (!DAILY_REVIEW_RANGES.includes(value as DailyReviewRange)) {
    throw invalidProtocolFrame('Invalid Daily Review range');
  }
  return value as DailyReviewRange;
}

function requireOffsetDays(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < -DAILY_REVIEW_OFFSET_DAYS_MAX ||
    (value as number) > DAILY_REVIEW_OFFSET_DAYS_MAX
  ) {
    throw invalidProtocolFrame('Daily Review offsetDays is out of range');
  }
  return value as number;
}

function requireConfig(value: unknown): DailyReviewConfig {
  const record = requireExactRecord(value, 'Daily Review config', [
    'enabled',
    'executeTime',
    'modelKey',
  ]);
  if (typeof record.enabled !== 'boolean' || !isDailyReviewExecuteTime(record.executeTime)) {
    throw invalidProtocolFrame('Invalid Daily Review config');
  }
  const modelKey = requireModelKey(record.modelKey);
  return normalizeDailyReviewConfig({
    enabled: record.enabled,
    executeTime: record.executeTime,
    modelKey,
  });
}

function requireModelKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > DAILY_REVIEW_MODEL_KEY_MAX_BYTES
  ) {
    throw invalidProtocolFrame('Invalid Daily Review model key');
  }
  return value;
}

function requireArchiveId(value: unknown): string {
  const archiveId = requireEntityId(value, 'Daily Review archive id');
  if (!/^\d{4}-\d{2}-\d{2}-(1d|7d|30d)$/.test(archiveId)) {
    throw invalidProtocolFrame('Invalid Daily Review archive id');
  }
  return archiveId;
}

function requireArchive(value: unknown): DailyReviewArchive {
  const record = requireShapedRecord(
    value,
    'Daily Review archive',
    ['id', 'day', 'range', 'status', 'generatedAt', 'trigger', 'modelKey', 'sections', 'totals'],
    ['errorMessage'],
  );
  const sections = requireRecord(record.sections, 'Daily Review archive sections');
  if (
    Object.keys(sections).some(
      (key) => key !== 'summary' && key !== 'gaps' && key !== 'usage' && key !== 'code',
    )
  ) {
    throw invalidProtocolFrame('Unknown Daily Review archive section');
  }
  const normalizedSections: Record<string, string> = {};
  for (const key of ['summary', 'gaps', 'usage', 'code'] as const) {
    if (sections[key] === undefined) continue;
    normalizedSections[key] = requireBoundedText(
      sections[key],
      `Daily Review archive section ${key}`,
      DAILY_REVIEW_RESULT_MAX_BYTES,
      true,
    );
  }
  if (!DAILY_REVIEW_ARCHIVE_STATUSES.includes(record.status as DailyReviewArchive['status'])) {
    throw invalidProtocolFrame('Invalid Daily Review archive status');
  }
  if (record.trigger !== 'cron' && record.trigger !== 'manual') {
    throw invalidProtocolFrame('Invalid Daily Review archive trigger');
  }
  const errorMessage =
    record.errorMessage === undefined
      ? undefined
      : requireBoundedText(
          record.errorMessage,
          'Daily Review archive error message',
          DAILY_REVIEW_RESULT_MAX_BYTES,
          true,
        );
  try {
    return normalizeDailyReviewArchive({
      id: requireArchiveId(record.id),
      day: requireDay(record.day),
      range: requireRange(record.range),
      status: record.status,
      generatedAt: requireCount(record.generatedAt, 'Daily Review generated time'),
      trigger: record.trigger,
      modelKey: requireModelKey(record.modelKey),
      sections: normalizedSections,
      totals: requireTotals(record.totals),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  } catch {
    throw invalidProtocolFrame('Invalid Daily Review archive');
  }
}

function requireArchiveSummary(value: unknown): DailyReviewArchiveSummary {
  const record = requireShapedRecord(
    value,
    'Daily Review archive summary',
    ['id', 'day', 'range', 'status', 'generatedAt', 'trigger', 'modelKey', 'totals'],
    ['errorMessage'],
  );
  const archive = requireArchive({
    ...record,
    sections: { summary: 'projection' },
  });
  const { sections: _sections, ...summary } = archive;
  return summary;
}

function requireSummary(value: unknown): DailyReviewSummary {
  const record = requireExactRecord(value, 'Daily Review summary', [
    'day',
    'totals',
    'sessions',
    'topTools',
    'topModels',
  ]);
  const day = requireDay(record.day);
  const totals = requireTotals(record.totals);
  if (!Array.isArray(record.sessions) || record.sessions.length > 8) {
    throw invalidProtocolFrame('Invalid Daily Review sessions');
  }
  if (!Array.isArray(record.topTools) || record.topTools.length > 8) {
    throw invalidProtocolFrame('Invalid Daily Review top tools');
  }
  if (!Array.isArray(record.topModels) || record.topModels.length > 8) {
    throw invalidProtocolFrame('Invalid Daily Review top models');
  }
  return {
    day,
    totals,
    sessions: record.sessions.map(requireSession),
    topTools: record.topTools.map(requireTopEntry),
    topModels: record.topModels.map(requireTopEntry),
  };
}

function requireSession(value: unknown): DailyReviewSummary['sessions'][number] {
  const session = requireShapedRecord(
    value,
    'Daily Review Session row',
    ['id', 'name', 'lastMessageAt'],
    ['lastMessagePreview'],
  );
  const preview =
    session.lastMessagePreview === undefined
      ? undefined
      : requireBoundedText(
          session.lastMessagePreview,
          'Daily Review Session preview',
          8 * 1024,
          true,
        );
  return {
    id: requireEntityId(session.id, 'Daily Review Session id'),
    name: requireBoundedText(session.name, 'Daily Review Session name', 4 * 1024, false),
    lastMessageAt: requireCount(session.lastMessageAt, 'Daily Review last message time'),
    ...(preview === undefined ? {} : { lastMessagePreview: preview }),
  };
}

function requireTopEntry(value: unknown): DailyReviewSummary['topModels'][number] {
  const entry = requireExactRecord(value, 'Daily Review top entry', [
    'key',
    'label',
    'requests',
    'totalTokens',
    'costUsd',
  ]);
  if (typeof entry.costUsd !== 'number' || !Number.isFinite(entry.costUsd) || entry.costUsd < 0) {
    throw invalidProtocolFrame('Invalid Daily Review top entry cost');
  }
  return {
    key: requireBoundedText(entry.key, 'Daily Review top entry key', 4 * 1024, false),
    label: requireBoundedText(entry.label, 'Daily Review top entry label', 4 * 1024, false),
    requests: requireCount(entry.requests, 'Daily Review top entry requests'),
    totalTokens: requireCount(entry.totalTokens, 'Daily Review top entry tokens'),
    costUsd: entry.costUsd,
  };
}

function requireBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireDay(value: unknown): DailyReviewSummary['day'] {
  const day = requireExactRecord(value, 'Daily Review day', ['fromMs', 'toMs']);
  const fromMs = requireCount(day.fromMs, 'Daily Review day fromMs');
  const toMs = requireCount(day.toMs, 'Daily Review day toMs');
  if (toMs <= fromMs) throw invalidProtocolFrame('Invalid Daily Review day range');
  return { fromMs, toMs };
}

function requireTotals(value: unknown): DailyReviewSummary['totals'] {
  const totals = requireExactRecord(value, 'Daily Review totals', [
    'sessionCount',
    'requestCount',
    'totalTokens',
    'costUsd',
    'errorCount',
  ]);
  if (
    typeof totals.costUsd !== 'number' ||
    !Number.isFinite(totals.costUsd) ||
    totals.costUsd < 0
  ) {
    throw invalidProtocolFrame('Invalid Daily Review cost');
  }
  return {
    sessionCount: requireCount(totals.sessionCount, 'Daily Review session count'),
    requestCount: requireCount(totals.requestCount, 'Daily Review request count'),
    totalTokens: requireCount(totals.totalTokens, 'Daily Review token count'),
    costUsd: totals.costUsd,
    errorCount: requireCount(totals.errorCount, 'Daily Review error count'),
  };
}
