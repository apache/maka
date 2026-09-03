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
import { dirname, join, posix, resolve, win32 } from 'node:path';
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
import { compareProductReleaseVersions } from '@maka/runtime-host/operator/update-package-evidence';
import { connectExistingRuntimeHost } from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import {
  resolveRuntimeHostNpmGlobalInstallation,
  type RuntimeHostNpmGlobalInstallation,
} from './runtime-host-cli-installation.js';
import {
  openRuntimeHostPackageDeployment,
  prepareRuntimeHostPackageDeployment,
  resolveRuntimeHostPackageCliPath,
  type RuntimeHostPackageDeployment,
} from './runtime-host-package-deployment.js';
import {
  RuntimeHostUpdatePackageError,
  withRuntimeHostRegistryUpdatePackage,
} from './runtime-host-update-package.js';
import type { RuntimeHostUpdateCandidate } from './runtime-host-update-discovery.js';
import { resolveRuntimeHostRegistryUpdateCandidate } from './runtime-host-update-discovery.js';
import {
  launchRuntimeHostTargetActivator,
  type RuntimeHostTargetActivation,
  type RuntimeHostTargetActivationInput,
} from './runtime-host-local-target-activation.js';
import { launchRuntimeHostLocalSourceRetirement } from './runtime-host-local-source-retirement.js';

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
      | 'selected_target_observation_conflict'
      | 'source_owner_mismatch'
      | 'unsupported_downgrade',
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
  readonly connectExisting: typeof connectExistingRuntimeHost;
  readonly activateTarget: (
    input: RuntimeHostTargetActivationInput,
  ) => Promise<RuntimeHostTargetActivation>;
  readonly retireSource: typeof launchRuntimeHostLocalSourceRetirement;
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
 * the installed npm-global CLI. A durable selected source may retire its exact
 * Host through its own compatible client; released Hosts without that helper
 * retain only the bounded true-idle takeover adapter.
 */
export async function restartRuntimeHostNpmGlobalDeployment(
  input: {
    readonly rootPath: string;
    readonly registration: HostRegistration;
    readonly installationOptions?: Parameters<typeof resolveRuntimeHostNpmGlobalInstallation>[0];
    readonly deploymentPathOptions?: RuntimeHostLocalDeploymentPathOptions;
    readonly activeWorkPolicy?: 'refuse_active_work' | 'interrupt_active_work';
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
    connectExisting: connectExistingRuntimeHost,
    activateTarget: launchRuntimeHostTargetActivator,
    retireSource: launchRuntimeHostLocalSourceRetirement,
    ...overrides,
  };
  const installation = await deps.resolveInstallation(input.installationOptions);
  const current = await deps.readRecord(input.registration.rootId, authorityOptions);
  const sourceOwner = current?.state.kind === 'handoff' ? current.state.from : current?.state.owner;
  if (sourceOwner && !sameOwner(sourceOwner, installation.owner)) {
    throw new RuntimeHostLocalHandoffError(
      'source_owner_mismatch',
      'External npm replacement can reconcile only the same durable npm-global installation owner',
    );
  }
  const target = await deps.resolveCandidate({
    kind: 'exact',
    version: installation.observedRelease.version,
  });
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
  if (
    current &&
    compareProductReleaseVersions(target.version, current.state.selected.version) < 0
  ) {
    throw new RuntimeHostLocalHandoffError(
      'unsupported_downgrade',
      `Downgrading the local Runtime Host from ${current.state.selected.version} to ${target.version} is not supported`,
    );
  }
  const transactionId = restartTransactionId(input.registration.rootId, installation.owner, target);
  const activeWorkPolicy = input.activeWorkPolicy ?? 'refuse_active_work';
  const staged = await stageRuntimeHostNpmGlobalDeploymentTarget(
    {
      rootId: input.registration.rootId,
      owner: installation.owner,
      target,
      transactionId,
    },
    input.deploymentPathOptions,
    deps,
  );
  const selected = current?.state.selected;
  const sourceIdentity = selected && !sameDeployment(selected, target) ? selected : undefined;
  const source = sourceIdentity
    ? await openRuntimeHostNpmGlobalStagedDeployment(
        {
          rootId: input.registration.rootId,
          owner: installation.owner,
          target: sourceIdentity,
          transactionId: `${transactionId}:source`,
        },
        input.deploymentPathOptions,
      )
    : undefined;
  const sourceSupportsRetirement = source ? await hasSourceRetirementHelper(source) : false;
  let targetActivator: RuntimeHostTargetActivation | undefined;
  const activateExactTarget = async (
    rootId: string,
    stagedTarget: RuntimeHostLocalStagedDeployment,
    inheritableAuthorityLeaseFd: number,
    takeoverHostEpoch?: string,
  ): Promise<'target_present' | 'active_work' | 'operator_required'> => {
    const activated = await deps.activateTarget({
      rootPath: input.rootPath,
      rootId,
      staged: stagedTarget,
      ownerInstallationId: installation.owner.installationId,
      target,
      inheritableAuthorityLeaseFd,
      ...(takeoverHostEpoch ? { takeoverHostEpoch } : {}),
    });
    if (activated.kind !== 'ready') return activated.kind;
    targetActivator = activated;
    return 'target_present';
  };
  const prepare = async (
    rootId: string,
    selectedDeployment: RuntimeHostUpdateCandidate | undefined,
    stagedTarget: RuntimeHostLocalStagedDeployment,
    inheritableAuthorityLeaseFd: number,
  ): Promise<{ readonly kind: 'target_present' | 'active_work' }> => {
    if (rootId !== input.registration.rootId) {
      throw new RuntimeHostLocalHandoffError(
        'root_changed',
        'The local Runtime Host State Root changed before restart',
      );
    }
    const observed = await deps.connectExisting({
      rootPath: input.rootPath,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      clientInstanceId: randomUUID(),
    });
    const registration = observed.registration;
    if (registration?.rootId !== undefined && registration.rootId !== rootId) {
      if (observed.kind === 'connected') await observed.connection.close().catch(() => undefined);
      throw new RuntimeHostLocalHandoffError(
        'root_changed',
        'The local Runtime Host State Root changed during restart',
      );
    }
    if (observed.kind === 'connected') await observed.connection.close();
    if (!registration) {
      const activated = await activateExactTarget(
        rootId,
        stagedTarget,
        inheritableAuthorityLeaseFd,
      );
      if (activated !== 'target_present') {
        throw new Error('The exact target could not start after the source Host disappeared');
      }
      return { kind: 'target_present' };
    }
    if (registration.lifecycleMode !== 'ephemeral') {
      throw new Error('The observed Runtime Host requires its operator to perform replacement');
    }
    if (registration.generation === stagedTarget.launchGeneration) {
      const activated = await activateExactTarget(
        rootId,
        stagedTarget,
        inheritableAuthorityLeaseFd,
      );
      if (activated !== 'target_present') {
        throw new Error('The exact staged Runtime Host could not be reattached for recovery');
      }
      return { kind: 'target_present' };
    }
    if (registration.hostEpoch !== input.registration.hostEpoch) {
      throw new Error('The observed Runtime Host changed after restart confirmation');
    }
    if (
      source &&
      sourceSupportsRetirement &&
      selectedDeployment &&
      sourceIdentity &&
      sameDeployment(selectedDeployment, sourceIdentity)
    ) {
      const retired = await deps.retireSource({
        sourceCliPath: source.cliPath,
        rootPath: input.rootPath,
        expectedRootId: rootId,
        expectedHostEpoch: registration.hostEpoch,
        activeWorkPolicy,
        inheritableAuthorityLeaseFd,
      });
      if (retired === 'active_work') return { kind: 'active_work' };
      if (retired === 'operator_required') {
        throw new Error('The observed Runtime Host requires its operator to perform replacement');
      }
      const activated = await activateExactTarget(
        rootId,
        stagedTarget,
        inheritableAuthorityLeaseFd,
        registration.hostEpoch,
      );
      if (activated !== 'target_present') {
        throw new Error('The exact target did not activate after source retirement began');
      }
      return { kind: 'target_present' };
    }
    const activated = await activateExactTarget(
      rootId,
      stagedTarget,
      inheritableAuthorityLeaseFd,
      registration.hostEpoch,
    );
    if (activated === 'active_work') return { kind: 'active_work' };
    if (activated === 'operator_required') {
      throw new Error('The observed Runtime Host requires its operator to perform replacement');
    }
    return { kind: 'target_present' };
  };
  const unreachable = async (): Promise<never> => {
    throw new Error('Local restart must converge through its exact target activator');
  };
  let result:
    | LocalHostProcessDeploymentClaimResult
    | LocalHostProcessDeploymentHandoffResult
    | undefined;
  try {
    result = await reconcilePreparedRuntimeHostNpmGlobalDeployment(
      {
        rootId: input.registration.rootId,
        transactionId,
        target,
        activeWorkPolicy,
        installation,
        staged,
        ...(input.deploymentPathOptions
          ? { deploymentPathOptions: input.deploymentPathOptions }
          : {}),
      },
      {
        prepareUnownedHostCutover: (rootId, _target, stagedTarget, _policy, leaseFd) =>
          prepare(rootId, undefined, stagedTarget, leaseFd),
        prepareHostCutover: (rootId, selectedDeployment, _target, stagedTarget, _policy, leaseFd) =>
          prepare(rootId, selectedDeployment, stagedTarget, leaseFd),
        observeWriterRelease: unreachable,
        activateTarget: unreachable,
        async verifyTargetReady() {
          if (targetActivator?.kind !== 'ready') {
            throw new Error('Exact restarted Runtime Host Ready evidence is unavailable');
          }
        },
        async finalizeTarget() {
          const observedInstallation = await deps.resolveInstallation(input.installationOptions);
          if (
            observedInstallation.owner.installationId !== installation.owner.installationId ||
            observedInstallation.observedRelease.version !== target.version
          ) {
            throw new RuntimeHostLocalHandoffError(
              'installed_release_mismatch',
              'The installed Maka release changed again before local Host ownership committed',
            );
          }
        },
      },
      authorityOptions,
      deps,
    );
    return result;
  } finally {
    if (targetActivator) {
      const settlement = targetActivator.settle();
      if (result?.kind === 'completed') await settlement;
      else await settlement.catch(() => undefined);
    }
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
  const staged = await stageRuntimeHostNpmGlobalDeploymentTarget(
    {
      rootId: request.rootId,
      owner: installation.owner,
      target: request.target,
      transactionId: request.transactionId,
    },
    request.deploymentPathOptions,
    deps,
  );
  return reconcilePreparedRuntimeHostNpmGlobalDeployment(
    { ...request, installation, staged },
    lifecycle,
    authorityOptions,
    deps,
  );
}

export async function reconcilePreparedRuntimeHostNpmGlobalDeployment(
  request: RuntimeHostNpmGlobalReconciliationRequest & {
    readonly installation: RuntimeHostNpmGlobalInstallation;
    readonly staged: RuntimeHostLocalStagedDeployment;
  },
  lifecycle: RuntimeHostLocalProcessLifecycleAdapter,
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
  overrides: Pick<RuntimeHostLocalHandoffDeps, 'readRecord' | 'claim' | 'handoff'> = {
    readRecord: readLocalHostDeploymentRecord,
    claim: claimLocalHostProcessDeployment,
    handoff: handoffLocalHostProcessDeployment,
  },
): Promise<LocalHostProcessDeploymentClaimResult | LocalHostProcessDeploymentHandoffResult> {
  const stageTarget = async (target: RuntimeHostUpdateCandidate, transactionId: string) => {
    if (
      transactionId !== request.transactionId ||
      target.kind !== request.target.kind ||
      target.version !== request.target.version ||
      target.integrity !== request.target.integrity
    ) {
      throw new RuntimeHostLocalHandoffError(
        'selected_target_observation_conflict',
        'The prepared local Host target does not match its owner transaction',
      );
    }
    return request.staged;
  };
  const current = await overrides.readRecord(request.rootId, authorityOptions);
  if (!current) {
    return overrides.claim(
      {
        rootId: request.rootId,
        transactionId: request.transactionId,
        owner: request.installation.owner,
        target: request.target,
        activeWorkPolicy: request.activeWorkPolicy,
      },
      { ...lifecycle, stageTarget },
      authorityOptions,
    );
  }
  return overrides.handoff(
    {
      rootId: request.rootId,
      expectedRevision: current.revision,
      transactionId:
        current.state.kind === 'handoff' ? current.state.transactionId : request.transactionId,
      from: current.state.kind === 'handoff' ? current.state.from : current.state.owner,
      to: request.installation.owner,
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
  return overrides.withPackage(input.target, async (sourcePackageRoot) => {
    return prepareRuntimeHostNpmGlobalStagedDeployment(
      { ...input, sourcePackageRoot },
      pathOptions,
      overrides.prepareDeployment,
    );
  });
}

export async function prepareRuntimeHostNpmGlobalStagedDeployment(
  input: {
    readonly rootId: string;
    readonly owner: RuntimeHostInstallationOwner & { readonly kind: 'cli' };
    readonly target: RuntimeHostUpdateCandidate;
    readonly transactionId: string;
    readonly sourcePackageRoot: string;
  },
  pathOptions: RuntimeHostLocalDeploymentPathOptions = {},
  prepareDeployment: typeof prepareRuntimeHostPackageDeployment = prepareRuntimeHostPackageDeployment,
): Promise<RuntimeHostLocalStagedDeployment> {
  const deploymentRoot = resolveRuntimeHostLocalCliDeploymentRoot(
    input.rootId,
    input.owner,
    pathOptions,
  );
  const staged = await prepareDeployment({
    deploymentRoot,
    sourcePackageRoot: input.sourcePackageRoot,
    version: input.target.version,
    packageIntegrity: input.target.integrity,
  });
  const candidateEntrypoint = await requireCandidateEntrypoint(staged.packageRoot);
  return {
    ...staged,
    candidateEntrypoint,
    launchGeneration: launchGeneration(input.transactionId, input.target),
  };
}

async function openRuntimeHostNpmGlobalStagedDeployment(
  input: {
    readonly rootId: string;
    readonly owner: RuntimeHostInstallationOwner & { readonly kind: 'cli' };
    readonly target: RuntimeHostUpdateCandidate;
    readonly transactionId: string;
  },
  pathOptions: RuntimeHostLocalDeploymentPathOptions = {},
): Promise<RuntimeHostLocalStagedDeployment> {
  const deploymentRoot = resolveRuntimeHostLocalCliDeploymentRoot(
    input.rootId,
    input.owner,
    pathOptions,
  );
  const staged = await openRuntimeHostPackageDeployment({
    deploymentRoot,
    cliPath: resolveRuntimeHostPackageCliPath(
      deploymentRoot,
      input.target.version,
      input.target.integrity,
    ),
    version: input.target.version,
  });
  const candidateEntrypoint = await requireCandidateEntrypoint(staged.packageRoot);
  return {
    ...staged,
    candidateEntrypoint,
    launchGeneration: launchGeneration(input.transactionId, input.target),
  };
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

async function hasSourceRetirementHelper(
  source: RuntimeHostLocalStagedDeployment,
): Promise<boolean> {
  try {
    return (
      await stat(join(dirname(source.cliPath), 'runtime-host-local-source-retirement.js'))
    ).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function sameDeployment(
  left: RuntimeHostUpdateCandidate,
  right: RuntimeHostUpdateCandidate,
): boolean {
  return (
    left.kind === right.kind && left.version === right.version && left.integrity === right.integrity
  );
}

function sameOwner(
  left: RuntimeHostInstallationOwner,
  right: RuntimeHostInstallationOwner,
): boolean {
  return left.kind === right.kind && left.installationId === right.installationId;
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
