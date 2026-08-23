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

import { OAuthTokenEndpointError } from '@maka/runtime/oauth-login';
import { createProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import {
  exchangeCodexDeviceAuthorizationCode,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from '@maka/runtime/codex-oauth-enrollment';
import { OAuthDeviceAuthorizationExpiredError } from '@maka/runtime/oauth-provider-contracts';
import {
  pollXaiDeviceAuthorization,
  startXaiDeviceAuthorization,
} from '@maka/runtime/xai-oauth-enrollment';
import {
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';
import {
  RuntimePolicyStoreError,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import {
  decodeOAuthPresentationResult,
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
  type OAuthLoginFailureCode,
  type OAuthLoginProjection,
  type OAuthLoginProvider,
  type OAuthPresentationRequest,
  type OAuthPresentationResult,
  type OperationOutcome,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import { HostOAuthExecutionAuthority } from './oauth-execution-authority.js';
import {
  ClientCapabilityInvocationError,
  type HostClientCapabilityCoordinator,
} from './client-capability-coordinator.js';
import type { OAuthOperationHandlerMap } from './operation-dispatcher.js';
import type { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

const MAX_TERMINAL_ATTEMPTS = 256;

export class HostOAuthFatalError extends Error {
  constructor(
    message: string,
    readonly fatalCause: unknown,
  ) {
    super(message, { cause: fatalCause });
    this.name = 'HostOAuthFatalError';
  }
}

export interface HostOAuthCoordinatorInput {
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly oauthCredentials?: HostOAuthExecutionAuthority;
  readonly activation: RuntimePolicyActivationGate;
  readonly clientCapabilities: HostClientCapabilityCoordinator;
  readonly isProviderEnabled: (provider: OAuthLoginProvider) => boolean;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly invalidateBackends: () => Promise<void>;
  readonly onFatal: (error: HostOAuthFatalError) => void;
  readonly now?: () => number;
  readonly startXaiAuthorization?: typeof startXaiDeviceAuthorization;
  readonly pollXaiAuthorization?: typeof pollXaiDeviceAuthorization;
  readonly startCodexAuthorization?: typeof startCodexDeviceAuthorization;
  readonly pollCodexAuthorization?: typeof pollCodexDeviceAuthorization;
  readonly exchangeCodexCode?: typeof exchangeCodexDeviceAuthorizationCode;
  readonly createFetchTransport?: typeof createProxiedFetchTransport;
}

type OAuthLoginAdmission = Extract<
  Awaited<ReturnType<RuntimePolicyStoresWriter['operations']['beginInteractiveOAuthLogin']>>,
  { readonly kind: 'ready' }
>;

interface ActiveLoginAttempt {
  readonly kind: 'active';
  readonly attemptId: string;
  readonly connectionId: string;
  readonly initiatingConnectionId: string;
  readonly provider: OAuthLoginProvider;
  readonly ticket: OAuthLoginAdmission;
  readonly abort: AbortController;
  readonly residency: RuntimeHostResidency;
  phase: OAuthLoginProjection['phase'];
  failure?: OAuthLoginFailureCode;
  cancellationDeferred: boolean;
  cancelRequested: boolean;
  settlement: Promise<void>;
}

interface TerminalLoginAttempt {
  readonly kind: 'terminal';
  readonly projection: OAuthLoginProjection;
}

type LoginAttemptRecord = ActiveLoginAttempt | TerminalLoginAttempt;

/** Host-owned OAuth enrollment and presentation authority. */
export class HostOAuthCoordinator {
  readonly handlers: OAuthOperationHandlerMap = {
    'oauth.login.start': (input, context) => this.#start(input, context.connectionId),
    'oauth.login.query': (input) => this.#query(input.attemptId),
    'oauth.login.cancel': (input) => this.#cancel(input.attemptId),
  };

  readonly #runtimePolicy: RuntimePolicyStoresWriter;
  readonly #oauthCredentials: HostOAuthExecutionAuthority;
  readonly #activation: RuntimePolicyActivationGate;
  readonly #clientCapabilities: HostClientCapabilityCoordinator;
  readonly #isProviderEnabled: (provider: OAuthLoginProvider) => boolean;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #invalidateBackends: () => Promise<void>;
  readonly #onFatal: (error: HostOAuthFatalError) => void;
  readonly #now: () => number;
  readonly #startXaiAuthorization: typeof startXaiDeviceAuthorization;
  readonly #pollXaiAuthorization: typeof pollXaiDeviceAuthorization;
  readonly #startCodexAuthorization: typeof startCodexDeviceAuthorization;
  readonly #pollCodexAuthorization: typeof pollCodexDeviceAuthorization;
  readonly #exchangeCodexCode: typeof exchangeCodexDeviceAuthorizationCode;
  readonly #createFetchTransport: typeof createProxiedFetchTransport;
  readonly #attempts = new Map<string, LoginAttemptRecord>();
  #activeAttempt: ActiveLoginAttempt | undefined;
  /**
   * Serializes oauth.login.start admissions so concurrent starts cannot dual-open
   * interactive logins after supersede replaced operation_conflict.
   */
  #startGate: Promise<void> = Promise.resolve();
  #admissionClosed = false;
  #closeTask: Promise<void> | undefined;

  constructor(input: HostOAuthCoordinatorInput) {
    this.#runtimePolicy = input.runtimePolicy;
    this.#oauthCredentials =
      input.oauthCredentials ?? new HostOAuthExecutionAuthority(input.runtimePolicy);
    this.#activation = input.activation;
    this.#clientCapabilities = input.clientCapabilities;
    this.#isProviderEnabled = input.isProviderEnabled;
    this.#acquireResidency = input.acquireResidency;
    this.#invalidateBackends = input.invalidateBackends;
    this.#onFatal = input.onFatal;
    this.#now = input.now ?? Date.now;
    this.#startXaiAuthorization = input.startXaiAuthorization ?? startXaiDeviceAuthorization;
    this.#pollXaiAuthorization = input.pollXaiAuthorization ?? pollXaiDeviceAuthorization;
    this.#startCodexAuthorization = input.startCodexAuthorization ?? startCodexDeviceAuthorization;
    this.#pollCodexAuthorization = input.pollCodexAuthorization ?? pollCodexDeviceAuthorization;
    this.#exchangeCodexCode = input.exchangeCodexCode ?? exchangeCodexDeviceAuthorizationCode;
    this.#createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  }

  beginDrain(): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    if (this.#activeAttempt) {
      this.#requestCancellation(
        this.#activeAttempt,
        new DOMException('Runtime Host is draining', 'AbortError'),
      );
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#closeOnce();
    return this.#closeTask;
  }

  async #start(
    input: { readonly attemptId: string; readonly connectionId: string },
    initiatingConnectionId: string,
  ): Promise<OperationOutcome<'oauth.login.start'>> {
    const existing = this.#attempts.get(input.attemptId);
    if (existing) {
      if (projection(existing).connectionId !== input.connectionId) {
        return invalidRequest('OAuth attemptId is already bound to another connection');
      }
      return { ok: true, result: projection(existing) };
    }

    // Claim the start gate before any await so concurrent admissions queue.
    let releaseGate!: () => void;
    const previousGate = this.#startGate;
    this.#startGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await previousGate.catch(() => undefined);
    try {
      const again = this.#attempts.get(input.attemptId);
      if (again) {
        if (projection(again).connectionId !== input.connectionId) {
          return invalidRequest('OAuth attemptId is already bound to another connection');
        }
        return { ok: true, result: projection(again) };
      }
      // User re-clicked 登录 after the browser already authorized (or abandoned)
      // an earlier attempt. Supersede instead of blocking until process restart.
      if (this.#activeAttempt) await this.#supersedeActiveLogin();
      if (this.#admissionClosed) return hostDraining();
      return await this.#prepareStart(input, initiatingConnectionId);
    } finally {
      releaseGate();
    }
  }

  /**
   * Cancel the active interactive login and wait until its residency is released.
   * Used when the user starts a new login while a prior device-code poll is still open.
   */
  async #supersedeActiveLogin(): Promise<void> {
    const previous = this.#activeAttempt;
    if (!previous) return;
    // Align with cancel: once a token poll is admitted or credentials are
    // committing, finish that path instead of aborting a browser-approved grant.
    if (previous.phase === 'committing' || previous.cancellationDeferred) {
      await previous.settlement.catch(() => undefined);
      return;
    }
    const reason = new DOMException('OAuth login superseded by a new attempt', 'AbortError');
    previous.cancelRequested = true;
    if (previous.phase !== 'authenticated' && previous.phase !== 'failed') {
      previous.phase = 'cancelled';
    }
    if (!previous.abort.signal.aborted) previous.abort.abort(reason);
    await previous.settlement.catch(() => undefined);
  }

  async #prepareStart(
    input: { readonly attemptId: string; readonly connectionId: string },
    initiatingConnectionId: string,
  ): Promise<OperationOutcome<'oauth.login.start'>> {
    let admitted: Awaited<
      ReturnType<RuntimePolicyStoresWriter['operations']['beginInteractiveOAuthLogin']>
    >;
    try {
      admitted = await this.#runtimePolicy.operations.beginInteractiveOAuthLogin(
        input.connectionId,
      );
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError) {
        return persistenceFailure('OAuth login admission failed');
      }
      throw error;
    }
    if (admitted.kind === 'connection_not_found') {
      return notFound('OAuth connection was not found');
    }
    if (admitted.kind !== 'ready') {
      return invalidRequest('Connection cannot start an interactive OAuth login');
    }
    if (this.#admissionClosed) return hostDraining();
    if (!this.#isProviderEnabled(admitted.connection.providerType)) {
      return operationUnavailable('OAuth enrollment is disabled for this provider');
    }
    if (
      !this.#clientCapabilities.hasService(
        initiatingConnectionId,
        OAUTH_PRESENTATION_SERVICE_ID,
        OAUTH_PRESENTATION_SERVICE_VERSION,
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'capability_unavailable',
          message: 'Initiating Client cannot present this OAuth login',
        },
      };
    }
    const attempt: ActiveLoginAttempt = {
      kind: 'active',
      attemptId: input.attemptId,
      connectionId: input.connectionId,
      initiatingConnectionId,
      provider: admitted.connection.providerType,
      ticket: admitted,
      abort: new AbortController(),
      residency: this.#acquireResidency(),
      phase: 'awaiting_authorization',
      cancellationDeferred: false,
      cancelRequested: false,
      settlement: Promise.resolve(),
    };
    this.#attempts.set(attempt.attemptId, attempt);
    this.#activeAttempt = attempt;
    attempt.settlement = this.#runLogin(attempt);
    observe(attempt.settlement);
    return { ok: true, result: projection(attempt) };
  }

  #query(attemptId: string): Promise<OperationOutcome<'oauth.login.query'>> {
    const attempt = this.#attempts.get(attemptId);
    return Promise.resolve(
      attempt ? { ok: true, result: projection(attempt) } : notFound('OAuth login was not found'),
    );
  }

  #cancel(attemptId: string): Promise<OperationOutcome<'oauth.login.cancel'>> {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt) return Promise.resolve(notFound('OAuth login was not found'));
    if (attempt.kind === 'active') {
      this.#requestCancellation(attempt, new DOMException('OAuth login cancelled', 'AbortError'));
    }
    return Promise.resolve({ ok: true, result: projection(attempt) });
  }

  #requestCancellation(attempt: ActiveLoginAttempt, reason: Error): void {
    attempt.cancelRequested = true;
    if (attempt.cancellationDeferred) return;
    attempt.phase = 'cancelled';
    attempt.abort.abort(reason);
  }

  async #runLogin(attempt: ActiveLoginAttempt): Promise<void> {
    let transport: ReturnType<typeof createProxiedFetchTransport> | undefined;
    try {
      transport = createProxiedFetchTransport(
        toRuntimePolicyProxy(
          attempt.ticket.networkProxy,
          attempt.ticket.secretMaterial.networkProxy?.secret,
        ),
      );
      // Switched rather than defaulted: with the retired provider gone the
      // union is two wide, and a ternary would route any future third member
      // into the Codex device flow without a compiler error.
      const tokens = await this.#runProviderLogin(attempt, transport.fetch);
      attempt.abort.signal.throwIfAborted();
      attempt.cancellationDeferred = true;
      attempt.phase = 'committing';
      await this.#activation.runMutation(async () => {
        const completion = await this.#runtimePolicy.operations.completeInteractiveOAuthLogin(
          attempt.ticket.ticket,
          serializeOAuthSubscriptionTokens(tokens),
        );
        if (completion.kind !== 'committed') throw new LoginFailure('credential_changed');
        await this.#invalidateAfterCredentialMutation();
      });
      attempt.phase = 'authenticated';
    } catch (error) {
      if (!attempt.cancellationDeferred && attempt.abort.signal.aborted) {
        attempt.phase = 'cancelled';
      } else {
        attempt.phase = 'failed';
        attempt.failure = loginFailureCode(error);
        if (isCommitOutcomeUnknown(error)) {
          this.#onFatal(new HostOAuthFatalError('OAuth login commit outcome is unknown', error));
        }
      }
    } finally {
      if (transport) await transport.close().catch(() => undefined);
      if (this.#activeAttempt === attempt) this.#activeAttempt = undefined;
      attempt.residency.release();
      if (this.#attempts.get(attempt.attemptId) === attempt) {
        this.#attempts.set(attempt.attemptId, terminalAttempt(attempt));
        this.#pruneTerminalAttempts();
      }
    }
  }

  async #runCodexDeviceLogin(attempt: ActiveLoginAttempt, fetchFn: typeof fetch) {
    const authorization = await this.#startCodexAuthorization({
      fetchFn,
      signal: attempt.abort.signal,
      now: this.#now,
    });
    await this.#present(attempt, {
      method: 'open_external',
      url: authorization.verificationUrl,
      stateHint: authorization.userCode,
    });
    attempt.phase = 'exchanging';
    const grant = await this.#pollCodexAuthorization({
      authorization,
      fetchFn,
      signal: attempt.abort.signal,
      now: this.#now,
      onPollAdmission: () => {
        attempt.cancellationDeferred = true;
      },
      onPollRetry: () => {
        attempt.cancellationDeferred = false;
        if (attempt.cancelRequested) {
          this.#requestCancellation(
            attempt,
            new DOMException('OAuth login cancelled', 'AbortError'),
          );
        }
      },
    });
    return this.#exchangeCodexCode({
      grant,
      fetchFn,
      signal: attempt.abort.signal,
      now: this.#now,
    });
  }

  #runProviderLogin(
    attempt: ActiveLoginAttempt,
    fetchFn: typeof fetch,
  ): Promise<OAuthSubscriptionTokens> {
    switch (attempt.provider) {
      case 'xai-oauth':
        return this.#runXaiLogin(attempt, fetchFn);
      case 'openai-codex':
        return this.#runCodexDeviceLogin(attempt, fetchFn);
    }
  }

  async #runXaiLogin(attempt: ActiveLoginAttempt, fetchFn: typeof fetch) {
    const authorization = await this.#startXaiAuthorization({
      fetchFn,
      signal: attempt.abort.signal,
      now: this.#now,
    });
    await this.#present(attempt, {
      method: 'open_external',
      url: authorization.verificationUrl,
      stateHint: authorization.userCode,
    });
    attempt.phase = 'exchanging';
    return this.#pollXaiAuthorization({
      authorization,
      fetchFn,
      signal: attempt.abort.signal,
      now: this.#now,
      onPollAdmission: () => {
        attempt.cancellationDeferred = true;
      },
      onPollRetry: () => {
        attempt.cancellationDeferred = false;
        if (attempt.cancelRequested) {
          this.#requestCancellation(
            attempt,
            new DOMException('OAuth login cancelled', 'AbortError'),
          );
        }
      },
    });
  }

  async #present(
    attempt: ActiveLoginAttempt,
    request: OAuthPresentationRequest,
  ): Promise<OAuthPresentationResult> {
    const { method, ...input } = request;
    let result: Awaited<ReturnType<HostClientCapabilityCoordinator['callService']>>;
    try {
      result = await this.#clientCapabilities.callService({
        connectionId: attempt.initiatingConnectionId,
        serviceId: OAUTH_PRESENTATION_SERVICE_ID,
        version: OAUTH_PRESENTATION_SERVICE_VERSION,
        method,
        input,
        signal: attempt.abort.signal,
      });
    } catch (error) {
      if (error instanceof ClientCapabilityInvocationError) {
        throw new LoginFailure('capability_unavailable');
      }
      throw error;
    }
    try {
      return decodeOAuthPresentationResult(method, result);
    } catch {
      throw new LoginFailure('authorization_failed');
    }
  }

  async #invalidateAfterCredentialMutation(): Promise<void> {
    try {
      await this.#invalidateBackends();
    } catch (error) {
      const fatal = new HostOAuthFatalError(
        'OAuth login committed but backend invalidation failed',
        error,
      );
      this.#onFatal(fatal);
      throw fatal;
    }
  }

  #pruneTerminalAttempts(): void {
    const terminalIds = [...this.#attempts]
      .filter(([, attempt]) => attempt.kind === 'terminal')
      .map(([attemptId]) => attemptId);
    for (const attemptId of terminalIds.slice(0, -MAX_TERMINAL_ATTEMPTS)) {
      this.#attempts.delete(attemptId);
    }
  }

  async #closeOnce(): Promise<void> {
    this.beginDrain();
    const active = this.#activeAttempt;
    if (active) await active.settlement;
  }
}

class LoginFailure extends Error {
  constructor(readonly code: OAuthLoginFailureCode) {
    super(code);
  }
}

function projection(attempt: LoginAttemptRecord): OAuthLoginProjection {
  if (attempt.kind === 'terminal') return attempt.projection;
  return {
    attemptId: attempt.attemptId,
    connectionId: attempt.connectionId,
    provider: attempt.provider,
    phase: attempt.phase,
    ...(attempt.phase === 'failed' ? { failure: attempt.failure ?? 'internal_failure' } : {}),
  };
}

function terminalAttempt(attempt: ActiveLoginAttempt): TerminalLoginAttempt {
  return Object.freeze({ kind: 'terminal', projection: Object.freeze(projection(attempt)) });
}

function loginFailureCode(error: unknown): OAuthLoginFailureCode {
  if (error instanceof LoginFailure) return error.code;
  if (error instanceof RuntimePolicyStoreError) return 'persistence_failed';
  // A local device window that elapsed without approval is a timeout, not
  // a provider rejection of the account.
  if (error instanceof OAuthDeviceAuthorizationExpiredError) return 'authorization_failed';
  if (error instanceof OAuthTokenEndpointError) {
    return error.category === 'invalid_grant' || error.category === 'invalid_token'
      ? 'provider_rejected'
      : 'authorization_failed';
  }
  return 'internal_failure';
}

function isCommitOutcomeUnknown(error: unknown): error is RuntimePolicyStoreError {
  return error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown';
}

function invalidRequest(message: string) {
  return { ok: false, error: { code: 'invalid_request', message } } as const;
}

function notFound(message: string) {
  return { ok: false, error: { code: 'not_found', message } } as const;
}

function persistenceFailure(message: string) {
  return { ok: false, error: { code: 'persistence_failed', message } } as const;
}

function operationUnavailable(message: string) {
  return { ok: false, error: { code: 'operation_unavailable', message } } as const;
}

function hostDraining(): OperationOutcome<'oauth.login.start'> {
  return {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  };
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
