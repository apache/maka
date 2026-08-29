import { decodeBedrockConfig } from '@maka/core/runtime-policy';
import { discoverBedrockModels, manualBedrockModel } from '@maka/runtime/bedrock-model-discovery';
import { getAIModel, type AwsCredentialIdentity } from '@maka/runtime/model-factory';
import {
  listBedrockSsoAccounts,
  listBedrockSsoRoles,
  getBedrockSsoRoleCredentials,
  pollBedrockSsoDeviceAuthorization,
  serializeBedrockSsoSession,
  startBedrockSsoDeviceAuthorization,
  type BedrockSsoSession,
} from '@maka/runtime/bedrock-sso';
import { createProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import {
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
  type BedrockSsoLoginProjection,
  type OperationOutcome,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';
import type { BedrockSsoOperationHandlerMap } from './operation-dispatcher.js';
import type { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

const ATTEMPT_TTL_MS = 15 * 60_000;

type StartAuthorization = typeof startBedrockSsoDeviceAuthorization;
type PollAuthorization = typeof pollBedrockSsoDeviceAuthorization;
type ListAccounts = typeof listBedrockSsoAccounts;
type ListRoles = typeof listBedrockSsoRoles;
type GetRoleCredentials = typeof getBedrockSsoRoleCredentials;
type DiscoverModels = typeof discoverBedrockModels;
type SerializeSession = typeof serializeBedrockSsoSession;

export interface BedrockSsoCoordinatorDependencies {
  readonly startAuthorization: StartAuthorization;
  readonly pollAuthorization: PollAuthorization;
  readonly listAccounts: ListAccounts;
  readonly listRoles: ListRoles;
  readonly getRoleCredentials: GetRoleCredentials;
  readonly discoverModels: DiscoverModels;
  readonly serializeSession: SerializeSession;
  readonly withFetch?: <T>(run: (fetchFn: typeof fetch) => Promise<T>) => Promise<T>;
}

const DEFAULT_DEPENDENCIES: BedrockSsoCoordinatorDependencies = {
  startAuthorization: startBedrockSsoDeviceAuthorization,
  pollAuthorization: pollBedrockSsoDeviceAuthorization,
  listAccounts: listBedrockSsoAccounts,
  listRoles: listBedrockSsoRoles,
  getRoleCredentials: getBedrockSsoRoleCredentials,
  discoverModels: discoverBedrockModels,
  serializeSession: serializeBedrockSsoSession,
};

interface Attempt {
  readonly attemptId: string;
  readonly initiatingConnectionId: string;
  readonly ssoStartUrl: string;
  readonly ssoRegion: string;
  readonly region: string;
  readonly abort: AbortController;
  readonly residency: RuntimeHostResidency;
  createdAt: number;
  phase: BedrockSsoLoginProjection['phase'];
  userCode?: string;
  failure?: BedrockSsoLoginProjection['failure'];
  session?: BedrockSsoSession;
  accountId?: string;
  roleName?: string;
  models?: Awaited<ReturnType<typeof discoverBedrockModels>>;
  settlement: Promise<void>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** Host-owned IAM Identity Center onboarding; no AWS secret crosses its protocol. */
export class HostBedrockSsoCoordinator {
  readonly handlers: BedrockSsoOperationHandlerMap = {
    'bedrock.sso.login.start': (input, context) => this.#start(input, context.connectionId),
    'bedrock.sso.login.query': (input) => this.#query(input.attemptId),
    'bedrock.sso.login.cancel': (input) => this.#cancel(input.attemptId),
    'bedrock.sso.accounts.list': (input) => this.#accounts(input.attemptId),
    'bedrock.sso.roles.list': (input) => this.#roles(input.attemptId, input.accountId),
    'bedrock.sso.models.fetch': (input) =>
      this.#models(input.attemptId, input.accountId, input.roleName, input.manualModelIds),
    'bedrock.sso.onboarding.commit': (input) =>
      this.#commit(input.attemptId, input.enabledModelIds),
  };

  readonly #attempts = new Map<string, Attempt>();
  readonly #committed = new Map<string, { connectionId: string; slug: string }>();
  #active: Attempt | undefined;
  #accepting = true;
  #startAdmission = Promise.resolve();
  readonly #inFlightOperations = new Set<Promise<void>>();

  constructor(
    private readonly stores: RuntimePolicyStoresWriter,
    private readonly activation: RuntimePolicyActivationGate,
    private readonly capabilities: HostClientCapabilityCoordinator,
    private readonly acquireResidency: () => RuntimeHostResidency,
    private readonly invalidateBackends: () => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly dependencies: BedrockSsoCoordinatorDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  beginDrain(): void {
    this.#accepting = false;
    for (const attempt of this.#attempts.values()) this.#cancelAttempt(attempt);
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.#startAdmission;
    await Promise.all([
      ...[...this.#attempts.values()].map((attempt) => attempt.settlement),
      ...this.#inFlightOperations,
    ]);
    this.#attempts.clear();
    this.#committed.clear();
  }

  async #start(
    input: { attemptId: string; ssoStartUrl: string; ssoRegion: string; region: string },
    initiatingConnectionId: string,
  ): Promise<OperationOutcome<'bedrock.sso.login.start'>> {
    const precedingAdmission = this.#startAdmission;
    let releaseAdmission!: () => void;
    this.#startAdmission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    await precedingAdmission;
    try {
      return await this.#startAdmitted(input, initiatingConnectionId);
    } finally {
      releaseAdmission();
    }
  }

  async #startAdmitted(
    input: { attemptId: string; ssoStartUrl: string; ssoRegion: string; region: string },
    initiatingConnectionId: string,
  ): Promise<OperationOutcome<'bedrock.sso.login.start'>> {
    if (!this.#accepting) return failure('host_draining', 'Runtime Host is draining');
    const existing = this.#attempts.get(input.attemptId);
    if (existing) return { ok: true, result: projection(existing) };
    if (
      !this.capabilities.hasService(
        initiatingConnectionId,
        OAUTH_PRESENTATION_SERVICE_ID,
        OAUTH_PRESENTATION_SERVICE_VERSION,
      )
    ) {
      return failure('operation_unavailable', 'Desktop cannot present IAM Identity Center login');
    }
    for (const previous of this.#attempts.values()) {
      this.#cancelAttempt(previous);
      await previous.settlement.catch(() => undefined);
    }
    this.#attempts.clear();
    let normalized;
    try {
      normalized = decodeBedrockConfig({
        ssoStartUrl: input.ssoStartUrl,
        ssoRegion: input.ssoRegion,
        region: input.region,
        accountId: '000000000000',
        roleName: 'MakaPending',
      });
    } catch {
      return failure(
        'invalid_request',
        'IAM Identity Center or Bedrock region configuration is invalid',
      );
    }
    const attempt: Attempt = {
      attemptId: input.attemptId,
      initiatingConnectionId,
      ssoStartUrl: normalized.ssoStartUrl,
      ssoRegion: normalized.ssoRegion,
      region: normalized.region,
      abort: new AbortController(),
      residency: this.acquireResidency(),
      createdAt: this.now(),
      phase: 'awaiting_authorization',
      settlement: Promise.resolve(),
    };
    attempt.expiryTimer = setTimeout(() => {
      this.#cancelAttempt(attempt);
      this.#attempts.delete(attempt.attemptId);
    }, ATTEMPT_TTL_MS);
    attempt.expiryTimer.unref?.();
    this.#attempts.set(attempt.attemptId, attempt);
    this.#active = attempt;
    try {
      const authorization = await this.#withFetch((fetchFn) =>
        this.dependencies.startAuthorization({
          ssoStartUrl: attempt.ssoStartUrl,
          ssoRegion: attempt.ssoRegion,
          fetchFn,
          signal: attempt.abort.signal,
          now: this.now,
        }),
      );
      attempt.userCode = authorization.userCode;
      await this.capabilities.callService({
        connectionId: initiatingConnectionId,
        serviceId: OAUTH_PRESENTATION_SERVICE_ID,
        version: OAUTH_PRESENTATION_SERVICE_VERSION,
        method: 'open_external',
        input: {
          url: authorization.verificationUriComplete,
          stateHint: authorization.userCode,
        },
        signal: attempt.abort.signal,
      });
      attempt.settlement = this.#poll(attempt, authorization);
      void attempt.settlement.catch(() => undefined);
      return { ok: true, result: projection(attempt) };
    } catch {
      attempt.phase = attempt.abort.signal.aborted ? 'cancelled' : 'failed';
      attempt.failure = 'authorization_failed';
      attempt.residency.release();
      if (this.#active === attempt) this.#active = undefined;
      return { ok: true, result: projection(attempt) };
    }
  }

  async #poll(
    attempt: Attempt,
    authorization: Awaited<ReturnType<typeof startBedrockSsoDeviceAuthorization>>,
  ): Promise<void> {
    try {
      attempt.session = await this.#withFetch((fetchFn) =>
        this.dependencies.pollAuthorization({
          authorization,
          ssoRegion: attempt.ssoRegion,
          fetchFn,
          signal: attempt.abort.signal,
          now: this.now,
        }),
      );
      attempt.phase = 'authenticated';
    } catch (error) {
      attempt.phase = attempt.abort.signal.aborted ? 'cancelled' : 'failed';
      attempt.failure = /AccessDenied|Unauthorized|InvalidGrant/i.test(
        error instanceof Error ? `${error.name} ${error.message}` : '',
      )
        ? 'provider_rejected'
        : 'authorization_failed';
    } finally {
      if (this.#active === attempt) this.#active = undefined;
      attempt.residency.release();
    }
  }

  #query(attemptId: string): Promise<OperationOutcome<'bedrock.sso.login.query'>> {
    const attempt = this.#usableAttempt(attemptId);
    return Promise.resolve(
      attempt
        ? { ok: true, result: projection(attempt) }
        : failure('not_found', 'Bedrock SSO attempt was not found'),
    );
  }

  #cancel(attemptId: string): Promise<OperationOutcome<'bedrock.sso.login.cancel'>> {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt) return Promise.resolve(failure('not_found', 'Bedrock SSO attempt was not found'));
    this.#cancelAttempt(attempt);
    this.#attempts.delete(attemptId);
    return Promise.resolve({ ok: true, result: projection(attempt) });
  }

  async #accounts(attemptId: string): Promise<OperationOutcome<'bedrock.sso.accounts.list'>> {
    const attempt = this.#authenticated(attemptId);
    if (!attempt) return failure('not_found', 'Authenticated Bedrock SSO attempt was not found');
    try {
      const accounts = await this.#runAttemptOperation(attempt, () =>
        this.#withAttemptFetch(attempt, (fetchFn) =>
          this.dependencies.listAccounts({
            accessToken: attempt.session!.accessToken,
            ssoRegion: attempt.ssoRegion,
            fetchFn,
            signal: attempt.abort.signal,
          }),
        ),
      );
      return { ok: true, result: { accounts } };
    } catch {
      return failure('operation_unavailable', 'AWS accounts could not be listed');
    }
  }

  async #roles(
    attemptId: string,
    accountId: string,
  ): Promise<OperationOutcome<'bedrock.sso.roles.list'>> {
    const attempt = this.#authenticated(attemptId);
    if (!attempt) return failure('not_found', 'Authenticated Bedrock SSO attempt was not found');
    try {
      const roles = await this.#runAttemptOperation(attempt, () =>
        this.#withAttemptFetch(attempt, (fetchFn) =>
          this.dependencies.listRoles({
            accessToken: attempt.session!.accessToken,
            accountId,
            ssoRegion: attempt.ssoRegion,
            fetchFn,
            signal: attempt.abort.signal,
          }),
        ),
      );
      return { ok: true, result: { roles } };
    } catch {
      return failure('operation_unavailable', 'AWS roles could not be listed');
    }
  }

  async #models(
    attemptId: string,
    accountId: string,
    roleName: string,
    manualModelIds: readonly string[],
  ): Promise<OperationOutcome<'bedrock.sso.models.fetch'>> {
    const attempt = this.#authenticated(attemptId);
    if (!attempt) return failure('not_found', 'Authenticated Bedrock SSO attempt was not found');
    try {
      const { credentials, models } = await this.#runAttemptOperation(attempt, () =>
        this.#withAttemptFetch(attempt, async (fetchFn) => {
          const credentials = await this.dependencies.getRoleCredentials({
            accessToken: attempt.session!.accessToken,
            accountId,
            roleName,
            ssoRegion: attempt.ssoRegion,
            fetchFn,
            signal: attempt.abort.signal,
          });
          const credentialProvider = async () => credentials;
          const models = await this.dependencies.discoverModels({
            region: attempt.region,
            credentialProvider,
            fetchFn,
            signal: attempt.abort.signal,
          });
          for (const modelId of manualModelIds) {
            if (models.some((model) => model.id === modelId)) continue;
            await probeManualModel(attempt, modelId, credentials, fetchFn);
            models.push(manualBedrockModel(modelId));
          }
          return { credentials, models };
        }),
      );
      attempt.abort.signal.throwIfAborted();
      void credentials;
      attempt.accountId = accountId;
      attempt.roleName = roleName;
      attempt.models = models;
      return { ok: true, result: { models } };
    } catch (error) {
      const message = error instanceof Error ? `${error.name} ${error.message}` : '';
      return failure(
        /AccessDenied/i.test(message) ? 'operation_unavailable' : 'invalid_request',
        /AccessDenied/i.test(message)
          ? 'Selected AWS role lacks Bedrock permissions'
          : 'Bedrock models could not be discovered or validated',
      );
    }
  }

  async #commit(
    attemptId: string,
    enabledModelIds: readonly string[],
  ): Promise<OperationOutcome<'bedrock.sso.onboarding.commit'>> {
    const replay = this.#committed.get(attemptId);
    if (replay) return { ok: true, result: replay };
    const attempt = this.#authenticated(attemptId);
    if (!attempt?.accountId || !attempt.roleName || !attempt.models || !attempt.session) {
      return failure('invalid_request', 'Bedrock account, role, and models must be selected first');
    }
    const available = new Set(attempt.models.map((model) => model.id));
    if (enabledModelIds.length === 0 || enabledModelIds.some((id) => !available.has(id))) {
      return failure(
        'invalid_request',
        'Enabled Bedrock models are not in the validated inventory',
      );
    }
    try {
      return await this.activation.runMutation(async () => {
        const begun = await this.stores.operations.beginConnectionOnboarding({
          target: { kind: 'create', providerType: 'amazon-bedrock' },
          baseUrl: null,
        });
        if (begun.kind !== 'ready') {
          return failure('persistence_failed', 'Amazon Bedrock connection could not be prepared');
        }
        const committed = await this.stores.operations.completeConnectionOnboarding(begun.ticket, {
          suppliedSecret: this.dependencies.serializeSession(attempt.session!),
          enabledModelIds,
          discovery: { models: attempt.models!, source: 'fetched', fetchedAt: this.now() },
          bedrock: {
            ssoStartUrl: attempt.ssoStartUrl,
            ssoRegion: attempt.ssoRegion,
            region: attempt.region,
            accountId: attempt.accountId!,
            roleName: attempt.roleName!,
          },
        });
        if (committed.kind !== 'committed') {
          return failure('persistence_failed', 'Amazon Bedrock connection could not be committed');
        }
        const connection = committed.snapshot.connections.find(
          (candidate) => candidate.providerType === 'amazon-bedrock',
        );
        if (!connection) {
          this.activation.poison();
          return failure('internal_failure', 'Committed Bedrock connection is missing');
        }
        this.#attempts.delete(attemptId);
        if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
        const result = { connectionId: connection.connectionId, slug: connection.slug };
        this.#committed.set(attemptId, result);
        for (const stale of [...this.#committed.keys()].slice(0, -256))
          this.#committed.delete(stale);
        try {
          await this.invalidateBackends();
        } catch {
          // Persistence is already durable and remains authoritative. Prevent any
          // later activation from selecting a backend that invalidation did not retire.
          this.activation.poison();
        }
        return { ok: true, result };
      });
    } catch {
      return failure('persistence_failed', 'Amazon Bedrock connection could not be committed');
    }
  }

  #authenticated(attemptId: string): Attempt | undefined {
    const attempt = this.#usableAttempt(attemptId);
    return attempt?.phase === 'authenticated' && attempt.session ? attempt : undefined;
  }

  #usableAttempt(attemptId: string): Attempt | undefined {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt) return undefined;
    if (this.now() - attempt.createdAt <= ATTEMPT_TTL_MS) return attempt;
    this.#cancelAttempt(attempt);
    this.#attempts.delete(attemptId);
    return undefined;
  }

  #cancelAttempt(attempt: Attempt): void {
    if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
    if (!attempt.abort.signal.aborted)
      attempt.abort.abort(new DOMException('Cancelled', 'AbortError'));
    if (attempt.phase !== 'failed') attempt.phase = 'cancelled';
    attempt.session = undefined;
    attempt.models = undefined;
  }

  async #runAttemptOperation<T>(attempt: Attempt, run: () => Promise<T>): Promise<T> {
    const operation = run();
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlightOperations.add(tracked);
    attempt.settlement = Promise.all([attempt.settlement.catch(() => undefined), tracked]).then(
      () => undefined,
    );
    try {
      const result = await operation;
      attempt.abort.signal.throwIfAborted();
      return result;
    } finally {
      this.#inFlightOperations.delete(tracked);
    }
  }

  #withAttemptFetch<T>(attempt: Attempt, run: (fetchFn: typeof fetch) => Promise<T>): Promise<T> {
    return this.#withFetch((fetchFn) => run(fetchWithAbortSignal(fetchFn, attempt.abort.signal)));
  }

  async #withFetch<T>(run: (fetchFn: typeof fetch) => Promise<T>): Promise<T> {
    if (this.dependencies.withFetch) return this.dependencies.withFetch(run);
    const proxy = await this.stores.operations.resolveNetworkProxyExecution();
    if (proxy.kind !== 'ready') throw new Error('Network proxy credential is unavailable');
    const transport = createProxiedFetchTransport(
      toRuntimePolicyProxy(proxy.networkProxy, proxy.secretMaterial.networkProxy?.secret),
    );
    try {
      return await run(transport.fetch);
    } finally {
      await transport.close();
    }
  }
}

function fetchWithAbortSignal(fetchFn: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) =>
    fetchFn(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
}

async function probeManualModel(
  attempt: Attempt,
  modelId: string,
  credentials: AwsCredentialIdentity,
  fetchFn: typeof fetch,
): Promise<void> {
  const model = getAIModel({
    connection: {
      slug: 'amazon-bedrock',
      providerType: 'amazon-bedrock',
      defaultModel: modelId,
      models: [manualBedrockModel(modelId)],
      bedrock: {
        ssoStartUrl: attempt.ssoStartUrl,
        ssoRegion: attempt.ssoRegion,
        region: attempt.region,
        accountId: attempt.accountId ?? '000000000000',
        roleName: attempt.roleName ?? 'MakaPending',
      },
    },
    apiKey: '',
    modelId,
    fetch: fetchFn,
    awsCredentialProvider: async () => credentials,
  });
  await generateText({
    model,
    prompt: 'Reply with OK. This is a Maka model capability check.',
    maxOutputTokens: 8,
    tools: {
      maka_probe: tool({
        description: 'A no-op capability probe. Do not call it.',
        inputSchema: z.object({}),
      }),
    },
  });
}

function projection(attempt: Attempt): BedrockSsoLoginProjection {
  return {
    attemptId: attempt.attemptId,
    phase: attempt.phase,
    ...(attempt.phase === 'awaiting_authorization' && attempt.userCode
      ? { userCode: attempt.userCode }
      : {}),
    ...(attempt.phase === 'failed' ? { failure: attempt.failure ?? 'internal_failure' } : {}),
  };
}

function failure<K extends keyof BedrockSsoOperationHandlerMap>(
  code:
    | 'host_draining'
    | 'operation_unavailable'
    | 'invalid_request'
    | 'not_found'
    | 'persistence_failed'
    | 'internal_failure',
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}
