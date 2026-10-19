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

import { lstat, readFile, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  encodeRuntimeHostSetupFrame,
  resolveRuntimeHostManagedDeploymentAuthority,
  runtimeHostManagedOperatorCommand,
  runtimeHostManagedOperatorModulePath,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import { tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import { applyRuntimeHostLifecycleTransition } from './runtime-host-lifecycle-transaction.js';
import {
  convergeRuntimeHostManagedOperator,
  resolveRuntimeHostManagedControlRoot,
  verifyRuntimeHostManagedOperator,
} from './runtime-host-managed-deployment.js';
import { withRuntimeHostManagedServiceDeploymentLock } from './runtime-host-service-manager.js';

export interface RuntimeHostWslNodeRepairInput {
  readonly rootId: string;
  readonly expectedNodePath: string;
  readonly expectedModulePath: string;
}

/** Only invoked by Desktop's WSL missing-file preflight; never by Host startup failure. */
export async function repairRuntimeHostMissingWslNode(
  input: RuntimeHostWslNodeRepairInput,
  overrides: { readonly isWsl?: () => Promise<boolean> } = {},
): Promise<RuntimeHostManagedDeploymentConfig> {
  const isWsl =
    overrides.isWsl ??
    (async () =>
      process.platform === 'linux' &&
      /microsoft/i.test(await readFile('/proc/sys/kernel/osrelease', 'utf8')));
  if (!(await isWsl())) throw new Error('Missing Node recovery is available only in WSL');
  // Validate the discovered runtime before altering durable deployment authority.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (
    !(major! >= 24 || (major === 22 && minor! >= 19)) ||
    typeof DatabaseSync !== 'function' ||
    typeof zstdCompressSync !== 'function' ||
    typeof zstdDecompressSync !== 'function'
  ) {
    throw new Error('The Node found by the WSL login shell cannot run this Runtime Host');
  }
  const nodePath = await realpath(process.execPath);
  return withRuntimeHostManagedServiceDeploymentLock(
    resolveRuntimeHostManagedControlRoot(input.rootId),
    async () => {
      const resolved = await resolveRuntimeHostManagedDeploymentAuthority(input.rootId, {
        repairRootAfterRemount: true,
      });
      if (!resolved || resolved.record.state !== 'active')
        throw new Error('WSL deployment is absent or requires transaction recovery');
      const current = resolved.record;
      if (
        current.lifecycle.mode !== 'on_demand' ||
        runtimeHostManagedOperatorModulePath(current.deploymentRoot, 'posix') !==
          input.expectedModulePath
      ) {
        throw new Error('WSL Node recovery does not match the on-demand deployment');
      }
      // A stale Desktop binding may be retried after a prior repair committed.
      if (current.launch.nodePath !== input.expectedNodePath) {
        if (await missingNode(current.launch.nodePath))
          throw new Error('WSL deployment Node binding changed; reconnect its current profile');
        return current;
      }
      if (!(await missingNode(current.launch.nodePath))) {
        throw new Error('The saved WSL Node still exists; refusing to replace it');
      }
      const owner = await tryAcquireStateRootOwner(resolved.capability);
      if (!owner)
        throw new Error('The WSL Host is still running; Node recovery will not interrupt it');
      try {
        // Fence source reappearance under the root lease too.
        if (!(await missingNode(current.launch.nodePath)))
          throw new Error('The saved WSL Node reappeared');
        const desired = {
          ...current,
          configRevision: current.configRevision + 1,
          launch: { ...current.launch, nodePath },
        };
        const configured = await applyRuntimeHostLifecycleTransition(
          owner,
          {
            operation: 'configure',
            current,
            desired,
          },
          {
            convergeOperator: convergeRuntimeHostManagedOperator,
            verifyOperator: verifyRuntimeHostManagedOperator,
            resolveProvider: () => {
              throw new Error('WSL Node recovery cannot alter a supervisor');
            },
          },
        );
        if (!configured) throw new Error('WSL Node recovery did not retain the deployment');
        return configured;
      } finally {
        await owner.close();
      }
    },
  );
}

async function missingNode(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

export async function runRuntimeHostWslNodeRepairCli(
  input: RuntimeHostWslNodeRepairInput,
): Promise<number> {
  try {
    const config = await repairRuntimeHostMissingWslNode(input);
    process.stdout.write(
      encodeRuntimeHostSetupFrame({
        schemaVersion: 1,
        sequence: 1,
        kind: 'existing_environment',
        version: config.launch.package.version,
        serviceId: config.root.id,
        rootId: config.root.id,
        rootPath: config.root.path,
        deploymentId: config.deploymentId,
        operator: runtimeHostManagedOperatorCommand(config, 'posix'),
      }),
    );
    return 0;
  } catch (error) {
    process.stdout.write(
      encodeRuntimeHostSetupFrame({
        schemaVersion: 1,
        sequence: 1,
        kind: 'error',
        error: {
          code: 'activation_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return 1;
  }
}
