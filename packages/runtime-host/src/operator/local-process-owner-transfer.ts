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

import type { RuntimeHostDeploymentIdentity } from './update-package-evidence.js';
import {
  withLocalHostDeploymentAuthority,
  type LocalHostDeploymentAuthorityOptions,
  type LocalHostDeploymentRecord,
  type LocalHostDeploymentTransitionRejection,
  type RuntimeHostInstallationOwner,
} from './local-deployment-owner.js';

export type LocalHostTransferActiveWorkPolicy = 'refuse_active_work' | 'interrupt_active_work';

export interface LocalHostProcessOwnerTransferRequest {
  readonly rootId: string;
  readonly expectedRevision: string;
  readonly transactionId: string;
  readonly from: RuntimeHostInstallationOwner;
  readonly to: RuntimeHostInstallationOwner;
  readonly target: RuntimeHostDeploymentIdentity;
  readonly activeWorkPolicy: LocalHostTransferActiveWorkPolicy;
}

export interface LocalHostProcessOwnerTransferAdapter<StagedTarget> {
  /**
   * Stages and verifies the exact runnable closure without changing Host authority.
   * A retry must reconstruct the same transaction-scoped launch fence in the staged handle.
   */
  stageTarget(target: RuntimeHostDeploymentIdentity, transactionId: string): Promise<StagedTarget>;
  /**
   * Re-observes the actual local Host and retires it only when it is the previous deployment.
   * `target_present` means the exact transaction-scoped staged target is already running.
   * Source-specific supervisors must be quiesced before cutover. `active_work` guarantees that
   * retirement did not begin and the previous owner remains runnable, so restoring it is safe.
   */
  prepareHostCutover(
    rootId: string,
    selected: RuntimeHostDeploymentIdentity,
    target: RuntimeHostDeploymentIdentity,
    staged: StagedTarget,
    policy: LocalHostTransferActiveWorkPolicy,
  ): Promise<{
    readonly kind: 'target_absent' | 'target_present' | 'active_work';
  }>;
  /** Resolves only after the State Root writer fence proves that the old writer is gone. */
  observeWriterRelease(rootId: string): Promise<void>;
  /** Starts the already staged target without selecting it as durable owner yet. */
  activateTarget(rootId: string, staged: StagedTarget): Promise<void>;
  /** Verifies Ready, root identity, and the exact deployment selected by the request. */
  verifyTargetReady(
    rootId: string,
    target: RuntimeHostDeploymentIdentity,
    staged: StagedTarget,
  ): Promise<void>;
}

export type LocalHostProcessOwnerTransferPhase =
  | 'prepare_host_cutover'
  | 'observe_writer_release'
  | 'activate_target'
  | 'verify_target_ready'
  | 'commit_owner'
  | 'rollback_active_work';

export type LocalHostProcessOwnerTransferResult =
  | {
      readonly kind: 'completed';
      readonly record: LocalHostDeploymentRecord;
    }
  | {
      readonly kind: 'active_work';
      readonly record: LocalHostDeploymentRecord;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: LocalHostDeploymentTransitionRejection;
      readonly record: LocalHostDeploymentRecord | undefined;
    }
  | {
      readonly kind: 'recovery_required';
      readonly phase: LocalHostProcessOwnerTransferPhase;
      readonly record: LocalHostDeploymentRecord;
      readonly cause: unknown;
    };

/**
 * Transfers one local-process deployment slot between persistent installation
 * owners. Staging is deliberately outside the authority lock; all operations
 * after durable transfer intent remain serialized until commit or a safe
 * active-work rollback.
 */
export async function transferLocalHostProcessOwner<StagedTarget>(
  request: LocalHostProcessOwnerTransferRequest,
  adapter: LocalHostProcessOwnerTransferAdapter<StagedTarget>,
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
): Promise<LocalHostProcessOwnerTransferResult> {
  const staged = await adapter.stageTarget(request.target, request.transactionId);
  return withLocalHostDeploymentAuthority(
    request.rootId,
    async (authority) => {
      const current = await authority.read();
      if (
        current?.state.kind === 'owned' &&
        sameOwner(current.state.owner, request.to) &&
        sameDeployment(current.state.selected, request.target)
      ) {
        try {
          const confirmed = await authority.apply({
            kind: 'commit_transfer',
            expectedRevision: request.expectedRevision,
            transactionId: request.transactionId,
            to: request.to,
            target: request.target,
          });
          if (confirmed.kind === 'rejected' || !confirmed.record) {
            return recoveryRequired(
              'commit_owner',
              current,
              new Error('Committed local Host owner durability could not be confirmed'),
            );
          }
          return { kind: 'completed', record: confirmed.record };
        } catch (cause) {
          return recoveryRequired('commit_owner', current, cause);
        }
      }

      let begun: Awaited<ReturnType<typeof authority.apply>>;
      const beginTransition = {
        kind: 'begin_transfer',
        expectedRevision: request.expectedRevision,
        transactionId: request.transactionId,
        from: request.from,
        to: request.to,
        target: request.target,
      } as const;
      try {
        begun = await authority.apply(beginTransition);
      } catch {
        begun = await authority.apply(beginTransition);
      }
      if (begun.kind === 'rejected') return begun;
      const transferRecord = begun.record;
      if (!transferRecord || transferRecord.state.kind !== 'transferring') {
        throw new Error('Local Host owner transfer did not persist transfer intent');
      }

      let host: Awaited<ReturnType<typeof adapter.prepareHostCutover>>;
      try {
        host = await adapter.prepareHostCutover(
          request.rootId,
          transferRecord.state.selected,
          request.target,
          staged,
          request.activeWorkPolicy,
        );
      } catch (cause) {
        return recoveryRequired('prepare_host_cutover', transferRecord, cause);
      }
      if (host.kind === 'active_work') {
        try {
          const rolledBack = await authority.apply({
            kind: 'rollback_transfer',
            expectedRevision: transferRecord.revision,
            transactionId: request.transactionId,
            from: request.from,
            selected: transferRecord.state.selected,
          });
          if (rolledBack.kind === 'rejected' || !rolledBack.record) {
            return recoveryRequired(
              'rollback_active_work',
              transferRecord,
              new Error('Active-work rollback was rejected'),
            );
          }
          return { kind: 'active_work', record: rolledBack.record };
        } catch (cause) {
          return recoveryRequired('rollback_active_work', transferRecord, cause);
        }
      }

      if (host.kind !== 'target_present') {
        const writerRelease = await runPhase('observe_writer_release', transferRecord, () =>
          adapter.observeWriterRelease(request.rootId),
        );
        if (writerRelease) return writerRelease;
        const activation = await runPhase('activate_target', transferRecord, () =>
          adapter.activateTarget(request.rootId, staged),
        );
        if (activation) return activation;
      }
      const verification = await runPhase('verify_target_ready', transferRecord, () =>
        adapter.verifyTargetReady(request.rootId, request.target, staged),
      );
      if (verification) return verification;

      let committed: Awaited<ReturnType<typeof authority.apply>>;
      const commitTransition = {
        kind: 'commit_transfer',
        expectedRevision: transferRecord.revision,
        transactionId: request.transactionId,
        to: request.to,
        target: request.target,
      } as const;
      try {
        committed = await authority.apply(commitTransition);
      } catch {
        try {
          committed = await authority.apply(commitTransition);
        } catch (cause) {
          return recoveryRequired('commit_owner', transferRecord, cause);
        }
      }
      if (committed.kind === 'rejected' || !committed.record) {
        return recoveryRequired(
          'commit_owner',
          transferRecord,
          new Error('Verified local Host owner transfer could not be committed'),
        );
      }
      return { kind: 'completed', record: committed.record };
    },
    authorityOptions,
  );
}

async function runPhase(
  phase: Exclude<
    LocalHostProcessOwnerTransferPhase,
    'prepare_host_cutover' | 'commit_owner' | 'rollback_active_work'
  >,
  record: LocalHostDeploymentRecord,
  operation: () => Promise<void>,
): Promise<
  Extract<LocalHostProcessOwnerTransferResult, { kind: 'recovery_required' }> | undefined
> {
  try {
    await operation();
    return undefined;
  } catch (cause) {
    return recoveryRequired(phase, record, cause);
  }
}

function recoveryRequired(
  phase: LocalHostProcessOwnerTransferPhase,
  record: LocalHostDeploymentRecord,
  cause: unknown,
): Extract<LocalHostProcessOwnerTransferResult, { kind: 'recovery_required' }> {
  return { kind: 'recovery_required', phase, record, cause };
}

function sameOwner(
  left: RuntimeHostInstallationOwner,
  right: RuntimeHostInstallationOwner,
): boolean {
  return left.kind === right.kind && left.installationId === right.installationId;
}

function sameDeployment(
  left: RuntimeHostDeploymentIdentity,
  right: RuntimeHostDeploymentIdentity,
): boolean {
  return (
    left.kind === right.kind && left.version === right.version && left.integrity === right.integrity
  );
}
