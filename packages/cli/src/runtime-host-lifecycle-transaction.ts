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
import { isDeepStrictEqual } from 'node:util';
import {
  resolveExistingStorageRoot,
  tryAcquireStateRootOwner,
  type StateRootOwner,
} from '@maka/storage/root-authority';
import {
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
  waitForRuntimeHostReady,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import {
  beginRuntimeHostManagedDeploymentTransition,
  blockRuntimeHostManagedDeploymentTransition,
  commitRuntimeHostManagedDeploymentTransition,
  decodeRuntimeHostManagedDeploymentConfig,
  readRuntimeHostManagedDeploymentAuthorityRecord,
  resolveRuntimeHostManagedDeploymentAuthority,
  resolveRuntimeHostNpmDeploymentLayout,
  rollbackRuntimeHostManagedDeploymentTransition,
  RuntimeHostManagedDeploymentError,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentBlocked,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostManagedDeploymentTransition,
  type RuntimeHostManagedDeploymentTransitionOperation,
  type RuntimeHostManagedDeploymentTransitionRecovery,
  type RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import type {
  RuntimeHostLifecycleProvider,
  RuntimeHostProviderDefinition,
} from './runtime-host-lifecycle-provider.js';

/** The budget a managed Runtime Host has to become reachable after its lifecycle is activated. */
export const RUNTIME_HOST_READY_TIMEOUT_MS = 45_000;

export interface RuntimeHostLifecycleTransactionDeps {
  readonly resolveProvider: (
    provider: RuntimeHostSupervisorProvider,
  ) => RuntimeHostLifecycleProvider;
  readonly convergeOperator: (
    current: RuntimeHostManagedDeploymentConfig | undefined,
    desired: RuntimeHostManagedDeploymentConfig | undefined,
  ) => Promise<void>;
  readonly verifyOperator: (config: RuntimeHostManagedDeploymentConfig) => Promise<void>;
  readonly connectExisting?: typeof connectExistingRuntimeHost;
  /** Legacy migration keeps the validated old config until commit as its deterministic receipt. */
  readonly uninstallLegacy?: (
    transition: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  ) => Promise<void>;
  readonly restoreLegacy?: (
    transition: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  ) => Promise<void>;
}

export interface RuntimeHostLifecycleTransitionInput {
  readonly operation: RuntimeHostManagedDeploymentTransitionOperation;
  readonly recovery?: RuntimeHostManagedDeploymentTransitionRecovery;
  readonly current?: RuntimeHostManagedDeploymentConfig;
  readonly desired?: RuntimeHostManagedDeploymentConfig;
  readonly transactionId?: string;
}

export class RuntimeHostLifecycleTransactionError extends Error {
  constructor(
    readonly code: 'transition_failed' | 'recovery_failed' | 'owner_changed' | 'active_tasks',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostLifecycleTransactionError';
  }
}

export function canDiscardRuntimeHostLifecycleDesiredArtifacts(error: unknown): boolean {
  return !(
    isCommitUnknown(error) ||
    (error instanceof RuntimeHostLifecycleTransactionError && error.code === 'recovery_failed')
  );
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

export type RuntimeHostRecoverableDeployment =
  | { readonly kind: 'active'; readonly config: RuntimeHostManagedDeploymentConfig }
  | { readonly kind: 'absent' };

/**
 * Applies a transition after retirement and restores availability only when the fenced authority
 * proves that the exact previous owner remains canonical.
 */
export async function applyRetiredRuntimeHostLifecycleTransition(input: {
  readonly owner: StateRootOwner<'interactive'>;
  readonly operation: RuntimeHostManagedDeploymentTransitionOperation;
  readonly current?: RuntimeHostManagedDeploymentConfig;
  readonly desired?: RuntimeHostManagedDeploymentConfig;
  readonly deps: RuntimeHostLifecycleTransactionDeps;
  readonly activatePrevious?: () => Promise<void>;
  /** Final product invariant checked after Host admission is closed and before lifecycle commit. */
  readonly validateRetiredState?: () => Promise<void>;
}): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  const current = input.current
    ? decodeRuntimeHostManagedDeploymentConfig(input.current)
    : undefined;
  const desired = input.desired
    ? decodeRuntimeHostManagedDeploymentConfig(input.desired)
    : undefined;
  let result: RuntimeHostManagedDeploymentConfig | undefined;
  let transitionError: unknown;
  let previousAuthorityRestored = false;
  try {
    await input.validateRetiredState?.();
    result = await applyRuntimeHostLifecycleTransition(
      input.owner,
      {
        operation: input.operation,
        ...(current ? { current } : {}),
        ...(desired ? { desired } : {}),
      },
      input.deps,
    );
  } catch (error) {
    transitionError = error;
    try {
      const authority = await readRuntimeHostManagedDeploymentAuthorityRecord(
        input.owner.capability,
      );
      previousAuthorityRestored = current
        ? authority?.state === 'active' && isDeepStrictEqual(authority, current)
        : authority === undefined;
      if (!previousAuthorityRestored && !isCommitUnknown(error)) {
        transitionError = new RuntimeHostLifecycleTransactionError(
          'recovery_failed',
          'The Runtime Host transition failed and its lifecycle authority could not be restored',
          { cause: error },
        );
      }
    } catch (authorityError) {
      transitionError = new RuntimeHostLifecycleTransactionError(
        'recovery_failed',
        'The Runtime Host transition failed and its lifecycle authority could not be verified',
        { cause: new AggregateError([error, authorityError]) },
      );
    }
  } finally {
    await input.owner.close();
  }
  if (transitionError === undefined) return result;
  if (previousAuthorityRestored && (input.activatePrevious || current)) {
    try {
      if (input.activatePrevious) {
        await input.activatePrevious();
      } else if (current) {
        await activateRuntimeHostLifecycle(current, input.deps);
        await verifyRuntimeHostLifecycleReady(current, input.deps);
      }
    } catch (recoveryError) {
      throw new RuntimeHostLifecycleTransactionError(
        'recovery_failed',
        'The Runtime Host transition failed and its previous lifecycle could not be reactivated',
        { cause: new AggregateError([transitionError, recoveryError]) },
      );
    }
  }
  throw transitionError;
}

export async function resolveRecoverableRuntimeHostManagedDeployment(
  rootId: string,
  deps: RuntimeHostLifecycleTransactionDeps,
  options: {
    readonly retirementSupervisor?: {
      status(): Promise<{ readonly active: boolean; readonly pid: number | null }>;
      retire(): Promise<void>;
    };
    readonly activatePrevious?: () => Promise<void>;
    readonly expectedTarget?: {
      readonly serviceId: string;
      readonly rootPath: string;
      readonly rootId: string;
      readonly deploymentId?: string;
    };
    readonly expectedOwner?: { readonly hostEpoch: string; readonly pid: number };
    readonly allowInterruptActiveTasks?: boolean;
    readonly ensureAvailable?: boolean;
  } = {},
): Promise<RuntimeHostRecoverableDeployment> {
  const resolved = await resolveRuntimeHostManagedDeploymentAuthority(rootId);
  if (!resolved) return { kind: 'absent' };
  assertRecoveryTarget(options.expectedTarget, rootId, resolved.record);
  if (resolved.record.state === 'active') {
    if (options.ensureAvailable) {
      await activateRuntimeHostLifecycle(resolved.record, deps);
      await verifyRuntimeHostLifecycleReady(resolved.record, deps);
    }
    return { kind: 'active', config: resolved.record };
  }
  const previous = resolved.record.from ?? undefined;
  const previousProvider = supervisedProvider(previous ?? null, deps);
  const retirement = await retireRuntimeHostLifecycleOwner({
    rootPath: resolved.capability.canonicalPath,
    rootId,
    ...(resolved.record.operation === 'legacy_migration' && options.retirementSupervisor
      ? { supervisor: options.retirementSupervisor }
      : previousProvider
        ? { supervisor: previousProvider.supervisor }
        : {}),
    ...(options.expectedOwner ? { expectedOwner: options.expectedOwner } : {}),
    allowInterruptActiveTasks: options.allowInterruptActiveTasks ?? false,
    retireIdleSupervisor: false,
  });
  if (retirement.kind === 'active_tasks') {
    throw new RuntimeHostLifecycleTransactionError(
      'active_tasks',
      'Runtime Host lifecycle recovery is waiting for active work to finish',
    );
  }
  let recovered: RuntimeHostManagedDeploymentConfig | undefined;
  let current: RuntimeHostManagedDeploymentConfig | undefined;
  let targetError: unknown;
  try {
    const record = await readRuntimeHostManagedDeploymentAuthorityRecord(
      retirement.owner.capability,
    );
    try {
      if (record) assertRecoveryTarget(options.expectedTarget, rootId, record);
    } catch (error) {
      targetError = error;
    }
    if (record?.state === 'active') current = record;
    else if (!targetError && record) {
      recovered = await recoverRuntimeHostLifecycleTransition(retirement.owner, record, deps);
    }
  } finally {
    await retirement.owner.close();
  }
  if (current) {
    await activateRuntimeHostLifecycle(current, deps);
    await verifyRuntimeHostLifecycleReady(current, deps);
  }
  if (targetError) throw targetError;
  const active = recovered ?? current;
  if (active) {
    if (recovered) {
      await activateRuntimeHostLifecycle(active, deps);
      await verifyRuntimeHostLifecycleReady(active, deps);
    }
    return { kind: 'active', config: active };
  }
  await options.activatePrevious?.();
  return { kind: 'absent' };
}

function assertRecoveryTarget(
  expected:
    | {
        readonly serviceId: string;
        readonly rootPath: string;
        readonly rootId: string;
        readonly deploymentId?: string;
      }
    | undefined,
  rootId: string,
  record:
    | RuntimeHostManagedDeploymentConfig
    | RuntimeHostManagedDeploymentTransition
    | RuntimeHostManagedDeploymentBlocked,
): void {
  if (!expected) return;
  const endpoint = record.state === 'active' ? record : (record.from ?? record.to)!;
  if (
    expected.serviceId !== rootId ||
    expected.rootId !== rootId ||
    expected.rootPath !== endpoint.root.path ||
    (expected.deploymentId !== undefined && expected.deploymentId !== endpoint.deploymentId)
  ) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_claim_mismatch',
      'The managed Runtime Host does not match the expected deployment identity',
    );
  }
}

export async function retireRuntimeHostLifecycleOwner(input: {
  readonly rootPath: string;
  readonly rootId: string;
  readonly allowInterruptActiveTasks?: boolean;
  /**
   * Freshness fence evaluated before a canonical supervised-deployment retirement is admitted.
   * The deployment lock and provider identity remain the mutation authority after admission.
   */
  readonly expectedOwner?: { readonly hostEpoch: string; readonly pid: number };
  readonly supervisor?: {
    status(): Promise<{
      readonly active: boolean;
      readonly pid: number | null;
    }>;
    retire(): Promise<void>;
  };
  readonly timeoutMs?: number;
  readonly retireIdleSupervisor?: boolean;
}): Promise<RuntimeHostLifecycleRetirement> {
  if (input.expectedOwner && !input.supervisor) {
    throw new RuntimeHostLifecycleTransactionError(
      'owner_changed',
      'A Runtime Host identity fence requires a supervised deployment',
    );
  }
  const capability = await resolveExistingStorageRoot({
    path: input.rootPath,
    kind: 'interactive',
    expectedRootId: input.rootId,
  });
  const idleOwner = await tryAcquireStateRootOwner(capability);
  if (idleOwner) {
    try {
      if (input.expectedOwner && input.supervisor) {
        const status = await input.supervisor.status();
        assertExpectedSupervisorOwner(input.expectedOwner, status);
      }
      if (input.retireIdleSupervisor !== false) await input.supervisor?.retire();
      return { kind: 'retired', owner: idleOwner };
    } catch (error) {
      await idleOwner.close();
      throw error;
    }
  }
  const connected = await connectExistingRuntimeHost({
    rootPath: capability.canonicalPath,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  assertExpectedRuntimeHostOwner(
    input.expectedOwner,
    'registration' in connected ? connected.registration : undefined,
  );
  if (connected.kind !== 'connected') {
    if (input.supervisor) {
      const status = await input.supervisor.status();
      assertExpectedSupervisorOwner(input.expectedOwner, status);
      if (status.active && status.pid !== null) {
        if (!input.allowInterruptActiveTasks) return { kind: 'active_tasks' };
        await input.supervisor.retire();
        return waitForRuntimeHostLifecycleOwner(capability, input.timeoutMs ?? 45_000);
      }
    }
    throw new RuntimeHostLifecycleTransactionError(
      'transition_failed',
      `Runtime Host cannot prepare for retirement: ${connected.kind}`,
    );
  }
  try {
    const diagnostics = await connected.connection.request('host.diagnostics.query', {});
    const supervisorStatus = await input.supervisor?.status();
    if (supervisorStatus) assertExpectedSupervisorOwner(input.expectedOwner, supervisorStatus);
    if (
      supervisorStatus &&
      (!supervisorStatus.active || supervisorStatus.pid !== diagnostics.pid)
    ) {
      throw new RuntimeHostLifecycleTransactionError(
        'transition_failed',
        'The supervisor and State Root report different Runtime Host processes',
      );
    }
    // The exact Root owner and canonical supervisor now agree while the deployment lock is held.
    // This admits retirement of that deployment; a later same-deployment restart is not a new
    // authority, but it must not acquire the Root before the supervisor is retired.
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
    const retirement = await waitForRuntimeHostLifecycleOwner(
      capability,
      input.timeoutMs ?? 45_000,
    );
    try {
      await input.supervisor?.retire();
      return retirement;
    } catch (error) {
      await retirement.owner.close().catch(() => undefined);
      throw error;
    }
  } finally {
    await connected.connection.close().catch(() => undefined);
  }
}

function assertExpectedRuntimeHostOwner(
  expected: { readonly hostEpoch: string; readonly pid: number } | undefined,
  observed: { readonly hostEpoch: string; readonly pid: number } | undefined,
): void {
  if (!expected) return;
  if (!observed || observed.hostEpoch !== expected.hostEpoch || observed.pid !== expected.pid) {
    throw new RuntimeHostLifecycleTransactionError(
      'owner_changed',
      'The Runtime Host changed after replacement was confirmed',
    );
  }
}

function assertExpectedSupervisorOwner(
  expected: { readonly hostEpoch: string; readonly pid: number } | undefined,
  observed: { readonly active: boolean; readonly pid: number | null },
): void {
  if (!expected) return;
  if (!observed.active || observed.pid !== expected.pid) {
    throw new RuntimeHostLifecycleTransactionError(
      'owner_changed',
      'The supervised Runtime Host changed after replacement was confirmed',
    );
  }
}

async function waitForRuntimeHostLifecycleOwner(
  capability: Awaited<ReturnType<typeof resolveExistingStorageRoot>>,
  timeoutMs: number,
): Promise<Extract<RuntimeHostLifecycleRetirement, { readonly kind: 'retired' }>> {
  const deadline = Date.now() + timeoutMs;
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
  readonly operation: Exclude<RuntimeHostManagedDeploymentTransitionOperation, 'uninstall'>;
  readonly current?: RuntimeHostManagedDeploymentConfig;
  readonly desired: RuntimeHostManagedDeploymentConfig;
  readonly allowInterruptActiveTasks?: boolean;
  readonly expectedOwner?: { readonly hostEpoch: string; readonly pid: number };
  readonly deps: RuntimeHostLifecycleTransactionDeps;
  readonly retirementSupervisor?: {
    status(): Promise<{ readonly active: boolean; readonly pid: number | null }>;
    retire(): Promise<void>;
  };
  readonly activatePrevious?: () => Promise<void>;
  /** Final product invariant checked after Host admission is closed and before lifecycle commit. */
  readonly validateRetiredState?: () => Promise<void>;
  /** Product-level activation for lifecycles whose readiness is not owned by an OS supervisor. */
  readonly activateDesired?: () => Promise<void>;
}): Promise<RuntimeHostLifecycleReplacement> {
  const current = input.current
    ? decodeRuntimeHostManagedDeploymentConfig(input.current)
    : undefined;
  const desired = decodeRuntimeHostManagedDeploymentConfig(input.desired);
  const currentProvider = supervisedProvider(current ?? null, input.deps);
  if (desired.lifecycle.mode === 'supervised') {
    await input.deps.resolveProvider(desired.lifecycle.provider).supervisor.preflight();
  }
  const retirement = await retireRuntimeHostLifecycleOwner({
    rootPath: desired.root.path,
    rootId: desired.root.id,
    ...(input.retirementSupervisor
      ? { supervisor: input.retirementSupervisor }
      : currentProvider
        ? { supervisor: currentProvider.supervisor }
        : {}),
    allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
    ...(input.expectedOwner ? { expectedOwner: input.expectedOwner } : {}),
  });
  if (retirement.kind === 'active_tasks') return retirement;
  await applyRetiredRuntimeHostLifecycleTransition({
    owner: retirement.owner,
    operation: input.operation,
    ...(current ? { current } : {}),
    desired,
    deps: input.deps,
    ...(input.activatePrevious ? { activatePrevious: input.activatePrevious } : {}),
    ...(input.validateRetiredState ? { validateRetiredState: input.validateRetiredState } : {}),
  });
  try {
    if (input.activateDesired) {
      await input.activateDesired();
    } else {
      await activateRuntimeHostLifecycle(desired, input.deps);
      await verifyRuntimeHostLifecycleReady(desired, input.deps);
    }
  } catch (activationError) {
    const rollback = current
      ? ({
          ...current,
          configRevision: desired.configRevision + 1,
        } satisfies RuntimeHostManagedDeploymentConfig)
      : undefined;
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
        await applyRuntimeHostLifecycleTransition(
          recovery.owner,
          rollback
            ? {
                operation: input.operation,
                recovery: 'complete_to',
                current: desired,
                desired: rollback,
              }
            : {
                operation:
                  input.operation === 'legacy_migration' ? 'legacy_migration' : 'uninstall',
                recovery: 'complete_to',
                current: desired,
              },
          input.deps,
        );
      } finally {
        await recovery.owner.close();
      }
      if (input.activatePrevious) {
        await input.activatePrevious();
      } else if (rollback) {
        await activateRuntimeHostLifecycle(rollback, input.deps);
        await verifyRuntimeHostLifecycleReady(rollback, input.deps);
      }
    } catch (recoveryError) {
      if (isCommitUnknown(recoveryError)) throw recoveryError;
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
  return { kind: 'replaced', config: desired };
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
  const { record } = await beginRuntimeHostManagedDeploymentTransition(
    owner,
    {
      transactionId,
      operation: input.operation,
      recovery: input.recovery ?? 'restore_from',
      ...(current ? { expected: current } : {}),
      ...(desired ? { desired } : {}),
    },
    authorityOptions,
  );
  try {
    await convergeTransitionOwnership(record.from, record.to, record, deps);
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
      const recovered = await settleRuntimeHostLifecycleTransition(
        owner,
        record,
        deps,
        authorityOptions,
      );
      if (record.recovery === 'complete_to') return recovered;
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

async function settleRuntimeHostLifecycleTransition(
  owner: StateRootOwner<'interactive'>,
  record: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  deps: RuntimeHostLifecycleTransactionDeps,
  authorityOptions: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  if (record.recovery === 'complete_to') {
    await convergeTransitionOwnership(record.from, record.to, record, deps);
    await commitRuntimeHostManagedDeploymentTransition(
      owner,
      record.transactionId,
      record.to ?? undefined,
      authorityOptions,
    );
    return record.to ?? undefined;
  }
  await restoreTransition(record, deps);
  await rollbackRuntimeHostManagedDeploymentTransition(
    owner,
    record.transactionId,
    record.from ?? undefined,
    authorityOptions,
  );
  return record.from ?? undefined;
}

function isCommitUnknown(error: unknown): error is RuntimeHostManagedDeploymentError {
  return (
    error instanceof RuntimeHostManagedDeploymentError && error.code === 'deployment_commit_unknown'
  );
}

/** Settles an interrupted transition at its persisted recovery endpoint. */
export async function recoverRuntimeHostLifecycleTransition(
  owner: StateRootOwner<'interactive'>,
  expected: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  deps: RuntimeHostLifecycleTransactionDeps,
  authorityOptions: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  const record = await readRuntimeHostManagedDeploymentAuthorityRecord(
    owner.capability,
    authorityOptions,
  );
  if (!record || record.state === 'active' || record.transactionId !== expected.transactionId) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_transaction_mismatch',
      'The Runtime Host lifecycle transition changed before recovery',
    );
  }
  try {
    return await settleRuntimeHostLifecycleTransition(owner, record, deps, authorityOptions);
  } catch (error) {
    if (isCommitUnknown(error)) throw error;
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
  timeoutMs = RUNTIME_HOST_READY_TIMEOUT_MS,
): Promise<void> {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  await verifyRuntimeHostLifecycleProjection(canonical, deps);
  if (canonical.lifecycle.mode !== 'supervised') return;
  const provider = deps.resolveProvider(canonical.lifecycle.provider);
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown = new Error('Runtime Host is not ready');
  while (Date.now() < deadline) {
    const status = await provider.supervisor.status();
    if (status.pid !== null && status.active) {
      const connected = await (deps.connectExisting ?? connectExistingRuntimeHost)({
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
            await waitForRuntimeHostReady(connected.connection, Math.max(1, deadline - Date.now()));
            return;
          }
          lastFailure = new Error('Runtime Host process or Root identity did not match');
        } catch (error) {
          lastFailure = error;
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

/** Verifies the durable operator and supervisor projection without requiring a compatible Host. */
export async function verifyRuntimeHostLifecycleProjection(
  config: RuntimeHostManagedDeploymentConfig,
  deps: RuntimeHostLifecycleTransactionDeps,
): Promise<void> {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  await deps.verifyOperator(canonical);
  if (canonical.lifecycle.mode !== 'supervised') return;
  const provider = deps.resolveProvider(canonical.lifecycle.provider);
  await provider.supervisor.verify(runtimeHostSupervisorDefinition(canonical));
  if (canonical.reconciliation.trigger !== 'scheduled') return;
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
  await deps.convergeOperator(from ?? undefined, to ?? undefined);
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

async function convergeTransitionOwnership(
  from: RuntimeHostManagedDeploymentConfig | null,
  to: RuntimeHostManagedDeploymentConfig | null,
  record: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  deps: RuntimeHostLifecycleTransactionDeps,
): Promise<void> {
  if (record.operation !== 'legacy_migration') {
    await convergeLifecycleArtifacts(from, to, deps);
    return;
  }
  if (!from && to) {
    if (!deps.uninstallLegacy) throw new Error('Legacy deployment removal is unavailable');
    await deps.uninstallLegacy(record);
    await convergeLifecycleArtifacts(from, to, deps);
    return;
  }
  if (from && !to) {
    await convergeLifecycleArtifacts(from, to, deps);
    if (!deps.restoreLegacy) throw new Error('Legacy deployment recovery is unavailable');
    await deps.restoreLegacy(record);
    return;
  }
  throw new Error('Legacy lifecycle transition endpoints are invalid');
}

async function restoreTransition(
  record: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
  deps: RuntimeHostLifecycleTransactionDeps,
): Promise<void> {
  await convergeTransitionOwnership(record.to, record.from, record, deps);
}

function supervisedProvider(
  config: RuntimeHostManagedDeploymentConfig | null,
  deps: RuntimeHostLifecycleTransactionDeps,
): RuntimeHostLifecycleProvider | undefined {
  return config?.lifecycle.mode === 'supervised'
    ? deps.resolveProvider(config.lifecycle.provider)
    : undefined;
}
