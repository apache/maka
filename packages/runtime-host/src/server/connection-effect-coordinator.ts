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
  ConnectionCatalogEntry,
  ConnectionModelDiscoveryResult,
  ConnectionTestErrorClass,
  ConnectionTestSummary,
} from '@maka/core/runtime-policy';
import { parseRequestHeaders } from '@maka/core/runtime-policy';
import {
  PROVIDER_DEFAULTS,
  deriveConnectionSlug,
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import {
  createConnectionEffectFetchTransport,
  type ConnectionEffectFetchTransport,
  type ConnectionEffectProxySnapshot,
} from '@maka/runtime/network/scoped-fetch-transport';
import { createRequestCustomizationFetch } from '@maka/runtime/request-customization-fetch';
import { isOAuthSubscriptionProvider } from '@maka/runtime/subscription-credentials';
import { runConnectionModelDiscoveryEffect } from '@maka/runtime/model-fetcher';
import { runConnectionTestEffect } from '@maka/runtime/test-connection';
import {
  type ConnectionEffectErrorKind,
  type ConnectionModelDiscoveryEffectOutcome,
  type ConnectionTestEffectOutcome,
} from '@maka/runtime/connection-effect-outcome';
import { type ConnectionEffectFetchDependency } from '@maka/runtime/connection-effect-fetch';
import {
  authenticateRuntimePolicyStoresWriter,
  RuntimePolicyStoreError,
  type BeginConnectionTestResult,
  type BeginModelFetchResult,
  type ConnectionEffectCompletionResult,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import type {
  ConnectionEffectChangedDomain,
  ConnectionEffectFailureClass,
  ConnectionEffectRejectionReason,
  ConnectionModelFetchInput,
  ConnectionModelFetchResult,
  ConnectionOnboardingVerifyInput,
  ConnectionOnboardingSaveInput,
  ConnectionOnboardingSaveResult,
  ConnectionTestProjection,
  ConnectionTestRunInput,
  ConnectionTestRunResult,
  OperationOutcome,
} from '../protocol/index.js';
import type { ConnectionEffectOperationHandlerMap } from './operation-dispatcher.js';
import type { HostOAuthExecutionAuthority } from './oauth-execution-authority.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

type ModelDiscoveryRunner = (
  connection: ConnectionCatalogEntry,
  apiKey: string,
  options: ConnectionEffectFetchDependency,
) => Promise<ConnectionModelDiscoveryEffectOutcome>;

type ConnectionTestRunner = (
  connection: ConnectionCatalogEntry,
  apiKey: string,
  options: ConnectionEffectFetchDependency,
  modelId?: string,
) => Promise<ConnectionTestEffectOutcome>;

export interface HostConnectionEffectCoordinatorOptions {
  readonly stores: RuntimePolicyStoresWriter;
  readonly activation: RuntimePolicyActivationGate;
  readonly oauthCredentials: Pick<HostOAuthExecutionAuthority, 'bind'>;
  readonly onCommittedMutation?: () => void;
  readonly now?: () => number;
  readonly runModelDiscovery?: ModelDiscoveryRunner;
  readonly runConnectionTest?: ConnectionTestRunner;
  readonly createTransport?: (
    proxy: ConnectionEffectProxySnapshot | null,
  ) => ConnectionEffectFetchTransport;
}

/** Runs provider I/O outside Storage lanes and conditionally commits canonical results. */
export class HostConnectionEffectCoordinator {
  readonly handlers: ConnectionEffectOperationHandlerMap = {
    'connection.onboarding.save': (input) => this.#saveOnboarding(input),
    'connection.onboarding.verify': (input) => this.#verifyOnboarding(input),
    'connection.models.fetch': (input) => this.#fetchModels(input),
    'connection.test.run': (input) => this.#testConnection(input),
  };

  readonly #stores: RuntimePolicyStoresWriter;
  readonly #activation: RuntimePolicyActivationGate;
  readonly #oauthCredentials: Pick<HostOAuthExecutionAuthority, 'bind'>;
  readonly #onCommittedMutation: () => void;
  readonly #now: () => number;
  readonly #runModelDiscovery: ModelDiscoveryRunner;
  readonly #runConnectionTest: ConnectionTestRunner;
  readonly #createTransport: (
    proxy: ConnectionEffectProxySnapshot | null,
  ) => ConnectionEffectFetchTransport;
  readonly #tails = new Map<string, Promise<void>>();
  #accepting = true;
  #closePromise: Promise<void> | undefined;

  constructor(options: HostConnectionEffectCoordinatorOptions) {
    this.#stores = authenticateRuntimePolicyStoresWriter(options.stores);
    this.#activation = options.activation;
    this.#oauthCredentials = options.oauthCredentials;
    this.#onCommittedMutation = options.onCommittedMutation ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#runModelDiscovery = options.runModelDiscovery ?? runConnectionModelDiscoveryEffect;
    this.#runConnectionTest = options.runConnectionTest ?? runConnectionTestEffect;
    this.#createTransport = options.createTransport ?? createConnectionEffectFetchTransport;
  }

  beginDrain(): void {
    this.#accepting = false;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.beginDrain();
    this.#closePromise = Promise.all([...this.#tails.values()]).then(() => undefined);
    return this.#closePromise;
  }

  #fetchModels(
    input: ConnectionModelFetchInput,
  ): Promise<OperationOutcome<'connection.models.fetch'>> {
    return this.#admit(input.connectionId, 'connection.models.fetch', async () => {
      const prepared = await this.#stores.operations.beginModelFetch(input.connectionId);
      if (prepared.kind !== 'ready') return preparationResult(prepared);

      const effect = await this.#withTransport(prepared, (fetch, secret) =>
        this.#runModelDiscovery(prepared.connection, secret, { fetch }),
      );
      if (!effect.ok || effect.models.length === 0) {
        return {
          kind: 'failed',
          errorClass: effect.ok ? 'invalid_response' : effect.error.kind,
        };
      }

      const result: ConnectionModelDiscoveryResult = {
        models: effect.models,
        source: 'fetched',
        fetchedAt: this.#now(),
      };
      const completion = await this.#complete(() =>
        this.#stores.operations.completeModelFetch(prepared.ticket, result),
      );
      return completion.kind === 'committed'
        ? {
            kind: 'committed',
            catalogRevision: completion.snapshot.revision,
            connection: committedConnectionBasis(
              completion.snapshot.connections,
              prepared.connection.connectionId,
            ),
            modelCount: result.models.length,
            source: result.source,
            fetchedAt: result.fetchedAt,
          }
        : projectSuperseded(completion);
    });
  }

  #verifyOnboarding(
    input: ConnectionOnboardingVerifyInput,
  ): Promise<OperationOutcome<'connection.onboarding.verify'>> {
    const slug = deriveConnectionSlug(input.providerType);
    return this.#admit(slug, 'connection.onboarding.verify', async () => {
      const prepared = await this.#discoverOnboarding(input);
      return prepared.kind === 'ready' ? { kind: 'verified', models: prepared.models } : prepared;
    });
  }

  #saveOnboarding(
    input: ConnectionOnboardingSaveInput,
  ): Promise<OperationOutcome<'connection.onboarding.save'>> {
    const slug = deriveConnectionSlug(input.providerType);
    return this.#admit(slug, 'connection.onboarding.save', async () => {
      const prepared = await this.#discoverOnboarding(input);
      if (prepared.kind !== 'ready') return prepared;
      const available = new Set(prepared.models.map(({ id }) => id));
      if (input.enabledModelIds.some((modelId) => !available.has(modelId))) {
        return { kind: 'rejected', reason: 'model_unavailable' };
      }
      return this.#activation.runMutation(async () => this.#commitOnboarding(input, prepared));
    });
  }

  async #discoverOnboarding(input: ConnectionOnboardingVerifyInput): Promise<OnboardingDiscovery> {
    if (!providerAuthSupportsApiKey(input.providerType)) {
      return { kind: 'rejected', reason: 'provider_unsupported' };
    }
    const slug = deriveConnectionSlug(input.providerType);
    const catalog = await this.#stores.connectionCatalog.getSnapshot();
    const candidate = catalog.connections.find((connection) => connection.slug === slug);
    if (candidate && candidate.providerType !== input.providerType) {
      return { kind: 'rejected', reason: 'slug_conflict' };
    }
    const supplied = input.apiKey?.trim() ?? '';
    const stored = candidate
      ? await this.#stores.operations.exportCredentialMaterial({
          scope: 'connection',
          connectionId: candidate.connectionId,
          kind: 'api_key',
        })
      : null;
    const secret = supplied || stored?.secret || '';
    if (PROVIDER_DEFAULTS[input.providerType].authKind === 'api_key' && secret.length === 0) {
      return { kind: 'rejected', reason: 'credential_not_configured' };
    }
    const proxy = await this.#stores.operations.resolveNetworkProxyExecution();
    if (proxy.kind !== 'ready') return { kind: 'failed', errorClass: 'network' };
    const transport = this.#createTransport(
      toRuntimePolicyProxy(proxy.networkProxy, proxy.secretMaterial.networkProxy?.secret),
    );
    try {
      const effect = await this.#runModelDiscovery(
        candidate ?? transientConnection(input.providerType),
        secret,
        { fetch: transport.fetch },
      );
      if (!effect.ok || effect.models.length === 0) {
        return {
          kind: 'failed',
          errorClass: effect.ok ? 'invalid_response' : effect.error.kind,
        };
      }
      return {
        kind: 'ready',
        suppliedSecret: supplied,
        models: effect.models,
      };
    } finally {
      await transport.close();
    }
  }

  async #commitOnboarding(
    input: ConnectionOnboardingSaveInput,
    prepared: Extract<OnboardingDiscovery, { readonly kind: 'ready' }>,
  ): Promise<ConnectionOnboardingSaveResult> {
    try {
      const committed = await this.#stores.operations.commitConnectionOnboarding({
        providerType: input.providerType,
        suppliedSecret: prepared.suppliedSecret || null,
        enabledModelIds: input.enabledModelIds,
        discovery: {
          models: prepared.models,
          source: 'fetched',
          fetchedAt: this.#now(),
        },
      });
      if (committed.kind === 'slug_conflict') {
        return { kind: 'rejected', reason: 'slug_conflict' };
      }
      if (committed.changed) this.#onCommittedMutation();
      return { kind: 'saved' };
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown') {
        this.#onCommittedMutation();
      }
      throw error;
    }
  }

  #testConnection(input: ConnectionTestRunInput): Promise<OperationOutcome<'connection.test.run'>> {
    return this.#admit(input.connectionId, 'connection.test.run', async () => {
      const prepared = await this.#stores.operations.beginConnectionTest(
        input.connectionId,
        input.modelId,
      );
      if (prepared.kind !== 'ready') return preparationResult(prepared);

      const effect = await this.#withTransport(prepared, (fetch, secret) =>
        this.#runConnectionTest(
          prepared.connection,
          secret,
          { fetch },
          prepared.modelId ?? undefined,
        ),
      );
      const projected = projectConnectionTest(effect, this.#now());
      const completion = await this.#complete(() =>
        this.#stores.operations.completeConnectionTest(
          prepared.ticket,
          connectionTestSummary(projected),
        ),
      );
      return completion.kind === 'committed'
        ? {
            kind: 'committed',
            catalogRevision: completion.snapshot.revision,
            connection: committedConnectionBasis(
              completion.snapshot.connections,
              prepared.connection.connectionId,
            ),
            test: projected,
          }
        : projectSuperseded(completion);
    });
  }

  #admit<
    K extends
      | 'connection.models.fetch'
      | 'connection.test.run'
      | 'connection.onboarding.verify'
      | 'connection.onboarding.save',
  >(
    connectionId: string,
    operation: K,
    run: () => Promise<Extract<OperationOutcome<K>, { ok: true }>['result']>,
  ): Promise<OperationOutcome<K>> {
    if (!this.#accepting) {
      return Promise.resolve({
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      } as OperationOutcome<K>);
    }
    return this.#enqueue(connectionId, async () => {
      try {
        return { ok: true, result: await run() } as OperationOutcome<K>;
      } catch (error) {
        return storeFailure<K>(error);
      }
    });
  }

  async #withTransport<T>(
    prepared: Pick<
      BeginModelFetchReady | BeginConnectionTestReady,
      'connection' | 'networkProxy' | 'secretMaterial'
    >,
    run: (fetch: typeof globalThis.fetch, secret: string) => Promise<T>,
  ): Promise<T> {
    const proxy = toRuntimePolicyProxy(
      prepared.networkProxy,
      prepared.secretMaterial.networkProxy?.secret,
    );
    const secret = await this.#connectionSecret(prepared, proxy);
    const transport = this.#createTransport(proxy);
    try {
      const requestHeaders = prepared.secretMaterial.requestHeaders
        ? parseRequestHeaders(prepared.secretMaterial.requestHeaders.secret)
        : {};
      return await run(
        createRequestCustomizationFetch(transport.fetch, {
          headers: requestHeaders,
          bodyOverlay: prepared.connection.requestBodyOverlay,
        }),
        secret,
      );
    } finally {
      await transport.close();
    }
  }

  async #connectionSecret(
    prepared: Pick<
      BeginModelFetchReady | BeginConnectionTestReady,
      'connection' | 'secretMaterial'
    >,
    proxy: ConnectionEffectProxySnapshot | null,
  ): Promise<string> {
    const material = prepared.secretMaterial.connection;
    if (!material) return '';
    if (!isOAuthSubscriptionProvider(prepared.connection.providerType)) return material.secret;
    const binding = this.#oauthCredentials.bind({
      providerType: prepared.connection.providerType,
      connectionSlug: prepared.connection.slug,
      material,
      createRefreshTransport: () => this.#createTransport(proxy),
    });
    return (await binding.resolve()).access_token;
  }

  async #complete(
    commit: () => Promise<ConnectionEffectCompletionResult>,
  ): Promise<ConnectionEffectCompletionResult> {
    return this.#activation.runMutation(async () => {
      try {
        const result = await commit();
        if (result.kind === 'committed') this.#onCommittedMutation();
        return result;
      } catch (error) {
        if (error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown') {
          this.#onCommittedMutation();
        }
        throw error;
      }
    });
  }

  #enqueue<T>(connectionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(connectionId) ?? Promise.resolve();
    const pending = previous.then(run, run);
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(connectionId, tail);
    void tail.finally(() => {
      if (this.#tails.get(connectionId) === tail) this.#tails.delete(connectionId);
    });
    return pending;
  }
}

type BeginModelFetchReady = Extract<BeginModelFetchResult, { readonly kind: 'ready' }>;
type BeginConnectionTestReady = Extract<BeginConnectionTestResult, { readonly kind: 'ready' }>;

type OnboardingDiscovery =
  | {
      readonly kind: 'ready';
      readonly suppliedSecret: string;
      readonly models: ConnectionModelDiscoveryResult['models'];
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'provider_unsupported' | 'credential_not_configured' | 'slug_conflict';
    }
  | { readonly kind: 'failed'; readonly errorClass: ConnectionEffectFailureClass };

function preparationResult(
  prepared: Exclude<BeginModelFetchResult, { readonly kind: 'ready' }>,
): Extract<ConnectionModelFetchResult, { readonly kind: 'rejected' }>;
function preparationResult(
  prepared: Exclude<BeginConnectionTestResult, { readonly kind: 'ready' }>,
): Extract<ConnectionTestRunResult, { readonly kind: 'rejected' }>;
function preparationResult(
  prepared: Exclude<BeginModelFetchResult | BeginConnectionTestResult, { readonly kind: 'ready' }>,
): Extract<ConnectionModelFetchResult, { readonly kind: 'rejected' }> {
  return {
    kind: 'rejected',
    reason: prepared.kind satisfies ConnectionEffectRejectionReason,
  };
}

function projectSuperseded(
  completion: Extract<ConnectionEffectCompletionResult, { readonly kind: 'superseded' }>,
): Extract<ConnectionModelFetchResult | ConnectionTestRunResult, { readonly kind: 'superseded' }> {
  return {
    kind: 'superseded',
    changed: completion.changed.map((domain) => domain satisfies ConnectionEffectChangedDomain),
  };
}

function projectConnectionTest(
  outcome: ConnectionTestEffectOutcome,
  checkedAt: number,
): ConnectionTestProjection {
  const checkedAtIso = new Date(checkedAt).toISOString();
  if (outcome.ok) {
    return {
      kind: 'verified',
      checkedAt: checkedAtIso,
      modelId: outcome.modelId,
      latencyMs: outcome.latencyMs,
    };
  }

  return {
    kind: 'failed',
    checkedAt: checkedAtIso,
    modelId: outcome.modelId ?? null,
    latencyMs: outcome.latencyMs ?? null,
    statusCode: outcome.error.statusCode ?? null,
    errorClass: outcome.error.kind,
  };
}

function connectionTestSummary(projection: ConnectionTestProjection): ConnectionTestSummary {
  return projection.kind === 'verified'
    ? { status: 'verified', checkedAt: projection.checkedAt }
    : {
        status: projection.errorClass === 'auth' ? 'needs_reauth' : 'error',
        checkedAt: projection.checkedAt,
        errorClass: toConnectionTestErrorClass(projection.errorClass),
      };
}

function toConnectionTestErrorClass(kind: ConnectionEffectErrorKind): ConnectionTestErrorClass {
  return kind === 'invalid_response' ? 'unknown' : kind;
}

function committedConnectionBasis(
  connections: readonly ConnectionCatalogEntry[],
  connectionId: string,
) {
  const connection = connections.find((candidate) => candidate.connectionId === connectionId);
  if (!connection) throw new Error('Connection effect commit omitted its connection');
  return { connectionId, revision: connection.revision };
}

function storeFailure<
  K extends
    | 'connection.models.fetch'
    | 'connection.test.run'
    | 'connection.onboarding.verify'
    | 'connection.onboarding.save',
>(error: unknown): OperationOutcome<K> {
  if (!(error instanceof RuntimePolicyStoreError)) throw error;
  switch (error.code) {
    case 'commit_outcome_unknown':
      return operationFailure(
        'commit_outcome_unknown',
        'Connection effect commit outcome is unknown',
      );
    case 'io_failed':
    case 'invalid_document':
      return operationFailure('persistence_failed', 'Connection effect persistence failed');
    case 'invalid_policy_input':
    case 'invalid_connection_input':
      return operationFailure('invalid_request', 'Connection effect request is invalid');
    case 'invalid_credential_input':
      throw new Error('Connection effect admitted an invalid credential operation');
  }
}

function operationFailure<
  K extends
    | 'connection.models.fetch'
    | 'connection.test.run'
    | 'connection.onboarding.verify'
    | 'connection.onboarding.save',
>(
  code: 'commit_outcome_unknown' | 'persistence_failed' | 'invalid_request',
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}

function transientConnection(
  providerType: ConnectionOnboardingVerifyInput['providerType'],
): ConnectionCatalogEntry {
  const definition = PROVIDER_DEFAULTS[providerType];
  const models = definition.fallbackModels.map((id) => ({ id }));
  return {
    connectionId: '00000000-0000-4000-8000-000000000000',
    revision: 0,
    slug: deriveConnectionSlug(providerType),
    name: definition.label,
    providerType,
    ...(definition.baseUrl ? { baseUrl: definition.baseUrl } : {}),
    enabled: true,
    enabledModelIds: models.map(({ id }) => id),
    models,
    modelSource: 'fallback',
    modelsFetchedAt: 0,
  };
}
