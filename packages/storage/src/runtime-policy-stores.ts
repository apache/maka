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
  ConnectionCatalogMutationResult,
  ConnectionCatalogSnapshot,
  CreateCatalogConnectionInput,
  CredentialLocator,
  CredentialMutationResult,
  CredentialVaultSnapshot,
  DeleteCredentialInput,
  MutateRuntimePolicyInput,
  MutateRuntimePolicyResult,
  RemoveCatalogConnectionInput,
  RuntimePolicySnapshot,
  SetCredentialInput,
  MigrateSystemSeedInput,
  SetDefaultConnectionTargetInput,
  UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { RuntimePolicyCoordinator } from './runtime-policy/coordinator.js';
import type {
  CredentialStatusQueryResult as CredentialStatusQuery,
  RuntimePolicyOperationCoordinator as OperationCoordinator,
} from './runtime-policy/operations.js';

export {
  RuntimePolicyStoreError,
  type RuntimePolicyStoreErrorCode,
} from './runtime-policy/errors.js';
export type {
  BeginConnectionTestResult,
  BeginInteractiveOAuthLoginResult,
  BeginModelFetchResult,
  CompareAndSetOAuthCredentialInput,
  CompareAndSetOAuthCredentialResult,
  ConnectionEffectChangedDomain,
  ConnectionEffectCompletionResult,
  CommitConnectionOnboardingInput,
  CommitConnectionOnboardingResult,
  ConnectionEffectPreparationFailure,
  ConnectionTestTicket,
  InteractiveOAuthLoginCompletionResult,
  InteractiveOAuthLoginProvider,
  InteractiveOAuthLoginTicket,
  CredentialStatusQueryResult,
  ModelFetchTicket,
  ProviderAuthKind,
  RuntimePolicyCredentialMaterial,
  RuntimePolicyOperationCoordinator,
  RuntimePolicyOperationSecretMaterial,
  ResolveExecutionConnectionResult,
  ReplaceConnectionRequestHeadersResult,
  ResolveNetworkProxyExecutionInput,
  ResolveNetworkProxyExecutionResult,
  ResolveWebSearchExecutionInput,
  ResolveWebSearchExecutionResult,
  ResolveWebFetchExecutionResult,
  UnavailableProviderActionAvailability,
} from './runtime-policy/operations.js';

const readerBrand: unique symbol = Symbol('RuntimePolicyStoresReader');
const writerBrand: unique symbol = Symbol('RuntimePolicyStoresWriter');
const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, RuntimePolicyStoresWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<RuntimePolicyStoresWriter>>();

export interface RuntimePolicyReader {
  getSnapshot(): Promise<RuntimePolicySnapshot>;
}

export interface RuntimePolicyWriter extends RuntimePolicyReader {
  mutate(input: MutateRuntimePolicyInput): Promise<MutateRuntimePolicyResult>;
}

export interface ConnectionCatalogReader {
  getSnapshot(): Promise<ConnectionCatalogSnapshot>;
}

export interface ConnectionCatalogWriter extends ConnectionCatalogReader {
  create(input: CreateCatalogConnectionInput): Promise<ConnectionCatalogMutationResult>;
  update(input: UpdateCatalogConnectionInput): Promise<ConnectionCatalogMutationResult>;
  remove(input: RemoveCatalogConnectionInput): Promise<ConnectionCatalogMutationResult>;
  setDefaultTarget(
    input: SetDefaultConnectionTargetInput,
  ): Promise<ConnectionCatalogMutationResult>;
  migrateSystemSeed(input: MigrateSystemSeedInput): Promise<ConnectionCatalogMutationResult>;
}

export interface CredentialVaultReader {
  getSnapshot(): Promise<CredentialVaultSnapshot>;
  getStatus(locator: CredentialLocator): Promise<CredentialStatusQuery>;
}

export interface CredentialVaultWriter extends CredentialVaultReader {
  set(input: SetCredentialInput): Promise<CredentialMutationResult>;
  delete(input: DeleteCredentialInput): Promise<CredentialMutationResult>;
}

export interface RuntimePolicyStoresReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
  readonly runtimePolicy: Readonly<RuntimePolicyReader>;
  readonly connectionCatalog: Readonly<ConnectionCatalogReader>;
  readonly credentialVault: Readonly<CredentialVaultReader>;
}

export interface RuntimePolicyStoresWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  readonly runtimePolicy: Readonly<RuntimePolicyWriter>;
  readonly connectionCatalog: Readonly<ConnectionCatalogWriter>;
  readonly credentialVault: Readonly<CredentialVaultWriter>;
  readonly operations: Readonly<OperationCoordinator>;
}

export function authenticateRuntimePolicyStoresReader(
  stores: RuntimePolicyStoresReader,
): RuntimePolicyStoresReader {
  if (!readers.has(stores)) throw invalidFacade('read');
  return stores;
}

export function authenticateRuntimePolicyStoresWriter(
  stores: RuntimePolicyStoresWriter,
): RuntimePolicyStoresWriter {
  if (!writers.has(stores)) throw invalidFacade('write');
  return stores;
}

export async function openInteractiveRuntimePolicyStoresForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<RuntimePolicyStoresReader> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const coordinator = new RuntimePolicyCoordinator(<T>(operation: (root: string) => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation),
  );
  const stores: RuntimePolicyStoresReader = {
    kind: 'interactive',
    access: 'read',
    [readerBrand]: true,
    runtimePolicy: { getSnapshot: () => coordinator.getPolicySnapshot() },
    connectionCatalog: { getSnapshot: () => coordinator.getCatalogSnapshot() },
    credentialVault: {
      getSnapshot: () => coordinator.getVaultSnapshot(),
      getStatus: (locator) => coordinator.getCredentialStatus(locator),
    },
  };
  freezeFacade(stores);
  readers.add(stores);
  return stores;
}

export async function openInteractiveRuntimePolicyStoresForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<RuntimePolicyStoresWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const coordinator = new RuntimePolicyCoordinator(<T>(operation: (root: string) => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation),
  );
  const pending = Promise.resolve().then(async () => {
    await coordinator.recoverForWrite();
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const stores = createWriterFacade(coordinator);
    writers.add(stores);
    writerByLease.set(lease, stores);
    return stores;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(coordinator: RuntimePolicyCoordinator): RuntimePolicyStoresWriter {
  const stores: RuntimePolicyStoresWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    runtimePolicy: {
      getSnapshot: () => coordinator.getPolicySnapshot(),
      mutate: (input) => coordinator.mutatePolicy(input),
    },
    connectionCatalog: {
      getSnapshot: () => coordinator.getCatalogSnapshot(),
      create: (input) => coordinator.createConnection(input),
      update: (input) => coordinator.updateConnection(input),
      remove: (input) => coordinator.removeConnection(input),
      setDefaultTarget: (input) => coordinator.setDefaultTarget(input),
      migrateSystemSeed: (input) => coordinator.migrateSystemSeed(input),
    },
    credentialVault: {
      getSnapshot: () => coordinator.getVaultSnapshot(),
      getStatus: (locator) => coordinator.getCredentialStatus(locator),
      set: (input) => coordinator.setCredential(input),
      delete: (input) => coordinator.deleteCredential(input),
    },
    operations: {
      exportCredentialMaterial: (locator) => coordinator.exportCredentialMaterial(locator),
      getConnectionRequestHeaders: (connectionId) =>
        coordinator.getConnectionRequestHeaders(connectionId),
      replaceConnectionRequestHeaders: (connectionId, updates) =>
        coordinator.replaceConnectionRequestHeaders(connectionId, updates),
      resolveExecutionConnection: (connectionSlug) =>
        coordinator.resolveExecutionConnection(connectionSlug),
      resolveWebSearchExecution: (input) => coordinator.resolveWebSearchExecution(input),
      resolveWebFetchExecution: () => coordinator.resolveWebFetchExecution(),
      resolveNetworkProxyExecution: (input) => coordinator.resolveNetworkProxyExecution(input),
      compareAndSetOAuthCredential: (input) => coordinator.compareAndSetOAuthCredential(input),
      importConnectionCredential: (input) => coordinator.importConnectionCredential(input),
      beginInteractiveOAuthLogin: (connectionId) =>
        coordinator.beginInteractiveOAuthLogin(connectionId),
      completeInteractiveOAuthLogin: (ticket, secret) =>
        coordinator.completeInteractiveOAuthLogin(ticket, secret),
      beginModelFetch: (connectionId) => coordinator.beginModelFetch(connectionId),
      completeModelFetch: (ticket, result) => coordinator.completeModelFetch(ticket, result),
      commitConnectionOnboarding: (input) => coordinator.commitConnectionOnboarding(input),
      beginConnectionTest: (connectionId, modelId) =>
        coordinator.beginConnectionTest(connectionId, modelId),
      completeConnectionTest: (ticket, result) =>
        coordinator.completeConnectionTest(ticket, result),
    },
  };
  freezeFacade(stores);
  return stores;
}

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} runtime policy stores`,
  );
}

function freezeFacade(stores: {
  readonly runtimePolicy: object;
  readonly connectionCatalog: object;
  readonly credentialVault: object;
  readonly operations?: object;
}): void {
  Object.freeze(stores.runtimePolicy);
  Object.freeze(stores.connectionCatalog);
  Object.freeze(stores.credentialVault);
  if (stores.operations) Object.freeze(stores.operations);
  Object.freeze(stores);
}
