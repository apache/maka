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
  connectOrSpawnRuntimeHost,
  createRuntimeHostCandidateLaunchBarrier,
  prepareConnectedRuntimeHostRetirement,
  runtimeHostStartupError,
  type RuntimeHostCandidateLaunchBarrier,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { readLocalHostDeploymentRecord } from '@maka/runtime-host/operator';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';

export async function runRuntimeHostInstalledUpdateActivator(
  input: {
    readonly rootPath: string;
    readonly expectedRootId: string;
    readonly generation: string;
    readonly candidateEntrypoint: string;
    readonly takeoverHostEpoch?: string;
    /** The coordinator keeps this short-lived activator alive through durable commit. */
    readonly awaitCoordinatorCommit?: boolean;
    readonly expectedOwnerInstallationId?: string;
    readonly targetVersion?: string;
    readonly targetIntegrity?: string;
    /** fd 4 inherited from the coordinator's existing authority transaction. */
    readonly inheritableAuthorityLeaseFd?: number;
  },
  overrides: {
    readonly connectOrSpawn?: typeof connectOrSpawnRuntimeHost;
    readonly createLaunchBarrier?: typeof createRuntimeHostCandidateLaunchBarrier;
    readonly awaitCoordinatorCommit?: typeof awaitCoordinatorCommit;
    readonly retireTarget?: typeof prepareConnectedRuntimeHostRetirement;
    readonly readRecord?: typeof readLocalHostDeploymentRecord;
  } = {},
): Promise<number> {
  const launchBarrier = (
    overrides.createLaunchBarrier ?? createRuntimeHostCandidateLaunchBarrier
  )();
  const result = await (overrides.connectOrSpawn ?? ((request) => launchBarrier.connect(request)))({
    rootPath: input.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    generation: input.generation,
    ...(input.takeoverHostEpoch ? { takeoverHostEpoch: input.takeoverHostEpoch } : {}),
    clientInstanceId: randomUUID(),
    candidateEntrypoint: input.candidateEntrypoint,
    ...(input.inheritableAuthorityLeaseFd === undefined
      ? {}
      : { inheritableAuthorityLeaseFd: input.inheritableAuthorityLeaseFd }),
  });
  if (result.kind === 'connected') {
    let exactTarget = false;
    let commitWaitOwnsAbort = false;
    try {
      if (
        result.registration.rootId !== input.expectedRootId ||
        result.registration.generation !== input.generation ||
        (result.spawnedProcess !== undefined &&
          result.spawnedProcess.pid !== result.registration.pid)
      ) {
        throw new Error('The activated Runtime Host does not match the exact staged target');
      }
      exactTarget = true;
      if (input.awaitCoordinatorCommit) {
        if (!input.expectedOwnerInstallationId || !input.targetVersion || !input.targetIntegrity) {
          throw new Error('The activator is missing its exact durable commit expectation');
        }
        commitWaitOwnsAbort = true;
        await (overrides.awaitCoordinatorCommit ?? awaitCoordinatorCommit)({
          registration: result.registration,
          connection: result.connection,
          expectedRootId: input.expectedRootId,
          ownerInstallationId: input.expectedOwnerInstallationId,
          targetVersion: input.targetVersion,
          targetIntegrity: input.targetIntegrity,
          ownsCandidate: result.spawnedProcess !== undefined,
          launchBarrier,
          retireTarget: overrides.retireTarget ?? prepareConnectedRuntimeHostRetirement,
          readRecord: overrides.readRecord ?? readLocalHostDeploymentRecord,
        });
      } else {
        launchBarrier.release();
      }
      return 0;
    } catch (error) {
      if (exactTarget && !commitWaitOwnsAbort) {
        await retireUncommittedTarget({
          connection: result.connection,
          ownsCandidate: result.spawnedProcess !== undefined,
          launchBarrier,
          retireTarget: overrides.retireTarget ?? prepareConnectedRuntimeHostRetirement,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      await result.connection.close().catch(() => undefined);
    }
  }
  await retireOwnedCandidates(launchBarrier).catch(() => undefined);
  if (result.kind === 'failed') {
    throw runtimeHostStartupError(result.reason, result.diagnostic);
  }
  if (result.registration.lifecycleMode !== 'ephemeral') return 4;
  return 3;
}

interface CoordinatorCommitWaitInput {
  readonly registration: { readonly pid: number };
  readonly connection: RuntimeHostConnection;
  readonly expectedRootId: string;
  readonly ownerInstallationId: string;
  readonly targetVersion: string;
  readonly targetIntegrity: string;
  readonly ownsCandidate: boolean;
  readonly launchBarrier: RuntimeHostCandidateLaunchBarrier;
  readonly retireTarget: typeof prepareConnectedRuntimeHostRetirement;
  readonly readRecord: typeof readLocalHostDeploymentRecord;
}

type UncommittedTargetInput = Pick<
  CoordinatorCommitWaitInput,
  'connection' | 'ownsCandidate' | 'launchBarrier' | 'retireTarget'
>;

/**
 * The coordinator owns the durable authority transaction, while this child
 * holds its inherited lease until that transaction commits. If the coordinator
 * disappears, read the durable record before deciding whether the target is an
 * orphan. That closes the commit-before-ack race without handing the lease to
 * the long-lived Runtime Host.
 */
async function awaitCoordinatorCommit(input: CoordinatorCommitWaitInput): Promise<void> {
  if (typeof process.send !== 'function' || !process.connected) {
    await retireUncommittedTarget(input);
    throw new Error('The installed update activator lost its coordinator channel');
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const settle = (operation: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      cleanup();
      void operation().then(resolve, reject);
    };
    const onMessage = (message: unknown) => {
      if (!isCoordinatorMessage(message)) return;
      if (message.kind === 'committed') {
        settle(async () => {
          if (!(await isCommittedTarget(input))) {
            await retireUncommittedTarget(input);
            throw new Error(
              'The target activation was acknowledged before durable ownership committed',
            );
          }
          input.launchBarrier.release();
        });
      }
      if (message.kind === 'abort') {
        settle(async () => {
          await retireUncommittedTarget(input);
          throw new Error(
            'The installed update coordinator aborted before durable ownership committed',
          );
        });
      }
    };
    const onDisconnect = () => {
      settle(async () => {
        if (await isCommittedTarget(input)) return;
        await retireUncommittedTarget(input);
        throw new Error(
          'The installed update coordinator exited before durable ownership committed',
        );
      });
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send?.({ kind: 'ready' });
  });
}

function isCoordinatorMessage(value: unknown): value is { readonly kind: 'committed' | 'abort' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind !== undefined &&
    ((value as { kind?: unknown }).kind === 'committed' ||
      (value as { kind?: unknown }).kind === 'abort')
  );
}

async function isCommittedTarget(input: CoordinatorCommitWaitInput): Promise<boolean> {
  const record = await input.readRecord(input.expectedRootId);
  return (
    record?.state.kind === 'owned' &&
    record.state.owner.kind === 'cli' &&
    record.state.owner.installationId === input.ownerInstallationId &&
    record.state.selected.kind === 'npm_registry' &&
    record.state.selected.version === input.targetVersion &&
    record.state.selected.integrity === input.targetIntegrity
  );
}

async function retireUncommittedTarget(input: UncommittedTargetInput): Promise<void> {
  if (input.ownsCandidate) {
    await retireOwnedCandidates(input.launchBarrier);
    return;
  }
  const retirement = await input.retireTarget(input.connection, 'interrupt_active_work');
  if (retirement.kind !== 'prepared') {
    throw new Error('The uncommitted Runtime Host would not accept exact retirement');
  }
}

async function retireOwnedCandidates(barrier: RuntimeHostCandidateLaunchBarrier): Promise<void> {
  barrier.pause();
  await barrier.retireExcept(-1);
}
