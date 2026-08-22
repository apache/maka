/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type {
  OperationOutcome,
  SkillCatalogInvocableQueryInput,
  SkillCatalogMutateInput,
  SkillCatalogPreviewUpdateInput,
  SkillCatalogQueryInput,
  WorkspaceProjection,
} from '../protocol/index.js';
import type { ConnectionContext, SkillCatalogOperationHandlerMap } from './operation-dispatcher.js';
import type { HostCapabilities } from '@maka/runtime/skills';
import {
  SkillCatalogRepository,
  SkillCatalogRepositoryError,
  type CanonicalSkillInventorySnapshot,
  type SkillCatalogLocalContext,
  type SkillCatalogRepositoryInvocableQueryInput,
  type SkillCatalogRepositoryMutateInput,
  type SkillCatalogRepositoryPreviewUpdateInput,
  type SkillCatalogRepositoryQueryInput,
} from './skill-catalog-repository.js';
import {
  type HostWorkspaceResolver,
  type ResolvedWorkspace,
  WorkspaceResolutionError,
} from './workspace-resolver.js';

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
  readonly #workspaceResolver: Pick<HostWorkspaceResolver, 'run'>;
  readonly #resolveInvocableContext: SkillCatalogInvocableContextResolver | undefined;
  #accepting = true;
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(
    repository: SkillCatalogRepository,
    workspaceResolver: Pick<HostWorkspaceResolver, 'run'>,
    resolveInvocableContext?: SkillCatalogInvocableContextResolver,
  ) {
    this.#repository = repository;
    this.#workspaceResolver = workspaceResolver;
    this.#resolveInvocableContext = resolveInvocableContext;
  }

  recover(): Promise<void> {
    return this.#enqueue(() => this.#repository.recover());
  }

  query(input: SkillCatalogQueryInput): Promise<OperationOutcome<'skill.catalog.query'>> {
    return this.#admitProtocolOperation('skill.catalog.query', () =>
      this.#workspaceResolver.run(input.context.workspace, async (workspace) =>
        withResolvedWorkspace(
          await this.#repository.query(repositoryQueryInput(input), {
            projectRoot: workspace.cwd,
          }),
          workspace,
        ),
      ),
    );
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
        repositoryInvocableQueryInput(input),
        { projectRoot: resolved.projectRoot },
        resolved.host,
      );
    });
  }

  mutate(input: SkillCatalogMutateInput): Promise<OperationOutcome<'skill.catalog.mutate'>> {
    return this.#admitProtocolOperation('skill.catalog.mutate', () =>
      this.#workspaceResolver.run(input.context.workspace, async (workspace) =>
        withResolvedWorkspace(
          await this.#repository.mutate(repositoryMutateInput(input), {
            projectRoot: workspace.cwd,
          }),
          workspace,
        ),
      ),
    );
  }

  previewUpdate(
    input: SkillCatalogPreviewUpdateInput,
  ): Promise<OperationOutcome<'skill.catalog.preview-update'>> {
    return this.#admitProtocolOperation('skill.catalog.preview-update', () =>
      this.#workspaceResolver.run(input.context.workspace, async (workspace) =>
        withResolvedWorkspace(
          await this.#repository.previewUpdate(repositoryPreviewInput(input), {
            projectRoot: workspace.cwd,
          }),
          workspace,
        ),
      ),
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

function withResolvedWorkspace<Result extends object>(
  result: Result,
  workspace: ResolvedWorkspace,
): Result & { readonly resolvedWorkspace: WorkspaceProjection } {
  return {
    ...result,
    resolvedWorkspace: { target: workspace.target, hostCwd: workspace.cwd },
  };
}

function repositoryQueryInput(input: SkillCatalogQueryInput): SkillCatalogRepositoryQueryInput {
  return input.kind === 'start'
    ? { kind: 'start', view: input.view }
    : {
        kind: 'continue',
        view: input.view,
        revision: input.revision,
        cursor: input.cursor,
      };
}

function repositoryInvocableQueryInput(
  input: SkillCatalogInvocableQueryInput,
): SkillCatalogRepositoryInvocableQueryInput {
  return input.kind === 'start'
    ? { kind: 'start' }
    : { kind: 'continue', revision: input.revision, cursor: input.cursor };
}

function repositoryMutateInput(input: SkillCatalogMutateInput): SkillCatalogRepositoryMutateInput {
  return {
    expectedRevision: input.expectedRevision,
    mutation: input.mutation,
  };
}

function repositoryPreviewInput(
  input: SkillCatalogPreviewUpdateInput,
): SkillCatalogRepositoryPreviewUpdateInput {
  return {
    expectedRevision: input.expectedRevision,
    ref: input.ref,
  };
}

function repositoryFailure<K extends CatalogOperation>(
  operation: K,
  error: unknown,
): OperationOutcome<K> {
  if (!(error instanceof SkillCatalogRepositoryError)) {
    if (error instanceof WorkspaceResolutionError) {
      return {
        ok: false,
        error: { code: 'invalid_request', message: error.message },
      } as OperationOutcome<K>;
    }
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
