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

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
  waitForRuntimeHostReady,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { type LocalHostDeploymentAuthorityOptions } from '@maka/runtime-host/operator';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  prepareRuntimeHostNpmGlobalStagedDeployment,
  reconcilePreparedRuntimeHostNpmGlobalDeployment,
} from './runtime-host-local-handoff.js';
import {
  resolveRuntimeHostNpmGlobalInstallation,
  type RuntimeHostNpmGlobalInstallation,
} from './runtime-host-cli-installation.js';
import type { RuntimeHostUpdateCandidate } from './runtime-host-registry-update.js';
import {
  assertRuntimeHostArchiveExpansionBudget,
  withVerifiedRuntimeHostUpdateArchive,
} from './runtime-host-update-package.js';
import {
  launchRuntimeHostTargetActivator,
  type RuntimeHostTargetActivation,
  type RuntimeHostTargetActivationInput,
} from './runtime-host-local-target-activation.js';

const NPM_TIMEOUT_MS = 5 * 60_000;
const NPM_OUTPUT_MAX_BYTES = 64 * 1024;
const OFFLINE_REGISTRY = 'http://127.0.0.1:9/';

interface RuntimeHostInstalledUpdateCoordinatorDeps {
  readonly resolveInstallation: typeof resolveRuntimeHostNpmGlobalInstallation;
  readonly resolveRoot: typeof resolveStorageRoot;
  readonly connectExisting: typeof connectExistingRuntimeHost;
  readonly waitForReady: typeof waitForRuntimeHostReady;
  readonly prepareRetirement: typeof prepareConnectedRuntimeHostRetirement;
  readonly withArchive: typeof withVerifiedRuntimeHostUpdateArchive;
  readonly prepareStaged: typeof prepareRuntimeHostNpmGlobalStagedDeployment;
  readonly reconcile: typeof reconcilePreparedRuntimeHostNpmGlobalDeployment;
  readonly activateTarget: (
    input: RuntimeHostTargetActivationInput,
  ) => Promise<RuntimeHostTargetActivation>;
  readonly installArchive: typeof installRuntimeHostNpmGlobalArchive;
}

export interface RuntimeHostInstalledUpdateCoordinatorInput {
  readonly rootPath: string;
  readonly archivePath: string;
  readonly installedPackageRoot: string;
  readonly installedCliPath: string;
  readonly currentVersion: string;
  readonly target: RuntimeHostUpdateCandidate;
  readonly allowInterruptActiveTasks: boolean;
}

export async function runRuntimeHostInstalledUpdateCoordinator(
  input: RuntimeHostInstalledUpdateCoordinatorInput,
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
  overrides: Partial<RuntimeHostInstalledUpdateCoordinatorDeps> = {},
): Promise<number> {
  const deps: RuntimeHostInstalledUpdateCoordinatorDeps = {
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    resolveRoot: resolveStorageRoot,
    connectExisting: connectExistingRuntimeHost,
    waitForReady: waitForRuntimeHostReady,
    prepareRetirement: prepareConnectedRuntimeHostRetirement,
    withArchive: withVerifiedRuntimeHostUpdateArchive,
    prepareStaged: prepareRuntimeHostNpmGlobalStagedDeployment,
    reconcile: reconcilePreparedRuntimeHostNpmGlobalDeployment,
    activateTarget: launchRuntimeHostTargetActivator,
    installArchive: installRuntimeHostNpmGlobalArchive,
    ...overrides,
  };
  const installationOptions = {
    manifestUrl: pathToFileURL(join(input.installedPackageRoot, 'package.json')),
    cliPath: input.installedCliPath,
  };
  const installation = await deps.resolveInstallation(installationOptions);
  if (installation.observedRelease.version !== input.currentVersion) {
    throw new Error(
      `The installed Maka release changed from ${input.currentVersion} to ${installation.observedRelease.version} before update coordination`,
    );
  }
  const root = await deps.resolveRoot({ path: input.rootPath, kind: 'interactive' });
  const transactionId = updateTransactionId(root.rootId, installation, input.target);

  return deps.withArchive(input.target, input.archivePath, async ({ packageRoot, archivePath }) => {
    const staged = await deps.prepareStaged({
      rootId: root.rootId,
      owner: installation.owner,
      target: input.target,
      transactionId,
      sourcePackageRoot: packageRoot,
    });
    const preliminary = await observeCurrentHost(input.rootPath, root.rootId, deps);
    if (preliminary.registration && preliminary.registration.lifecycleMode !== 'ephemeral') {
      throw new Error('Only an ephemeral local Runtime Host can be updated by this CLI');
    }
    await preliminary.connection?.close();
    let observation: Awaited<ReturnType<typeof observeCurrentHost>> = {};
    let targetReady = false;
    let targetActivator: RuntimeHostTargetActivation | undefined;
    const activateExactTarget = async (
      inheritableAuthorityLeaseFd: number,
      takeoverHostEpoch?: string,
    ): Promise<'target_present' | 'active_work' | 'operator_required'> => {
      const activated = await deps.activateTarget({
        rootPath: input.rootPath,
        rootId: root.rootId,
        staged,
        ownerInstallationId: installation.owner.installationId,
        target: input.target,
        inheritableAuthorityLeaseFd,
        ...(takeoverHostEpoch ? { takeoverHostEpoch } : {}),
      });
      if (activated.kind === 'operator_required') return 'operator_required';
      if (activated.kind === 'active_work') return 'active_work';
      targetActivator = activated;
      targetReady = true;
      return 'target_present';
    };
    const prepare = async (inheritableAuthorityLeaseFd: number) => {
      observation = await observeCurrentHost(input.rootPath, root.rootId, deps);
      if (observation.registration && observation.registration.lifecycleMode !== 'ephemeral') {
        throw new Error('Only an ephemeral local Runtime Host can be updated by this CLI');
      }
      // Crash-retry after activation: the observed Host may already be this
      // transaction's staged target (the generation is derived from the
      // transaction id, so a retry stages the same one). Retiring it would
      // either kill the live target or, when it holds active work, drive the
      // handoff's active-work rollback that re-selects the retired Host while
      // the target keeps running — durable record and reality would diverge.
      if (observation.registration?.generation === staged.launchGeneration) {
        if (!observation.connection) {
          throw new Error('The exact staged Runtime Host is not connected for Ready verification');
        }
        try {
          await deps.waitForReady(observation.connection);
        } finally {
          await observation.connection.close();
        }
        observation = { registration: observation.registration };
        const activated = await activateExactTarget(inheritableAuthorityLeaseFd);
        if (activated === 'operator_required') {
          throw new Error('The observed Runtime Host requires its operator to perform the update');
        }
        if (activated === 'active_work') return { kind: 'active_work' as const };
        return { kind: 'target_present' as const };
      }
      const takeoverHostEpoch = observation.registration?.hostEpoch;
      if (observation.connection) {
        const retirement = await deps.prepareRetirement(
          observation.connection,
          input.allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
        );
        if (retirement.kind === 'active_tasks') return { kind: 'active_work' as const };
        await observation.connection.close();
        observation = { registration: observation.registration };
      }
      const activated = await activateExactTarget(inheritableAuthorityLeaseFd, takeoverHostEpoch);
      if (activated === 'operator_required') {
        throw new Error('The observed Runtime Host requires its operator to perform the update');
      }
      if (activated === 'active_work') return { kind: 'active_work' as const };
      return { kind: 'target_present' as const };
    };
    const unreachable = async (): Promise<never> => {
      throw new Error('The exact target activator must settle local Host cutover');
    };
    let result: Awaited<ReturnType<typeof deps.reconcile>> | undefined;
    try {
      result = await deps.reconcile(
        {
          rootId: root.rootId,
          transactionId,
          target: input.target,
          activeWorkPolicy: input.allowInterruptActiveTasks
            ? 'interrupt_active_work'
            : 'refuse_active_work',
          installation,
          staged,
        },
        {
          prepareUnownedHostCutover: (_rootId, _target, _staged, _policy, leaseFd) =>
            prepare(leaseFd),
          prepareHostCutover: (_rootId, _selected, _target, _staged, _policy, leaseFd) =>
            prepare(leaseFd),
          observeWriterRelease: unreachable,
          activateTarget: unreachable,
          async verifyTargetReady() {
            if (!targetReady) throw new Error('The exact target Ready evidence is unavailable');
          },
          async finalizeTarget(_rootId, _target, _staged, inheritableAuthorityLeaseFd) {
            await finalizeInstalledPackage(
              input,
              installation,
              archivePath,
              installationOptions,
              deps,
              inheritableAuthorityLeaseFd,
            );
          },
        },
        authorityOptions,
      );
    } finally {
      if (targetActivator) {
        const settlement = targetActivator.settle();
        if (result?.kind === 'completed') await settlement;
        else await settlement.catch(() => undefined);
      }
    }
    if (!result) throw new Error('The installed update transaction produced no result');
    if (result.kind === 'completed') {
      process.stdout.write(`Updated Maka to ${input.target.version}.\n`);
      return 0;
    }
    if (result.kind === 'active_work') {
      process.stderr.write(
        input.allowInterruptActiveTasks
          ? 'The local Runtime Host still owns work that this release cannot safely interrupt. Retry with a compatible CLI, or wait for it to become idle.\n'
          : 'The local Runtime Host still owns active or durable work. Retry later, or explicitly allow interruption.\n',
      );
      return 2;
    }
    if (result.kind === 'rejected') {
      process.stderr.write(`The local Runtime Host update was rejected: ${result.reason}.\n`);
      return 2;
    }
    process.stderr.write(`The local Runtime Host update requires recovery at ${result.phase}.\n`);
    return 1;
  });
}

async function observeCurrentHost(
  rootPath: string,
  rootId: string,
  deps: Pick<RuntimeHostInstalledUpdateCoordinatorDeps, 'connectExisting'>,
): Promise<{ connection?: RuntimeHostConnection; registration?: HostRegistration }> {
  const result = await deps.connectExisting({
    rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    clientInstanceId: randomUUID(),
  });
  if (result.registration && result.registration.rootId !== rootId) {
    throw new Error('The local Runtime Host State Root changed before update');
  }
  if (result.kind === 'connected') {
    return { connection: result.connection, registration: result.registration };
  }
  return result.registration ? { registration: result.registration } : {};
}

async function finalizeInstalledPackage(
  input: RuntimeHostInstalledUpdateCoordinatorInput,
  before: RuntimeHostNpmGlobalInstallation,
  archivePath: string,
  installationOptions: Parameters<typeof resolveRuntimeHostNpmGlobalInstallation>[0],
  deps: Pick<RuntimeHostInstalledUpdateCoordinatorDeps, 'resolveInstallation' | 'installArchive'>,
  inheritableAuthorityLeaseFd: number,
): Promise<void> {
  if (before.observedRelease.version !== input.target.version) {
    await deps.installArchive(archivePath, inheritableAuthorityLeaseFd);
  }
  const installed = await deps.resolveInstallation(installationOptions);
  if (
    installed.owner.installationId !== before.owner.installationId ||
    installed.observedRelease.version !== input.target.version
  ) {
    throw new Error(
      'npm did not install the exact selected Maka release into the same global slot',
    );
  }
}

export async function installRuntimeHostNpmGlobalArchive(
  archivePath: string,
  inheritableAuthorityLeaseFd: number,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  // The final global switch extracts the same verified archive a second time;
  // apply the expansion budget here as well so the bound holds no matter
  // which caller reached this function.
  await assertRuntimeHostArchiveExpansionBudget(archivePath);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'npm',
      [
        'install',
        '--global',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--offline',
        '--cache',
        join(dirname(archivePath), 'install-cache'),
        '--registry',
        OFFLINE_REGISTRY,
        archivePath,
      ],
      {
        cwd: homedir(),
        stdio: ['ignore', 'pipe', 'pipe', inheritableAuthorityLeaseFd],
        timeout: NPM_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    let outputBytes = 0;
    const observe = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > NPM_OUTPUT_MAX_BYTES) child.kill('SIGKILL');
    };
    child.stdout?.on('data', observe);
    child.stderr?.on('data', observe);
    child.once('error', reject);
    child.once('close', (code) => {
      if (outputBytes > NPM_OUTPUT_MAX_BYTES) {
        reject(new Error('npm returned too much output while installing Maka'));
      } else if (code !== 0) {
        reject(new Error('npm could not install the selected Maka release'));
      } else resolve();
    });
  });
}

function updateTransactionId(
  rootId: string,
  installation: RuntimeHostNpmGlobalInstallation,
  target: RuntimeHostUpdateCandidate,
): string {
  return `npm-global-update:${createHash('sha256')
    .update(rootId)
    .update('\0')
    .update(installation.owner.installationId)
    .update('\0')
    .update(target.version)
    .update('\0')
    .update(target.integrity)
    .digest('hex')}`;
}
