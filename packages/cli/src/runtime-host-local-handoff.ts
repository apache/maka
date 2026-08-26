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

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import {
  handoffLocalHostProcessDeployment,
  type LocalHostDeploymentAuthorityOptions,
  type LocalHostProcessDeploymentHandoffAdapter,
  type LocalHostProcessDeploymentHandoffRequest,
  type LocalHostProcessDeploymentHandoffResult,
  type RuntimeHostInstallationOwner,
} from '@maka/runtime-host/operator';
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
    readonly code: 'installed_release_mismatch',
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
  readonly handoff: typeof handoffLocalHostProcessDeployment;
}

export type RuntimeHostLocalProcessLifecycleAdapter = Omit<
  LocalHostProcessDeploymentHandoffAdapter<RuntimeHostLocalStagedDeployment>,
  'stageTarget'
>;

export interface RuntimeHostNpmGlobalHandoffRequest
  extends Omit<LocalHostProcessDeploymentHandoffRequest, 'to'> {
  readonly installationOptions?: Parameters<typeof resolveRuntimeHostNpmGlobalInstallation>[0];
  readonly deploymentPathOptions?: RuntimeHostLocalDeploymentPathOptions;
}

/**
 * Resolves the persistent npm-global owner, stages the exact registry target,
 * and delegates the only authority mutation to the shared local handoff.
 * Lifecycle policy and process control stay in the caller-provided adapter.
 */
export async function handoffRuntimeHostNpmGlobalDeployment(
  request: RuntimeHostNpmGlobalHandoffRequest,
  lifecycle: RuntimeHostLocalProcessLifecycleAdapter,
  authorityOptions: LocalHostDeploymentAuthorityOptions = {},
  overrides: Partial<RuntimeHostLocalHandoffDeps> = {},
): Promise<LocalHostProcessDeploymentHandoffResult> {
  const deps: RuntimeHostLocalHandoffDeps = {
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    withPackage: withRuntimeHostRegistryUpdatePackage,
    prepareDeployment: prepareRuntimeHostPackageDeployment,
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
  return deps.handoff(
    {
      rootId: request.rootId,
      expectedRevision: request.expectedRevision,
      transactionId: request.transactionId,
      from: request.from,
      to: installation.owner,
      target: request.target,
      activeWorkPolicy: request.activeWorkPolicy,
    },
    {
      ...lifecycle,
      stageTarget: (target, transactionId) =>
        stageRuntimeHostNpmGlobalDeploymentTarget(
          {
            rootId: request.rootId,
            owner: installation.owner,
            target,
            transactionId,
          },
          request.deploymentPathOptions,
          deps,
        ),
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

function invalidStagedPackage(message: string, cause?: unknown): RuntimeHostUpdatePackageError {
  return new RuntimeHostUpdatePackageError('invalid_package', message, { cause });
}
