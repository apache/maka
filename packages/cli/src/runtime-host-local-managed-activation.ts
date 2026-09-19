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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeHostStartupError } from '@maka/runtime-host/client';
import {
  prepareRuntimeHostRoot,
  decodeRuntimeHostActivationFrame,
  readRuntimeHostManagedDeploymentAuthorityRecord,
  RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES,
  resolveRuntimeHostNpmDeploymentLayout,
} from '@maka/runtime-host/operator';

const run = promisify(execFile);

/** Invoke the installed owner; never launch the calling CLI's candidate as the owner. */
export async function activateLocalManagedRuntimeHost(input: {
  readonly rootPath: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const capability = await prepareRuntimeHostRoot(input.rootPath);
  const record = await readRuntimeHostManagedDeploymentAuthorityRecord(capability);
  const config =
    record?.state === 'active'
      ? record
      : record?.recovery === 'complete_to'
        ? record.to
        : record?.from;
  if (!config || config.lifecycle.mode !== 'on_demand') {
    throw runtimeHostStartupError('managed_root_requires_operator');
  }
  // The root's deployment record selects the exact operator package, including
  // recovery before its stable launcher projection has been updated.
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const result = await run(
    config.launch.nodePath,
    [layout.cliPath, 'runtime-host', 'activate', '--framed', '--root-id', capability.rootId],
    {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      maxBuffer: RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES + 256,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  ).catch((error: unknown) => {
    input.signal?.throwIfAborted();
    // Operators report a framed diagnostic and exit nonzero on expected failures.
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
      const frame = decodeSingleActivationFrame(error.stdout);
      if (frame?.kind === 'error') throw new Error(frame.error.message, { cause: error });
    }
    throw error;
  });
  input.signal?.throwIfAborted();
  const frame = decodeSingleActivationFrame(result.stdout);
  if (!frame)
    throw new Error('The installed Runtime Host operator returned an invalid activation result');
  if (frame.kind === 'error') throw new Error(frame.error.message);
  if (frame.rootId !== capability.rootId || frame.deploymentId !== config.deploymentId) {
    throw new Error('The installed Runtime Host operator activated a different deployment');
  }
}

function decodeSingleActivationFrame(stdout: string) {
  const line = stdout.replace(/\r?\n$/u, '');
  return /[\r\n]/u.test(line) ? undefined : decodeRuntimeHostActivationFrame(line);
}
