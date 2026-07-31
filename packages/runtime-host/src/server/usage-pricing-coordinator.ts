import { createHash } from 'node:crypto';
import type {
  PricingConfig,
  ToolInvocationRecord,
  UsageBucket,
  UsageLogRow,
} from '@maka/core/usage-stats/types';
import {
  authenticateInteractiveUsageStoresWriter,
  classifyInteractiveUsageStoresFailure,
  type InteractiveUsageStoresFailureClassification,
  type InteractiveUsageStoresWriter,
} from '@maka/storage/usage-stores';
import {
  encodePricingQueryResult,
  encodeUsageQueryResult,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  type OperationOutcome,
  type PricingMutateInput,
  type PricingQueryInput,
  type PricingQueryResult,
  type LlmUsageLogProjection,
  type ToolUsageLogProjection,
  type UsageLogProjection,
  type UsageQueryInput,
  type UsageQueryResult,
} from '../protocol/index.js';
import type { UsagePricingOperationHandlerMap } from './operation-dispatcher.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';

/** Root-scoped projection over the authentic lease-bound usage stores. */
export class HostUsagePricingCoordinator {
  readonly handlers: UsagePricingOperationHandlerMap = {
    'usage.query': (input) => this.#queryUsage(input),
    'pricing.query': (input) => this.#queryPricing(input),
    'pricing.mutate': (input) => this.#mutatePricing(input),
  };

  readonly #stores: InteractiveUsageStoresWriter;
  readonly #requestDrain: () => void;
  readonly #activation: RuntimePolicyActivationGate;
  readonly #onCommittedPricingMutation: () => void;
  #poisonDrainRequested = false;

  constructor(
    stores: InteractiveUsageStoresWriter,
    requestDrain: () => void,
    activation: RuntimePolicyActivationGate,
    onCommittedPricingMutation: () => void = () => {},
  ) {
    this.#stores = authenticateInteractiveUsageStoresWriter(stores);
    this.#requestDrain = requestDrain;
    this.#activation = activation;
    this.#onCommittedPricingMutation = onCommittedPricingMutation;
  }

  async #queryUsage(input: UsageQueryInput): Promise<OperationOutcome<'usage.query'>> {
    try {
      if (input.kind === 'summary') {
        return {
          ok: true,
          result: encodeUsageQueryResult({
            kind: 'summary',
            summary: await this.#stores.telemetry.summary(input.query),
          }),
        };
      }
      if (input.kind === 'buckets') {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? USAGE_PAGE_MAX_ITEMS;
        const buckets = await this.#stores.telemetry.buckets(input.query, input.groupBy);
        if (offset > buckets.length) return invalidUsageOffset();
        return {
          ok: true,
          result: encodeUsageQueryResult(
            usagePage('buckets', buckets.map(projectUsageBucket), buckets.length, offset, limit),
          ),
        };
      }
      const offset = input.offset ?? 0;
      const limit = input.limit ?? USAGE_PAGE_MAX_ITEMS;
      if (input.source === 'tool') {
        const page = await this.#stores.telemetry.toolLogs(input.query, offset, limit);
        if (offset > page.total) return invalidUsageOffset();
        return {
          ok: true,
          result: encodeUsageQueryResult(
            usageLogPage('tool', page.rows.map(projectToolUsageLog), page.total, offset, limit),
          ),
        };
      }
      const page = await this.#stores.telemetry.logs(input.query, offset, limit);
      if (offset > page.total) return invalidUsageOffset();
      return {
        ok: true,
        result: encodeUsageQueryResult(
          usageLogPage('llm', page.rows.map(projectUsageLog), page.total, offset, limit),
        ),
      };
    } catch (error) {
      return this.#mapReadFailure<'usage.query'>(error, 'Usage authority');
    }
  }

  async #queryPricing(input: PricingQueryInput): Promise<OperationOutcome<'pricing.query'>> {
    try {
      const snapshot = await this.#stores.pricing.snapshot();
      if (input.kind === 'continue' && input.revision !== snapshot.revision) {
        return {
          ok: true,
          result: encodePricingQueryResult({
            kind: 'revision_changed',
            expectedRevision: input.revision,
            actualRevision: snapshot.revision,
          }),
        };
      }
      const offset = input.kind === 'start' ? 0 : input.offset;
      if (
        offset > snapshot.overrides.length ||
        (input.kind === 'continue' && offset === snapshot.overrides.length)
      ) {
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'Pricing offset is invalid' },
        };
      }
      return {
        ok: true,
        result: createPricingPage(snapshot.revision, snapshot.overrides, offset),
      };
    } catch (error) {
      return this.#mapReadFailure<'pricing.query'>(error, 'Pricing authority');
    }
  }

  async #mutatePricing(input: PricingMutateInput): Promise<OperationOutcome<'pricing.mutate'>> {
    return this.#activation.runMutation(() => this.#mutatePricingWithinActivation(input));
  }

  async #mutatePricingWithinActivation(
    input: PricingMutateInput,
  ): Promise<OperationOutcome<'pricing.mutate'>> {
    try {
      const stored =
        input.mutation.kind === 'upsert'
          ? await this.#stores.pricing.upsert(input.expectedRevision, input.mutation.pricing)
          : await this.#stores.pricing.delete(input.expectedRevision, input.mutation.modelKey);
      if (stored.changed) this.#onCommittedPricingMutation();
      return {
        ok: true,
        result: {
          kind: stored.changed ? 'committed' : 'unchanged',
          revision: stored.snapshot.revision,
        },
      };
    } catch (error) {
      const failure = classifyInteractiveUsageStoresFailure(error);
      if (failure.kind === 'commit_outcome_unknown') {
        this.#onCommittedPricingMutation();
      }
      return this.#mapMutationFailure(failure);
    }
  }

  #mapMutationFailure(
    failure: InteractiveUsageStoresFailureClassification,
  ): OperationOutcome<'pricing.mutate'> {
    switch (failure.kind) {
      case 'revision_conflict':
        return {
          ok: true,
          result: {
            kind: 'revision_conflict',
            expectedRevision: failure.expectedRevision,
            actualRevision: failure.actualRevision,
          },
        };
      case 'invalid_request':
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'Pricing mutation is invalid' },
        };
      case 'lifecycle':
        return {
          ok: false,
          error: { code: 'host_draining', message: 'Runtime Host is draining' },
        };
      case 'commit_outcome_unknown':
        this.#requestPoisonDrain();
        return {
          ok: false,
          error: {
            code: 'commit_outcome_unknown',
            message: 'Pricing mutation commit outcome is unknown',
          },
        };
      case 'persistence_failed':
        if (failure.needsDrain) this.#requestPoisonDrain();
        return {
          ok: false,
          error: {
            code: 'persistence_failed',
            message: 'Pricing authority persistence failed',
          },
        };
      case 'unknown':
        throw failure.error;
    }
  }

  #mapReadFailure<K extends 'usage.query' | 'pricing.query'>(
    error: unknown,
    authority: string,
  ): OperationOutcome<K> {
    const failure = classifyInteractiveUsageStoresFailure(error);
    switch (failure.kind) {
      case 'invalid_request':
        return {
          ok: false,
          error: { code: 'invalid_request', message: `${authority} request is invalid` },
        } as OperationOutcome<K>;
      case 'lifecycle':
        return {
          ok: false,
          error: { code: 'host_draining', message: 'Runtime Host is draining' },
        } as OperationOutcome<K>;
      case 'commit_outcome_unknown':
        this.#requestPoisonDrain();
        return {
          ok: false,
          error: { code: 'persistence_failed', message: `${authority} persistence failed` },
        } as OperationOutcome<K>;
      case 'persistence_failed':
        if (failure.needsDrain) this.#requestPoisonDrain();
        return {
          ok: false,
          error: { code: 'persistence_failed', message: `${authority} persistence failed` },
        } as OperationOutcome<K>;
      case 'revision_conflict':
        throw error;
      case 'unknown':
        throw failure.error;
    }
  }

  #requestPoisonDrain(): void {
    if (this.#poisonDrainRequested) return;
    this.#poisonDrainRequested = true;
    this.#requestDrain();
  }
}

function invalidUsageOffset(): OperationOutcome<'usage.query'> {
  return {
    ok: false,
    error: { code: 'invalid_request', message: 'Usage offset is invalid' },
  };
}

function createPricingPage(
  revision: number,
  overrides: readonly Readonly<PricingConfig>[],
  offset: number,
): PricingQueryResult {
  const items: Readonly<PricingConfig>[] = [];
  for (let index = offset; index < overrides.length; index += 1) {
    if (items.length >= PRICING_PAGE_MAX_ITEMS) break;
    const item = overrides[index];
    if (!item) break;
    const candidate = [...items, item];
    const nextOffset = offset + candidate.length;
    const page: PricingQueryResult = {
      kind: 'page',
      revision,
      offset,
      overrides: candidate,
      nextOffset: nextOffset < overrides.length ? nextOffset : null,
    };
    if (jsonBytes(page) > PRICING_PAGE_MAX_BYTES) {
      if (items.length === 0) {
        throw new Error('Canonical pricing override exceeds the wire page limit');
      }
      break;
    }
    items.push(item);
  }
  const nextOffset = offset + items.length;
  return encodePricingQueryResult({
    kind: 'page',
    revision,
    offset,
    overrides: items,
    nextOffset: nextOffset < overrides.length ? nextOffset : null,
  });
}

function usagePage(
  kind: 'buckets',
  allItems: readonly UsageBucket[],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'buckets' }>;
function usagePage(
  kind: 'buckets',
  allItems: readonly UsageBucket[],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'buckets' }> {
  const source = allItems.slice(offset, offset + limit);
  const items: UsageBucket[] = [];
  for (const item of source) {
    const candidate = [...items, item];
    const nextOffset = offset + candidate.length;
    if (
      jsonBytes(
        bucketPageResult(candidate, total, offset, nextOffset < total ? nextOffset : null),
      ) > USAGE_PAGE_MAX_BYTES
    ) {
      break;
    }
    items.push(item);
  }
  if (items.length === 0 && offset < total) {
    throw new Error('Canonical usage item exceeds the wire page limit');
  }
  const nextOffset = offset + items.length;
  return bucketPageResult(items, total, offset, nextOffset < total ? nextOffset : null);
}

function bucketPageResult(
  items: readonly UsageBucket[],
  total: number,
  offset: number,
  nextOffset: number | null,
): Extract<UsageQueryResult, { kind: 'buckets' }> {
  return { kind: 'buckets', buckets: items, offset, total, nextOffset };
}

function usageLogPage(
  source: 'llm',
  allItems: readonly LlmUsageLogProjection[],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'logs'; source: 'llm' }>;
function usageLogPage(
  source: 'tool',
  allItems: readonly ToolUsageLogProjection[],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'logs'; source: 'tool' }>;
function usageLogPage(
  source: 'llm' | 'tool',
  allItems: readonly UsageLogProjection[],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'logs' }> {
  const items: UsageLogProjection[] = [];
  for (const item of allItems.slice(0, limit)) {
    const candidate = [...items, item];
    const nextOffset = offset + candidate.length;
    if (
      jsonBytes(
        logPageResult(source, candidate, total, offset, nextOffset < total ? nextOffset : null),
      ) > USAGE_PAGE_MAX_BYTES
    ) {
      break;
    }
    items.push(item);
  }
  if (items.length === 0 && offset < total) {
    throw new Error('Canonical usage item exceeds the wire page limit');
  }
  const nextOffset = offset + items.length;
  return logPageResult(source, items, total, offset, nextOffset < total ? nextOffset : null);
}

function logPageResult(
  source: 'llm' | 'tool',
  rows: readonly UsageLogProjection[],
  total: number,
  offset: number,
  nextOffset: number | null,
): Extract<UsageQueryResult, { kind: 'logs' }> {
  return { kind: 'logs', source, rows, offset, total, nextOffset } as Extract<
    UsageQueryResult,
    { kind: 'logs' }
  >;
}

function projectUsageBucket(bucket: UsageBucket): UsageBucket {
  return {
    ...bucket,
    key: projectIdentity(bucket.key),
    label: projectText(bucket.label),
  };
}

function projectUsageLog(row: UsageLogRow): LlmUsageLogProjection {
  const cacheMissInputSource = (row as UsageLogRow & { readonly cacheMissInputSource?: unknown })
    .cacheMissInputSource;
  return {
    source: 'llm',
    id: projectIdentity(row.id),
    ts: row.ts,
    ...(row.callKind === undefined ? {} : { callKind: row.callKind }),
    ...(row.callId === undefined ? {} : { callId: projectIdentity(row.callId) }),
    ...(row.connectionSlug === undefined
      ? {}
      : { connectionSlug: projectIdentity(row.connectionSlug) }),
    providerId: projectIdentity(row.providerId),
    modelId: projectIdentity(row.modelId),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheMissTokens: row.cacheMissTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    ...(cacheMissInputSource === 'explicit' || cacheMissInputSource === 'derived'
      ? { cacheMissInputSource }
      : {}),
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    latencyMs: row.latencyMs,
    status: row.status,
    ...(row.errorClass === undefined ? {} : { errorClass: projectText(row.errorClass) }),
    ...(row.sessionId === undefined ? {} : { sessionId: projectIdentity(row.sessionId) }),
    ...(row.turnId === undefined ? {} : { turnId: projectIdentity(row.turnId) }),
  };
}

function projectToolUsageLog(
  row: ToolInvocationRecord & {
    readonly id: string;
    readonly bytesIn: number;
    readonly bytesOut: number;
    readonly ts: number;
  },
): ToolUsageLogProjection {
  return {
    source: 'tool',
    id: projectIdentity(row.id),
    ts: row.ts,
    ...(row.toolCallId === undefined ? {} : { toolCallId: projectIdentity(row.toolCallId) }),
    toolName: projectIdentity(row.toolName),
    ...(row.providerId === undefined ? {} : { providerId: projectIdentity(row.providerId) }),
    ...(row.modelId === undefined ? {} : { modelId: projectIdentity(row.modelId) }),
    durationMs: row.durationMs,
    status: row.status,
    ...(row.errorClass === undefined ? {} : { errorClass: projectText(row.errorClass) }),
    ...(row.argsSummary === undefined ? {} : { argsSummary: projectText(row.argsSummary) }),
    ...(row.resultSummary === undefined
      ? {}
      : {
          resultSummary: {
            ...row.resultSummary,
            kind: projectText(row.resultSummary.kind),
            ...(row.resultSummary.status === undefined
              ? {}
              : { status: projectText(row.resultSummary.status) }),
          },
        }),
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    startedAt: row.startedAt,
    ...(row.sessionId === undefined ? {} : { sessionId: projectIdentity(row.sessionId) }),
    ...(row.turnId === undefined ? {} : { turnId: projectIdentity(row.turnId) }),
  };
}

const IDENTITY_HASH_HEX_CHARS = 16;
const IDENTITY_HASH_SEPARATOR = '~';
const IDENTITY_HASH_SUFFIX_BYTES = IDENTITY_HASH_SEPARATOR.length + IDENTITY_HASH_HEX_CHARS;

function projectIdentity(value: string): string {
  const prefixMaxBytes = USAGE_PROJECTION_TEXT_MAX_BYTES - IDENTITY_HASH_SUFFIX_BYTES;
  let projected = '';
  let prefix = '';
  let bytes = 0;
  let prefixBytes = 0;
  let canonicalized = false;
  let prefixTruncated = false;
  let truncated = false;

  for (const codePoint of value) {
    const canonical = projectCodePoint(codePoint);
    if (canonical !== codePoint) canonicalized = true;
    const size = Buffer.byteLength(canonical, 'utf8');
    if (!truncated && bytes + size <= USAGE_PROJECTION_TEXT_MAX_BYTES) {
      projected += canonical;
      bytes += size;
    } else {
      truncated = true;
    }
    if (!prefixTruncated && prefixBytes + size <= prefixMaxBytes) {
      prefix += canonical;
      prefixBytes += size;
    } else {
      prefixTruncated = true;
    }
  }

  if (!truncated && !canonicalized) return projected || '\ufffd';
  const hashSuffix =
    IDENTITY_HASH_SEPARATOR +
    createHash('sha256').update(value, 'utf16le').digest('hex').slice(0, IDENTITY_HASH_HEX_CHARS);
  return prefix + hashSuffix;
}

function projectText(value: string): string {
  let projected = '';
  let bytes = 0;
  for (const codePoint of value) {
    const canonical = projectCodePoint(codePoint);
    const size = Buffer.byteLength(canonical, 'utf8');
    if (bytes + size > USAGE_PROJECTION_TEXT_MAX_BYTES) break;
    projected += canonical;
    bytes += size;
  }
  return projected || '\ufffd';
}

function projectCodePoint(codePoint: string): string {
  const scalar = codePoint.codePointAt(0);
  return scalar !== undefined && (scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f))
    ? '\ufffd'
    : codePoint;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
