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

import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  readRuntimeHostManagedDeploymentRecoveryTarget,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import {
  prepareStorageRootIdentityRepair,
  repairStorageRootIdentity,
  resolveExistingStorageRoot,
  resolveStorageRoot,
  StorageRootAuthorityError,
  type StorageRootIdentityRepairCandidate,
} from '@maka/storage/root-authority';
import {
  readRuntimeHostManagedServiceConfig,
  RuntimeHostServiceManagerError,
  resolveRuntimeHostManagedServiceConfigPath,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceConfig,
} from './runtime-host-service-manager.js';
import {
  assertRuntimeHostManagedOperatorConfig,
  resolveRuntimeHostManagedControlRoot,
} from './runtime-host-managed-deployment.js';

interface RootRepairOptions {
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly rootPath?: string;
  readonly managedRootId?: string;
  readonly operatorDeploymentId?: string;
  readonly cliPath: string;
}

interface RootRepairDependencies {
  readonly readDeployment: typeof readRuntimeHostManagedDeploymentRecoveryTarget;
  readonly readLegacyConfig: typeof readRuntimeHostManagedServiceConfig;
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly withLifecycleLock: typeof withRuntimeHostManagedServiceLifecycleLock;
  readonly confirm: (
    candidate: StorageRootIdentityRepairCandidate<'interactive'>,
  ) => Promise<boolean>;
  readonly writeOutput: (text: string) => unknown;
  readonly writeError: (text: string) => unknown;
}

/** Repair only the candidate the operator has just inspected and confirmed. */
export async function runRuntimeHostRootRepairCli(
  options: RootRepairOptions,
  overrides: Partial<RootRepairDependencies> = {},
): Promise<number> {
  const deps: RootRepairDependencies = {
    readDeployment: readRuntimeHostManagedDeploymentRecoveryTarget,
    readLegacyConfig: readRuntimeHostManagedServiceConfig,
    withDeploymentLock: withRuntimeHostManagedServiceDeploymentLock,
    withLifecycleLock: withRuntimeHostManagedServiceLifecycleLock,
    confirm: confirmRootRepair,
    writeOutput: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    ...overrides,
  };
  try {
    let deployment: RuntimeHostManagedDeploymentConfig | undefined;
    const readDeployment = async (rootId: string) => {
      const record = await deps.readDeployment(rootId);
      if (record !== undefined && record.state !== 'active') {
        throw new Error(
          'The managed deployment has an unfinished transition; root repair made no changes',
        );
      }
      return record;
    };
    if (options.managedRootId) {
      deployment = await readDeployment(options.managedRootId);
      if (!deployment) throw new Error('The managed Runtime Host deployment is not installed');
      if (
        options.rootPath !== undefined &&
        (await realpath(options.rootPath)) !== deployment.root.path
      ) {
        throw new Error('The requested storage root does not match the managed deployment');
      }
      if (options.operatorDeploymentId) {
        assertRuntimeHostManagedOperatorConfig(
          deployment,
          options.operatorDeploymentId,
          options.cliPath,
        );
      }
    }
    const legacyConfigPath = resolveRuntimeHostManagedServiceConfigPath(options.clientDataRoot);
    let legacy: RuntimeHostManagedServiceConfig | undefined;
    if (!deployment && options.rootPath === undefined) {
      try {
        legacy = await deps.readLegacyConfig(legacyConfigPath);
      } catch (error) {
        if (!(error instanceof RuntimeHostServiceManagerError) || error.code !== 'not_installed')
          throw error;
      }
    }
    const path =
      deployment?.root.path ?? options.rootPath ?? legacy?.rootPath ?? options.defaultRootPath;
    const candidate = await prepareStorageRootIdentityRepair({ path, kind: 'interactive' });
    if (!candidate) {
      if (options.managedRootId) {
        await resolveExistingStorageRoot({
          path,
          kind: 'interactive',
          expectedRootId: options.managedRootId,
        });
      } else {
        await resolveStorageRoot({ path, kind: 'interactive' });
      }
      deps.writeOutput('The Runtime Host storage root does not require identity repair.\n');
      return 0;
    }
    if (!deployment) deployment = await readDeployment(candidate.rootId);
    if (deployment) {
      legacy = undefined;
      if (
        deployment.root.id !== candidate.rootId ||
        deployment.root.path !== candidate.canonicalPath ||
        (options.rootPath !== undefined &&
          (await realpath(options.rootPath)) !== candidate.canonicalPath)
      ) {
        throw new Error('The storage root does not match the managed deployment');
      }
      if (options.operatorDeploymentId) {
        assertRuntimeHostManagedOperatorConfig(
          deployment,
          options.operatorDeploymentId,
          options.cliPath,
        );
      }
    } else {
      if (options.operatorDeploymentId)
        throw new Error('The managed deployment is no longer installed');
      legacy = await deps.readLegacyConfig(legacyConfigPath);
      if ((await realpath(legacy.rootPath)) !== candidate.canonicalPath) {
        throw new Error('The storage root does not match the installed service');
      }
    }
    if (!(await deps.confirm(candidate))) {
      deps.writeOutput('Storage root repair cancelled; no changes were made.\n');
      return 1;
    }
    const controlRoot = deployment
      ? resolveRuntimeHostManagedControlRoot(candidate.rootId)
      : options.clientDataRoot;
    await deps.withDeploymentLock(controlRoot, () =>
      deps.withLifecycleLock(controlRoot, async () => {
        // A confirmation never transfers to a replacement deployment or marker.
        if (
          !isDeepStrictEqual(deployment, await readDeployment(candidate.rootId)) ||
          (legacy && !isDeepStrictEqual(legacy, await deps.readLegacyConfig(legacyConfigPath)))
        ) {
          throw new Error(
            'The Runtime Host deployment changed while awaiting confirmation; no root repair was applied',
          );
        }
        await repairStorageRootIdentity(candidate);
      }),
    );
    deps.writeOutput(
      'Storage root identity repaired. Start the Runtime Host service if its supervisor has not already restarted it.\n',
    );
    return 0;
  } catch (error) {
    deps.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function confirmRootRepair(
  candidate: StorageRootIdentityRepairCandidate<'interactive'>,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      'Root repair requires an interactive terminal to confirm this exact storage root',
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(
      `Storage root: ${JSON.stringify(candidate.canonicalPath)}\nRoot ID: ${candidate.rootId}\n` +
        'Only continue if this is the original workspace, not a copy on another volume.\n' +
        'Rebind this storage root identity? [y/N] ',
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}

/** Keep startup fail-closed, but point a local operator to explicit recovery. */
export function runtimeHostRootRepairError(
  error: unknown,
  target: {
    readonly rootId?: string;
    readonly rootPath?: string;
    readonly clientDataRoot?: string;
  },
): unknown {
  if (
    !(error instanceof StorageRootAuthorityError) ||
    (error.code !== 'root_identity_collision' && error.code !== 'root_identity_changed')
  )
    return error;
  const selector = target.rootId
    ? `--managed-root-id ${target.rootId}`
    : target.rootPath
      ? `--root ${JSON.stringify(target.rootPath)}`
      : '';
  const clientSelector =
    !target.rootId && target.clientDataRoot
      ? ` --client-data-root ${JSON.stringify(target.clientDataRoot)}`
      : '';
  return new Error(
    `${error.message}\nTo inspect and explicitly repair this root, run: maka runtime-host service repair-root${selector ? ` ${selector}` : ''}${clientSelector}`,
    { cause: error },
  );
}
