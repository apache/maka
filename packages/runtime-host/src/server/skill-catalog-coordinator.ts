import type {
  OperationOutcome,
  SkillCatalogInvocableQueryInput,
  SkillCatalogLocalContext,
  SkillCatalogMutateInput,
  SkillCatalogPreviewUpdateInput,
  SkillCatalogQueryInput,
} from '../protocol/index.js';
import type { ConnectionContext, SkillCatalogOperationHandlerMap } from './operation-dispatcher.js';
import type { HostCapabilities } from '@maka/runtime';
import {
  SkillCatalogRepository,
  SkillCatalogRepositoryError,
  type CanonicalSkillInventorySnapshot,
} from './skill-catalog-repository.js';

type CatalogOperation =
  | 'skill.catalog.query'
  | 'skill.catalog.invocable.query'
  | 'skill.catalog.mutate'
  | 'skill.catalog.preview-update';

export interface SkillCatalogInvocableContext {
  readonly projectRoot: string;
  readonly host: HostCapabilities;
}

export type SkillCatalogInvocableContextResolver = (
  input: SkillCatalogInvocableQueryInput,
  context: ConnectionContext,
) => Promise<SkillCatalogInvocableContext>;

/** Serialized single authority lane for catalog recovery, reads, and mutations. */
export class HostSkillCatalogCoordinator {
  readonly handlers: SkillCatalogOperationHandlerMap = {
    'skill.catalog.query': (input) => this.query(input),
    'skill.catalog.invocable.query': (input, context) => this.queryInvocable(input, context),
    'skill.catalog.mutate': (input) => this.mutate(input),
    'skill.catalog.preview-update': (input) => this.previewUpdate(input),
  };

  readonly #repository: SkillCatalogRepository;
  readonly #resolveInvocableContext: SkillCatalogInvocableContextResolver | undefined;
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(
    repository: SkillCatalogRepository,
    resolveInvocableContext?: SkillCatalogInvocableContextResolver,
  ) {
    this.#repository = repository;
    this.#resolveInvocableContext = resolveInvocableContext;
  }

  recover(): Promise<void> {
    return this.#enqueue(() => this.#repository.recover());
  }

  query(input: SkillCatalogQueryInput): Promise<OperationOutcome<'skill.catalog.query'>> {
    return this.#admitProtocolOperation('skill.catalog.query', () => this.#repository.query(input));
  }

  queryInvocable(
    input: SkillCatalogInvocableQueryInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'skill.catalog.invocable.query'>> {
    if (!this.#resolveInvocableContext) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'operation_unavailable',
          message: 'Invocable Skill catalog context is unavailable',
        },
      });
    }
    return this.#admitProtocolOperation('skill.catalog.invocable.query', async () => {
      const resolved = await this.#resolveInvocableContext!(input, context);
      return this.#repository.queryInvocable(
        input,
        { projectRoot: resolved.projectRoot },
        resolved.host,
      );
    });
  }

  mutate(input: SkillCatalogMutateInput): Promise<OperationOutcome<'skill.catalog.mutate'>> {
    return this.#admitProtocolOperation('skill.catalog.mutate', () =>
      this.#repository.mutate(input),
    );
  }

  previewUpdate(
    input: SkillCatalogPreviewUpdateInput,
  ): Promise<OperationOutcome<'skill.catalog.preview-update'>> {
    return this.#admitProtocolOperation('skill.catalog.preview-update', () =>
      this.#repository.previewUpdate(input),
    );
  }

  readCanonicalModelInventory(
    context: SkillCatalogLocalContext,
  ): Promise<CanonicalSkillInventorySnapshot> {
    return this.#admitModelInventoryRead(() =>
      this.#repository.readCanonicalModelInventory(context),
    );
  }

  beginDrain(): void {
    this.#accepting = false;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.beginDrain();
    this.#closePromise = this.#tail;
    return this.#closePromise;
  }

  #admitProtocolOperation<K extends CatalogOperation>(
    operation: K,
    run: () => Promise<Extract<OperationOutcome<K>, { ok: true }>['result']>,
  ): Promise<OperationOutcome<K>> {
    if (!this.#accepting) {
      return Promise.resolve({
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      } as OperationOutcome<K>);
    }
    return this.#enqueue(async () => {
      try {
        return { ok: true, result: await run() } as OperationOutcome<K>;
      } catch (error) {
        return repositoryFailure<K>(operation, error);
      }
    });
  }

  #admitModelInventoryRead<T>(run: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(
        new SkillCatalogRepositoryError('persistence_failed', 'Runtime Host is draining'),
      );
    }
    return this.#enqueue(run);
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(run, run);
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

function repositoryFailure<K extends CatalogOperation>(
  operation: K,
  error: unknown,
): OperationOutcome<K> {
  if (!(error instanceof SkillCatalogRepositoryError)) {
    return {
      ok: false,
      error: { code: 'internal_failure', message: 'Skill catalog operation failed' },
    } as OperationOutcome<K>;
  }
  if (error.code === 'commit_outcome_unknown' && operation !== 'skill.catalog.mutate') {
    return {
      ok: false,
      error: { code: 'persistence_failed', message: error.message },
    } as OperationOutcome<K>;
  }
  return {
    ok: false,
    error: { code: error.code, message: error.message },
  } as OperationOutcome<K>;
}
