import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import { throwDeduplicatedFailures } from './failure-utils.js';
import {
  createSqliteModelCallLedger,
  ModelCallLedgerClosedError,
  ModelCallLedgerPublicationError,
  type ModelCallLedger,
  type ModelCallLedgerPage,
  type ModelCallLedgerReader,
  type PendingReprojection,
} from './model-call-ledger.js';
import {
  PricingCommitUnknownError,
  PricingRevisionConflictError,
  PricingStoreClosedError,
  PricingStoreNotLoadedError,
  PricingStorePublicationError,
  PricingValidationError,
  type PricingMutationResult,
  type PricingSnapshot,
  type PricingStore,
} from './pricing-store.js';
import {
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootAuthorityErrorCode,
  type StorageRootLease,
} from './root-authority.js';
import {
  TelemetryQueryValidationError,
  TelemetryRepoClosedError,
  TelemetryRepoNotLoadedError,
  TelemetryRepoPublicationError,
  type PersistedLlmCallRecord,
  type PersistedToolInvocationRecord,
  type TelemetryRepo,
  type ToolUsageQuery,
} from './telemetry-repo.js';
import { createSqlitePricingStore, createSqliteTelemetryRepo } from './sqlite-usage-store.js';

const readerBrand: unique symbol = Symbol('InteractiveUsageStoresReader');
const writerBrand: unique symbol = Symbol('InteractiveUsageStoresWriter');
const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveUsageStoresWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveUsageStoresWriter>>();

export interface TelemetryIndexReader {
  summary(query: UsageQuery): Promise<UsageSummaryV2>;
  buckets(query: UsageQuery, groupBy: UsageGroupBy): Promise<UsageBucket[]>;
  logs(
    query: UsageQuery,
    offset?: number,
    limit?: number,
  ): Promise<{ rows: UsageLogRow[]; total: number }>;
  toolLogs(
    query: ToolUsageQuery,
    offset?: number,
    limit?: number,
  ): Promise<{ rows: PersistedToolInvocationRecord[]; total: number }>;
  latestLlmRuntimeProbe(connectionSlug: string, modelId?: string): Promise<UsageLogRow | undefined>;
}

export interface TelemetryIndexWriter extends TelemetryIndexReader {
  recordLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  recordToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
}

/**
 * Read side of the canonical model-call ledger (#1679). Async here — unlike the
 * synchronous store beneath it — because every authority read goes through the
 * storage-root lease.
 */
export interface ModelCallIndexReader {
  modelCallAttempts(range: {
    readonly from: number;
    readonly to: number;
  }): Promise<ModelCallLedgerPage>;
}

export interface ModelCallIndexWriter extends ModelCallIndexReader {
  recordModelCallAttempt(attempt: ModelCallAttempt): Promise<void>;
  markRunPendingReprojection(sessionId: string, runId: string): Promise<void>;
  pendingReprojections(): Promise<PendingReprojection[]>;
  clearPendingReprojection(sessionId: string, runId: string): Promise<void>;
}

export interface PricingAuthorityReader {
  snapshot(): Promise<PricingSnapshot>;
}

export interface PricingAuthorityWriter extends PricingAuthorityReader {
  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult>;
  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult>;
}

export interface InteractiveUsageStoresReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
  readonly telemetry: Readonly<TelemetryIndexReader>;
  readonly modelCalls: Readonly<ModelCallIndexReader>;
  readonly pricing: Readonly<PricingAuthorityReader>;
  close(): Promise<void>;
}

export interface InteractiveUsageStoresWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  readonly telemetry: Readonly<TelemetryIndexWriter>;
  readonly modelCalls: Readonly<ModelCallIndexWriter>;
  readonly pricing: Readonly<PricingAuthorityWriter>;
  beginDrain(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InteractiveUsageStoresClosedError extends Error {
  constructor() {
    super('Interactive usage stores are draining or closed');
    this.name = 'InteractiveUsageStoresClosedError';
  }
}

export type InteractiveUsageStoresFailureClassification =
  | { readonly kind: 'lifecycle' }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly kind: 'invalid_request' }
  | { readonly kind: 'commit_outcome_unknown'; readonly needsDrain: true }
  | { readonly kind: 'persistence_failed'; readonly needsDrain: boolean }
  | { readonly kind: 'unknown'; readonly error: unknown };

export function classifyInteractiveUsageStoresFailure(
  error: unknown,
): InteractiveUsageStoresFailureClassification {
  if (error instanceof PricingRevisionConflictError) {
    return {
      kind: 'revision_conflict',
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    };
  }
  if (error instanceof PricingValidationError || error instanceof TelemetryQueryValidationError) {
    return { kind: 'invalid_request' };
  }
  if (
    error instanceof InteractiveUsageStoresClosedError ||
    error instanceof PricingStoreClosedError ||
    error instanceof TelemetryRepoClosedError ||
    error instanceof ModelCallLedgerClosedError ||
    (error instanceof StorageRootAuthorityError &&
      (error.code === 'invalid_lease' || error.code === 'invalid_owner'))
  ) {
    return { kind: 'lifecycle' };
  }
  if (
    error instanceof PricingCommitUnknownError ||
    (error instanceof TelemetryRepoPublicationError && error.commitUnknown) ||
    (error instanceof ModelCallLedgerPublicationError && error.commitUnknown)
  ) {
    return { kind: 'commit_outcome_unknown', needsDrain: true };
  }
  if (
    error instanceof PricingStorePublicationError ||
    error instanceof TelemetryRepoPublicationError ||
    error instanceof ModelCallLedgerPublicationError
  ) {
    return { kind: 'persistence_failed', needsDrain: true };
  }
  if (error instanceof PricingStoreNotLoadedError || error instanceof TelemetryRepoNotLoadedError) {
    return { kind: 'persistence_failed', needsDrain: false };
  }
  if (error instanceof StorageRootAuthorityError) {
    return {
      kind: 'persistence_failed',
      needsDrain: rootAuthorityFailureNeedsDrain(error.code),
    };
  }
  return { kind: 'unknown', error };
}

function rootAuthorityFailureNeedsDrain(code: StorageRootAuthorityErrorCode): boolean {
  switch (code) {
    case 'root_unmarked':
    case 'invalid_marker':
    case 'root_identity_collision':
    case 'root_identity_changed':
      return true;
    case 'invalid_root':
    case 'invalid_root_kind':
    case 'root_not_found':
    case 'invalid_repair':
    case 'invalid_capability':
    case 'invalid_lease':
    case 'invalid_owner':
    case 'invalid_lock_artifact':
    case 'insecure_control_directory':
    case 'root_io_failed':
    case 'control_io_failed':
    case 'lock_failed':
      return false;
  }
}

export function authenticateInteractiveUsageStoresReader(
  stores: InteractiveUsageStoresReader,
): InteractiveUsageStoresReader {
  if (!readers.has(stores)) throw new TypeError('Expected an authentic interactive usage reader');
  return stores;
}

export function authenticateInteractiveUsageStoresWriter(
  stores: InteractiveUsageStoresWriter,
): InteractiveUsageStoresWriter {
  if (!writers.has(stores)) throw new TypeError('Expected an authentic interactive usage writer');
  return stores;
}

export async function openInteractiveUsageStoresForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveUsageStoresReader> {
  const repos = await runWithStorageRootLease(lease, 'interactive', 'read', (root) =>
    openRepos(root, false),
  );
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const run = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new InteractiveUsageStoresClosedError());
    return runWithStorageRootLease(lease, 'interactive', 'read', async () => operation());
  };
  const stores: InteractiveUsageStoresReader = {
    kind: 'interactive',
    access: 'read',
    [readerBrand]: true,
    telemetry: telemetryReader(repos.telemetry, run),
    modelCalls: modelCallReader(repos.modelCalls, run),
    pricing: pricingReader(repos.pricing, run),
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = closeRepos(repos.telemetry, repos.modelCalls, repos.pricing);
      return closePromise;
    },
  };
  freezeFacade(stores);
  readers.add(stores);
  return stores;
}

export async function openInteractiveUsageStoresForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveUsageStoresWriter> {
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;
  const pending = runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
    const repos = await openRepos(root, true);
    const stores = createWriterFacade(lease, repos.telemetry, repos.modelCalls, repos.pricing);
    writers.add(stores);
    writerByLease.set(lease, stores);
    return stores;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

async function openRepos(
  root: string,
  createIfMissing: boolean,
): Promise<{ telemetry: TelemetryRepo; modelCalls: ModelCallLedger; pricing: PricingStore }> {
  const telemetry = createSqliteTelemetryRepo(root, { createIfMissing, managePricing: false });
  await telemetry.load();
  const modelCalls = createSqliteModelCallLedger(root);
  const pricing = createSqlitePricingStore(root, { createIfMissing });
  try {
    await pricing.load();
    return { telemetry, modelCalls, pricing };
  } catch (error) {
    const closed = await Promise.allSettled([
      telemetry.close(),
      modelCalls.close(),
      pricing.close(),
    ]);
    const failures = [error, ...rejectedReasons(closed)];
    throwDeduplicatedFailures('Unable to open interactive usage stores', failures);
    throw error;
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  telemetry: TelemetryRepo,
  modelCalls: ModelCallLedger,
  pricing: PricingStore,
): InteractiveUsageStoresWriter {
  const run = <T>(operation: () => T | Promise<T>): Promise<T> =>
    runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
  let state: 'open' | 'draining' | 'closed' = 'open';
  let barrier: Promise<void> = Promise.resolve();
  const failures: unknown[] = [];
  let drainPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const assertOpen = () => {
    if (state !== 'open') throw new InteractiveUsageStoresClosedError();
  };
  const admit = <T>(
    operation: () => Promise<T>,
    expectedFailure: (error: unknown) => boolean = () => false,
  ): Promise<T> => {
    assertOpen();
    const admitted = Promise.resolve().then(operation);
    const observed = admitted.then(
      () => undefined,
      (error: unknown) => {
        if (!expectedFailure(error)) failures.push(error);
      },
    );
    barrier = Promise.all([barrier, observed]).then(() => undefined);
    return admitted;
  };
  const read = <T>(operation: () => T): Promise<T> => {
    assertOpen();
    return run(operation);
  };

  const beginDrain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    state = 'draining';
    const accepted = barrier;
    drainPromise = accepted.then(() =>
      throwDeduplicatedFailures('Interactive usage store drain failed', failures),
    );
    return drainPromise;
  };

  const flush = async (): Promise<void> => {
    const accepted = barrier;
    await accepted;
    const flushed = await Promise.allSettled([
      run(() => telemetry.flush()),
      run(() => modelCalls.flush()),
      run(() => pricing.flush()),
    ]);
    throwDeduplicatedFailures('Interactive usage store flush failed', [
      ...failures,
      ...rejectedReasons(flushed),
    ]);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    state = 'draining';
    const accepted = barrier;
    closePromise = accepted
      .then(async () => {
        const closed = await Promise.allSettled([
          telemetry.close(),
          modelCalls.close(),
          pricing.close(),
        ]);
        throwDeduplicatedFailures('Interactive usage stores close failed', [
          ...failures,
          ...rejectedReasons(closed),
        ]);
      })
      .finally(() => {
        state = 'closed';
      });
    return closePromise;
  };

  const stores: InteractiveUsageStoresWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    telemetry: {
      summary: (query) => read(() => telemetry.summary(query)),
      buckets: (query, groupBy) => read(() => telemetry.buckets(query, groupBy)),
      logs: (query, offset, limit) => read(() => telemetry.logs(query, offset, limit)),
      toolLogs: (query, offset, limit) => read(() => telemetry.toolLogs(query, offset, limit)),
      latestLlmRuntimeProbe: (connectionSlug, modelId) =>
        read(() => telemetry.latestLlmRuntimeProbe(connectionSlug, modelId)),
      recordLlmCall: (record) => admit(() => run(() => telemetry.insertLlmCall(record))),
      recordToolInvocation: (record) =>
        admit(() => run(() => telemetry.insertToolInvocation(record))),
    },
    modelCalls: {
      modelCallAttempts: (range) => read(() => modelCalls.read(range)),
      recordModelCallAttempt: (attempt) => admit(() => run(() => modelCalls.record(attempt))),
      markRunPendingReprojection: (sessionId, runId) =>
        admit(() => run(() => modelCalls.markRunPendingReprojection(sessionId, runId))),
      pendingReprojections: () => read(() => modelCalls.pendingReprojections()),
      clearPendingReprojection: (sessionId, runId) =>
        admit(() => run(() => modelCalls.clearPendingReprojection(sessionId, runId))),
    },
    pricing: {
      snapshot: () => read(() => pricing.snapshot()),
      upsert: (expectedRevision, value) =>
        admit(() => run(() => pricing.upsert(expectedRevision, value)), isExpectedPricingFailure),
      delete: (expectedRevision, modelKey) =>
        admit(
          () => run(() => pricing.delete(expectedRevision, modelKey)),
          isExpectedPricingFailure,
        ),
    },
    beginDrain,
    flush,
    close,
  };
  freezeFacade(stores);
  return stores;
}

function telemetryReader(
  repo: TelemetryRepo,
  run: <T>(operation: () => T | Promise<T>) => Promise<T>,
): Readonly<TelemetryIndexReader> {
  return Object.freeze({
    summary: (query: UsageQuery) => run(() => repo.summary(query)),
    buckets: (query: UsageQuery, groupBy: UsageGroupBy) => run(() => repo.buckets(query, groupBy)),
    logs: (query: UsageQuery, offset?: number, limit?: number) =>
      run(() => repo.logs(query, offset, limit)),
    toolLogs: (query: ToolUsageQuery, offset?: number, limit?: number) =>
      run(() => repo.toolLogs(query, offset, limit)),
    latestLlmRuntimeProbe: (connectionSlug: string, modelId?: string) =>
      run(() => repo.latestLlmRuntimeProbe(connectionSlug, modelId)),
  });
}

function modelCallReader(
  ledger: ModelCallLedgerReader,
  run: <T>(operation: () => T | Promise<T>) => Promise<T>,
): Readonly<ModelCallIndexReader> {
  return Object.freeze({
    modelCallAttempts: (range: { readonly from: number; readonly to: number }) =>
      run(() => ledger.read(range)),
  });
}

function pricingReader(
  store: PricingStore,
  run: <T>(operation: () => T | Promise<T>) => Promise<T>,
): Readonly<PricingAuthorityReader> {
  return Object.freeze({ snapshot: () => run(() => store.snapshot()) });
}

function isExpectedPricingFailure(error: unknown): boolean {
  return error instanceof PricingRevisionConflictError || error instanceof PricingValidationError;
}

async function closeRepos(
  telemetry: TelemetryRepo,
  modelCalls: ModelCallLedger,
  pricing: PricingStore,
): Promise<void> {
  const closed = await Promise.allSettled([telemetry.close(), modelCalls.close(), pricing.close()]);
  throwDeduplicatedFailures('Unable to close interactive usage stores', rejectedReasons(closed));
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

function freezeFacade(stores: InteractiveUsageStoresReader | InteractiveUsageStoresWriter): void {
  Object.freeze(stores.telemetry);
  Object.freeze(stores.modelCalls);
  Object.freeze(stores.pricing);
  Object.freeze(stores);
}
