import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  canonicalPricingConfigsEqual,
  comparePricingModelKeys,
  normalizePricingConfig,
  normalizePricingModelKey,
  validateCanonicalPricingConfig,
} from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import { throwDeduplicatedFailures } from './failure-utils.js';
import { syncDirectory } from './stable-storage.js';

const PRICING_DOCUMENT_VERSION = 1;

interface PricingDocument {
  readonly version: 1;
  readonly revision: number;
  readonly overrides: readonly Readonly<PricingConfig>[];
}

export interface PricingSnapshot {
  readonly revision: number;
  readonly overrides: readonly Readonly<PricingConfig>[];
}

export interface PricingMutationResult {
  readonly committed: boolean;
  readonly changed: boolean;
  readonly snapshot: PricingSnapshot;
}

export interface PricingStore {
  snapshot(): PricingSnapshot;
  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult>;
  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult>;
  load(): Promise<void>;
  flush(): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface CreatePricingStoreOptions {
  readonly createIfMissing?: boolean;
  readonly initialOverrides?: readonly unknown[];
}

export class PricingStoreClosedError extends Error {
  constructor() {
    super('Pricing store is draining or closed');
    this.name = 'PricingStoreClosedError';
  }
}

export class PricingStoreNotLoadedError extends Error {
  constructor() {
    super('Pricing store has not been loaded');
    this.name = 'PricingStoreNotLoadedError';
  }
}

export class PricingRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Pricing revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'PricingRevisionConflictError';
  }
}

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(`Invalid pricing authority: ${message}`);
    this.name = 'PricingValidationError';
  }
}

export class PricingStorePublicationError extends Error {
  readonly domain = 'pricing_authority';

  constructor(options: { cause: unknown }) {
    super('Unable to publish pricing authority', options);
    this.name = 'PricingStorePublicationError';
  }
}

export class PricingCommitUnknownError extends Error {
  readonly domain = 'pricing_authority';

  constructor(options: { cause: unknown }) {
    super('Pricing commit outcome is unknown; reload before retrying', options);
    this.name = 'PricingCommitUnknownError';
  }
}

export function createPricingStore(
  workspaceRoot: string,
  options: CreatePricingStoreOptions = {},
): PricingStore {
  return new FilePricingStore(
    workspaceRoot,
    options.createIfMissing ?? true,
    options.initialOverrides ?? [],
  );
}

class FilePricingStore implements PricingStore {
  private readonly path: string;
  private document: PricingDocument;
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private failure: PricingCommitUnknownError | PricingStorePublicationError | undefined;
  private state: 'open' | 'draining' | 'closed' = 'open';
  private loadPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    workspaceRoot: string,
    private readonly createIfMissing: boolean,
    private readonly initialOverrides: readonly unknown[],
  ) {
    this.path = join(workspaceRoot, 'pricing.json');
    this.document = makeDocument(0, []);
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.assertOpen();
    if (this.loadPromise) return this.loadPromise;
    const operation = this.loadFromDisk();
    this.loadPromise = operation;
    void operation.catch(() => {
      if (this.state === 'open' && this.loadPromise === operation) {
        this.loadPromise = undefined;
      }
    });
    return operation;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      this.document = decodeDocument(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.document = makeDocument(0, normalizeLegacyOverrides(this.initialOverrides));
      if (this.createIfMissing) await this.publish(this.document);
    }
    this.loaded = true;
  }

  snapshot(): PricingSnapshot {
    this.assertReady();
    if (this.failure instanceof PricingCommitUnknownError) throw this.failure;
    return cloneSnapshot(this.document);
  }

  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult> {
    assertRevision(expectedRevision, 'expectedRevision');
    const normalized = normalizePricingConfig(pricing);
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    const admitted = freezePricing(normalized.value);
    return this.enqueueMutation(expectedRevision, (current) => {
      const existing = current.find((item) => item.modelKey === admitted.modelKey);
      if (existing && canonicalPricingConfigsEqual(existing, admitted)) return current;
      return [...current.filter((item) => item.modelKey !== admitted.modelKey), admitted].sort(
        (left, right) => comparePricingModelKeys(left.modelKey, right.modelKey),
      );
    });
  }

  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult> {
    assertRevision(expectedRevision, 'expectedRevision');
    const normalized = normalizePricingModelKey(modelKey);
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    return this.enqueueMutation(expectedRevision, (current) =>
      current.some((item) => item.modelKey === normalized.value)
        ? current.filter((item) => item.modelKey !== normalized.value)
        : current,
    );
  }

  async flush(): Promise<void> {
    this.assertLoaded();
    await this.queue;
    if (this.failure) throw this.failure;
  }

  beginDrain(): Promise<void> {
    if (this.state === 'open') this.state = 'draining';
    return this.flush();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = 'draining';
    this.closePromise = Promise.allSettled([
      this.loadPromise ?? Promise.resolve(),
      this.queue.then(() => {
        if (this.failure) throw this.failure;
      }),
    ])
      .then((results) => {
        throwDeduplicatedFailures(
          'Unable to close pricing store',
          results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        );
      })
      .finally(() => {
        this.state = 'closed';
      });
    return this.closePromise;
  }

  private enqueueMutation(
    expectedRevision: number,
    mutate: (current: readonly Readonly<PricingConfig>[]) => readonly Readonly<PricingConfig>[],
  ): Promise<PricingMutationResult> {
    this.assertReady();
    const operation = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const current = this.document;
      if (current.revision !== expectedRevision) {
        throw new PricingRevisionConflictError(expectedRevision, current.revision);
      }
      const overrides = mutate(current.overrides);
      if (overrides === current.overrides) {
        return { committed: false, changed: false, snapshot: cloneSnapshot(current) };
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new PricingValidationError('revision cannot advance beyond Number.MAX_SAFE_INTEGER');
      }
      const candidate = makeDocument(current.revision + 1, overrides);
      try {
        await this.publish(candidate);
      } catch (error) {
        if (
          error instanceof PricingCommitUnknownError ||
          error instanceof PricingStorePublicationError
        ) {
          this.failure = error;
        }
        throw error;
      }
      this.document = candidate;
      return { committed: true, changed: true, snapshot: cloneSnapshot(candidate) };
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async publish(document: PricingDocument): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(document, null, 2) + '\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      published = true;
      await syncDirectory(directory);
    } catch (cause) {
      if (published) throw new PricingCommitUnknownError({ cause });
      throw new PricingStorePublicationError({ cause });
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new PricingStoreNotLoadedError();
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new PricingStoreClosedError();
  }

  private assertReady(): void {
    this.assertOpen();
    this.assertLoaded();
  }
}

function decodeDocument(input: unknown): PricingDocument {
  if (!isRecord(input)) throw new PricingValidationError('expected an object');
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('version') ||
    !keys.includes('revision') ||
    !keys.includes('overrides')
  ) {
    throw new PricingValidationError('document must contain exactly version, revision, overrides');
  }
  if (input.version !== PRICING_DOCUMENT_VERSION) {
    throw new PricingValidationError(`expected version ${PRICING_DOCUMENT_VERSION}`);
  }
  assertRevision(input.revision, 'revision');
  if (!Array.isArray(input.overrides)) {
    throw new PricingValidationError('overrides must be an array');
  }
  return makeDocument(input.revision, decodeCanonicalOverrides(input.overrides));
}

function normalizeLegacyOverrides(input: readonly unknown[]): readonly Readonly<PricingConfig>[] {
  const result = input.map((value, index) => {
    const normalized = normalizePricingConfig(value);
    if (!normalized.ok) {
      throw new PricingValidationError(`overrides[${index}]: ${normalized.error}`);
    }
    return freezePricing(normalized.value);
  });
  const keys = new Set<string>();
  for (const item of result) {
    if (keys.has(item.modelKey)) {
      throw new PricingValidationError(`duplicate modelKey: ${item.modelKey}`);
    }
    keys.add(item.modelKey);
  }
  return result.sort((left, right) => comparePricingModelKeys(left.modelKey, right.modelKey));
}

function decodeCanonicalOverrides(input: readonly unknown[]): readonly Readonly<PricingConfig>[] {
  const result = input.map((value, index) => {
    const canonical = validateCanonicalPricingConfig(value);
    if (!canonical.ok) {
      throw new PricingValidationError(`overrides[${index}]: ${canonical.error}`);
    }
    return freezePricing(canonical.value);
  });
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    if (!previous || !current) continue;
    const order = comparePricingModelKeys(previous.modelKey, current.modelKey);
    if (order === 0) {
      throw new PricingValidationError(`duplicate modelKey: ${current.modelKey}`);
    }
    if (order > 0) {
      throw new PricingValidationError('overrides must be sorted by modelKey');
    }
  }
  return result;
}

function makeDocument(
  revision: number,
  overrides: readonly Readonly<PricingConfig>[],
): PricingDocument {
  return Object.freeze({
    version: PRICING_DOCUMENT_VERSION,
    revision,
    overrides: Object.freeze(overrides.map(freezePricing)),
  });
}

function cloneSnapshot(document: PricingDocument): PricingSnapshot {
  return Object.freeze({
    revision: document.revision,
    overrides: Object.freeze(document.overrides.map(freezePricing)),
  });
}

function freezePricing(pricing: PricingConfig): Readonly<PricingConfig> {
  return Object.freeze({ ...pricing });
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PricingValidationError(`${label} must be a nonnegative safe integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
