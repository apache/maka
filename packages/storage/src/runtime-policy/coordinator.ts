import {
  decodeConnectionModelId,
  decodeConnectionSlug,
  decodeRuntimePolicyEntityId,
  decodeCredentialLocator,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeSetCredentialInput,
  type ConnectionCatalogEntry,
  type ConnectionModelDiscoveryResult,
  type ConnectionTestSummary,
  type CreateCatalogConnectionInput,
  type CredentialLocator,
  type CredentialStatus,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RuntimePolicy,
  type SetCredentialInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import { deriveProviderAuthContract, type ProviderAuthAction } from '@maka/core/provider-auth';
import { effectiveBaseUrl, PROVIDER_DEFAULTS, type ProviderType } from '@maka/core/llm-connections';
import { deepFreeze } from './codec.js';
import {
  catalogSnapshot,
  connectionBasis,
  ConnectionCatalogDocumentOwner,
  connectionTestModelBasis,
  findConnection,
  sameConnectionTestModelBasis,
  type ConnectionCatalogDocument,
  type ConnectionTestModelBasis,
} from './connection-catalog-document.js';
import {
  credentialMaterial,
  credentialStatus,
  CredentialVaultDocumentOwner,
  findCredential,
  vaultSnapshot,
} from './credential-vault-document.js';
import { cleanupRuntimePolicyDocumentTemps } from './document-io.js';
import {
  codecError,
  commitOutcomeUnknown,
  decodeConnectionInput,
  decodeCredentialInput,
} from './errors.js';
import {
  connectionCredentialLocator,
  type CredentialStatusQueryResult,
  type BeginConnectionTestResult,
  type BeginModelFetchResult,
  type CompareAndSetOAuthCredentialInput,
  type ConnectionEffectChangedDomain,
  type ConnectionEffectCompletionResult,
  type ConnectionTestTicket,
  type ModelFetchTicket,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyOperationSecretMaterial,
  type ResolveExecutionConnectionResult,
} from './operations.js';
import { policySnapshot, RuntimePolicyDocumentOwner } from './policy-document.js';
import { SerializedOperationLane } from '../serialized-operation-lane.js';

type RootExecutor = <T>(operation: (root: string) => Promise<T>) => Promise<T>;

interface PreparedConnectionMaterial {
  readonly kind: 'ready';
  readonly connection: ConnectionCatalogEntry;
  readonly connectionCredentialStatus: CredentialStatus | null;
  readonly proxyCredentialStatus: CredentialStatus | null;
  readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
  readonly networkProxy: RuntimePolicy['networkProxy'];
}

type ConnectionTicketKind = 'model_fetch' | 'connection_test';
type TicketState = 'available' | 'in_flight' | 'consumed';

type EffectiveProxyConfigurationBasis =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'proxy';
      readonly protocol: RuntimePolicy['networkProxy']['protocol'];
      readonly host: string;
      readonly port: number;
      readonly authentication:
        | { readonly kind: 'none' }
        | { readonly kind: 'credentials'; readonly username: string };
      readonly bypassPatterns: readonly string[];
    };

interface CommonSemanticConnectionBasis {
  readonly connectionId: string;
  readonly providerType: ProviderType;
  readonly enabled: true;
  readonly effectiveEndpoint: string;
  readonly credential: CredentialStatus | null;
  readonly effectiveProxy: EffectiveProxyConfigurationBasis;
  readonly proxyCredential: CredentialStatus | null;
}

type SemanticConnectionBasis =
  | (CommonSemanticConnectionBasis & {
      readonly kind: 'model_fetch';
      readonly enabledModelIds: readonly string[];
    })
  | (CommonSemanticConnectionBasis & {
      readonly kind: 'connection_test';
      readonly model: ConnectionTestModelBasis;
    });

interface ConnectionTicketRecord {
  readonly kind: ConnectionTicketKind;
  readonly basis: SemanticConnectionBasis;
  state: TicketState;
}

export class RuntimePolicyCoordinator {
  private readonly lane: SerializedOperationLane<string>;
  private readonly policy = new RuntimePolicyDocumentOwner();
  private readonly catalog = new ConnectionCatalogDocumentOwner();
  private readonly vault = new CredentialVaultDocumentOwner();
  private readonly tickets = new WeakMap<object, ConnectionTicketRecord>();

  constructor(private readonly execute: RootExecutor) {
    this.lane = new SerializedOperationLane(execute);
  }

  recoverForWrite(): Promise<void> {
    return this.inLane(async (root) => {
      await cleanupRuntimePolicyDocumentTemps(root);
      const catalog = await this.catalog.read(root);
      const vault = await this.vault.read(root);
      await this.vault.deleteOrphanedConnectionCredentials(
        root,
        vault,
        new Set(catalog.connections.map((connection) => connection.connectionId)),
      );
    });
  }

  getPolicySnapshot() {
    return this.execute(async (root) => policySnapshot(await this.policy.read(root)));
  }

  getCatalogSnapshot() {
    return this.execute(async (root) => catalogSnapshot(await this.catalog.read(root)));
  }

  getVaultSnapshot() {
    return this.execute(async (root) => vaultSnapshot(await this.vault.read(root)));
  }

  getCredentialStatus(rawLocator: CredentialLocator): Promise<CredentialStatusQueryResult> {
    return this.inLane(async (root) => {
      const locator = decodeCredentialInput(() => decodeCredentialLocator(rawLocator));
      if (locator.scope === 'connection') {
        const catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
      }
      const status = credentialStatus(await this.vault.read(root), locator);
      return deepFreeze({ kind: 'status' as const, status });
    });
  }

  mutatePolicy(input: MutateRuntimePolicyInput) {
    return this.inLane(async (root) => {
      const current = await this.policy.read(root);
      const prepared = this.policy.prepareMutation(current, input);
      if (prepared.kind !== 'ready') return prepared;
      const proxyChanged = !sameEffectiveProxyConfiguration(
        effectiveProxyConfigurationBasis(prepared.current.policy.networkProxy),
        effectiveProxyConfigurationBasis(prepared.next.policy.networkProxy),
      );
      const cleared = proxyChanged
        ? await this.catalog.clearAllConnectionLastTests(root, await this.catalog.read(root))
        : false;
      try {
        return await this.policy.commitMutation(root, prepared);
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before network proxy update completed',
            error,
          );
        }
        throw error;
      }
    });
  }

  createConnection(input: CreateCatalogConnectionInput) {
    return this.inLane((root) => this.catalog.create(root, input));
  }

  updateConnection(input: UpdateCatalogConnectionInput) {
    return this.inLane((root) => this.catalog.update(root, input));
  }

  removeConnection(rawInput: RemoveCatalogConnectionInput) {
    return this.inLane(async (root) => {
      const { expected } = decodeConnectionInput(() =>
        normalizeRemoveCatalogConnectionInput(rawInput),
      );
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, expected);
      if (connection && connection.revision !== expected.revision) {
        return deepFreeze({
          kind: 'connection_stale' as const,
          expected,
          actual: connectionBasis(connection),
        });
      }

      const vault = await this.vault.read(root);
      if (!connection) {
        await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
        return deepFreeze({ kind: 'committed' as const, snapshot: catalogSnapshot(catalog) });
      }
      const result = await this.catalog.remove(root, { expected });
      if (result.kind === 'committed') {
        try {
          await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
        } catch (error) {
          throw commitOutcomeUnknown(
            'Connection removal committed before credential cleanup completed',
            error,
          );
        }
      }
      return result;
    });
  }

  setDefaultTarget(input: SetDefaultConnectionTargetInput) {
    return this.inLane((root) => this.catalog.setDefaultTarget(root, input));
  }

  setCredential(rawInput: SetCredentialInput) {
    return this.inLane(async (root) => {
      const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
      const { locator } = input;
      let catalog: ConnectionCatalogDocument | null = null;
      if (locator.scope === 'connection') {
        catalog = await this.catalog.read(root);
        const connection = findConnection(catalog, locator);
        if (!connection) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
        const required = connectionCredentialLocator(
          connection.connectionId,
          PROVIDER_DEFAULTS[connection.providerType].authKind,
        );
        if (!required || required.kind !== locator.kind) {
          throw codecError(
            'invalid_credential_input',
            'Connection credential kind does not match the provider auth contract',
          );
        }
        if (locator.kind === 'oauth_token' && connection.providerType !== 'github-copilot') {
          throw codecError(
            'invalid_credential_input',
            'Client-supplied OAuth credentials are only accepted for GitHub Copilot',
          );
        }
      }
      const prepared = this.vault.prepareSet(await this.vault.read(root), input);
      if (prepared.kind !== 'ready') return prepared;
      const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
      try {
        await this.vault.commitSet(root, prepared);
        return deepFreeze({
          kind: 'committed' as const,
          snapshot: vaultSnapshot(prepared.document),
        });
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before credential update completed',
            error,
          );
        }
        throw error;
      }
    });
  }

  compareAndSetOAuthCredential(rawInput: CompareAndSetOAuthCredentialInput) {
    return this.inLane(async (root) => {
      const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
      if (
        input.locator.scope !== 'connection' ||
        input.locator.kind !== 'oauth_token' ||
        input.expected === null
      ) {
        throw codecError(
          'invalid_credential_input',
          'OAuth refresh requires an existing connection OAuth credential generation',
        );
      }
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, input.locator);
      if (!connection) return deepFreeze({ kind: 'superseded' as const });
      if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'oauth_token') {
        throw codecError(
          'invalid_credential_input',
          'OAuth refresh credential does not match the provider auth contract',
        );
      }
      const prepared = this.vault.prepareSet(await this.vault.read(root), input);
      if (prepared.kind !== 'ready') return deepFreeze({ kind: 'superseded' as const });
      await this.vault.commitSet(root, prepared);
      return deepFreeze({
        kind: 'committed' as const,
        credentialId: prepared.entry.credentialId,
        revision: prepared.entry.revision,
      });
    });
  }

  deleteCredential(rawInput: DeleteCredentialInput) {
    return this.inLane(async (root) => {
      const { expected } = decodeCredentialInput(() => normalizeDeleteCredentialInput(rawInput));
      const { locator } = expected;
      let catalog: ConnectionCatalogDocument | null = null;
      if (locator.scope === 'connection') {
        catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
      }
      const prepared = this.vault.prepareDelete(await this.vault.read(root), { expected });
      if (prepared.kind !== 'ready') return prepared;
      const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
      try {
        return await this.vault.commitDelete(root, prepared);
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before credential deletion completed',
            error,
          );
        }
        throw error;
      }
    });
  }

  resolveExecutionConnection(rawConnectionSlug: string): Promise<ResolveExecutionConnectionResult> {
    return this.inLane(async (root) => {
      const connectionSlug = decodeConnectionInput(() => decodeConnectionSlug(rawConnectionSlug));
      const catalog = await this.catalog.read(root);
      const connection = catalog.connections.find((candidate) => candidate.slug === connectionSlug);
      if (!connection) return deepFreeze({ kind: 'not_found' as const });
      if (!connection.enabled) return deepFreeze({ kind: 'disabled' as const });

      const contract = deriveProviderAuthContract({
        providerType: connection.providerType,
        enabled: true,
        hasSecret: true,
        lastTestStatus: connection.lastTest?.status,
      });
      const prepared = await this.prepareConnectionMaterial(
        root,
        connection,
        contract.requiresSecret,
      );
      if (prepared.kind !== 'ready') return prepared;
      return deepFreeze({
        kind: 'ready' as const,
        connection: structuredClone(connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  beginModelFetch(rawConnectionId: string): Promise<BeginModelFetchResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(root, connectionId, 'fetch_models');
      if (prepared.kind !== 'ready') return prepared;
      const ticket = this.issueTicket('model_fetch', modelFetchSemanticBasis(prepared));
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ModelFetchTicket,
        connection: structuredClone(prepared.connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeModelFetch(
    ticket: ModelFetchTicket,
    result: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionEffectCompletionResult> {
    const claimed = this.claimTicket(ticket, 'model_fetch');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'superseded' as const, changed: checked.changed });
        }
        const snapshot = await this.catalog.writeModelFetchResult(
          root,
          catalog,
          connectionBasis(checked.connection),
          result,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  beginConnectionTest(
    rawConnectionId: string,
    rawModelId: string | null,
  ): Promise<BeginConnectionTestResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(
        root,
        connectionId,
        'test_credentials',
      );
      if (prepared.kind !== 'ready') return prepared;
      const modelId =
        rawModelId === null
          ? null
          : decodeConnectionInput(() => decodeConnectionModelId(rawModelId));
      if (modelId !== null && !isCanonicalConnectionTestModel(prepared.connection, modelId)) {
        throw codecError(
          'invalid_connection_input',
          'Connection test model is not in the canonical model set',
        );
      }
      const ticket = this.issueTicket('connection_test', connectionTestSemanticBasis(prepared));
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ConnectionTestTicket,
        connection: structuredClone(prepared.connection),
        modelId,
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeConnectionTest(
    ticket: ConnectionTestTicket,
    result: ConnectionTestSummary,
  ): Promise<ConnectionEffectCompletionResult> {
    const claimed = this.claimTicket(ticket, 'connection_test');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'superseded' as const, changed: checked.changed });
        }
        const snapshot = await this.catalog.writeConnectionTestResult(
          root,
          catalog,
          connectionBasis(checked.connection),
          result,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  private async prepareConnectionOperation(
    root: string,
    connectionId: string,
    action: ProviderAuthAction,
  ): Promise<
    PreparedConnectionMaterial | Exclude<BeginModelFetchResult, { readonly kind: 'ready' }>
  > {
    const catalog = await this.catalog.read(root);
    const connection = findConnection(catalog, { connectionId });
    if (!connection) return deepFreeze({ kind: 'connection_not_found' as const });
    if (!connection.enabled) return deepFreeze({ kind: 'connection_disabled' as const });

    const contract = deriveProviderAuthContract({
      providerType: connection.providerType,
      enabled: true,
      hasSecret: true,
      lastTestStatus: connection.lastTest?.status,
    });
    const availability = contract.actionAvailability[action];
    if (availability !== 'available') {
      return deepFreeze({ kind: 'provider_action_unavailable' as const, availability });
    }
    return this.prepareConnectionMaterial(root, connection, contract.requiresSecret);
  }

  private async prepareConnectionMaterial(
    root: string,
    connection: ConnectionCatalogEntry,
    requiresConnectionSecret: boolean,
  ): Promise<
    | PreparedConnectionMaterial
    | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  > {
    const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
    const locator = connectionCredentialLocator(connection.connectionId, authKind);
    const policy = await this.policy.read(root);
    const networkProxy = structuredClone(policy.policy.networkProxy);
    const proxyLocator = requiresNetworkProxyCredential(networkProxy)
      ? networkProxyCredentialLocator()
      : null;
    let connectionCredentialStatus: CredentialStatus | null = null;
    let proxyCredentialStatus: CredentialStatus | null = null;
    const secretMaterial: {
      connection?: RuntimePolicyCredentialMaterial;
      networkProxy?: RuntimePolicyCredentialMaterial;
    } = {};

    if (locator || proxyLocator) {
      const vault = await this.vault.read(root);
      if (locator) {
        const status = credentialStatus(vault, locator);
        connectionCredentialStatus = status;
        const entry = findCredential(vault, locator);
        if (!entry) {
          if (requiresConnectionSecret) {
            return deepFreeze({
              kind: 'credential_not_configured' as const,
              status,
            });
          }
        } else {
          secretMaterial.connection = credentialMaterial(entry);
        }
      }
      if (proxyLocator) {
        const status = credentialStatus(vault, proxyLocator);
        proxyCredentialStatus = status;
        const entry = findCredential(vault, proxyLocator);
        if (!entry) {
          return deepFreeze({
            kind: 'credential_not_configured' as const,
            status,
          });
        }
        secretMaterial.networkProxy = credentialMaterial(entry);
      }
    }

    return {
      kind: 'ready',
      connection,
      connectionCredentialStatus,
      proxyCredentialStatus,
      secretMaterial,
      networkProxy,
    };
  }

  private validateConnectionCredentialLocator(
    catalog: ConnectionCatalogDocument,
    locator: CredentialLocator,
  ): boolean {
    if (locator.scope !== 'connection') return true;
    const connection = findConnection(catalog, locator);
    if (!connection) return false;
    const required = connectionCredentialLocator(
      connection.connectionId,
      PROVIDER_DEFAULTS[connection.providerType].authKind,
    );
    if (!required || required.kind !== locator.kind) {
      throw codecError(
        'invalid_credential_input',
        'Connection credential kind does not match the provider auth contract',
      );
    }
    return true;
  }

  private async clearCredentialDependentLastTests(
    root: string,
    locator: CredentialLocator,
    connectionCatalog: ConnectionCatalogDocument | null,
  ): Promise<boolean> {
    if (locator.scope === 'connection') {
      return this.catalog.clearConnectionLastTest(root, connectionCatalog!, locator.connectionId);
    }
    if (locator.scope !== 'network_proxy') return false;
    const policy = await this.policy.read(root);
    if (!requiresNetworkProxyCredential(policy.policy.networkProxy)) return false;
    return this.catalog.clearAllConnectionLastTests(root, await this.catalog.read(root));
  }

  private async checkSemanticConnectionBasis(
    root: string,
    catalog: Awaited<ReturnType<ConnectionCatalogDocumentOwner['read']>>,
    basis: SemanticConnectionBasis,
  ): Promise<{
    readonly connection: ConnectionCatalogEntry | undefined;
    readonly changed: ConnectionEffectChangedDomain[];
  }> {
    const connection = findConnection(catalog, { connectionId: basis.connectionId });
    const changed: ConnectionEffectChangedDomain[] = [];
    if (
      !connection ||
      connection.providerType !== basis.providerType ||
      !connection.enabled ||
      canonicalEffectiveEndpoint(connection) !== basis.effectiveEndpoint ||
      (basis.kind === 'model_fetch' &&
        !sameStringArray(connection.enabledModelIds, basis.enabledModelIds)) ||
      (basis.kind === 'connection_test' &&
        !sameConnectionTestModelBasis(connectionTestModelBasis(connection), basis.model))
    ) {
      changed.push('connection');
    }

    const policy = await this.policy.read(root);
    if (
      !sameEffectiveProxyConfiguration(
        effectiveProxyConfigurationBasis(policy.policy.networkProxy),
        basis.effectiveProxy,
      )
    ) {
      changed.push('network_proxy');
    }

    if (basis.credential || basis.proxyCredential) {
      const vault = await this.vault.read(root);
      const connectionCredentialChanged = Boolean(
        basis.credential &&
          !sameCredentialStatus(
            credentialStatus(vault, basis.credential.locator),
            basis.credential,
          ),
      );
      const proxyCredentialChanged = Boolean(
        basis.proxyCredential &&
          !sameCredentialStatus(
            credentialStatus(vault, basis.proxyCredential.locator),
            basis.proxyCredential,
          ),
      );
      if (connectionCredentialChanged || proxyCredentialChanged) changed.push('credential');
    }
    return { connection, changed };
  }

  private issueTicket(kind: ConnectionTicketKind, basis: SemanticConnectionBasis): object {
    const ticket = Object.freeze(Object.create(null)) as object;
    this.tickets.set(ticket, { kind, basis, state: 'available' });
    return ticket;
  }

  private claimTicket(ticket: object, expectedKind: ConnectionTicketKind): ConnectionTicketRecord {
    const record = ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined;
    if (!record || record.kind !== expectedKind || record.state !== 'available') {
      throw codecError(
        'invalid_connection_input',
        `Expected an authentic available ${ticketLabel(expectedKind)} ticket`,
      );
    }
    record.state = 'in_flight';
    return record;
  }

  private async completeClaimedTicket<T>(
    ticket: ConnectionTicketRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } finally {
      ticket.state = 'consumed';
    }
  }

  private inLane<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return this.lane.run(operation);
  }
}

function commonSemanticConnectionBasis(
  prepared: PreparedConnectionMaterial,
): CommonSemanticConnectionBasis {
  return {
    connectionId: prepared.connection.connectionId,
    providerType: prepared.connection.providerType,
    enabled: true,
    effectiveEndpoint: canonicalEffectiveEndpoint(prepared.connection),
    credential: prepared.connectionCredentialStatus,
    effectiveProxy: effectiveProxyConfigurationBasis(prepared.networkProxy),
    proxyCredential: prepared.proxyCredentialStatus,
  };
}

function modelFetchSemanticBasis(
  prepared: PreparedConnectionMaterial,
): Extract<SemanticConnectionBasis, { readonly kind: 'model_fetch' }> {
  return {
    kind: 'model_fetch',
    ...commonSemanticConnectionBasis(prepared),
    enabledModelIds: [...prepared.connection.enabledModelIds],
  };
}

function connectionTestSemanticBasis(
  prepared: PreparedConnectionMaterial,
): Extract<SemanticConnectionBasis, { readonly kind: 'connection_test' }> {
  return {
    kind: 'connection_test',
    ...commonSemanticConnectionBasis(prepared),
    model: connectionTestModelBasis(prepared.connection),
  };
}

function isCanonicalConnectionTestModel(
  connection: ConnectionCatalogEntry,
  modelId: string,
): boolean {
  const basis = connectionTestModelBasis(connection);
  const inCanonicalModels = basis.models.some((model) => model.id === modelId);
  return basis.modelSource === 'fetched'
    ? inCanonicalModels
    : inCanonicalModels || basis.enabledModelIds.includes(modelId);
}

function canonicalEffectiveEndpoint(connection: ConnectionCatalogEntry): string {
  const endpoint = effectiveBaseUrl(connection);
  try {
    return new URL(endpoint).toString();
  } catch {
    throw codecError('invalid_document', 'Connection has an invalid effective endpoint');
  }
}

function effectiveProxyConfigurationBasis(
  networkProxy: RuntimePolicy['networkProxy'],
): EffectiveProxyConfigurationBasis {
  if (!networkProxy.enabled) return { kind: 'direct' };
  return {
    kind: 'proxy',
    protocol: networkProxy.protocol,
    host: networkProxy.host.trim().toLowerCase(),
    port: networkProxy.port,
    authentication: networkProxy.authEnabled
      ? { kind: 'credentials', username: networkProxy.username }
      : { kind: 'none' },
    bypassPatterns: normalizeProxyPatterns([
      ...networkProxy.bypassList,
      ...networkProxy.autoBypassDomains,
    ]),
  };
}

function sameEffectiveProxyConfiguration(
  actual: EffectiveProxyConfigurationBasis,
  expected: EffectiveProxyConfigurationBasis,
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'direct' || expected.kind === 'direct') return true;
  return (
    actual.protocol === expected.protocol &&
    actual.host === expected.host &&
    actual.port === expected.port &&
    sameProxyAuthentication(actual.authentication, expected.authentication) &&
    sameStringArray(actual.bypassPatterns, expected.bypassPatterns)
  );
}

function sameProxyAuthentication(
  actual: Extract<EffectiveProxyConfigurationBasis, { kind: 'proxy' }>['authentication'],
  expected: Extract<EffectiveProxyConfigurationBasis, { kind: 'proxy' }>['authentication'],
): boolean {
  if (actual.kind !== expected.kind) return false;
  return (
    actual.kind === 'none' ||
    (expected.kind === 'credentials' && actual.username === expected.username)
  );
}

function normalizeProxyPatterns(patterns: readonly string[]): readonly string[] {
  return [
    ...new Set(
      patterns
        .map((pattern) => pattern.trim().toLowerCase())
        .filter((pattern) => pattern.length > 0),
    ),
  ].sort();
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function sameCredentialStatus(actual: CredentialStatus, expected: CredentialStatus): boolean {
  return (
    sameCredentialLocator(actual.locator, expected.locator) &&
    actual.configured === expected.configured &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

function sameCredentialLocator(actual: CredentialLocator, expected: CredentialLocator): boolean {
  return (
    actual.scope === expected.scope &&
    actual.kind === expected.kind &&
    (actual.scope !== 'connection' ||
      (expected.scope === 'connection' && actual.connectionId === expected.connectionId))
  );
}

function ticketLabel(kind: ConnectionTicketKind): string {
  return kind === 'model_fetch' ? 'model fetch' : 'connection test';
}

function networkProxyCredentialLocator(): Extract<CredentialLocator, { scope: 'network_proxy' }> {
  return { scope: 'network_proxy', kind: 'password' };
}

function requiresNetworkProxyCredential(networkProxy: RuntimePolicy['networkProxy']): boolean {
  return networkProxy.enabled && networkProxy.authEnabled;
}
