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
import { join } from 'node:path';
import {
  resolveExistingStorageRoot,
  tryAcquireStateRootOwner,
  type StateRootOwner,
} from '@maka/storage/root-authority';
import {
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import {
  beginRuntimeHostManagedDeploymentTransition,
  blockRuntimeHostManagedDeploymentTransition,
  commitRuntimeHostManagedDeploymentTransition,
  decodeRuntimeHostManagedDeploymentConfig,
  resolveRuntimeHostNpmDeploymentLayout,
  rollbackRuntimeHostManagedDeploymentTransition,
  RuntimeHostManagedDeploymentError,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentBlocked,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostManagedDeploymentTransition,
  type RuntimeHostManagedDeploymentTransitionOperation,
  type RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import type {
  RuntimeHostLifecycleProvider,
  RuntimeHostProviderDefinition,
} from './runtime-host-lifecycle-provider.js';

export interface RuntimeHostLifecycleTransactionDeps {
  readonly resolveProvider: (
    provider: RuntimeHostSupervisorProvider,
  ) => RuntimeHostLifecycleProvider;
  /** Legacy migration keeps the validated old config until commit as its deterministic receipt. */
  readonly uninstallLegacy?: () => Promise<void>;
  readonly restoreLegacy?: (
    transition: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  ) => Promise<void>;
}

export interface RuntimeHostLifecycleTransitionInput {
  readonly operation: RuntimeHostManagedDeploymentTransitionOperation;
  readonly current?: RuntimeHostManagedDeploymentConfig;
  readonly desired?: RuntimeHostManagedDeploymentConfig;
  readonly transactionId?: string;
}

export class RuntimeHostLifecycleTransactionError extends Error {
  constructor(
    readonly code: 'transition_failed' | 'recovery_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostLifecycleTransactionError';
  }
}

export type RuntimeHostLifecycleRetirement =
  | { readonly kind: 'active_tasks' }
  | { readonly kind: 'retired'; readonly owner: StateRootOwner<'interactive'> };

export type RuntimeHostLifecycleReplacement =
  | { readonly kind: 'active_tasks' }
  | {
      readonly kind: 'replaced';
      readonly config: RuntimeHostManagedDeploymentConfig;
    };

export async function retireRuntimeHostLifecycleOwner(input: {
  readonly rootPath: string;
  readonly rootId: string;
  readonly allowInterruptActiveTasks?: boolean;
  readonly supervisor?: {
    status(): Promise<{
      readonly active: boolean;
      readonly pid: number | null;
    }>;
    retire(): Promise<void>;
  };
  readonly timeoutMs?: number;
}): Promise<RuntimeHostLifecycleRetirement> {
  const capability = await resolveExistingStorageRoot({
    path: input.rootPath,
    kind: 'interactive',
    expectedRootId: input.rootId,
  });
  const idleOwner = await tryAcquireStateRootOwner(capability);
  if (idleOwner) return { kind: 'retired', owner: idleOwner };
  const connected = await connectExistingRuntimeHost({
    rootPath: capability.canonicalPath,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  if (connected.kind !== 'connected') {
    throw new RuntimeHostLifecycleTransactionError(
      'transition_failed',
      `Runtime Host cannot prepare for retirement: ${connected.kind}`,
    );
  }
  try {
    const diagnostics = await connected.connection.request('host.diagnostics.query', {});
    const supervisorStatus = await input.supervisor?.status();
    if (
      supervisorStatus &&
      (!supervisorStatus.active || supervisorStatus.pid !== diagnostics.pid)
    ) {
      throw new RuntimeHostLifecycleTransactionError(
        'transition_failed',
        'The supervisor and State Root report different Runtime Host processes',
      );
    }
    const prepared = await prepareConnectedRuntimeHostRetirement(
      connected.connection,
      input.allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (prepared.kind === 'active_tasks') return prepared;
    if (prepared.pid !== diagnostics.pid) {
      throw new RuntimeHostLifecycleTransactionError(
        'transition_failed',
        'The Runtime Host process changed while retirement was prepared',
      );
    }
    await input.supervisor?.retire();
  } finally {
    await connected.connection.close().catch(() => undefined);
  }
  const deadline = Date.now() + (input.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    const owner = await tryAcquireStateRootOwner(capability);
    if (owner) return { kind: 'retired', owner };
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new RuntimeHostLifecycleTransactionError(
    'transition_failed',
    'Runtime Host retirement did not release the State Root',
  );
}

/**
 * Replaces one active lifecycle definition and restores its semantics at a fresh revision when
 * post-commit activation fails. The deployment record remains the only recovery authority.
 */
export async function replaceRuntimeHostLifecycle(input: {
  readonly operation: Extract<
    RuntimeHostManagedDeploymentTransitionOperation,
    'lifecycle_change' | 'provider_change' | 'configure' | 'update'
  >;
  readonly current: RuntimeHostManagedDeploymentConfig;
  readonly desired: RuntimeHostManagedDeploymentConfig;
  readonly allowInterruptActiveTasks?: boolean;
  readonly deps: RuntimeHostLifecycleTransactionDeps;
  readonly prepareDesired?: () => Promise<void>;
  readonly prepareRollback?: () => Promise<void>;
}): Promise<RuntimeHostLifecycleReplacement> {
  const current = decodeRuntimeHostManagedDeploymentConfig(input.current);
  const desired = decodeRuntimeHostManagedDeploymentConfig(input.desired);
  const currentProvider = supervisedProvider(current, input.deps);
  const retirement = await retireRuntimeHostLifecycleOwner({
    rootPath: current.root.path,
    rootId: current.root.id,
    ...(currentProvider ? { supervisor: currentProvider.supervisor } : {}),
    allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
  });
  if (retirement.kind === 'active_tasks') return retirement;
  try {
    await input.prepareDesired?.();
    await applyRuntimeHostLifecycleTransition(
      retirement.owner,
      { operation: input.operation, current, desired },
      input.deps,
    );
  } finally {
    await retirement.owner.close();
  }
  try {
    await activateRuntimeHostLifecycle(desired, input.deps);
    await verifyRuntimeHostLifecycleReady(desired, input.deps);
    return { kind: 'replaced', config: desired };
  } catch (activationError) {
    const rollback: RuntimeHostManagedDeploymentConfig = {
      ...current,
      configRevision: desired.configRevision + 1,
    };
    try {
      const desiredProvider = supervisedProvider(desired, input.deps);
      const recovery = await retireRuntimeHostLifecycleOwner({
        rootPath: desired.root.path,
        rootId: desired.root.id,
        ...(desiredProvider ? { supervisor: desiredProvider.supervisor } : {}),
        allowInterruptActiveTasks: true,
      });
      if (recovery.kind === 'active_tasks') throw new Error('Recovery retirement was refused');
      try {
        await input.prepareRollback?.();
        await applyRuntimeHostLifecycleTransition(
          recovery.owner,
          { operation: input.operation, current: desired, desired: rollback },
          input.deps,
        );
      } finally {
        await recovery.owner.close();
      }
      await activateRuntimeHostLifecycle(rollback, input.deps);
      await verifyRuntimeHostLifecycleReady(rollback, input.deps);
    } catch (recoveryError) {
      throw new RuntimeHostLifecycleTransactionError(
        'recovery_failed',
        'The Runtime Host replacement failed and its previous lifecycle could not be restored',
        { cause: new AggregateError([activationError, recoveryError]) },
      );
    }
    throw new RuntimeHostLifecycleTransactionError(
      'transition_failed',
      'The Runtime Host replacement failed; its previous lifecycle was restored',
      { cause: activationError },
    );
  }
}

/**
 * Changes the only eligible lifecycle owner while the caller holds the State Root fence.
 * Provider artifacts are deterministic projections of the authority record, never a journal.
 */
export async function applyRuntimeHostLifecycleTransition(
  owner: StateRootOwner<'interactive'>,
  input: RuntimeHostLifecycleTransitionInput,
  deps: RuntimeHostLifecycleTransactionDeps,
  authorityOptions: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  const current = input.current && decodeRuntimeHostManagedDeploymentConfig(input.current);
  const desired = input.desired && decodeRuntimeHostManagedDeploymentConfig(input.desired);
  const transactionId = input.transactionId ?? randomUUID();
  if (desired?.lifecycle.mode === 'supervised') {
    await deps.resolveProvider(desired.lifecycle.provider).supervisor.preflight();
  }
  const { record } = await beginRuntimeHostManagedDeploymentTransition(
    owner,
    {
      transactionId,
      operation: input.operation,
      ...(current ? { expected: current } : {}),
      ...(desired ? { desired } : {}),
    },
    authorityOptions,
  );
  try {
    if (record.operation === 'legacy_migration') {
      if (!deps.uninstallLegacy) throw new Error('Legacy deployment removal is unavailable');
      await deps.uninstallLegacy();
    }
    await convergeLifecycleArtifacts(record.from, record.to, deps);
    await commitRuntimeHostManagedDeploymentTransition(
      owner,
      transactionId,
      desired,
      authorityOptions,
    );
    return desired;
  } catch (error) {
    if (isCommitUnknown(error)) throw error;
    try {
      await restoreTransition(record, deps);
      await rollbackRuntimeHostManagedDeploymentTransition(
        owner,
        transactionId,
        current,
        authorityOptions,
      );
    } catch (recoveryError) {
      if (isCommitUnknown(recoveryError)) throw recoveryError;
      await blockRuntimeHostManagedDeploymentTransition(
        owner,
        transactionId,
        recoveryError instanceof Error ? recoveryError.message : 'Lifecycle recovery failed',
        authorityOptions,
      ).catch(() => undefined);
      throw new RuntimeHostLifecycleTransactionError(
        'recovery_failed',
        'The Runtime Host lifecycle transition failed and requires explicit repair',
        { cause: new AggregateError([error, recoveryError]) },
      );
    }
    throw new RuntimeHostLifecycleTransactionError(
      'transition_failed',
      'The Runtime Host lifecycle transition failed; the previous owner was restored',
      { cause: error },
    );
  }
}

function isCommitUnknown(error: unknown): error is RuntimeHostManagedDeploymentError {
  return (
    error instanceof RuntimeHostManagedDeploymentError && error.code === 'deployment_commit_unknown'
  );
}

/** Rolls an interrupted transition back to its complete previous owner. */
export async function recoverRuntimeHostLifecycleTransition(
  owner: StateRootOwner<'interactive'>,
  record: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  deps: RuntimeHostLifecycleTransactionDeps,
  authorityOptions: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  try {
    await restoreTransition(record, deps);
    await rollbackRuntimeHostManagedDeploymentTransition(
      owner,
      record.transactionId,
      record.from ?? undefined,
      authorityOptions,
    );
    return record.from ?? undefined;
  } catch (error) {
    await blockRuntimeHostManagedDeploymentTransition(
      owner,
      record.transactionId,
      error instanceof Error ? error.message : 'Lifecycle recovery failed',
      authorityOptions,
    ).catch(() => undefined);
    throw new RuntimeHostLifecycleTransactionError(
      'recovery_failed',
      'The Runtime Host lifecycle transition requires explicit repair',
      { cause: error },
    );
  }
}

/** Activates only after the canonical active record has committed and the fence is released. */
export async function activateRuntimeHostLifecycle(
  config: RuntimeHostManagedDeploymentConfig,
  deps: RuntimeHostLifecycleTransactionDeps,
): Promise<void> {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  if (canonical.lifecycle.mode !== 'supervised') return;
  const provider = deps.resolveProvider(canonical.lifecycle.provider);
  await provider.supervisor.activate();
  if (canonical.reconciliation.trigger === 'scheduled') {
    await provider.reconciliationTrigger.activate();
  }
}

export async function verifyRuntimeHostLifecycleReady(
  config: RuntimeHostManagedDeploymentConfig,
  deps: RuntimeHostLifecycleTransactionDeps,
  timeoutMs = 45_000,
): Promise<void> {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  if (canonical.lifecycle.mode !== 'supervised') return;
  const provider = deps.resolveProvider(canonical.lifecycle.provider);
  const supervisorDefinition = runtimeHostSupervisorDefinition(canonical);
  await provider.supervisor.verify(supervisorDefinition);
  if (canonical.reconciliation.trigger === 'scheduled') {
    await provider.reconciliationTrigger.verify(
      runtimeHostReconciliationTriggerDefinition(canonical),
    );
    const trigger = await provider.reconciliationTrigger.status();
    if (!trigger.installed || !trigger.active) {
      throw new RuntimeHostLifecycleTransactionError(
        'transition_failed',
        'Runtime Host reconciliation scheduling is not active',
      );
    }
  }
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown = new Error('Runtime Host is not ready');
  while (Date.now() < deadline) {
    const status = await provider.supervisor.status();
    if (status.pid !== null && status.active) {
      const connected = await connectExistingRuntimeHost({
        rootPath: canonical.root.path,
        protocol: {
          min: RUNTIME_HOST_PROTOCOL_VERSION,
          max: RUNTIME_HOST_PROTOCOL_VERSION,
        },
      }).catch((error: unknown) => {
        lastFailure = error;
        return undefined;
      });
      if (connected?.kind === 'connected') {
        try {
          const diagnostics = await connected.connection.request('host.diagnostics.query', {});
          if (diagnostics.pid === status.pid && connected.connection.rootId === canonical.root.id) {
            return;
          }
          lastFailure = new Error('Runtime Host process or Root identity did not match');
        } finally {
          await connected.connection.close().catch(() => undefined);
        }
      } else if (connected) {
        lastFailure = new Error(`Runtime Host connection is ${connected.kind}`);
      }
    } else {
      lastFailure = new Error(`Runtime Host supervisor is ${status.state}`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new RuntimeHostLifecycleTransactionError(
    'transition_failed',
    `Runtime Host did not become ready: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`,
    { cause: lastFailure },
  );
}

export function runtimeHostSupervisorDefinition(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostProviderDefinition {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    canonical.deploymentRoot,
    canonical.launch.package.integrity,
  );
  return {
    command: [
      canonical.launch.nodePath,
      layout.cliPath,
      'runtime-host',
      'serve',
      '--root-id',
      canonical.root.id,
      '--deployment-id',
      canonical.deploymentId,
      '--config-revision',
      String(canonical.configRevision),
    ],
  };
}

export function runtimeHostReconciliationTriggerDefinition(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostProviderDefinition {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  return {
    command: [join(canonical.deploymentRoot, 'operator'), 'reconcile-update', '--framed'],
  };
}

async function convergeLifecycleArtifacts(
  from: RuntimeHostManagedDeploymentConfig | null,
  to: RuntimeHostManagedDeploymentConfig | null,
  deps: RuntimeHostLifecycleTransactionDeps,
): Promise<void> {
  const fromProvider = supervisedProvider(from, deps);
  const toProvider = supervisedProvider(to, deps);
  if (fromProvider && fromProvider.supervisor.provider !== toProvider?.supervisor.provider) {
    await fromProvider.reconciliationTrigger.uninstall();
    await fromProvider.supervisor.uninstall();
  }
  if (!to || !toProvider) return;
  const supervisor = runtimeHostSupervisorDefinition(to);
  await toProvider.supervisor.converge(supervisor);
  await toProvider.supervisor.verify(supervisor);
  if (to.reconciliation.trigger === 'scheduled') {
    const trigger = runtimeHostReconciliationTriggerDefinition(to);
    await toProvider.reconciliationTrigger.converge(trigger);
    await toProvider.reconciliationTrigger.verify(trigger);
  } else {
    await toProvider.reconciliationTrigger.uninstall();
  }
}

async function restoreTransition(
  record: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  deps: RuntimeHostLifecycleTransactionDeps,
): Promise<void> {
  if (record.operation === 'legacy_migration') {
    if (!deps.restoreLegacy) throw new Error('Legacy deployment recovery is unavailable');
    const desiredProvider = supervisedProvider(record.to, deps);
    if (desiredProvider) {
      await desiredProvider.reconciliationTrigger.uninstall();
      await desiredProvider.supervisor.uninstall();
    }
    await deps.restoreLegacy(record);
    return;
  }
  await convergeLifecycleArtifacts(record.to, record.from, deps);
}

function supervisedProvider(
  config: RuntimeHostManagedDeploymentConfig | null,
  deps: RuntimeHostLifecycleTransactionDeps,
): RuntimeHostLifecycleProvider | undefined {
  return config?.lifecycle.mode === 'supervised'
    ? deps.resolveProvider(config.lifecycle.provider)
    : undefined;
}
