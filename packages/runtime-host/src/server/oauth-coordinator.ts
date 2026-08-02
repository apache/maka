import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { constantTimeStringEqual, parsePastedAuthorization } from '@maka/core/oauth-subscription';
import {
  buildOAuthLoginAuthorization,
  createProxiedFetchTransport,
  exchangeOAuthAuthorizationCode,
  OAuthTokenEndpointError,
  pollXaiDeviceAuthorization,
  serializeOAuthSubscriptionTokens,
  startXaiDeviceAuthorization,
} from '@maka/runtime';
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
  type OAuthPresentationResultForMethod,
  type OperationOutcome,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import {
  ClientCapabilityInvocationError,
  type HostClientCapabilityCoordinator,
} from './client-capability-coordinator.js';
import type { OAuthOperationHandlerMap } from './operation-dispatcher.js';
import type { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

const CODEX_CALLBACK_HOST = '127.0.0.1';
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = '/auth/callback';
const CODEX_REDIRECT_URI = `http://localhost:${CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`;
const CALLBACK_CODE_MAX_CHARS = 8 * 1024;
const CALLBACK_ERROR_MAX_CHARS = 1_024;
const CALLBACK_ERROR_DESCRIPTION_MAX_CHARS = 8 * 1024;
const CALLBACK_ERROR_URI_MAX_CHARS = 8 * 1024;
const MAX_TERMINAL_ATTEMPTS = 256;
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 10 * 60_000;
const MAX_AUTHORIZATION_TIMEOUT_MS = 60 * 60_000;
const PRESENTATION_TIMEOUT_MARGIN_MS = 5_000;

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
  readonly activation: RuntimePolicyActivationGate;
  readonly clientCapabilities: HostClientCapabilityCoordinator;
  readonly isProviderEnabled: (provider: OAuthLoginProvider) => boolean;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly invalidateBackends: () => Promise<void>;
  readonly onFatal: (error: HostOAuthFatalError) => void;
  readonly now?: () => number;
  readonly exchangeCode?: typeof exchangeOAuthAuthorizationCode;
  readonly startXaiAuthorization?: typeof startXaiDeviceAuthorization;
  readonly pollXaiAuthorization?: typeof pollXaiDeviceAuthorization;
  readonly openCodexLoopback?: typeof openCodexLoopback;
  readonly authorizationTimeoutMs?: number;
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
  readonly #activation: RuntimePolicyActivationGate;
  readonly #clientCapabilities: HostClientCapabilityCoordinator;
  readonly #isProviderEnabled: (provider: OAuthLoginProvider) => boolean;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #invalidateBackends: () => Promise<void>;
  readonly #onFatal: (error: HostOAuthFatalError) => void;
  readonly #now: () => number;
  readonly #exchangeCode: typeof exchangeOAuthAuthorizationCode;
  readonly #startXaiAuthorization: typeof startXaiDeviceAuthorization;
  readonly #pollXaiAuthorization: typeof pollXaiDeviceAuthorization;
  readonly #openCodexLoopback: typeof openCodexLoopback;
  readonly #authorizationTimeoutMs: number;
  readonly #attempts = new Map<string, LoginAttemptRecord>();
  #activeAttempt: ActiveLoginAttempt | undefined;
  #pendingStart:
    | {
        readonly attemptId: string;
        readonly connectionId: string;
        readonly result: Promise<OperationOutcome<'oauth.login.start'>>;
      }
    | undefined;
  #admissionClosed = false;
  #closeTask: Promise<void> | undefined;

  constructor(input: HostOAuthCoordinatorInput) {
    this.#runtimePolicy = input.runtimePolicy;
    this.#activation = input.activation;
    this.#clientCapabilities = input.clientCapabilities;
    this.#isProviderEnabled = input.isProviderEnabled;
    this.#acquireResidency = input.acquireResidency;
    this.#invalidateBackends = input.invalidateBackends;
    this.#onFatal = input.onFatal;
    this.#now = input.now ?? Date.now;
    this.#exchangeCode = input.exchangeCode ?? exchangeOAuthAuthorizationCode;
    this.#startXaiAuthorization = input.startXaiAuthorization ?? startXaiDeviceAuthorization;
    this.#pollXaiAuthorization = input.pollXaiAuthorization ?? pollXaiDeviceAuthorization;
    this.#openCodexLoopback = input.openCodexLoopback ?? openCodexLoopback;
    this.#authorizationTimeoutMs = authorizationTimeout(input.authorizationTimeoutMs);
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
    if (this.#pendingStart) {
      if (
        this.#pendingStart.attemptId === input.attemptId &&
        this.#pendingStart.connectionId === input.connectionId
      ) {
        return this.#pendingStart.result;
      }
      return authorizationInProgress();
    }
    if (this.#activeAttempt) return authorizationInProgress();
    if (this.#admissionClosed) return hostDraining();

    const result = this.#prepareStart(input, initiatingConnectionId);
    this.#pendingStart = { ...input, result };
    try {
      return await result;
    } finally {
      if (this.#pendingStart?.result === result) this.#pendingStart = undefined;
    }
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
    let loopback: LoopbackClaim | undefined;
    try {
      transport = createProxiedFetchTransport(
        toRuntimePolicyProxy(
          attempt.ticket.networkProxy,
          attempt.ticket.secretMaterial.networkProxy?.secret,
        ),
      );
      const tokens =
        attempt.provider === 'xai-oauth'
          ? await this.#runXaiLogin(attempt, transport.fetch)
          : await this.#runAuthorizationCodeLogin(attempt, transport.fetch, (claim) => {
              loopback = claim;
            });
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
      await closeLoopback(loopback);
      if (transport) await transport.close().catch(() => undefined);
      if (this.#activeAttempt === attempt) this.#activeAttempt = undefined;
      attempt.residency.release();
      if (this.#attempts.get(attempt.attemptId) === attempt) {
        this.#attempts.set(attempt.attemptId, terminalAttempt(attempt));
        this.#pruneTerminalAttempts();
      }
    }
  }

  async #runAuthorizationCodeLogin(
    attempt: ActiveLoginAttempt,
    fetchFn: typeof fetch,
    rememberLoopback: (claim: LoopbackClaim) => void,
  ) {
    const provider = attempt.provider;
    if (provider === 'xai-oauth') throw new Error('xAI does not use authorization code login');
    const verifier = randomOpaqueValue();
    const state = randomOpaqueValue();
    const authorization = buildOAuthLoginAuthorization({
      provider,
      verifier,
      state,
      ...(provider === 'openai-codex' ? { redirectUri: CODEX_REDIRECT_URI } : {}),
    });
    let code: string;
    if (authorization.presentation === 'paste-code') {
      const result = await this.#present(attempt, {
        method: 'request_authorization_code',
        url: authorization.authorizationUrl,
        stateHint: state.slice(0, 8),
      });
      const pasted = parsePastedAuthorization(result.authorizationCode);
      if (!pasted || !constantTimeStringEqual(pasted.state, state)) {
        throw new LoginFailure('authorization_failed');
      }
      code = pasted.code;
    } else {
      const loopback = await this.#openCodexLoopback(state, attempt.abort.signal);
      rememberLoopback(loopback);
      await this.#present(attempt, {
        method: 'open_external',
        url: authorization.authorizationUrl,
      });
      const callback = await withDeadline(
        loopback.callback,
        this.#authorizationTimeoutMs,
        () => new OAuthAuthorizationTimeoutError(),
      );
      if (callback.kind === 'rejected') throw new LoginFailure('provider_rejected');
      code = callback.code;
    }
    attempt.abort.signal.throwIfAborted();
    attempt.cancellationDeferred = true;
    attempt.phase = 'exchanging';
    const tokens = await this.#exchangeCode({
      provider,
      code,
      verifier,
      state,
      ...(provider === 'openai-codex' ? { redirectUri: CODEX_REDIRECT_URI } : {}),
      signal: new AbortController().signal,
      fetchFn,
      now: this.#now,
    });
    if (provider === 'claude-subscription' && tokens.account_uuid === undefined) {
      throw new LoginFailure('authorization_failed');
    }
    return tokens;
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

  #present(
    attempt: ActiveLoginAttempt,
    request: Extract<OAuthPresentationRequest, { readonly method: 'open_external' }>,
  ): Promise<OAuthPresentationResultForMethod<'open_external'>>;
  #present(
    attempt: ActiveLoginAttempt,
    request: Extract<OAuthPresentationRequest, { readonly method: 'request_authorization_code' }>,
  ): Promise<OAuthPresentationResultForMethod<'request_authorization_code'>>;
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
        ...(method === 'request_authorization_code'
          ? { timeoutMs: this.#authorizationTimeoutMs + PRESENTATION_TIMEOUT_MARGIN_MS }
          : {}),
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

class OAuthAuthorizationTimeoutError extends Error {
  constructor() {
    super('OAuth authorization timed out');
    this.name = 'OAuthAuthorizationTimeoutError';
  }
}

interface LoopbackClaim {
  readonly callback: Promise<LoopbackCallback>;
  close(): Promise<void>;
}

type LoopbackCallback =
  | { readonly kind: 'authorized'; readonly code: string }
  | { readonly kind: 'rejected' };

async function openCodexLoopback(state: string, signal: AbortSignal): Promise<LoopbackClaim> {
  let claimed = false;
  let resolveCallback!: (result: LoopbackCallback) => void;
  let rejectCallback!: (error: unknown) => void;
  const callback = new Promise<LoopbackCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '', `http://${CODEX_CALLBACK_HOST}:${CODEX_CALLBACK_PORT}`);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const callbackState = url.searchParams.get('state');
    if (
      claimed ||
      url.pathname !== CODEX_CALLBACK_PATH ||
      !callbackState ||
      !constantTimeStringEqual(callbackState, state)
    ) {
      response.writeHead(400).end();
      return;
    }
    const parameters = url.searchParams;
    const keys = [...parameters.keys()];
    const callbackCode = parameters.get('code');
    const authorized =
      keys.length === 2 &&
      hasSingleParameter(parameters, 'code') &&
      hasSingleParameter(parameters, 'state') &&
      callbackCode !== null &&
      callbackCode.length > 0 &&
      callbackCode.length <= CALLBACK_CODE_MAX_CHARS;
    const denialKeys = new Set(['error', 'state', 'error_description', 'error_uri']);
    const callbackError = parameters.get('error');
    const rejected =
      keys.every((key) => denialKeys.has(key)) &&
      hasSingleParameter(parameters, 'error') &&
      hasSingleParameter(parameters, 'state') &&
      callbackError !== null &&
      callbackError.length > 0 &&
      callbackError.length <= CALLBACK_ERROR_MAX_CHARS &&
      optionalBoundedParameter(
        parameters,
        'error_description',
        CALLBACK_ERROR_DESCRIPTION_MAX_CHARS,
      ) &&
      optionalBoundedParameter(parameters, 'error_uri', CALLBACK_ERROR_URI_MAX_CHARS);
    if (!authorized && !rejected) {
      response.writeHead(400).end();
      return;
    }
    claimed = true;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(authorized ? 'Authorization received.' : 'Authorization rejected.');
    resolveCallback(
      authorized ? { kind: 'authorized', code: callbackCode ?? '' } : { kind: 'rejected' },
    );
  });
  server.setTimeout(10_000, (socket) => socket.destroy());
  let closeTask: Promise<void> | undefined;
  const close = () => {
    rejectCallback(new Error('OAuth loopback listener closed'));
    closeTask ??= closeLoopbackServer(server);
    return closeTask;
  };
  const onAbort = () => {
    rejectCallback(signal.reason ?? new Error('OAuth login cancelled'));
    observe(close());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  server.on('error', rejectCallback);
  callback.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { callback, close };
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
  if (error instanceof OAuthAuthorizationTimeoutError) return 'authorization_failed';
  if (error instanceof RuntimePolicyStoreError) return 'persistence_failed';
  if (error instanceof OAuthTokenEndpointError) {
    return error.category === 'invalid_grant' || error.category === 'invalid_token'
      ? 'provider_rejected'
      : 'authorization_failed';
  }
  return 'internal_failure';
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function authorizationTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_AUTHORIZATION_TIMEOUT_MS
  ) {
    throw new Error('OAuth authorization timeout is invalid');
  }
  return timeoutMs;
}

async function withDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isCommitOutcomeUnknown(error: unknown): error is RuntimePolicyStoreError {
  return error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown';
}

function authorizationInProgress(): OperationOutcome<'oauth.login.start'> {
  return {
    ok: false,
    error: {
      code: 'operation_conflict',
      message: 'Another OAuth authorization is already in progress',
    },
  };
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

function hasSingleParameter(parameters: URLSearchParams, name: string): boolean {
  return parameters.getAll(name).length === 1;
}

function optionalBoundedParameter(
  parameters: URLSearchParams,
  name: string,
  maxChars: number,
): boolean {
  const values = parameters.getAll(name);
  return values.length === 0 || (values.length === 1 && values[0]!.length <= maxChars);
}

async function closeLoopback(loopback: LoopbackClaim | undefined): Promise<void> {
  if (loopback) await loopback.close();
}

async function closeLoopbackServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
