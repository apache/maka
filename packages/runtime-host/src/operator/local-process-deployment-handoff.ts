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

export type LocalHostHandoffActiveWorkPolicy = 'refuse_active_work' | 'interrupt_active_work';

export interface LocalHostProcessDeploymentHandoffRequest {
  readonly rootId: string;
  readonly expectedRevision: string;
  readonly transactionId: string;
  readonly from: RuntimeHostInstallationOwner;
  readonly to: RuntimeHostInstallationOwner;
  readonly target: RuntimeHostDeploymentIdentity;
  readonly activeWorkPolicy: LocalHostHandoffActiveWorkPolicy;
}

export interface LocalHostProcessDeploymentHandoffAdapter<StagedTarget> {
  /**
   * Stages and verifies the exact runnable closure without changing Host authority.
   * A retry must reconstruct the same transaction-scoped launch fence in the staged handle.
   */
  stageTarget(target: RuntimeHostDeploymentIdentity, transactionId: string): Promise<StagedTarget>;
  /**
   * Re-observes the actual local Host and retires it only when it is the previous deployment.
   * `target_present` means the exact transaction-scoped staged target is already running.
   * Source-specific supervisors must be quiesced before cutover. `active_work` guarantees that
   * retirement did not begin and the previous deployment remains runnable, so restoring it is safe.
   */
  prepareHostCutover(
    rootId: string,
    selected: RuntimeHostDeploymentIdentity,
    target: RuntimeHostDeploymentIdentity,
    staged: StagedTarget,
    policy: LocalHostHandoffActiveWorkPolicy,
  ): Promise<{
    readonly kind: 'target_absent' | 'target_present' | 'active_work';
  }>;
  /** Resolves only after the State Root writer fence proves that the old writer is gone. */
  observeWriterRelease(rootId: string): Promise<void>;
  /** Starts the already staged target without selecting it in durable authority yet. */
  activateTarget(rootId: string, staged: StagedTarget): Promise<void>;
  /** Verifies Ready, root identity, and the exact deployment selected by the request. */
  verifyTargetReady(
    rootId: string,
    target: RuntimeHostDeploymentIdentity,
    staged: StagedTarget,
  ): Promise<void>;
}

export type LocalHostProcessDeploymentHandoffPhase =
  | 'prepare_host_cutover'
  | 'observe_writer_release'
  | 'activate_target'
  | 'verify_target_ready'
  | 'commit_handoff'
  | 'rollback_active_work';

export type LocalHostProcessDeploymentHandoffResult =
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
      readonly phase: LocalHostProcessDeploymentHandoffPhase;
      readonly record: LocalHostDeploymentRecord;
      readonly cause: unknown;
    };

/**
 * Hands one local-process deployment slot to an exact target. The installation
 * owner may stay the same or change. Staging is deliberately outside the
 * authority lock; all operations after durable handoff intent remain serialized
 * until commit or a safe active-work rollback.
 */
export async function handoffLocalHostProcessDeployment<StagedTarget>(
  request: LocalHostProcessDeploymentHandoffRequest,
  adapter: LocalHostProcessDeploymentHandoffAdapter<StagedTarget>,
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
): Promise<LocalHostProcessDeploymentHandoffResult> {
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
            kind: 'commit_handoff',
            expectedRevision: request.expectedRevision,
            transactionId: request.transactionId,
            to: request.to,
            target: request.target,
          });
          if (confirmed.kind === 'rejected' || !confirmed.record) {
            return recoveryRequired(
              'commit_handoff',
              current,
              new Error('Committed local Host handoff durability could not be confirmed'),
            );
          }
          return { kind: 'completed', record: confirmed.record };
        } catch (cause) {
          return recoveryRequired('commit_handoff', current, cause);
        }
      }

      let begun: Awaited<ReturnType<typeof authority.apply>>;
      const beginTransition = {
        kind: 'begin_handoff',
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
      const handoffRecord = begun.record;
      if (!handoffRecord || handoffRecord.state.kind !== 'handoff') {
        throw new Error('Local Host deployment handoff did not persist its intent');
      }

      let host: Awaited<ReturnType<typeof adapter.prepareHostCutover>>;
      try {
        host = await adapter.prepareHostCutover(
          request.rootId,
          handoffRecord.state.selected,
          request.target,
          staged,
          request.activeWorkPolicy,
        );
      } catch (cause) {
        return recoveryRequired('prepare_host_cutover', handoffRecord, cause);
      }
      if (host.kind === 'active_work') {
        try {
          const rolledBack = await authority.apply({
            kind: 'rollback_handoff',
            expectedRevision: handoffRecord.revision,
            transactionId: request.transactionId,
            from: request.from,
            selected: handoffRecord.state.selected,
          });
          if (rolledBack.kind === 'rejected' || !rolledBack.record) {
            return recoveryRequired(
              'rollback_active_work',
              handoffRecord,
              new Error('Active-work rollback was rejected'),
            );
          }
          return { kind: 'active_work', record: rolledBack.record };
        } catch (cause) {
          return recoveryRequired('rollback_active_work', handoffRecord, cause);
        }
      }

      if (host.kind !== 'target_present') {
        const writerRelease = await runPhase('observe_writer_release', handoffRecord, () =>
          adapter.observeWriterRelease(request.rootId),
        );
        if (writerRelease) return writerRelease;
        const activation = await runPhase('activate_target', handoffRecord, () =>
          adapter.activateTarget(request.rootId, staged),
        );
        if (activation) return activation;
      }
      const verification = await runPhase('verify_target_ready', handoffRecord, () =>
        adapter.verifyTargetReady(request.rootId, request.target, staged),
      );
      if (verification) return verification;

      let committed: Awaited<ReturnType<typeof authority.apply>>;
      const commitTransition = {
        kind: 'commit_handoff',
        expectedRevision: handoffRecord.revision,
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
          return recoveryRequired('commit_handoff', handoffRecord, cause);
        }
      }
      if (committed.kind === 'rejected' || !committed.record) {
        return recoveryRequired(
          'commit_handoff',
          handoffRecord,
          new Error('Verified local Host deployment handoff could not be committed'),
        );
      }
      return { kind: 'completed', record: committed.record };
    },
    authorityOptions,
  );
}

async function runPhase(
  phase: Exclude<
    LocalHostProcessDeploymentHandoffPhase,
    'prepare_host_cutover' | 'commit_handoff' | 'rollback_active_work'
  >,
  record: LocalHostDeploymentRecord,
  operation: () => Promise<void>,
): Promise<
  Extract<LocalHostProcessDeploymentHandoffResult, { kind: 'recovery_required' }> | undefined
> {
  try {
    await operation();
    return undefined;
  } catch (cause) {
    return recoveryRequired(phase, record, cause);
  }
}

function recoveryRequired(
  phase: LocalHostProcessDeploymentHandoffPhase,
  record: LocalHostDeploymentRecord,
  cause: unknown,
): Extract<LocalHostProcessDeploymentHandoffResult, { kind: 'recovery_required' }> {
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
