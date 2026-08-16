import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { CredentialLocator } from '@maka/core/runtime-policy';
import { buildSubscriptionModelFetch } from '@maka/runtime/subscription-model-fetch';
import {
  isOAuthSubscriptionProvider,
  refreshAndPersistOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  type OAuthSubscriptionCredentialStore,
  type OAuthSubscriptionProvider,
  type OAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';
import { openAiCodexHeaders } from '@maka/runtime/subscription-auth';
import { type ProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import {
  authenticateRuntimePolicyStoresWriter,
  RuntimePolicyStoreError,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';

export type OAuthExecutionCredentialErrorCode =
  | 'credential_unavailable'
  | 'credential_superseded'
  | 'refresh_failed'
  | 'persistence_failed';

type OAuthCredentialLocator = Extract<CredentialLocator, { scope: 'connection' }> & {
  readonly kind: 'oauth_token';
};

export class OAuthExecutionCredentialError extends Error {
  constructor(
    readonly code: OAuthExecutionCredentialErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OAuthExecutionCredentialError';
  }
}

interface CredentialState {
  readonly providerType: OAuthSubscriptionProvider;
  readonly connectionSlug: string;
  readonly locator: OAuthCredentialLocator;
  readonly credentialId: string;
  revision: number;
  raw: string;
  uncertainCommit?: CredentialCommitCandidate;
  resolving?: Promise<OAuthSubscriptionTokens>;
  resolvingForceRefresh?: boolean;
}

interface CredentialCommitCandidate {
  readonly credentialId: string;
  readonly revision: number;
  readonly raw: string;
}

export interface HostOAuthExecutionBinding {
  readonly providerType: OAuthSubscriptionProvider;
  readonly connectionSlug: string;
  resolve(): Promise<OAuthSubscriptionTokens>;
  forceRefresh?(): Promise<OAuthSubscriptionTokens>;
}

/** Host-local generation binding over the canonical Runtime Policy OAuth credential. */
export class HostOAuthExecutionAuthority {
  readonly #stores: RuntimePolicyStoresWriter;
  readonly #states = new Map<string, CredentialState>();
  readonly #now: () => number;

  constructor(stores: RuntimePolicyStoresWriter, now: () => number = Date.now) {
    this.#stores = authenticateRuntimePolicyStoresWriter(stores);
    this.#now = now;
  }

  bind(input: {
    providerType: RuntimeExecutionConnection['providerType'];
    connectionSlug: string;
    material: RuntimePolicyCredentialMaterial;
    createRefreshTransport: () => ProxiedFetchTransport;
  }): HostOAuthExecutionBinding {
    if (!isOAuthSubscriptionProvider(input.providerType)) {
      throw new OAuthExecutionCredentialError(
        'credential_unavailable',
        `OAuth execution is not available for provider ${input.providerType}`,
      );
    }
    const locator = requireOAuthLocator(input.material.locator);
    let state = this.#states.get(locator.connectionId);
    if (state) {
      if (
        state.providerType !== input.providerType ||
        state.connectionSlug !== input.connectionSlug ||
        !sameLocator(state.locator, locator)
      ) {
        throw new OAuthExecutionCredentialError(
          'persistence_failed',
          'Canonical OAuth credential identity was reused for a different connection',
        );
      }
      const candidate = state.uncertainCommit;
      if (
        candidate &&
        candidate.credentialId === input.material.credentialId &&
        candidate.revision === input.material.revision &&
        candidate.raw === input.material.secret
      ) {
        state.revision = candidate.revision;
        state.raw = candidate.raw;
        state.uncertainCommit = undefined;
      }
      if (
        state.credentialId !== input.material.credentialId ||
        state.revision !== input.material.revision ||
        state.raw !== input.material.secret
      ) {
        state = undefined;
      }
    }
    if (!state) {
      state = {
        providerType: input.providerType,
        connectionSlug: input.connectionSlug,
        locator,
        credentialId: input.material.credentialId,
        revision: input.material.revision,
        raw: input.material.secret,
      };
      this.#states.set(state.locator.connectionId, state);
    }

    const bound = state;
    return Object.freeze({
      providerType: bound.providerType,
      connectionSlug: bound.connectionSlug,
      resolve: () => this.#resolve(bound, input.createRefreshTransport),
      forceRefresh: () => this.#resolve(bound, input.createRefreshTransport, true),
    });
  }

  async #resolve(
    state: CredentialState,
    createRefreshTransport: () => ProxiedFetchTransport,
    forceRefresh = false,
  ): Promise<OAuthSubscriptionTokens> {
    this.#assertCurrent(state);
    if (state.resolving) {
      if (!forceRefresh || state.resolvingForceRefresh) return state.resolving;
      await state.resolving;
      this.#assertCurrent(state);
    }
    if (state.resolving) return this.#resolve(state, createRefreshTransport, forceRefresh);
    const resolving = this.#resolveUnshared(state, createRefreshTransport, forceRefresh);
    state.resolving = resolving;
    state.resolvingForceRefresh = forceRefresh;
    try {
      return await resolving;
    } finally {
      if (state.resolving === resolving) {
        state.resolving = undefined;
        state.resolvingForceRefresh = undefined;
      }
    }
  }

  async #resolveUnshared(
    state: CredentialState,
    createRefreshTransport: () => ProxiedFetchTransport,
    forceRefresh: boolean,
  ): Promise<OAuthSubscriptionTokens> {
    await this.#reconcileUncertainCommit(state);
    const credentialStore = this.#credentialStore(state);
    let refreshTransport: ProxiedFetchTransport | undefined;
    let result;
    try {
      const refreshInput = {
        providerType: state.providerType,
        slug: state.connectionSlug,
        credentialStore,
        now: this.#now,
        fetchFn: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (!this.#isCurrent(state)) throw new OAuthCredentialSupersededError();
          refreshTransport ??= createRefreshTransport();
          return refreshTransport.fetch(url, init);
        },
      } as const;
      result = forceRefresh
        ? await refreshAndPersistOAuthSubscriptionTokens(refreshInput)
        : await resolveAndPersistOAuthSubscriptionTokens(refreshInput);
    } finally {
      await refreshTransport?.close();
    }
    this.#assertCurrent(state);
    switch (result.outcome) {
      case 'current':
      case 'refreshed':
        return result.tokens;
      case 'superseded':
        this.#invalidate(state);
        throw supersededError();
      case 'logged-out':
        throw new OAuthExecutionCredentialError(
          'credential_unavailable',
          'OAuth credential is no longer configured',
        );
      case 'refresh-failed':
        throw new OAuthExecutionCredentialError(
          'refresh_failed',
          'OAuth credential refresh failed',
          { cause: result.error },
        );
      case 'storage-failed':
        if (result.error instanceof OAuthCredentialSupersededError) {
          throw supersededError(result.error);
        }
        throw new OAuthExecutionCredentialError(
          'persistence_failed',
          'OAuth credential persistence failed',
          { cause: result.error },
        );
    }
  }

  async #reconcileUncertainCommit(state: CredentialState): Promise<void> {
    const candidate = state.uncertainCommit;
    if (!candidate) return;

    let resolved;
    try {
      resolved = await this.#stores.operations.resolveExecutionConnection(state.connectionSlug);
    } catch (error) {
      throw new OAuthExecutionCredentialError(
        'persistence_failed',
        'Canonical OAuth credential could not be reconciled',
        { cause: error },
      );
    }
    this.#assertCurrent(state);
    const material = resolved.kind === 'ready' ? resolved.secretMaterial.connection : undefined;
    if (
      material &&
      material.credentialId === candidate.credentialId &&
      material.revision === candidate.revision &&
      material.secret === candidate.raw &&
      sameLocator(material.locator, state.locator)
    ) {
      state.revision = candidate.revision;
      state.raw = candidate.raw;
      state.uncertainCommit = undefined;
      return;
    }

    state.uncertainCommit = undefined;
    this.#invalidate(state);
    throw supersededError();
  }

  #credentialStore(state: CredentialState): OAuthSubscriptionCredentialStore {
    return {
      getSecret: async (slug, kind) => {
        assertBoundRequest(state, slug, kind);
        if (!this.#isCurrent(state)) throw new OAuthCredentialSupersededError();
        return state.raw;
      },
      compareAndSetSecret: async (slug, kind, expected, value) => {
        assertBoundRequest(state, slug, kind);
        if (!this.#isCurrent(state)) throw new OAuthCredentialSupersededError();
        if (expected !== state.raw) return { committed: false, current: state.raw };
        let committed;
        try {
          committed = await this.#stores.operations.compareAndSetOAuthCredential({
            locator: state.locator,
            expected: {
              credentialId: state.credentialId,
              revision: state.revision,
            },
            secret: value,
          });
        } catch (error) {
          if (!this.#isCurrent(state)) throw new OAuthCredentialSupersededError();
          if (error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown') {
            state.uncertainCommit = {
              credentialId: state.credentialId,
              revision: state.revision + 1,
              raw: value,
            };
          }
          throw error;
        }
        if (committed.kind !== 'committed') {
          this.#invalidate(state);
          throw new OAuthCredentialSupersededError();
        }
        if (!this.#isCurrent(state)) throw new OAuthCredentialSupersededError();
        state.revision = committed.revision;
        state.raw = value;
        return { committed: true };
      },
    };
  }

  #isCurrent(state: CredentialState): boolean {
    return this.#states.get(state.locator.connectionId) === state;
  }

  #assertCurrent(state: CredentialState): void {
    if (!this.#isCurrent(state)) throw supersededError();
  }

  #invalidate(state: CredentialState): void {
    if (this.#isCurrent(state)) this.#states.delete(state.locator.connectionId);
  }
}

export function createHostOAuthModelFetch(input: {
  binding: HostOAuthExecutionBinding;
  initialTokens: OAuthSubscriptionTokens;
  connection: RuntimeExecutionConnection;
  sessionId: string;
  modelId: string;
  claudeDeviceId: string;
  fetchFn: typeof fetch;
}): typeof fetch {
  if (
    input.binding.providerType === 'claude-subscription' &&
    !input.initialTokens.account_uuid?.trim()
  ) {
    throw new OAuthExecutionCredentialError(
      'credential_unavailable',
      'Claude OAuth credential is missing its canonical account identity',
    );
  }
  return async (url, init) => {
    const signal = effectiveRequestSignal(url, init);
    signal?.throwIfAborted();
    let tokens = await waitForCaller(input.binding.resolve(), signal);
    signal?.throwIfAborted();
    const authenticatedFetch = authenticatedOAuthFetch(input, () => tokens);
    const subscriptionFetch = buildSubscriptionModelFetch({
      connection: input.connection,
      sessionId: input.sessionId,
      modelId: input.modelId,
      fetchFn: authenticatedFetch,
      ...(input.binding.forceRefresh &&
      (input.binding.providerType === 'openai-codex' || input.binding.providerType === 'xai-oauth')
        ? {
            refreshOAuthAccessToken: async () =>
              (tokens = await input.binding.forceRefresh!()).access_token,
          }
        : {}),
      ...(input.binding.providerType === 'claude-subscription'
        ? {
            claude: {
              deviceId: input.claudeDeviceId,
              accountUuid: tokens.account_uuid ?? '',
            },
          }
        : {}),
    });
    return (subscriptionFetch ?? authenticatedFetch)(url, init);
  };
}

function effectiveRequestSignal(
  url: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): AbortSignal | null | undefined {
  return init?.signal !== undefined ? init.signal : url instanceof Request ? url.signal : undefined;
}

async function waitForCaller<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function authenticatedOAuthFetch(
  input: Pick<Parameters<typeof createHostOAuthModelFetch>[0], 'binding' | 'fetchFn'>,
  readTokens: () => OAuthSubscriptionTokens,
): typeof fetch {
  return async (url, init) => {
    const tokens = readTokens();
    const headers = mergedHeaders(url, init?.headers);
    headers.delete('api-key');
    headers.delete('x-api-key');
    headers.set('Authorization', `Bearer ${tokens.access_token}`);
    if (input.binding.providerType === 'openai-codex') {
      headers.delete('ChatGPT-Account-Id');
      for (const [name, value] of Object.entries(openAiCodexHeaders(tokens.access_token))) {
        headers.set(name, value);
      }
    }
    return input.fetchFn(url, { ...init, headers });
  };
}

class OAuthCredentialSupersededError extends Error {
  constructor() {
    super('OAuth credential generation is no longer canonical');
    this.name = 'OAuthCredentialSupersededError';
  }
}

function requireOAuthLocator(locator: CredentialLocator): OAuthCredentialLocator {
  if (locator.scope !== 'connection' || locator.kind !== 'oauth_token') {
    throw new OAuthExecutionCredentialError(
      'persistence_failed',
      'Canonical OAuth credential material has an invalid locator',
    );
  }
  return {
    scope: 'connection',
    connectionId: locator.connectionId,
    kind: 'oauth_token',
  };
}

function assertBoundRequest(state: CredentialState, slug: string, kind: 'oauth_token'): void {
  if (slug !== state.connectionSlug || kind !== 'oauth_token') {
    throw new OAuthExecutionCredentialError(
      'persistence_failed',
      'OAuth credential resolver escaped its bound connection',
    );
  }
}

function sameLocator(left: CredentialLocator, right: CredentialLocator): boolean {
  return (
    left.scope === 'connection' &&
    right.scope === 'connection' &&
    left.connectionId === right.connectionId &&
    left.kind === right.kind
  );
}

function mergedHeaders(
  url: Parameters<typeof fetch>[0],
  override: HeadersInit | undefined,
): Headers {
  const headers = new Headers(url instanceof Request ? url.headers : undefined);
  new Headers(override).forEach((value, name) => headers.set(name, value));
  return headers;
}

function supersededError(cause?: unknown): OAuthExecutionCredentialError {
  return new OAuthExecutionCredentialError(
    'credential_superseded',
    'OAuth credential changed during backend execution',
    cause === undefined ? undefined : { cause },
  );
}
