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
import type {
  OAuthLoginProjection,
  OAuthLoginTarget,
  OperationInput,
} from '@maka/runtime-host/protocol';
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
  readonly requestTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface RuntimeHostOnboardingSurface extends MakaOnboardingSurface {
  close(): Promise<void>;
}

interface OAuthLoginAttempt {
  readonly attemptId: string;
  readonly target: OAuthLoginTarget;
  rootId?: string;
  startRequested: boolean;
  task?: Promise<OnboardingOAuthResult>;
}

type OAuthLoginRequest = <
  K extends 'oauth.login.start' | 'oauth.login.query' | 'oauth.login.cancel',
>(
  operation: K,
  input: OperationInput<K>,
  deadline?: number,
) => Promise<OAuthLoginProjection>;

/** Adapt the TUI onboarding workflow to Host-owned verification and persistence. */
export function createRuntimeHostOnboardingSurface(
  connection: RuntimeHostConnection,
  options: RuntimeHostOnboardingSurfaceOptions = {},
): RuntimeHostOnboardingSurface {
  const shutdown = new AbortController();
  // An interrupted observation is not a new login intent. Keep its identity
  // until a later observation establishes a terminal result on the same root.
  const oauthAttempts = new Map<string, OAuthLoginAttempt>();
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
      const target = asOAuthTarget(input.target);
      if (!target) return Promise.resolve({ kind: 'failed', reason: 'unavailable' });
      const key = JSON.stringify(target);
      const pending = oauthAttempts.get(key);
      if (input.signal.aborted || shutdown.signal.aborted) {
        return Promise.resolve({ kind: pending?.startRequested ? 'unconfirmed' : 'cancelled' });
      }
      const attempt: OAuthLoginAttempt = pending ?? {
        attemptId: (options.createAttemptId ?? randomUUID)(),
        target,
        startRequested: false,
      };
      // Re-entering the same intent observes its existing result.
      if (attempt.task) return attempt.task;
      oauthAttempts.set(key, attempt);
      const task = runOAuthLogin(input, options, shutdown.signal, attempt);
      attempt.task = task;
      void task.then(
        (result) => {
          attempt.task = undefined;
          if (result.kind !== 'unconfirmed') oauthAttempts.delete(key);
        },
        () => {
          attempt.task = undefined;
        },
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
      await Promise.allSettled([...oauthAttempts.values()].map(({ task }) => task));
      oauthAttempts.clear();
    },
  };
}

async function runOAuthLogin(
  input: OnboardingOAuthInput,
  options: RuntimeHostOnboardingSurfaceOptions,
  shutdownSignal: AbortSignal,
  attempt: OAuthLoginAttempt,
): Promise<OnboardingOAuthResult> {
  if (!options.connectOAuth) return { kind: 'failed', reason: 'unavailable' };
  const signal = AbortSignal.any([input.signal, shutdownSignal]);
  if (signal.aborted) return { kind: attempt.startRequested ? 'unconfirmed' : 'cancelled' };
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_000;
  const observation = new AbortController();
  const pollingSignal = AbortSignal.any([signal, observation.signal]);
  let connected: RuntimeHostOnboardingOAuthConnection | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopDeadline = Number.POSITIVE_INFINITY;
  const stopAfter = (milliseconds: number): void => {
    const deadline = Date.now() + milliseconds;
    if (deadline >= stopDeadline) return;
    stopDeadline = deadline;
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => observation.abort(), milliseconds);
  };
  const cancelObservation = () => stopAfter(options.cancellationTimeoutMs ?? requestTimeoutMs);
  const closeObservation = () => stopAfter(shutdownTimeoutMs);
  input.signal.addEventListener('abort', cancelObservation, { once: true });
  shutdownSignal.addEventListener('abort', closeObservation, { once: true });
  try {
    const connecting = options.connectOAuth(AbortSignal.any([signal, observation.signal]));
    void connecting.then(
      (resource) => {
        // A connector may finish after its observer timed out. It still needs
        // an owner to release the late connection.
        if (observation.signal.aborted) void resource.close().catch(() => undefined);
      },
      () => undefined,
    );
    connected = await waitForOAuthOperation(connecting, undefined, observation.signal);
    const connection = connected.connection;
    if (attempt.rootId !== undefined && attempt.rootId !== connection.rootId) {
      return { kind: 'unconfirmed' };
    }
    attempt.rootId = connection.rootId;
    const provider = createOAuthPresentationClientProvider({
      openExternal: async (url, stateHint) => {
        if (!signal.aborted && !observation.signal.aborted) {
          input.onPresentation({ url, ...(stateHint === undefined ? {} : { stateHint }) });
        }
      },
    });
    const connectionKey = () => JSON.stringify([connection.hostEpoch, connection.connectionId]);
    let presentationConnectionKey: string | undefined;
    const request: OAuthLoginRequest = async (operation, input, deadline) => {
      const remainingTimeout = (): number => {
        if (observation.signal.aborted) throw new Error('OAuth observation ended');
        const remaining = Math.min(deadline ?? Infinity, stopDeadline) - Date.now();
        if (remaining <= 0) throw new Error('OAuth reconciliation timed out');
        return Math.min(requestTimeoutMs, remaining);
      };
      if (operation === 'oauth.login.start') {
        const current = connectionKey();
        if (presentationConnectionKey !== current) {
          // Capability ownership follows a physical connection. Queries need
          // no presentation service; only a start must await its publication.
          const timeoutMs = remainingTimeout();
          try {
            await waitForOAuthOperation(
              connection.replaceClientCapabilities(provider, timeoutMs),
              timeoutMs,
              observation.signal,
            );
          } catch (error) {
            if (
              error instanceof RuntimeHostRequestInterruptedError &&
              error.reason === 'connection_lost'
            ) {
              throw interruptedOAuthStart();
            }
            throw error;
          }
          if (current !== connectionKey()) throw interruptedOAuthStart();
          presentationConnectionKey = current;
        }
        remainingTimeout();
        if (signal.aborted && !attempt.startRequested)
          throw new Error('OAuth cancelled before start');
        attempt.startRequested = true;
      }
      const timeoutMs = remainingTimeout();
      return waitForOAuthOperation(
        connection.request(operation, input, timeoutMs),
        timeoutMs,
        observation.signal,
      );
    };
    const { attemptId, target } = attempt;
    let projection = await startOAuthAttempt(
      request,
      attemptId,
      target,
      requestTimeoutMs,
      attempt.startRequested,
    );
    let cancellationSent = false;
    while (!isTerminalOAuthProjection(projection)) {
      if (signal.aborted && !cancellationSent) {
        cancellationSent = true;
        const cancelledProjection = await cancelOAuthAttempt(request, attemptId, requestTimeoutMs);
        if (!cancelledProjection) return { kind: 'cancelled' };
        projection = cancelledProjection;
        continue;
      }
      // Once cancellation has reached the Host, the aborted UI signal must no
      // longer collapse this delay into a busy query loop while a commit wins.
      await waitForOAuthPoll(
        options.pollIntervalMs ?? 250,
        cancellationSent ? observation.signal : pollingSignal,
      );
      if (signal.aborted && !cancellationSent) continue;
      projection = await request('oauth.login.query', { attemptId });
    }
    if (projection.phase === 'authenticated') {
      return { kind: 'authenticated', connection: projection.connection };
    }
    if (projection.phase === 'cancelled') return { kind: 'cancelled' };
    return { kind: 'failed', reason: projection.failure ?? 'internal_failure' };
  } catch (error) {
    if (error instanceof RuntimeHostOperationError) {
      if (
        attempt.startRequested &&
        (error.code === 'persistence_failed' ||
          error.code === 'internal_failure' ||
          (error.code === 'not_found' && error.operation === 'oauth.login.query'))
      )
        return { kind: 'unconfirmed' };
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
    if (attempt.startRequested) return { kind: 'unconfirmed' };
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'unavailable' };
  } finally {
    observation.abort();
    clearTimeout(stopTimer);
    input.signal.removeEventListener('abort', cancelObservation);
    shutdownSignal.removeEventListener('abort', closeObservation);
    if (connected) {
      const resource = connected;
      await waitForOAuthOperation(
        Promise.resolve().then(() => resource.close()),
        Math.max(1, Math.min(shutdownTimeoutMs, stopDeadline - Date.now())),
      ).catch(() => undefined);
    }
  }
}

async function startOAuthAttempt(
  request: OAuthLoginRequest,
  attemptId: string,
  target: OAuthLoginTarget,
  timeoutMs: number,
  resume: boolean,
): Promise<OAuthLoginProjection> {
  const deadline = Date.now() + timeoutMs;
  if (resume) {
    try {
      return await request('oauth.login.query', { attemptId }, deadline);
    } catch (error) {
      if (!isOAuthAttemptNotFound(error)) throw error;
    }
  }
  while (true) {
    try {
      return await request('oauth.login.start', { attemptId, target }, deadline);
    } catch (error) {
      if (!isOAuthRequestInterruption(error, 'oauth.login.start')) throw error;
      try {
        // A write acknowledged by the local transport may already be running
        // on the Host. Query the stable attempt identity before retrying the
        // idempotent start so a lost response cannot create a second login.
        return await request('oauth.login.query', { attemptId }, deadline);
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
  request: OAuthLoginRequest,
  attemptId: string,
  timeoutMs: number,
): Promise<OAuthLoginProjection | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await request('oauth.login.cancel', { attemptId }, deadline);
    } catch (error) {
      if (isOAuthAttemptNotFound(error)) return null;
      if (!isOAuthRequestInterruption(error, 'oauth.login.cancel')) throw error;
      try {
        const projection = await request('oauth.login.query', { attemptId }, deadline);
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

function interruptedOAuthStart(): RuntimeHostRequestInterruptedError {
  return new RuntimeHostRequestInterruptedError(
    'oauth.login.start',
    'command',
    'not_dispatched',
    'connection_lost',
  );
}

/** A local observation deadline says nothing about whether the Host committed. */
function waitForOAuthOperation<T>(
  task: Promise<T>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void;
  return new Promise<T>((resolve, reject) => {
    stop = () => reject(new Error('OAuth result could not be confirmed'));
    if (timeoutMs !== undefined) timeout = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    void task.then(resolve, reject);
    if (signal?.aborted) stop();
  }).finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stop);
  });
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
  if (target.kind === 'existing') return { kind: 'existing', connectionId: target.connectionId };
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
