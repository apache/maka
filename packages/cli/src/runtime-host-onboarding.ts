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

import { randomUUID } from 'node:crypto';
import {
  deriveConnectionSlug,
  deriveInteractiveOAuthConnectionSlug,
  offerableCatalogEntries,
  providerFallbackModelIds,
  PROVIDER_REGISTRY,
} from '@maka/core/llm-connections';
import type { RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot } from '@maka/runtime-host/client';
import {
  createOAuthPresentationClientProvider,
  readRuntimeHostConnectionCatalog,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import type { OAuthLoginProjection, OAuthLoginTarget } from '@maka/runtime-host/protocol';
import { listApiKeyOnboardableProviders } from './onboarding-catalog.js';
import type {
  ConnectionIdentity,
  MakaOnboardingSurface,
  ModelChoice,
  OnboardingProviderEntry,
  OnboardingOAuthInput,
  OnboardingOAuthResult,
} from './pi-tui-contracts.js';

export interface RuntimeHostOnboardingOAuthConnection {
  readonly connection: RuntimeHostConnection;
  close(): Promise<void>;
}

export interface RuntimeHostOnboardingSurfaceOptions {
  readonly connectOAuth?: (signal: AbortSignal) => Promise<RuntimeHostOnboardingOAuthConnection>;
  readonly pollIntervalMs?: number;
  readonly createAttemptId?: () => string;
}

export interface RuntimeHostOnboardingSurface extends MakaOnboardingSurface {
  close(): Promise<void>;
}

/** Adapt the TUI onboarding workflow to Host-owned verification and persistence. */
export function createRuntimeHostOnboardingSurface(
  connection: RuntimeHostConnection,
  options: RuntimeHostOnboardingSurfaceOptions = {},
): RuntimeHostOnboardingSurface {
  const shutdown = new AbortController();
  const activeOAuthLogins = new Set<Promise<OnboardingOAuthResult>>();
  return {
    listProviders: async () => {
      const catalog = await readRuntimeHostConnectionCatalog(connection);
      let codexOAuthEnabled = false;
      try {
        codexOAuthEnabled = (
          await connection.request('oauth.enrollment.query', { provider: 'openai-codex' })
        ).enabled;
      } catch {
        // The API-key catalog remains useful when an older or temporarily
        // unavailable Host cannot answer the optional OAuth enrollment query.
      }
      return projectProviders(catalog, codexOAuthEnabled);
    },
    loginOAuth: (input) => {
      const task = runOAuthLogin(input, options, shutdown.signal);
      activeOAuthLogins.add(task);
      void task.then(
        () => activeOAuthLogins.delete(task),
        () => activeOAuthLogins.delete(task),
      );
      return task;
    },
    verify: async (input) => {
      try {
        const result = await connection.request('connection.onboarding.verify', {
          target: input.target,
          apiKey: trimmedOrNull(input.apiKey),
          baseUrl: trimmedOrNull(input.baseUrl),
        });
        if (result.kind === 'verified') return { kind: 'ok', models: [...result.models] };
        return result;
      } catch {
        return { kind: 'unavailable' };
      }
    },
    save: async (input) => {
      try {
        const result = await connection.request('connection.onboarding.save', {
          target: input.target,
          apiKey: trimmedOrNull(input.apiKey),
          baseUrl: trimmedOrNull(input.baseUrl),
          enabledModelIds: [...input.enabledModelIds],
        });
        if (result.kind !== 'saved') {
          return result;
        }
        try {
          const catalog = await readRuntimeHostConnectionCatalog(connection);
          return {
            kind: 'ok',
            connection: result.connection,
            refresh: {
              kind: 'ok',
              modelChoices: projectRuntimeHostModelChoices(catalog),
              connectionIdentities: projectRuntimeHostConnectionIdentities(catalog),
            },
          };
        } catch {
          // Saving and refreshing are separate outcomes. The Host has already
          // committed this exact Connection, so a transient catalog read must
          // never turn a successful create into a retryable create failure.
          return {
            kind: 'ok',
            connection: result.connection,
            refresh: {
              kind: 'failed',
              reason: 'catalog_unavailable',
            },
          };
        }
      } catch {
        return { kind: 'unavailable' };
      }
    },
    close: async () => {
      shutdown.abort();
      await Promise.allSettled([...activeOAuthLogins]);
    },
  };
}

async function runOAuthLogin(
  input: OnboardingOAuthInput,
  options: RuntimeHostOnboardingSurfaceOptions,
  shutdownSignal: AbortSignal,
): Promise<OnboardingOAuthResult> {
  if (!options.connectOAuth) return { kind: 'failed', reason: 'unavailable' };
  const signal = AbortSignal.any([input.signal, shutdownSignal]);
  if (signal.aborted) return { kind: 'cancelled' };
  const target = asOAuthTarget(input.target);
  if (!target) return { kind: 'failed', reason: 'unavailable' };
  let connected: RuntimeHostOnboardingOAuthConnection | undefined;
  let startRequested = false;
  let cancellationRequested: boolean = signal.aborted;
  const requestCancellation = () => {
    cancellationRequested = true;
  };
  signal.addEventListener('abort', requestCancellation, { once: true });
  try {
    connected = await options.connectOAuth(signal);
    await connected.connection.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async (url, stateHint) => {
          input.onPresentation({ url, ...(stateHint === undefined ? {} : { stateHint }) });
        },
      }),
    );
    const attemptId = (options.createAttemptId ?? randomUUID)();
    startRequested = true;
    let projection = await startOAuthAttempt(connected.connection, attemptId, target);
    let cancellationSent = false;
    while (!isTerminalOAuthProjection(projection)) {
      if (cancellationRequested && !cancellationSent) {
        cancellationSent = true;
        const cancelledProjection = await cancelOAuthAttempt(connected.connection, attemptId);
        if (!cancelledProjection) return { kind: 'cancelled' };
        projection = cancelledProjection;
        continue;
      }
      // Once cancellation has reached the Host, the aborted UI signal must no
      // longer collapse this delay into a busy query loop while a commit wins.
      await waitForOAuthPoll(options.pollIntervalMs ?? 250, cancellationSent ? undefined : signal);
      projection = await connected.connection.request('oauth.login.query', { attemptId });
    }
    if (projection.phase === 'authenticated') {
      return { kind: 'authenticated', connection: projection.connection };
    }
    if (projection.phase === 'cancelled') return { kind: 'cancelled' };
    return { kind: 'failed', reason: projection.failure ?? 'internal_failure' };
  } catch (error) {
    if (error instanceof RuntimeHostOperationError) {
      if (error.code === 'not_found') return { kind: 'failed', reason: 'connection_not_found' };
      if (error.code === 'operation_conflict') {
        return { kind: 'failed', reason: 'operation_conflict' };
      }
      if (error.code === 'slug_taken') return { kind: 'failed', reason: 'slug_taken' };
      if (error.code === 'capability_unavailable') {
        return { kind: 'failed', reason: 'capability_unavailable' };
      }
      if (error.code === 'persistence_failed' || error.code === 'internal_failure') {
        return { kind: 'failed', reason: error.code };
      }
    }
    return signal.aborted && !startRequested
      ? { kind: 'cancelled' }
      : { kind: 'failed', reason: 'unavailable' };
  } finally {
    signal.removeEventListener('abort', requestCancellation);
    await connected?.close().catch(() => undefined);
  }
}

async function startOAuthAttempt(
  connection: RuntimeHostConnection,
  attemptId: string,
  target: OAuthLoginTarget,
): Promise<OAuthLoginProjection> {
  while (true) {
    try {
      return await connection.request('oauth.login.start', { attemptId, target });
    } catch (error) {
      if (!isOAuthRequestInterruption(error, 'oauth.login.start')) throw error;
      try {
        // A write acknowledged by the local transport may already be running
        // on the Host. Query the stable attempt identity before retrying the
        // idempotent start so a lost response cannot create a second login.
        return await connection.request('oauth.login.query', { attemptId });
      } catch (queryError) {
        if (!isOAuthAttemptNotFound(queryError)) throw queryError;
        // No live or durable state is visible yet. Starting again with the same
        // attemptId is safe and synchronizes with an original handler still
        // behind the Host start gate, even if local cancellation arrived while
        // the outcome was unknown.
      }
    }
  }
}

async function cancelOAuthAttempt(
  connection: RuntimeHostConnection,
  attemptId: string,
): Promise<OAuthLoginProjection | null> {
  while (true) {
    try {
      return await connection.request('oauth.login.cancel', { attemptId });
    } catch (error) {
      if (isOAuthAttemptNotFound(error)) return null;
      if (!isOAuthRequestInterruption(error, 'oauth.login.cancel')) throw error;
      try {
        const projection = await connection.request('oauth.login.query', { attemptId });
        if (isTerminalOAuthProjection(projection)) return projection;
        // A non-terminal query cannot prove that the interrupted cancellation
        // reached the Host. Cancel again; the operation is attempt-idempotent.
      } catch (queryError) {
        if (isOAuthAttemptNotFound(queryError)) return null;
        throw queryError;
      }
    }
  }
}

function isOAuthRequestInterruption(
  error: unknown,
  operation: 'oauth.login.start' | 'oauth.login.cancel',
): error is RuntimeHostRequestInterruptedError {
  return error instanceof RuntimeHostRequestInterruptedError && error.operation === operation;
}

function isOAuthAttemptNotFound(error: unknown): error is RuntimeHostOperationError {
  return error instanceof RuntimeHostOperationError && error.code === 'not_found';
}

function asOAuthTarget(target: OnboardingOAuthInput['target']): OAuthLoginTarget | null {
  if (target.kind === 'existing') return target;
  return target.providerType === 'openai-codex'
    ? {
        kind: 'create',
        providerType: target.providerType,
        ...(target.slug === undefined ? {} : { slug: target.slug }),
        ...(target.name === undefined ? {} : { name: target.name }),
      }
    : null;
}

function isTerminalOAuthProjection(projection: OAuthLoginProjection): boolean {
  return (
    projection.phase === 'authenticated' ||
    projection.phase === 'cancelled' ||
    projection.phase === 'failed'
  );
}

function waitForOAuthPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function projectRuntimeHostModelChoices(catalog: ConnectionCatalogSnapshot): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const connection of catalog.connections) {
    // Which models are offerable, and what is true about them, are both the
    // Host's answers. A TUI older or newer than the Host must not re-derive
    // either against its own registry and bundled metadata — that is how the
    // same model came to be selectable here and refused elsewhere. A retained
    // retired connection drops out through the same gate: its entries are not
    // chat-capable, so none of them reach this list.
    for (const entry of offerableCatalogEntries(connection)) {
      choices.push({
        connectionId: connection.connectionId,
        connectionSlug: connection.slug,
        connectionName: connection.name,
        providerType: connection.providerType,
        model: entry.id,
        displayName: entry.displayName,
        isDefaultConnection: catalog.defaultTarget?.connectionId === connection.connectionId,
        contextWindow: entry.contextWindow,
        thinkingLevels: entry.thinkingLevels,
      });
    }
  }
  return choices;
}

export function projectRuntimeHostConnectionIdentities(
  catalog: ConnectionCatalogSnapshot,
): ConnectionIdentity[] {
  return catalog.connections.map((connection) => ({
    connectionId: connection.connectionId,
    connectionSlug: connection.slug,
    enabled: connection.enabled,
  }));
}

export function projectProviders(
  catalog: ConnectionCatalogSnapshot,
  codexOAuthEnabled = false,
): OnboardingProviderEntry[] {
  const entries: OnboardingProviderEntry[] = [];
  const existingSlugs = catalog.connections.map((connection) => connection.slug);
  for (const provider of listApiKeyOnboardableProviders()) {
    for (const connection of catalog.connections) {
      if (connection.providerType !== provider.providerType) continue;
      entries.push({
        ...provider,
        target: { kind: 'existing', connectionId: connection.connectionId },
        label: `${connection.name} · ${connection.slug}`,
        connectionSlug: connection.slug,
        enabledModelIds: [...connection.enabledModelIds],
      });
    }
    entries.push({
      ...provider,
      target: { kind: 'create', providerType: provider.providerType },
      label: provider.label,
      suggestedSlug: deriveConnectionSlug(provider.providerType, existingSlugs),
      enabledModelIds: [],
    });
    if (provider.providerType === 'openai' && codexOAuthEnabled) {
      const providerType = 'openai-codex' as const;
      const definition = PROVIDER_REGISTRY[providerType];
      for (const connection of catalog.connections) {
        if (connection.providerType !== providerType) continue;
        entries.push({
          providerType,
          label: `${connection.name} · ${connection.slug}`,
          requiresBaseUrl: false,
          setupMethod: 'oauth',
          target: { kind: 'existing', connectionId: connection.connectionId },
          connectionSlug: connection.slug,
          enabledModelIds: [...connection.enabledModelIds],
        });
      }
      entries.push({
        providerType,
        label: definition.label,
        requiresBaseUrl: false,
        setupMethod: 'oauth',
        target: { kind: 'create', providerType },
        suggestedSlug: deriveInteractiveOAuthConnectionSlug(providerType, existingSlugs),
        enabledModelIds: [...providerFallbackModelIds(definition)],
      });
    }
  }
  return entries;
}

function trimmedOrNull(value: string | undefined): string | null {
  const secret = value?.trim() ?? '';
  return secret.length === 0 ? null : secret;
}
