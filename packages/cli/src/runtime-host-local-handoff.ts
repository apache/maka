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

import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import {
  claimLocalHostProcessDeployment,
  handoffLocalHostProcessDeployment,
  readLocalHostDeploymentRecord,
  type LocalHostDeploymentAuthorityOptions,
  type LocalHostProcessDeploymentClaimAdapter,
  type LocalHostProcessDeploymentClaimResult,
  type LocalHostProcessDeploymentHandoffAdapter,
  type LocalHostProcessDeploymentHandoffResult,
  type RuntimeHostInstallationOwner,
} from '@maka/runtime-host/operator';
import { connectOrSpawnRuntimeHost, runtimeHostStartupError } from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import { resolveRuntimeHostNpmGlobalInstallation } from './runtime-host-cli-installation.js';
import {
  prepareRuntimeHostPackageDeployment,
  type RuntimeHostPackageDeployment,
} from './runtime-host-package-deployment.js';
import {
  RuntimeHostUpdatePackageError,
  withRuntimeHostRegistryUpdatePackage,
} from './runtime-host-update-package.js';
import type { RuntimeHostUpdateCandidate } from './runtime-host-update-discovery.js';
import { resolveRuntimeHostRegistryUpdateCandidate } from './runtime-host-update-discovery.js';

const ROOT_ID = /^[a-f0-9]{64}$/u;
const CANDIDATE_RELATIVE_PATH = [
  'node_modules',
  '@maka',
  'runtime-host',
  'dist',
  'execution-candidate-main.js',
] as const;

export interface RuntimeHostLocalStagedDeployment extends RuntimeHostPackageDeployment {
  readonly candidateEntrypoint: string;
  /** Transaction-scoped launch fence, not artifact identity or owner authority. */
  readonly launchGeneration: string;
}

export class RuntimeHostLocalHandoffError extends Error {
  constructor(
    readonly code:
      | 'installed_release_mismatch'
      | 'root_changed'
      | 'selected_target_observation_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostLocalHandoffError';
  }
}

export interface RuntimeHostLocalDeploymentPathOptions {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

interface RuntimeHostLocalHandoffDeps {
  readonly resolveInstallation: typeof resolveRuntimeHostNpmGlobalInstallation;
  readonly withPackage: typeof withRuntimeHostRegistryUpdatePackage;
  readonly prepareDeployment: typeof prepareRuntimeHostPackageDeployment;
  readonly readRecord: typeof readLocalHostDeploymentRecord;
  readonly claim: typeof claimLocalHostProcessDeployment;
  readonly handoff: typeof handoffLocalHostProcessDeployment;
}

interface RuntimeHostLocalRestartDeps extends RuntimeHostLocalHandoffDeps {
  readonly resolveCandidate: typeof resolveRuntimeHostRegistryUpdateCandidate;
  readonly connectOrSpawn: typeof connectOrSpawnRuntimeHost;
}

export type RuntimeHostLocalProcessLifecycleAdapter = Omit<
  LocalHostProcessDeploymentHandoffAdapter<RuntimeHostLocalStagedDeployment>,
  'stageTarget'
> &
  Pick<
    LocalHostProcessDeploymentClaimAdapter<RuntimeHostLocalStagedDeployment>,
    'prepareUnownedHostCutover'
  >;

export interface RuntimeHostNpmGlobalReconciliationRequest {
  readonly rootId: string;
  readonly transactionId: string;
  readonly target: RuntimeHostUpdateCandidate;
  readonly activeWorkPolicy: 'refuse_active_work' | 'interrupt_active_work';
  readonly installationOptions?: Parameters<typeof resolveRuntimeHostNpmGlobalInstallation>[0];
  readonly deploymentPathOptions?: RuntimeHostLocalDeploymentPathOptions;
}

export type RuntimeHostNpmGlobalRestartResult =
  | LocalHostProcessDeploymentClaimResult
  | LocalHostProcessDeploymentHandoffResult
  | {
      readonly kind: 'operator_required';
      readonly reason: 'service_host' | 'unowned_host';
    };

/**
 * Explicitly restarts one local ephemeral Host from the exact artifact matching
 * the installed npm-global CLI. The released-Host takeover is a bounded adapter:
 * it can replace only the observed exact Host when that Host reports true idle.
 */
export async function restartRuntimeHostNpmGlobalDeployment(
  input: {
    readonly rootPath: string;
    readonly registration: HostRegistration;
    readonly installationOptions?: Parameters<typeof resolveRuntimeHostNpmGlobalInstallation>[0];
    readonly deploymentPathOptions?: RuntimeHostLocalDeploymentPathOptions;
  },
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
  overrides: Partial<RuntimeHostLocalRestartDeps> = {},
): Promise<RuntimeHostNpmGlobalRestartResult> {
  if (input.registration.lifecycleMode !== 'ephemeral') {
    return {
      kind: 'operator_required',
      reason: input.registration.lifecycleMode === 'service' ? 'service_host' : 'unowned_host',
    };
  }
  const deps: RuntimeHostLocalRestartDeps = {
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    withPackage: withRuntimeHostRegistryUpdatePackage,
    prepareDeployment: prepareRuntimeHostPackageDeployment,
    readRecord: readLocalHostDeploymentRecord,
    claim: claimLocalHostProcessDeployment,
    handoff: handoffLocalHostProcessDeployment,
    resolveCandidate: resolveRuntimeHostRegistryUpdateCandidate,
    connectOrSpawn: connectOrSpawnRuntimeHost,
    ...overrides,
  };
  const installation = await deps.resolveInstallation(input.installationOptions);
  const target = await deps.resolveCandidate({
    kind: 'exact',
    version: installation.observedRelease.version,
  });
  const current = await deps.readRecord(input.registration.rootId, authorityOptions);
  if (
    current?.state.kind === 'owned' &&
    current.state.owner.kind === installation.owner.kind &&
    current.state.owner.installationId === installation.owner.installationId &&
    current.state.selected.kind === target.kind &&
    current.state.selected.version === target.version &&
    current.state.selected.integrity === target.integrity
  ) {
    throw new RuntimeHostLocalHandoffError(
      'selected_target_observation_conflict',
      'The active Runtime Host conflicts with the deployment already committed for this installation',
    );
  }
  const transactionId = restartTransactionId(input.registration.rootId, installation.owner, target);
  let connectedTarget:
    | Extract<Awaited<ReturnType<typeof connectOrSpawnRuntimeHost>>, { kind: 'connected' }>
    | undefined;
  const prepare = async (
    rootId: string,
    staged: RuntimeHostLocalStagedDeployment,
  ): Promise<{ readonly kind: 'target_present' | 'active_work' }> => {
    if (rootId !== input.registration.rootId) {
      throw new RuntimeHostLocalHandoffError(
        'root_changed',
        'The local Runtime Host State Root changed before restart',
      );
    }
    const result = await deps.connectOrSpawn({
      rootPath: input.rootPath,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      generation: staged.launchGeneration,
      takeoverHostEpoch: input.registration.hostEpoch,
      clientInstanceId: randomUUID(),
      candidateEntrypoint: staged.candidateEntrypoint,
    });
    if (result.kind === 'connected') {
      if (
        result.registration.rootId !== rootId ||
        result.registration.generation !== staged.launchGeneration ||
        (result.spawnedProcess !== undefined &&
          result.spawnedProcess.pid !== result.registration.pid)
      ) {
        await result.connection.close().catch(() => undefined);
        throw new Error('The restarted Runtime Host does not match the exact staged process');
      }
      connectedTarget = result;
      return { kind: 'target_present' };
    }
    if (
      (result.kind === 'incompatible' || result.kind === 'upgrade_required') &&
      result.registration.hostEpoch === input.registration.hostEpoch
    ) {
      return { kind: 'active_work' };
    }
    if (result.kind === 'failed') {
      throw runtimeHostStartupError(result.reason, result.diagnostic);
    }
    throw new Error('The observed Runtime Host changed before exact local restart completed');
  };
  const unreachable = async (): Promise<never> => {
    throw new Error('Legacy local restart must converge during exact takeover');
  };
  try {
    return await reconcileRuntimeHostNpmGlobalDeployment(
      {
        rootId: input.registration.rootId,
        transactionId,
        target,
        activeWorkPolicy: 'refuse_active_work',
        ...(input.installationOptions ? { installationOptions: input.installationOptions } : {}),
        ...(input.deploymentPathOptions
          ? { deploymentPathOptions: input.deploymentPathOptions }
          : {}),
      },
      {
        prepareUnownedHostCutover: (rootId, _target, staged) => prepare(rootId, staged),
        prepareHostCutover: (rootId, _selected, _target, staged) => prepare(rootId, staged),
        observeWriterRelease: unreachable,
        activateTarget: unreachable,
        async verifyTargetReady(rootId, _target, staged) {
          if (
            connectedTarget?.registration.rootId !== rootId ||
            connectedTarget.registration.generation !== staged.launchGeneration
          ) {
            throw new Error('Exact restarted Runtime Host Ready evidence is unavailable');
          }
          await connectedTarget.connection.close();
        },
      },
      authorityOptions,
      deps,
    );
  } finally {
    await connectedTarget?.connection.close().catch(() => undefined);
  }
}

/**
 * Resolves the persistent npm-global owner, stages the exact registry target,
 * and delegates the only authority mutation to the shared local handoff.
 * Lifecycle policy and process control stay in the caller-provided adapter.
 */
export async function reconcileRuntimeHostNpmGlobalDeployment(
  request: RuntimeHostNpmGlobalReconciliationRequest,
  lifecycle: RuntimeHostLocalProcessLifecycleAdapter,
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
  overrides: Partial<RuntimeHostLocalHandoffDeps> = {},
): Promise<LocalHostProcessDeploymentClaimResult | LocalHostProcessDeploymentHandoffResult> {
  const deps: RuntimeHostLocalHandoffDeps = {
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    withPackage: withRuntimeHostRegistryUpdatePackage,
    prepareDeployment: prepareRuntimeHostPackageDeployment,
    readRecord: readLocalHostDeploymentRecord,
    claim: claimLocalHostProcessDeployment,
    handoff: handoffLocalHostProcessDeployment,
    ...overrides,
  };
  const installation = await deps.resolveInstallation(request.installationOptions);
  if (installation.observedRelease.version !== request.target.version) {
    throw new RuntimeHostLocalHandoffError(
      'installed_release_mismatch',
      `The installed Maka release changed from ${request.target.version} to ${installation.observedRelease.version} before local Host reconciliation`,
    );
  }
  const stageTarget = (target: RuntimeHostUpdateCandidate, transactionId: string) =>
    stageRuntimeHostNpmGlobalDeploymentTarget(
      {
        rootId: request.rootId,
        owner: installation.owner,
        target,
        transactionId,
      },
      request.deploymentPathOptions,
      deps,
    );
  const current = await deps.readRecord(request.rootId, authorityOptions);
  if (!current) {
    return deps.claim(
      {
        rootId: request.rootId,
        transactionId: request.transactionId,
        owner: installation.owner,
        target: request.target,
        activeWorkPolicy: request.activeWorkPolicy,
      },
      { ...lifecycle, stageTarget },
      authorityOptions,
    );
  }
  return deps.handoff(
    {
      rootId: request.rootId,
      expectedRevision: current.revision,
      transactionId:
        current.state.kind === 'handoff' ? current.state.transactionId : request.transactionId,
      from: current.state.kind === 'handoff' ? current.state.from : current.state.owner,
      to: installation.owner,
      target: request.target,
      activeWorkPolicy: request.activeWorkPolicy,
    },
    {
      ...lifecycle,
      stageTarget,
    },
    authorityOptions,
  );
}

export async function stageRuntimeHostNpmGlobalDeploymentTarget(
  input: {
    readonly rootId: string;
    readonly owner: RuntimeHostInstallationOwner & { readonly kind: 'cli' };
    readonly target: RuntimeHostUpdateCandidate;
    readonly transactionId: string;
  },
  pathOptions: RuntimeHostLocalDeploymentPathOptions = {},
  overrides: Pick<RuntimeHostLocalHandoffDeps, 'withPackage' | 'prepareDeployment'> = {
    withPackage: withRuntimeHostRegistryUpdatePackage,
    prepareDeployment: prepareRuntimeHostPackageDeployment,
  },
): Promise<RuntimeHostLocalStagedDeployment> {
  const deploymentRoot = resolveRuntimeHostLocalCliDeploymentRoot(
    input.rootId,
    input.owner,
    pathOptions,
  );
  return overrides.withPackage(input.target, async (sourcePackageRoot) => {
    const staged = await overrides.prepareDeployment({
      deploymentRoot,
      sourcePackageRoot,
      version: input.target.version,
      packageIntegrity: input.target.integrity,
    });
    const candidateEntrypoint = await requireCandidateEntrypoint(staged.packageRoot);
    return {
      ...staged,
      candidateEntrypoint,
      launchGeneration: launchGeneration(input.transactionId, input.target),
    };
  });
}

export function resolveRuntimeHostLocalCliDeploymentRoot(
  rootId: string,
  owner: RuntimeHostInstallationOwner & { readonly kind: 'cli' },
  options: RuntimeHostLocalDeploymentPathOptions = {},
): string {
  if (!ROOT_ID.test(rootId) || owner.kind !== 'cli' || owner.installationId.length === 0) {
    throw new TypeError('Invalid local Runtime Host CLI deployment identity');
  }
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const accountHome = path.normalize(options.homeDir ?? homedir());
  if (!path.isAbsolute(accountHome)) {
    throw new TypeError('The OS account home must be absolute');
  }
  const dataRoot =
    platform === 'darwin'
      ? path.join(accountHome, 'Library', 'Application Support')
      : platform === 'win32'
        ? path.join(accountHome, 'AppData', 'Local')
        : path.join(accountHome, '.local', 'share');
  const ownerKey = createHash('sha256').update(owner.installationId).digest('hex');
  return path.join(dataRoot, 'Maka', 'runtime-host-deployments', 'cli', ownerKey, rootId);
}

async function requireCandidateEntrypoint(packageRoot: string): Promise<string> {
  const requested = join(packageRoot, ...CANDIDATE_RELATIVE_PATH);
  let candidate: string;
  try {
    candidate = await realpath(requested);
    if (!(await stat(candidate)).isFile()) throw new Error('Not a file');
  } catch (cause) {
    throw invalidStagedPackage('The staged Maka package has no Runtime Host candidate', cause);
  }
  if (candidate !== resolve(requested)) {
    throw invalidStagedPackage('The staged Runtime Host candidate is redirected');
  }
  return candidate;
}

function launchGeneration(transactionId: string, target: RuntimeHostUpdateCandidate): string {
  return `npm-global-handoff:${createHash('sha256')
    .update(transactionId)
    .update('\0')
    .update(target.version)
    .update('\0')
    .update(target.integrity)
    .digest('hex')}`;
}

function restartTransactionId(
  rootId: string,
  owner: RuntimeHostInstallationOwner,
  target: RuntimeHostUpdateCandidate,
): string {
  return `npm-global-restart:${createHash('sha256')
    .update(rootId)
    .update('\0')
    .update(owner.kind)
    .update('\0')
    .update(owner.installationId)
    .update('\0')
    .update(target.version)
    .update('\0')
    .update(target.integrity)
    .digest('hex')}`;
}

function invalidStagedPackage(message: string, cause?: unknown): RuntimeHostUpdatePackageError {
  return new RuntimeHostUpdatePackageError('invalid_package', message, { cause });
}
