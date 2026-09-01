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
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  decodeConnectionModelId,
  decodeConnectionSlug,
  decodeProviderType,
  decodeRuntimePolicyEntityId,
  decodeCredentialLocator,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeRequestHeaderUpdates,
  normalizeRequestHeaders,
  normalizeSetCredentialInput,
  parseRequestHeaders,
  serializeRequestHeaders,
  RequestCustomizationValidationError,
  normalizeCredentialSecret,
  normalizeCatalogConnectionBaseUrl,
  type ConnectionCatalogEntry,
  type ConnectionCatalogSnapshot,
  type ConnectionVersionBasis,
  type ConnectionModelDiscoveryResult,
  type ConnectionTestSummary,
  type CreateCatalogConnectionInput,
  type CredentialLocator,
  type CredentialStatus,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RuntimePolicy,
  type RequestHeaderUpdate,
  type SavedRequestHeaders,
  type SetCredentialInput,
  type MigrateSystemSeedInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import {
  applyModelFactOverridesToConnection,
  applyModelFactOverridesToCatalogSnapshot,
  type ModelFactsDocument,
} from '@maka/core/model-facts';
import { deriveProviderAuthContract, type ProviderAuthAction } from '@maka/core/provider-auth';
import { isRetiredProvider } from '@maka/core/provider-registry';
import {
  deriveConnectionSlug,
  deriveInteractiveOAuthConnectionSlug,
  effectiveBaseUrl,
  PROVIDER_REGISTRY,
  providerFallbackModelIds,
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  type ProviderType,
} from '@maka/core/llm-connections';
import { deepFreeze, nextRevision } from './codec.js';
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
  credentialBasis,
  credentialStatus,
  CredentialVaultDocumentOwner,
  findCredential,
  sameCredentialBasis,
  vaultSnapshot,
} from './credential-vault-document.js';
import { cleanupRuntimePolicyDocumentTemps } from './document-io.js';
import {
  codecError,
  commitOutcomeUnknown,
  decodeConnectionInput,
  decodeCredentialInput,
  RuntimePolicyStoreError,
} from './errors.js';
import {
  connectionCredentialLocator,
  connectionRequestHeadersLocator,
  type CredentialStatusQueryResult,
  type BeginConnectionTestResult,
  type BeginModelFetchResult,
  type BeginInteractiveOAuthLoginResult,
  type CompareAndSetOAuthCredentialInput,
  type ConnectionEffectChangedDomain,
  type ConnectionEffectCompletionResult,
  type BeginConnectionOnboardingInput,
  type BeginConnectionOnboardingResult,
  type CommitConnectionOnboardingInput,
  type CommitConnectionOnboardingResult,
  type ConnectionOnboardingTicket,
  type ConnectionTestTicket,
  type InteractiveOAuthLoginCompletionResult,
  type InteractiveOAuthLoginInput,
  type InteractiveOAuthLoginProvider,
  type InteractiveOAuthLoginTarget,
  type InteractiveOAuthLoginTicket,
  type ModelFetchTicket,
  type ExecutionConnectionRef,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyOperationSecretMaterial,
  type ResolveExecutionConnectionResult,
  type ResolveNetworkProxyExecutionInput,
  type ResolveNetworkProxyExecutionResult,
  type ResolveHostOutboundExecutionResult,
  type ResolveWebSearchExecutionInput,
  type ResolveWebSearchExecutionResult,
  type ReplaceConnectionRequestHeadersResult,
} from './operations.js';
import {
  clearConnectionOnboardingIntent,
  prepareConnectionOnboardingIntent,
  prepareInteractiveOAuthEnrollmentIntent,
  readConnectionOnboardingIntent,
  writeConnectionOnboardingIntent,
  type ConnectionOnboardingIntent,
  type InteractiveOAuthEnrollmentIntent,
} from './onboarding-transaction.js';
import {
  findInteractiveOAuthLoginReceipt,
  readInteractiveOAuthLoginReceipts,
  sameInteractiveOAuthLoginTarget,
  upsertInteractiveOAuthLoginReceipt,
} from './oauth-login-receipt-document.js';
import { policySnapshot, RuntimePolicyDocumentOwner } from './policy-document.js';
import { SerializedOperationLane } from '../serialized-operation-lane.js';
import { ModelFactsDocumentOwner } from '../model-facts-store.js';

type RootExecutor = <T>(operation: (root: string) => Promise<T>) => Promise<T>;

interface PreparedConnectionMaterial {
  readonly kind: 'ready';
  readonly connection: ConnectionCatalogEntry;
  readonly connectionCredentialStatus: CredentialStatus | null;
  readonly requestHeadersCredentialStatus: CredentialStatus;
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
  readonly requestHeadersCredential: CredentialStatus;
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
      readonly requestBodyOverlayJson: string;
      readonly model: ConnectionTestModelBasis;
      readonly modelFactsFingerprint: string;
    });

interface ConnectionTicketRecord {
  readonly kind: ConnectionTicketKind;
  readonly basis: SemanticConnectionBasis;
  state: TicketState;
}

/**
 * What onboarding discovery observed. Unlike the model-fetch/test bases, the
 * target may not exist yet (first-time creation at the canonical slug), and
 * the connection revision stands in for every catalog-visible property of an
 * existing target — a swapped endpoint bumps it.
 */
interface ConnectionOnboardingCandidateIdentity {
  readonly connectionId: string;
  readonly slug: string;
  readonly providerType: ProviderType;
}

interface ConnectionOnboardingBasis {
  readonly target:
    | {
        readonly kind: 'create';
        readonly candidate: ConnectionOnboardingCandidateIdentity;
      }
    | {
        readonly kind: 'existing';
        readonly candidate: ConnectionOnboardingCandidateIdentity;
        readonly revision: number;
      };
  readonly baseUrl: string | null;
  readonly credential: CredentialStatus | null;
  readonly requestHeadersCredential: CredentialStatus | null;
  readonly effectiveProxy: EffectiveProxyConfigurationBasis;
  readonly proxyCredential: CredentialStatus | null;
}

interface ConnectionOnboardingTicketRecord {
  readonly kind: 'connection_onboarding';
  readonly basis: ConnectionOnboardingBasis;
  state: TicketState;
}

interface InteractiveOAuthLoginTicketRecord {
  readonly kind: 'interactive_oauth_login';
  readonly attemptId: string;
  readonly target: InteractiveOAuthLoginTarget;
  readonly connectionBefore: ConnectionCatalogEntry | null;
  readonly connectionAfter: ConnectionCatalogEntry & {
    readonly providerType: InteractiveOAuthLoginProvider;
  };
  readonly credentialBasis: CredentialVersionBasis | null;
  state: TicketState;
}

type OperationTicketRecord =
  | ConnectionTicketRecord
  | ConnectionOnboardingTicketRecord
  | InteractiveOAuthLoginTicketRecord;

export class RuntimePolicyCoordinator {
  private readonly lane: SerializedOperationLane<string>;
  private readonly policy = new RuntimePolicyDocumentOwner();
  private readonly catalog = new ConnectionCatalogDocumentOwner();
  private readonly vault = new CredentialVaultDocumentOwner();
  private readonly modelFacts = new ModelFactsDocumentOwner();
  private warnedModelFactsFingerprint: string | undefined;
  private readonly tickets = new WeakMap<object, OperationTicketRecord>();
  private onboardingRecoveryRequired = false;

  constructor(private readonly execute: RootExecutor) {
    this.lane = new SerializedOperationLane(execute);
  }

  recoverForWrite(): Promise<void> {
    return this.lane.run(async (root) => {
      await cleanupRuntimePolicyDocumentTemps(root);
      await this.recoverConnectionOnboarding(root);
      await readInteractiveOAuthLoginReceipts(root);
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
    return this.inLane(async (root) => policySnapshot(await this.policy.read(root)));
  }

  getCatalogSnapshot() {
    return this.inLane(async (root) => this.projectCatalogSnapshot(root));
  }

  getVaultSnapshot() {
    return this.inLane(async (root) => vaultSnapshot(await this.vault.read(root)));
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
    return this.inLane(async (root) =>
      this.projectCatalogMutation(root, await this.catalog.create(root, input)),
    );
  }

  updateConnection(input: UpdateCatalogConnectionInput) {
    return this.inLane(async (root) =>
      this.projectCatalogMutation(root, await this.catalog.update(root, input)),
    );
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
        return deepFreeze({
          kind: 'committed' as const,
          snapshot: await this.projectCatalogSnapshot(root),
        });
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
      return this.projectCatalogMutation(root, result);
    });
  }

  setDefaultTarget(input: SetDefaultConnectionTargetInput) {
    return this.inLane(async (root) =>
      this.projectCatalogMutation(root, await this.catalog.setDefaultTarget(root, input)),
    );
  }

  migrateSystemSeed(input: MigrateSystemSeedInput) {
    return this.inLane((root) => this.catalog.migrateSystemSeed(root, input));
  }

  setCredential(rawInput: SetCredentialInput) {
    return this.setCredentialWithAuthority(rawInput, 'client');
  }

  importConnectionCredential(rawInput: SetCredentialInput) {
    return this.setCredentialWithAuthority(rawInput, 'migration');
  }

  private setCredentialWithAuthority(
    rawInput: SetCredentialInput,
    authority: 'client' | 'migration',
  ) {
    return this.inLane(async (root) => {
      const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
      const { locator } = input;
      if (authority === 'migration' && locator.scope !== 'connection') {
        throw codecError(
          'invalid_credential_input',
          'Connection credential import requires a Connection credential locator',
        );
      }
      let catalog: ConnectionCatalogDocument | null = null;
      if (locator.scope === 'connection') {
        catalog = await this.catalog.read(root);
        const connection = findConnection(catalog, locator);
        if (!connection) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
        assertConnectionIsWritable(connection);
        const required = connectionCredentialLocator(
          connection.connectionId,
          PROVIDER_REGISTRY[connection.providerType].authKind,
        );
        if (locator.kind !== 'request_headers' && (!required || required.kind !== locator.kind)) {
          throw codecError(
            'invalid_credential_input',
            'Connection credential kind does not match the provider auth contract',
          );
        }
        if (
          authority === 'client' &&
          locator.kind === 'oauth_token' &&
          connection.providerType !== 'github-copilot'
        ) {
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
      // Refreshing a token is a write like any other, and this path validated
      // only the auth kind — so a retired provider whose contract still says
      // `oauth_token` could have its credential rotated. No production caller
      // reaches it today (execution resolution refuses first), which is
      // exactly why it would have stayed open.
      assertConnectionIsWritable(connection);
      if (PROVIDER_REGISTRY[connection.providerType].authKind !== 'oauth_token') {
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

  beginInteractiveOAuthLogin(
    rawInput: InteractiveOAuthLoginInput,
  ): Promise<BeginInteractiveOAuthLoginResult> {
    return this.inLane(async (root) => {
      const input = normalizeInteractiveOAuthLoginInput(rawInput);
      const receipts = await readInteractiveOAuthLoginReceipts(root);
      const receipt = findInteractiveOAuthLoginReceipt(receipts, input.attemptId);
      if (receipt) {
        return deepFreeze(
          sameInteractiveOAuthLoginTarget(receipt.target, input.target)
            ? {
                kind: 'authenticated' as const,
                target: structuredClone(receipt.target),
                connection: structuredClone(receipt.connection),
              }
            : { kind: 'attempt_conflict' as const },
        );
      }
      const catalog = await this.catalog.read(root);
      let connectionBefore: ConnectionCatalogEntry | null;
      let connectionAfter: ConnectionCatalogEntry & {
        readonly providerType: InteractiveOAuthLoginProvider;
      };
      if (input.target.kind === 'create') {
        if (catalog.connections.length >= CONNECTION_CATALOG_MAX_CONNECTIONS) {
          return deepFreeze({ kind: 'catalog_full' as const });
        }
        connectionBefore = null;
        connectionAfter = newInteractiveOAuthConnection(
          randomUUID(),
          deriveInteractiveOAuthConnectionSlug(
            input.target.providerType,
            catalog.connections.map(({ slug }) => slug),
          ),
          input.target.providerType,
        );
      } else {
        const existing = findConnection(catalog, { connectionId: input.target.connectionId });
        if (!existing) return deepFreeze({ kind: 'connection_not_found' as const });
        if (!isInteractiveOAuthLoginProvider(existing.providerType)) {
          return deepFreeze({ kind: 'provider_action_unavailable' as const });
        }
        connectionBefore = structuredClone(existing);
        connectionAfter = reenabledInteractiveOAuthConnection(
          existing as ConnectionCatalogEntry & {
            readonly providerType: InteractiveOAuthLoginProvider;
          },
        );
      }
      const connection = connectionBefore ?? connectionAfter;
      if (!isInteractiveOAuthLoginProvider(connection.providerType)) {
        return deepFreeze({ kind: 'provider_action_unavailable' as const });
      }
      const contract = deriveProviderAuthContract({
        providerType: connection.providerType,
        hasSecret: false,
      });
      if (!contract.actionAvailability.start_oauth) {
        return deepFreeze({ kind: 'provider_action_unavailable' as const });
      }
      const prepared = await this.prepareConnectionMaterial(root, connection, false);
      if (prepared.kind !== 'ready') return prepared;
      const locator = connectionCredentialLocator(connection.connectionId, 'oauth_token');
      if (!locator || locator.kind !== 'oauth_token') {
        throw codecError(
          'invalid_document',
          'OAuth login admission produced no OAuth credential locator',
        );
      }
      const existing = findCredential(await this.vault.read(root), locator);
      const ticket = this.issueInteractiveOAuthLoginTicket(
        input.attemptId,
        input.target,
        connectionBefore,
        connectionAfter,
        existing ? credentialBasis(existing) : null,
      );
      return deepFreeze({
        kind: 'ready' as const,
        ticket,
        target: structuredClone(input.target),
        identity: interactiveOAuthConnectionIdentity(connectionAfter),
        connection: structuredClone(connectionAfter),
        secretMaterial: prepared.secretMaterial.networkProxy
          ? { networkProxy: prepared.secretMaterial.networkProxy }
          : {},
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  queryInteractiveOAuthLogin(rawAttemptId: string) {
    return this.inLane(async (root) => {
      const attemptId = decodeInteractiveOAuthAttemptId(rawAttemptId, 'invalid_connection_input');
      const receipt = findInteractiveOAuthLoginReceipt(
        await readInteractiveOAuthLoginReceipts(root),
        attemptId,
      );
      return deepFreeze(
        receipt
          ? {
              kind: 'authenticated' as const,
              target: structuredClone(receipt.target),
              connection: structuredClone(receipt.connection),
            }
          : { kind: 'not_found' as const },
      );
    });
  }

  async completeInteractiveOAuthLogin(
    ticket: InteractiveOAuthLoginTicket,
    rawSecret: string,
  ): Promise<InteractiveOAuthLoginCompletionResult> {
    const claimed = this.claimInteractiveOAuthLoginTicket(ticket);
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const secret = decodeCredentialInput(() => normalizeCredentialSecret(rawSecret));
        const catalog = await this.catalog.read(root);
        const changed: Array<'connection' | 'credential'> = [];
        const preparedCatalog = this.catalog.prepareOAuthEnrollmentUpsert(
          catalog,
          claimed.connectionBefore,
          claimed.connectionAfter,
        );
        if (preparedCatalog.kind !== 'ready') {
          changed.push('connection');
        }
        const locator = {
          scope: 'connection',
          connectionId: claimed.connectionAfter.connectionId,
          kind: 'oauth_token',
        } as const;
        const vault = await this.vault.read(root);
        const actual = findCredential(vault, locator);
        if (
          claimed.credentialBasis
            ? !sameCredentialBasis(actual, claimed.credentialBasis)
            : actual !== undefined
        ) {
          changed.push('credential');
        }
        if (changed.length > 0) {
          return deepFreeze({ kind: 'superseded' as const, changed });
        }
        const intent = prepareInteractiveOAuthEnrollmentIntent({
          attemptId: claimed.attemptId,
          target: claimed.target,
          connectionBefore: claimed.connectionBefore,
          connectionAfter: claimed.connectionAfter,
          credentialBasis: claimed.credentialBasis,
          secret,
        });
        try {
          await writeConnectionOnboardingIntent(root, intent);
        } catch (error) {
          if (isCommitOutcomeUnknown(error)) this.onboardingRecoveryRequired = true;
          throw error;
        }
        try {
          const result = await this.applyInteractiveOAuthEnrollment(root, intent);
          await clearConnectionOnboardingIntent(root);
          this.onboardingRecoveryRequired = false;
          return deepFreeze({ kind: 'committed' as const, ...result });
        } catch (error) {
          this.onboardingRecoveryRequired = true;
          if (isCommitOutcomeUnknown(error)) throw error;
          throw commitOutcomeUnknown(
            'OAuth enrollment has a durable intent and must recover before retrying',
            error,
          );
        }
      }),
    );
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

  resolveExecutionConnection(
    rawRef: ExecutionConnectionRef,
  ): Promise<ResolveExecutionConnectionResult> {
    return this.inLane(async (root) => {
      const ref = decodeConnectionInput(() => {
        if (rawRef.kind === 'bound') {
          return {
            kind: rawRef.kind,
            connectionId: decodeRuntimePolicyEntityId(rawRef.connectionId),
            connectionSlug: decodeConnectionSlug(rawRef.connectionSlug),
          } as const;
        }
        if (rawRef.kind === 'catalog_slug') {
          return {
            kind: rawRef.kind,
            connectionSlug: decodeConnectionSlug(rawRef.connectionSlug),
          } as const;
        }
        throw new Error('Invalid execution Connection reference kind');
      });
      const catalog = await this.catalog.read(root);
      const connection =
        ref.kind === 'bound'
          ? catalog.connections.find((candidate) => candidate.connectionId === ref.connectionId)
          : catalog.connections.find((candidate) => candidate.slug === ref.connectionSlug);
      if (!connection) return deepFreeze({ kind: 'not_found' as const });
      if (ref.kind === 'bound' && connection.slug !== ref.connectionSlug) {
        return deepFreeze({ kind: 'identity_mismatch' as const });
      }
      if (!connection.enabled) return deepFreeze({ kind: 'disabled' as const });
      // Ahead of the credential material: a retired connection keeps its stored
      // token, so `requiresSecret` is satisfied and every later check passes.
      // Answering `ready` here is what let Bot, CLI and scheduled-task session
      // creation persist a session that could only fail once a backend was
      // built for it.
      if (isRetiredProvider(connection.providerType)) {
        return deepFreeze({ kind: 'provider_retired' as const });
      }

      const prepared = await this.prepareConnectionMaterial(
        root,
        connection,
        providerAuthRequiresSecret(connection.providerType),
      );
      if (prepared.kind !== 'ready') return prepared;
      return deepFreeze({
        kind: 'ready' as const,
        connection: applyModelFactOverridesToConnection(
          structuredClone(connection),
          (await this.readModelFacts(root)).document.overrides,
        ),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  exportCredentialMaterial(
    rawLocator: CredentialLocator,
  ): Promise<RuntimePolicyCredentialMaterial | null> {
    return this.inLane(async (root) => {
      const locator = decodeCredentialInput(() => decodeCredentialLocator(rawLocator));
      if (locator.scope === 'connection') {
        const catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) return null;
      }
      const credential = findCredential(await this.vault.read(root), locator);
      return credential ? credentialMaterial(credential) : null;
    });
  }

  getConnectionRequestHeaders(rawConnectionId: string): Promise<SavedRequestHeaders | null> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const catalog = await this.catalog.read(root);
      if (!findConnection(catalog, { connectionId })) return null;
      const locator = connectionRequestHeadersLocator(connectionId);
      const credential = findCredential(await this.vault.read(root), locator);
      const headers = credential ? parseRequestHeaders(credential.secret) : {};
      return deepFreeze({ names: Object.keys(headers) });
    });
  }

  replaceConnectionRequestHeaders(
    rawConnectionId: string,
    rawUpdates: readonly RequestHeaderUpdate[],
  ): Promise<ReplaceConnectionRequestHeadersResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const updates = decodeRequestHeaderUpdates(rawUpdates);
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, { connectionId });
      if (!connection) {
        return deepFreeze({ kind: 'connection_not_found' as const });
      }
      assertConnectionIsWritable(connection);

      const locator = connectionRequestHeadersLocator(connectionId);
      const vault = await this.vault.read(root);
      const existing = findCredential(vault, locator);
      const savedHeaders = existing ? parseRequestHeaders(existing.secret) : {};
      const savedByName = new Map(
        Object.entries(savedHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const merged = Object.fromEntries(
        updates.map(({ name, value }) => {
          const retained = value ?? savedByName.get(name.toLowerCase());
          if (retained === undefined) {
            throw codecError('invalid_credential_input', `Request header ${name} requires a value`);
          }
          return [name, retained];
        }),
      );
      const headers = decodeRequestHeaders(merged);
      const names = Object.keys(headers);

      if (names.length === 0) {
        if (!existing) return deepFreeze({ kind: 'unchanged' as const, names });
        const prepared = this.vault.prepareDelete(vault, { expected: credentialBasis(existing) });
        if (prepared.kind !== 'ready') {
          throw codecError('invalid_document', 'Request header credential changed within its lane');
        }
        const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
        try {
          await this.vault.commitDelete(root, prepared);
        } catch (error) {
          if (cleared) {
            throw commitOutcomeUnknown(
              'Connection verification was cleared before request headers were deleted',
              error,
            );
          }
          throw error;
        }
        return deepFreeze({ kind: 'committed' as const, names });
      }

      const secret = serializeRequestHeaders(headers);
      if (existing?.secret === secret) {
        return deepFreeze({ kind: 'unchanged' as const, names });
      }
      const prepared = this.vault.prepareSet(vault, {
        locator,
        expected: existing
          ? { credentialId: existing.credentialId, revision: existing.revision }
          : null,
        secret,
      });
      if (prepared.kind !== 'ready') {
        throw codecError('invalid_document', 'Request header credential changed within its lane');
      }
      const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
      try {
        await this.vault.commitSet(root, prepared);
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before request headers were updated',
            error,
          );
        }
        throw error;
      }
      return deepFreeze({ kind: 'committed' as const, names });
    });
  }

  resolveWebSearchExecution(
    input: ResolveWebSearchExecutionInput = {},
  ): Promise<ResolveWebSearchExecutionResult> {
    return this.inLane(async (root) => {
      const policy = (await this.policy.read(root)).policy;
      if (!input.bypassFeatureGate && policy.privacy.incognitoActive) {
        return deepFreeze({ kind: 'privacy_mode' as const });
      }

      const provider = input.provider ?? policy.webSearch.defaultProvider;
      if (!input.bypassFeatureGate && !policy.webSearch.enabled) {
        return deepFreeze({ kind: 'disabled' as const, provider });
      }

      if (provider === 'model') {
        return deepFreeze({ kind: 'model_native_only' as const, provider });
      }

      const vault = await this.vault.read(root);
      const locator = { scope: 'web_search', provider, kind: 'api_key' } as const;
      const webSearchCredential = findCredential(vault, locator);
      const secretOverride =
        input.secretOverride === undefined
          ? undefined
          : decodeCredentialInput(() => normalizeCredentialSecret(input.secretOverride));
      if (!webSearchCredential && secretOverride === undefined) {
        return deepFreeze({
          kind: 'credential_not_configured' as const,
          status: credentialStatus(vault, locator),
        });
      }

      const proxyLocator = requiresNetworkProxyCredential(policy.networkProxy)
        ? networkProxyCredentialLocator()
        : null;
      let proxyCredential: RuntimePolicyCredentialMaterial | undefined;
      if (proxyLocator) {
        const entry = findCredential(vault, proxyLocator);
        if (!entry) {
          return deepFreeze({
            kind: 'credential_not_configured' as const,
            status: credentialStatus(vault, proxyLocator),
          });
        }
        proxyCredential = credentialMaterial(entry);
      }

      return deepFreeze({
        kind: 'ready' as const,
        provider,
        secretMaterial: {
          webSearch:
            secretOverride === undefined
              ? credentialMaterial(webSearchCredential!)
              : {
                  locator,
                  credentialId: 'ephemeral-web-search-override',
                  revision: 0,
                  secret: secretOverride,
                },
          ...(proxyCredential ? { networkProxy: proxyCredential } : {}),
        },
        networkProxy: structuredClone(policy.networkProxy),
      });
    });
  }

  resolveNetworkProxyExecution(
    input: ResolveNetworkProxyExecutionInput = {},
  ): Promise<ResolveNetworkProxyExecutionResult> {
    return this.inLane(async (root) => {
      const networkProxy =
        input.networkProxy ?? structuredClone((await this.policy.read(root)).policy.networkProxy);
      if (!requiresNetworkProxyCredential(networkProxy)) {
        return deepFreeze({
          kind: 'ready' as const,
          networkProxy: structuredClone(networkProxy),
          secretMaterial: {},
        });
      }
      const locator = networkProxyCredentialLocator();
      const vault = await this.vault.read(root);
      const credential = findCredential(vault, locator);
      const secretOverride =
        input.secretOverride === undefined
          ? undefined
          : decodeCredentialInput(() => normalizeCredentialSecret(input.secretOverride));
      if (!credential && secretOverride === undefined) {
        return deepFreeze({
          kind: 'credential_not_configured' as const,
          status: credentialStatus(vault, locator),
        });
      }
      return deepFreeze({
        kind: 'ready' as const,
        networkProxy: structuredClone(networkProxy),
        secretMaterial: {
          networkProxy:
            secretOverride === undefined
              ? credentialMaterial(credential!)
              : {
                  locator,
                  credentialId: 'ephemeral-network-proxy-override',
                  revision: 0,
                  secret: secretOverride,
                },
        },
      });
    });
  }

  resolveHostOutboundExecution(): Promise<ResolveHostOutboundExecutionResult> {
    return this.inLane(async (root) => {
      const policy = (await this.policy.read(root)).policy;
      if (policy.privacy.incognitoActive) {
        return deepFreeze({ kind: 'privacy_mode' as const });
      }
      const proxyLocator = requiresNetworkProxyCredential(policy.networkProxy)
        ? networkProxyCredentialLocator()
        : null;
      if (!proxyLocator) {
        return deepFreeze({
          kind: 'ready' as const,
          networkProxy: structuredClone(policy.networkProxy),
          secretMaterial: {},
        });
      }
      const vault = await this.vault.read(root);
      const credential = findCredential(vault, proxyLocator);
      if (!credential) {
        return deepFreeze({
          kind: 'credential_not_configured' as const,
          status: credentialStatus(vault, proxyLocator),
        });
      }
      return deepFreeze({
        kind: 'ready' as const,
        networkProxy: structuredClone(policy.networkProxy),
        secretMaterial: { networkProxy: credentialMaterial(credential) },
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
        return deepFreeze({
          kind: 'committed' as const,
          snapshot: await this.projectCatalogSnapshot(root),
        });
      }),
    );
  }

  beginConnectionOnboarding(
    input: BeginConnectionOnboardingInput,
  ): Promise<BeginConnectionOnboardingResult> {
    return this.inLane(async (root) => {
      const catalog = await this.catalog.read(root);
      let existing: ConnectionCatalogEntry | undefined;
      let target: ConnectionOnboardingBasis['target'];
      const requestedTarget = input.target;
      if (requestedTarget.kind === 'create') {
        const providerType = decodeConnectionInput(() =>
          decodeProviderType(requestedTarget.providerType),
        );
        target = {
          kind: 'create',
          candidate: {
            connectionId: randomUUID(),
            slug: deriveConnectionSlug(
              providerType,
              catalog.connections.map((connection) => connection.slug),
            ),
            providerType,
          },
        };
      } else if (requestedTarget.kind === 'existing') {
        const connectionId = decodeConnectionInput(() =>
          decodeRuntimePolicyEntityId(requestedTarget.connectionId),
        );
        existing = findConnection(catalog, { connectionId });
        if (!existing) return deepFreeze({ kind: 'target_missing' as const });
        target = {
          kind: 'existing',
          candidate: {
            connectionId: existing.connectionId,
            slug: existing.slug,
            providerType: existing.providerType,
          },
          revision: existing.revision,
        };
      } else {
        throw codecError('invalid_connection_input', 'Unknown connection onboarding target');
      }
      const providerType = target.candidate.providerType;
      // Onboarding guards the api_key credential slot; a provider whose auth
      // never uses one has no business here (the Host gates on the same
      // predicate, this keeps the storage API honest on its own).
      if (!providerAuthSupportsApiKey(providerType)) {
        return deepFreeze({ kind: 'provider_unsupported' as const });
      }
      if (
        target.kind === 'create' &&
        catalog.connections.length >= CONNECTION_CATALOG_MAX_CONNECTIONS
      ) {
        return deepFreeze({ kind: 'catalog_full' as const });
      }
      const baseUrl =
        input.baseUrl === null
          ? null
          : (decodeConnectionInput(() =>
              normalizeCatalogConnectionBaseUrl(input.baseUrl, providerType),
            ) ?? null);
      const policy = await this.policy.read(root);
      const networkProxy = structuredClone(policy.policy.networkProxy);
      const vault = await this.vault.read(root);
      let credential: CredentialStatus | null = null;
      let storedSecret: string | null = null;
      let requestHeadersCredential: CredentialStatus | null = null;
      let requestHeadersSecret: string | null = null;
      const locator = connectionCredentialLocator(
        target.candidate.connectionId,
        PROVIDER_REGISTRY[providerType].authKind,
      );
      if (locator) {
        credential = credentialStatus(vault, locator);
        if (existing) {
          storedSecret = findCredential(vault, locator)?.secret ?? null;
        }
      }
      // Discovery must probe with the same header customization the models
      // path applies, so even absence is pinned for a new candidate.
      const headersLocator = connectionRequestHeadersLocator(target.candidate.connectionId);
      requestHeadersCredential = credentialStatus(vault, headersLocator);
      if (existing) {
        requestHeadersSecret = findCredential(vault, headersLocator)?.secret ?? null;
      }
      // The proxy discovery will run through is pinned HERE, like
      // beginModelFetch pins it — re-resolving it later would let an A→B→A
      // proxy flip commit an inventory fetched through egress this basis
      // never saw.
      const proxyLocator = requiresNetworkProxyCredential(networkProxy)
        ? networkProxyCredentialLocator()
        : null;
      const proxyCredential = proxyLocator ? credentialStatus(vault, proxyLocator) : null;
      const proxySecret = proxyLocator
        ? (findCredential(vault, proxyLocator)?.secret ?? null)
        : null;
      const ticket = Object.freeze(Object.create(null)) as object;
      this.tickets.set(ticket, {
        kind: 'connection_onboarding',
        basis: {
          target,
          baseUrl,
          credential,
          requestHeadersCredential,
          effectiveProxy: effectiveProxyConfigurationBasis(networkProxy),
          proxyCredential,
        },
        state: 'available',
      });
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ConnectionOnboardingTicket,
        candidate: structuredClone(target.candidate),
        existingConnection: existing ? structuredClone(existing) : null,
        baseUrl,
        storedSecret,
        requestHeadersSecret,
        networkProxy,
        proxySecret,
        proxyCredentialMissing: proxyLocator !== null && proxySecret === null,
      });
    });
  }

  async completeConnectionOnboarding(
    ticket: ConnectionOnboardingTicket,
    input: CommitConnectionOnboardingInput,
  ): Promise<CommitConnectionOnboardingResult> {
    const record = ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined;
    if (!record || record.kind !== 'connection_onboarding' || record.state !== 'available') {
      throw codecError(
        'invalid_connection_input',
        'Expected an authentic available connection onboarding ticket',
      );
    }
    record.state = 'in_flight';
    return this.completeClaimedTicket(record, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        // Revalidate the discovery basis under the write lane: the committed
        // inventory must describe the connection state it was discovered
        // from, not whatever a concurrent policy update left behind.
        const checked = await this.checkOnboardingBasis(root, catalog, record.basis);
        if (checked.kind !== 'unchanged') {
          if (checked.kind === 'catalog_full') {
            return deepFreeze({ kind: 'catalog_full' as const });
          }
          return deepFreeze(
            checked.kind === 'target_missing'
              ? { kind: 'target_missing' as const }
              : { kind: 'superseded' as const, changed: checked.changed },
          );
        }
        return this.commitConnectionOnboardingInLane(root, catalog, record.basis, input);
      }),
    );
  }

  private async checkOnboardingBasis(
    root: string,
    catalog: Awaited<ReturnType<ConnectionCatalogDocumentOwner['read']>>,
    basis: ConnectionOnboardingBasis,
  ): Promise<
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'target_missing' }
    | { readonly kind: 'catalog_full' }
    | { readonly kind: 'superseded'; readonly changed: ConnectionEffectChangedDomain[] }
  > {
    const changed: ConnectionEffectChangedDomain[] = [];
    // One vault read serves every credential-status compare below.
    const vault = await this.vault.read(root);
    if (basis.target.kind === 'existing') {
      const connection = findConnection(catalog, {
        connectionId: basis.target.candidate.connectionId,
      });
      // A vanished target is its own answer — "the connection is gone" beats
      // "the connection changed" — while a survived one is compared by
      // revision, which covers every catalog-visible property, endpoint
      // included.
      if (!connection) return { kind: 'target_missing' };
      if (
        connection.revision !== basis.target.revision ||
        connection.slug !== basis.target.candidate.slug ||
        connection.providerType !== basis.target.candidate.providerType
      ) {
        changed.push('connection');
      } else if (
        basis.credential &&
        !sameCredentialStatus(credentialStatus(vault, basis.credential.locator), basis.credential)
      ) {
        changed.push('credential');
      }
    } else if (
      catalog.connections.some(
        (connection) =>
          connection.connectionId === basis.target.candidate.connectionId ||
          connection.slug === basis.target.candidate.slug,
      )
    ) {
      changed.push('connection');
    } else if (catalog.connections.length >= CONNECTION_CATALOG_MAX_CONNECTIONS) {
      return { kind: 'catalog_full' };
    }
    if (
      basis.requestHeadersCredential &&
      // The probe went out with these custom headers; a rotation since means
      // the inventory no longer describes what the connection would fetch.
      !sameCredentialStatus(
        credentialStatus(vault, basis.requestHeadersCredential.locator),
        basis.requestHeadersCredential,
      ) &&
      !changed.includes('credential')
    ) {
      changed.push('credential');
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
    if (
      basis.proxyCredential &&
      !sameCredentialStatus(
        credentialStatus(vault, basis.proxyCredential.locator),
        basis.proxyCredential,
      ) &&
      !changed.includes('credential')
    ) {
      changed.push('credential');
    }
    return changed.length > 0 ? { kind: 'superseded', changed } : { kind: 'unchanged' };
  }

  private async commitConnectionOnboardingInLane(
    root: string,
    catalog: Awaited<ReturnType<ConnectionCatalogDocumentOwner['read']>>,
    basis: ConnectionOnboardingBasis,
    input: CommitConnectionOnboardingInput,
  ): Promise<CommitConnectionOnboardingResult> {
    const candidate = basis.target.candidate;
    const existing =
      basis.target.kind === 'existing'
        ? findConnection(catalog, { connectionId: candidate.connectionId })
        : undefined;
    const connectionId = candidate.connectionId;
    let invalidateLastTest = false;
    if (input.suppliedSecret !== null) {
      const locator = {
        scope: 'connection',
        connectionId,
        kind: 'api_key',
      } as const;
      const vault = await this.vault.read(root);
      const credential = findCredential(vault, locator);
      if (credential?.secret !== input.suppliedSecret) {
        invalidateLastTest = true;
        const prepared = this.vault.prepareSet(vault, {
          locator,
          expected: credential
            ? { credentialId: credential.credentialId, revision: credential.revision }
            : null,
          secret: input.suppliedSecret,
        });
        if (prepared.kind !== 'ready') {
          throw codecError(
            'invalid_document',
            `Onboarding credential preflight returned ${prepared.kind}`,
          );
        }
      }
    }
    const intent = prepareConnectionOnboardingIntent({
      ...input,
      connectionId,
      slug: candidate.slug,
      providerType: candidate.providerType,
      baseUrl: basis.baseUrl,
      invalidateLastTest,
    });
    const catalogPreflight = this.catalog.prepareOnboardingUpsert(
      catalog,
      intent.connectionId,
      intent.slug,
      intent.providerType,
      intent.baseUrl,
      intent.enabledModelIds,
      intent.discovery,
      intent.invalidateLastTest,
    );
    if (catalogPreflight.kind === 'slug_conflict') {
      return deepFreeze({ kind: 'superseded' as const, changed: ['connection'] as const });
    }
    if (catalogPreflight.kind === 'catalog_full') {
      return deepFreeze({ kind: 'catalog_full' as const });
    }
    try {
      await writeConnectionOnboardingIntent(root, intent);
    } catch (error) {
      if (isCommitOutcomeUnknown(error)) this.onboardingRecoveryRequired = true;
      throw error;
    }
    try {
      const result = await this.applyConnectionOnboarding(root, intent);
      await clearConnectionOnboardingIntent(root);
      this.onboardingRecoveryRequired = false;
      return deepFreeze({ kind: 'committed' as const, ...result });
    } catch (error) {
      this.onboardingRecoveryRequired = true;
      if (isCommitOutcomeUnknown(error)) throw error;
      throw commitOutcomeUnknown(
        'Connection onboarding has a durable intent and must recover before retrying',
        error,
      );
    }
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
      const facts = await this.readModelFacts(root);
      const projectedConnection = applyModelFactOverridesToConnection(
        structuredClone(prepared.connection),
        facts.document.overrides,
      );
      const modelId =
        rawModelId === null
          ? null
          : decodeConnectionInput(() => decodeConnectionModelId(rawModelId));
      if (modelId !== null && !isCanonicalConnectionTestModel(projectedConnection, modelId)) {
        throw codecError(
          'invalid_connection_input',
          'Connection test model is not in the canonical model set',
        );
      }
      const ticket = this.issueTicket(
        'connection_test',
        connectionTestSemanticBasis(
          prepared,
          this.modelFacts.fingerprintForConnection(facts.document, prepared.connection),
        ),
      );
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ConnectionTestTicket,
        connection: projectedConnection,
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
        if (claimed.basis.kind !== 'connection_test') {
          throw new Error('Coordinator admitted a non-connection-test ticket');
        }
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
          claimed.basis.modelFactsFingerprint,
        );
        return deepFreeze({
          kind: 'committed' as const,
          snapshot: await this.projectCatalogSnapshot(root),
        });
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
      hasSecret: true,
    });
    if (!contract.actionAvailability[action]) {
      return deepFreeze({ kind: 'provider_action_unavailable' as const });
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
    const authKind = PROVIDER_REGISTRY[connection.providerType].authKind;
    const locator = connectionCredentialLocator(connection.connectionId, authKind);
    const policy = await this.policy.read(root);
    const networkProxy = structuredClone(policy.policy.networkProxy);
    const proxyLocator = requiresNetworkProxyCredential(networkProxy)
      ? networkProxyCredentialLocator()
      : null;
    const requestHeadersLocator = connectionRequestHeadersLocator(connection.connectionId);
    let connectionCredentialStatus: CredentialStatus | null = null;
    let proxyCredentialStatus: CredentialStatus | null = null;
    const vault = await this.vault.read(root);
    const requestHeadersCredentialStatus = credentialStatus(vault, requestHeadersLocator);
    const secretMaterial: {
      connection?: RuntimePolicyCredentialMaterial;
      requestHeaders?: RuntimePolicyCredentialMaterial;
      networkProxy?: RuntimePolicyCredentialMaterial;
    } = {};

    const requestHeaders = findCredential(vault, requestHeadersLocator);
    if (requestHeaders) secretMaterial.requestHeaders = credentialMaterial(requestHeaders);
    if (locator || proxyLocator) {
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
      requestHeadersCredentialStatus,
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
    if (locator.kind === 'request_headers') return true;
    const required = connectionCredentialLocator(
      connection.connectionId,
      PROVIDER_REGISTRY[connection.providerType].authKind,
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
    const facts = basis.kind === 'connection_test' ? await this.readModelFacts(root) : undefined;
    if (
      basis.kind === 'connection_test' &&
      (!connection ||
        this.modelFacts.fingerprintForConnection(facts!.document, connection) !==
          basis.modelFactsFingerprint)
    ) {
      changed.push('connection');
    }
    const effectiveConnection =
      connection && basis.kind === 'connection_test'
        ? applyModelFactOverridesToConnection(connection, facts!.document.overrides)
        : connection;
    if (
      !effectiveConnection ||
      effectiveConnection.providerType !== basis.providerType ||
      !effectiveConnection.enabled ||
      canonicalEffectiveEndpoint(effectiveConnection) !== basis.effectiveEndpoint ||
      (basis.kind === 'model_fetch' &&
        !sameStringArray(effectiveConnection.enabledModelIds, basis.enabledModelIds)) ||
      (basis.kind === 'connection_test' &&
        JSON.stringify(effectiveConnection.requestBodyOverlay ?? {}) !==
          basis.requestBodyOverlayJson) ||
      (basis.kind === 'connection_test' &&
        !sameConnectionTestModelBasis(connectionTestModelBasis(connection!), basis.model))
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

    if (basis.credential || basis.requestHeadersCredential || basis.proxyCredential) {
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
      const requestHeadersCredentialChanged = !sameCredentialStatus(
        credentialStatus(vault, basis.requestHeadersCredential.locator),
        basis.requestHeadersCredential,
      );
      if (
        connectionCredentialChanged ||
        requestHeadersCredentialChanged ||
        proxyCredentialChanged
      ) {
        changed.push('credential');
      }
    }
    return { connection, changed };
  }

  private issueTicket(kind: ConnectionTicketKind, basis: SemanticConnectionBasis): object {
    const ticket = Object.freeze(Object.create(null)) as object;
    this.tickets.set(ticket, { kind, basis, state: 'available' });
    return ticket;
  }

  private issueInteractiveOAuthLoginTicket(
    attemptId: string,
    target: InteractiveOAuthLoginTarget,
    connectionBefore: ConnectionCatalogEntry | null,
    connectionAfter: ConnectionCatalogEntry & {
      readonly providerType: InteractiveOAuthLoginProvider;
    },
    credentialBasisValue: CredentialVersionBasis | null,
  ): InteractiveOAuthLoginTicket {
    const ticket = Object.freeze(Object.create(null)) as object;
    this.tickets.set(ticket, {
      kind: 'interactive_oauth_login',
      attemptId,
      target: structuredClone(target),
      connectionBefore: connectionBefore ? structuredClone(connectionBefore) : null,
      connectionAfter: structuredClone(connectionAfter),
      credentialBasis: credentialBasisValue,
      state: 'available',
    });
    return ticket as InteractiveOAuthLoginTicket;
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

  private claimInteractiveOAuthLoginTicket(
    ticket: InteractiveOAuthLoginTicket,
  ): InteractiveOAuthLoginTicketRecord {
    const record = ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined;
    if (!record || record.kind !== 'interactive_oauth_login' || record.state !== 'available') {
      throw codecError(
        'invalid_credential_input',
        'Expected an authentic available interactive OAuth login ticket',
      );
    }
    record.state = 'in_flight';
    return record;
  }

  private async completeClaimedTicket<T>(
    ticket: OperationTicketRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } finally {
      ticket.state = 'consumed';
    }
  }

  private async recoverConnectionOnboarding(root: string): Promise<void> {
    const intent = await readConnectionOnboardingIntent(root);
    if (!intent) {
      this.onboardingRecoveryRequired = false;
      return;
    }
    this.onboardingRecoveryRequired = true;
    try {
      if (intent.schemaVersion === 3) {
        await this.applyInteractiveOAuthEnrollment(root, intent);
      } else {
        await this.applyConnectionOnboarding(root, intent);
      }
      await clearConnectionOnboardingIntent(root);
      this.onboardingRecoveryRequired = false;
    } catch (error) {
      if (isObsoleteConnectionOnboardingIntent(error)) {
        await clearConnectionOnboardingIntent(root);
        this.onboardingRecoveryRequired = false;
        return;
      }
      if (isCommitOutcomeUnknown(error)) throw error;
      throw commitOutcomeUnknown('Connection onboarding recovery did not converge', error);
    }
  }

  private async applyInteractiveOAuthEnrollment(
    root: string,
    intent: InteractiveOAuthEnrollmentIntent,
  ): Promise<{
    readonly credentialId: string;
    readonly revision: number;
    readonly connection: ReturnType<typeof interactiveOAuthConnectionIdentity>;
  }> {
    const existingReceipt = findInteractiveOAuthLoginReceipt(
      await readInteractiveOAuthLoginReceipts(root),
      intent.attemptId,
    );
    const intendedIdentity = interactiveOAuthConnectionIdentity(intent.connectionAfter);
    if (
      existingReceipt &&
      (!sameInteractiveOAuthLoginTarget(existingReceipt.target, intent.target) ||
        existingReceipt.connection.connectionId !== intendedIdentity.connectionId ||
        existingReceipt.connection.slug !== intendedIdentity.slug ||
        existingReceipt.connection.providerType !== intendedIdentity.providerType)
    ) {
      throw codecError(
        'invalid_document',
        'OAuth login receipt conflicts with the enrollment intent',
      );
    }
    const catalog = await this.catalog.read(root);
    // Validate the complete catalog transition before the vault-first write.
    // A damaged intent must never rotate a real account and discover its
    // identity collision only afterwards.
    const catalogPrepared = this.catalog.prepareOAuthEnrollmentUpsert(
      catalog,
      intent.connectionBefore,
      intent.connectionAfter,
    );
    if (catalogPrepared.kind !== 'ready') {
      throw codecError(
        'invalid_document',
        `OAuth enrollment catalog preflight returned ${catalogPrepared.kind}`,
      );
    }
    const locator = {
      scope: 'connection',
      connectionId: intent.connectionAfter.connectionId,
      kind: 'oauth_token',
    } as const;
    const vault = await this.vault.read(root);
    let credential = findCredential(vault, locator);
    if (credential?.secret !== intent.secret) {
      if (
        intent.credentialBasis
          ? !sameCredentialBasis(credential, intent.credentialBasis)
          : credential !== undefined
      ) {
        throw codecError('invalid_document', 'OAuth enrollment credential basis changed');
      }
      const prepared = this.vault.prepareSet(vault, {
        locator,
        expected: intent.credentialBasis
          ? {
              credentialId: intent.credentialBasis.credentialId,
              revision: intent.credentialBasis.revision,
            }
          : null,
        secret: intent.secret,
      });
      if (prepared.kind !== 'ready') {
        throw codecError(
          'invalid_document',
          `OAuth enrollment credential write returned ${prepared.kind}`,
        );
      }
      await this.vault.commitSet(root, prepared);
      credential = prepared.entry;
    }
    if (!credential) {
      throw codecError('invalid_document', 'OAuth enrollment did not produce a credential');
    }
    await this.catalog.commitPreparedOnboarding(root, catalogPrepared);
    const connection = intendedIdentity;
    await upsertInteractiveOAuthLoginReceipt(root, {
      attemptId: intent.attemptId,
      target: intent.target,
      connection,
    });
    return {
      credentialId: credential.credentialId,
      revision: credential.revision,
      connection,
    };
  }

  private async applyConnectionOnboarding(
    root: string,
    intent: ConnectionOnboardingIntent,
  ): Promise<{
    readonly snapshot: ConnectionCatalogSnapshot;
    readonly changed: boolean;
    readonly connection: Pick<
      ConnectionCatalogEntry,
      'connectionId' | 'slug' | 'providerType' | 'revision'
    >;
  }> {
    let changed = false;
    const catalog = await this.catalog.read(root);
    const existingConnection = findConnection(catalog, { connectionId: intent.connectionId });
    const slug =
      intent.slug ?? existingConnection?.slug ?? deriveConnectionSlug(intent.providerType);
    // Validate the durable identity and final catalog shape before touching
    // the vault. A damaged v2 intent must not rotate a real connection's
    // credential before discovering that its ID/slug pair cannot commit.
    const prepared = this.catalog.prepareOnboardingUpsert(
      catalog,
      intent.connectionId,
      slug,
      intent.providerType,
      intent.baseUrl,
      intent.enabledModelIds,
      intent.discovery,
      intent.invalidateLastTest,
    );
    if (prepared.kind === 'slug_conflict') {
      throw codecError(
        'invalid_document',
        intent.schemaVersion === 1
          ? 'Legacy onboarding intent conflicts with the connection id'
          : 'Onboarding intent conflicts with the connection slug',
      );
    }
    if (prepared.kind === 'catalog_full') {
      throw codecError('invalid_document', 'Onboarding intent exceeds the connection catalog');
    }
    if (intent.suppliedSecret !== null) {
      const locator = {
        scope: 'connection',
        connectionId: intent.connectionId,
        kind: 'api_key',
      } as const;
      const vault = await this.vault.read(root);
      const existing = findCredential(vault, locator);
      if (existing?.secret !== intent.suppliedSecret) {
        const prepared = this.vault.prepareSet(vault, {
          locator,
          expected: existing
            ? { credentialId: existing.credentialId, revision: existing.revision }
            : null,
          secret: intent.suppliedSecret,
        });
        if (prepared.kind !== 'ready') {
          throw codecError(
            'invalid_document',
            `Onboarding credential write returned ${prepared.kind}`,
          );
        }
        await this.vault.commitSet(root, prepared);
        changed = true;
      }
    }

    const snapshot = await this.catalog.commitPreparedOnboarding(root, prepared);
    const connection = snapshot.connections.find(
      (candidate) => candidate.connectionId === intent.connectionId,
    );
    if (!connection)
      throw codecError('invalid_document', 'Onboarding commit omitted its connection');
    return {
      snapshot,
      changed: changed || prepared.changed,
      connection: {
        connectionId: connection.connectionId,
        slug: connection.slug,
        providerType: connection.providerType,
        revision: connection.revision,
      },
    };
  }

  private inLane<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return this.lane.run(async (root) => {
      if (this.onboardingRecoveryRequired) await this.recoverConnectionOnboarding(root);
      return operation(root);
    });
  }

  private async projectCatalogSnapshot(root: string): Promise<ConnectionCatalogSnapshot> {
    const facts = await this.readModelFacts(root);
    const snapshot = catalogSnapshot(await this.catalog.read(root));
    return deepFreeze(
      hideStaleModelFactsVerification(
        applyModelFactOverridesToCatalogSnapshot(snapshot, facts.document.overrides),
        snapshot,
        facts.document,
        this.modelFacts,
      ),
    );
  }

  private async readModelFacts(root: string) {
    const facts = await this.modelFacts.readWithDiagnostics(root);
    if (facts.diagnostic !== undefined && this.warnedModelFactsFingerprint !== facts.fingerprint) {
      process.emitWarning(`model-facts.json is ${facts.diagnostic}; ignoring its overrides`, {
        type: 'RuntimePolicyWarning',
      });
      this.warnedModelFactsFingerprint = facts.fingerprint;
    }
    return facts;
  }

  private async projectCatalogMutation<T extends { readonly kind: string }>(
    root: string,
    result: T,
  ): Promise<T> {
    if (result.kind !== 'committed' || !('snapshot' in result)) return result;
    return deepFreeze({
      ...result,
      snapshot: await this.projectCatalogSnapshot(root),
    }) as T;
  }
}

function hideStaleModelFactsVerification(
  projected: ConnectionCatalogSnapshot,
  persisted: ConnectionCatalogSnapshot,
  document: ModelFactsDocument,
  owner: ModelFactsDocumentOwner,
): ConnectionCatalogSnapshot {
  const persistedById = new Map(
    persisted.connections.map((connection) => [connection.connectionId, connection] as const),
  );
  return {
    ...projected,
    connections: projected.connections.map((connection) => {
      if (connection.lastTest === undefined) return connection;
      const raw = persistedById.get(connection.connectionId);
      if (!raw) return connection;
      const current = owner.fingerprintForConnection(document, raw);
      const emptyFactsFingerprint = owner.fingerprintForConnection(
        { ...document, overrides: {} },
        raw,
      );
      // Catalogs written before model facts existed have no marker. They remain
      // valid until facts for this connection actually exist; every test
      // recorded by this feature carries a connection-scoped marker and is
      // checked exactly.
      if (
        raw.lastTestModelFactsFingerprint === current ||
        (raw.lastTestModelFactsFingerprint === undefined && current === emptyFactsFingerprint)
      ) {
        return connection;
      }
      const {
        lastTest: _lastTest,
        lastTestModelFactsFingerprint: _lastTestModelFactsFingerprint,
        ...withoutLastTest
      } = connection;
      return withoutLastTest;
    }),
  };
}

function isCommitOutcomeUnknown(error: unknown): error is RuntimePolicyStoreError {
  return error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown';
}

function isObsoleteConnectionOnboardingIntent(error: unknown): boolean {
  return (
    error instanceof RuntimePolicyStoreError &&
    error.code === 'invalid_document' &&
    error.message === 'Legacy onboarding intent conflicts with the connection id'
  );
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
    requestHeadersCredential: prepared.requestHeadersCredentialStatus,
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
  modelFactsFingerprint: string,
): Extract<SemanticConnectionBasis, { readonly kind: 'connection_test' }> {
  return {
    kind: 'connection_test',
    ...commonSemanticConnectionBasis(prepared),
    requestBodyOverlayJson: JSON.stringify(prepared.connection.requestBodyOverlay ?? {}),
    model: connectionTestModelBasis(prepared.connection),
    modelFactsFingerprint,
  };
}

function isCanonicalConnectionTestModel(
  connection: ConnectionCatalogEntry,
  modelId: string,
): boolean {
  const basis = connectionTestModelBasis(connection);
  // Either source admits: testing a discovered model before enabling it is the
  // point of the button, and the user's own selection is authorization no
  // catalog overrules (#1584).
  return (
    basis.models.some((model) => model.id === modelId) || basis.enabledModelIds.includes(modelId)
  );
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

function decodeRequestHeaderUpdates(value: unknown): readonly RequestHeaderUpdate[] {
  try {
    return normalizeRequestHeaderUpdates(value);
  } catch (error) {
    if (error instanceof RequestCustomizationValidationError) {
      throw codecError('invalid_credential_input', error.message);
    }
    throw error;
  }
}

function decodeRequestHeaders(value: unknown): Readonly<Record<string, string>> {
  try {
    return normalizeRequestHeaders(value);
  } catch (error) {
    if (error instanceof RequestCustomizationValidationError) {
      throw codecError('invalid_credential_input', error.message);
    }
    throw error;
  }
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

/**
 * A retired provider's connection is a tombstone: it may be decoded, queried
 * and deleted, and nothing else. Every write a connection owns funnels through
 * here rather than growing its own guard — the catalog update, the credential
 * vault, and the request-header replacement are siblings, and guarding them one
 * at a time is what left the last two open.
 */
function assertConnectionIsWritable(connection: { readonly providerType: ProviderType }): void {
  if (isRetiredProvider(connection.providerType)) {
    throw codecError(
      'invalid_connection_input',
      `"${connection.providerType}" is retired; its connections can only be read or deleted`,
    );
  }
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

function isInteractiveOAuthLoginProvider(
  providerType: ProviderType,
): providerType is InteractiveOAuthLoginProvider {
  return providerType === 'openai-codex' || providerType === 'xai-oauth';
}

function normalizeInteractiveOAuthLoginInput(
  input: InteractiveOAuthLoginInput,
): InteractiveOAuthLoginInput {
  const attemptId = decodeInteractiveOAuthAttemptId(input?.attemptId, 'invalid_connection_input');
  const target = input?.target;
  if (target?.kind === 'create') {
    const providerType = decodeConnectionInput(() => decodeProviderType(target.providerType));
    if (!isInteractiveOAuthLoginProvider(providerType)) {
      throw codecError('invalid_connection_input', 'OAuth create target provider is unsupported');
    }
    return { attemptId, target: { kind: 'create', providerType } };
  }
  if (target?.kind === 'existing') {
    return {
      attemptId,
      target: {
        kind: 'existing',
        connectionId: decodeConnectionInput(() => decodeRuntimePolicyEntityId(target.connectionId)),
      },
    };
  }
  throw codecError('invalid_connection_input', 'Unknown interactive OAuth login target');
}

function newInteractiveOAuthConnection(
  connectionId: string,
  slug: string,
  providerType: InteractiveOAuthLoginProvider,
): ConnectionCatalogEntry & { readonly providerType: InteractiveOAuthLoginProvider } {
  const defaults = PROVIDER_REGISTRY[providerType];
  return {
    connectionId,
    revision: 1,
    slug,
    name: defaults.label,
    providerType,
    enabled: true,
    enabledModelIds: providerFallbackModelIds(defaults),
    models: [],
  };
}

function reenabledInteractiveOAuthConnection(
  connection: ConnectionCatalogEntry & { readonly providerType: InteractiveOAuthLoginProvider },
): ConnectionCatalogEntry & { readonly providerType: InteractiveOAuthLoginProvider } {
  if (connection.enabled && connection.lastTest === undefined) return structuredClone(connection);
  const { lastTest: _lastTest, ...withoutLastTest } = connection;
  return {
    ...withoutLastTest,
    revision: nextRevision(connection.revision),
    enabled: true,
  };
}

function interactiveOAuthConnectionIdentity(
  connection: ConnectionCatalogEntry & { readonly providerType: InteractiveOAuthLoginProvider },
) {
  return {
    connectionId: connection.connectionId,
    slug: connection.slug,
    providerType: connection.providerType,
  } as const;
}

function decodeInteractiveOAuthAttemptId(
  value: unknown,
  source: 'invalid_connection_input' | 'invalid_document',
): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw codecError(source, 'OAuth attempt id is invalid');
  }
  return value;
}
