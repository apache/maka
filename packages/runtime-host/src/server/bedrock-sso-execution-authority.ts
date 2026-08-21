import type { BedrockConnectionConfig } from '@maka/core/llm-connections';
import type { CredentialLocator } from '@maka/core/runtime-policy';
import {
  getBedrockSsoRoleCredentials,
  parseBedrockSsoSession,
  refreshBedrockSsoSession,
  serializeBedrockSsoSession,
  type BedrockSsoSession,
} from '@maka/runtime/bedrock-sso';
import type { AwsCredentialIdentity } from '@maka/runtime/model-factory';
import type { ProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import type {
  RuntimePolicyCredentialMaterial,
  RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';

const REFRESH_SKEW_MS = 5 * 60_000;

type AwsSsoLocator = Extract<CredentialLocator, { scope: 'connection' }> & {
  readonly kind: 'aws_sso';
};

interface State {
  readonly locator: AwsSsoLocator;
  readonly connectionSlug: string;
  readonly config: BedrockConnectionConfig;
  readonly credentialId: string;
  revision: number;
  raw: string;
  session?: BedrockSsoSession;
  roleCredentials?: AwsCredentialIdentity;
  resolving?: Promise<AwsCredentialIdentity>;
}

export class BedrockSsoCredentialError extends Error {
  constructor(
    readonly code: 'credential_unavailable' | 'credential_superseded' | 'refresh_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BedrockSsoCredentialError';
  }
}

export interface BedrockSsoExecutionBinding {
  readonly connectionSlug: string;
  credentials(): Promise<AwsCredentialIdentity>;
}

/** Canonical, Host-local IAM Identity Center session and role credential authority. */
export class BedrockSsoExecutionAuthority {
  readonly #states = new Map<string, State>();

  constructor(
    private readonly stores: Pick<RuntimePolicyStoresWriter, 'operations'>,
    private readonly now: () => number = Date.now,
  ) {}

  bind(input: {
    readonly connectionSlug: string;
    readonly config: BedrockConnectionConfig;
    readonly material: RuntimePolicyCredentialMaterial;
    readonly createTransport: () => ProxiedFetchTransport;
  }): BedrockSsoExecutionBinding {
    const locator = requireLocator(input.material.locator);
    let state = this.#states.get(locator.connectionId);
    if (
      state &&
      (state.credentialId !== input.material.credentialId ||
        state.revision !== input.material.revision ||
        state.raw !== input.material.secret ||
        state.connectionSlug !== input.connectionSlug ||
        JSON.stringify(state.config) !== JSON.stringify(input.config))
    ) {
      this.#states.delete(locator.connectionId);
      state = undefined;
    }
    state ??= {
      locator,
      connectionSlug: input.connectionSlug,
      config: structuredClone(input.config),
      credentialId: input.material.credentialId,
      revision: input.material.revision,
      raw: input.material.secret,
    };
    this.#states.set(locator.connectionId, state);
    const bound = state;
    return Object.freeze({
      connectionSlug: bound.connectionSlug,
      credentials: () => this.#credentials(bound, input.createTransport),
    });
  }

  invalidate(connectionId?: string): void {
    if (connectionId) this.#states.delete(connectionId);
    else this.#states.clear();
  }

  async #credentials(
    state: State,
    createTransport: () => ProxiedFetchTransport,
  ): Promise<AwsCredentialIdentity> {
    this.#assertCurrent(state);
    const expiration = state.roleCredentials?.expiration?.getTime() ?? 0;
    if (expiration - this.now() > REFRESH_SKEW_MS) return state.roleCredentials!;
    if (state.resolving) return state.resolving;
    const pending = this.#resolve(state, createTransport);
    state.resolving = pending;
    try {
      return await pending;
    } finally {
      if (state.resolving === pending) state.resolving = undefined;
    }
  }

  async #resolve(
    state: State,
    createTransport: () => ProxiedFetchTransport,
  ): Promise<AwsCredentialIdentity> {
    let transport: ProxiedFetchTransport | undefined;
    try {
      transport = createTransport();
      let session = state.session ?? parseBedrockSsoSession(state.raw);
      if (!session) {
        throw new BedrockSsoCredentialError(
          'credential_unavailable',
          'Stored IAM Identity Center session is invalid',
        );
      }
      if (session.expiresAt - this.now() <= REFRESH_SKEW_MS) {
        try {
          const refreshed = await refreshBedrockSsoSession({
            session,
            ssoRegion: state.config.ssoRegion,
            fetchFn: transport.fetch,
            now: this.now,
          });
          const raw = serializeBedrockSsoSession(refreshed);
          let committed;
          try {
            committed = await this.stores.operations.compareAndSetAwsSsoCredential({
              locator: state.locator,
              expected: { credentialId: state.credentialId, revision: state.revision },
              secret: raw,
            });
          } catch (error) {
            committed = await this.#reconcileRefreshCommit(state, raw).catch(() => {
              throw error;
            });
          }
          if (committed.kind !== 'committed') {
            this.#invalidate(state);
            throw new BedrockSsoCredentialError(
              'credential_superseded',
              'IAM Identity Center session was replaced',
            );
          }
          state.revision = committed.revision;
          state.raw = raw;
          session = refreshed;
        } catch (error) {
          if (error instanceof BedrockSsoCredentialError) throw error;
          throw new BedrockSsoCredentialError(
            'refresh_failed',
            'IAM Identity Center session must be authorized again',
            { cause: error },
          );
        }
      }
      this.#assertCurrent(state);
      state.session = session;
      const credentials = await getBedrockSsoRoleCredentials({
        accessToken: session.accessToken,
        accountId: state.config.accountId,
        roleName: state.config.roleName,
        ssoRegion: state.config.ssoRegion,
        fetchFn: transport.fetch,
      });
      this.#assertCurrent(state);
      state.roleCredentials = credentials;
      return credentials;
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  async #reconcileRefreshCommit(
    state: State,
    raw: string,
  ): Promise<{
    readonly kind: 'committed';
    readonly credentialId: string;
    readonly revision: number;
  }> {
    const resolved = await this.stores.operations.resolveExecutionConnection(state.connectionSlug);
    const material = resolved.kind === 'ready' ? resolved.secretMaterial.connection : undefined;
    if (
      !material ||
      material.credentialId !== state.credentialId ||
      material.secret !== raw ||
      material.revision !== state.revision + 1
    ) {
      throw new BedrockSsoCredentialError(
        'refresh_failed',
        'IAM Identity Center refresh commit could not be reconciled',
      );
    }
    return {
      kind: 'committed',
      credentialId: material.credentialId,
      revision: material.revision,
    };
  }

  #assertCurrent(state: State): void {
    if (this.#states.get(state.locator.connectionId) !== state) {
      throw new BedrockSsoCredentialError(
        'credential_superseded',
        'IAM Identity Center credential generation is no longer canonical',
      );
    }
  }

  #invalidate(state: State): void {
    if (this.#states.get(state.locator.connectionId) === state) {
      this.#states.delete(state.locator.connectionId);
    }
  }
}

function requireLocator(locator: CredentialLocator): AwsSsoLocator {
  if (locator.scope !== 'connection' || locator.kind !== 'aws_sso') {
    throw new BedrockSsoCredentialError(
      'credential_unavailable',
      'Amazon Bedrock connection has an invalid credential locator',
    );
  }
  return {
    scope: 'connection',
    connectionId: locator.connectionId,
    kind: 'aws_sso',
  };
}
