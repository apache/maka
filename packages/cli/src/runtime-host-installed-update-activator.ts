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
import { connectOrSpawnRuntimeHost, runtimeHostStartupError } from '@maka/runtime-host/client';
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
  },
  overrides: { readonly connectOrSpawn?: typeof connectOrSpawnRuntimeHost } = {},
): Promise<number> {
  const result = await (overrides.connectOrSpawn ?? connectOrSpawnRuntimeHost)({
    rootPath: input.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    generation: input.generation,
    ...(input.takeoverHostEpoch ? { takeoverHostEpoch: input.takeoverHostEpoch } : {}),
    clientInstanceId: randomUUID(),
    candidateEntrypoint: input.candidateEntrypoint,
  });
  if (result.kind === 'connected') {
    try {
      if (
        result.registration.rootId !== input.expectedRootId ||
        result.registration.generation !== input.generation ||
        (result.spawnedProcess !== undefined &&
          result.spawnedProcess.pid !== result.registration.pid)
      ) {
        throw new Error('The activated Runtime Host does not match the exact staged target');
      }
      return 0;
    } finally {
      await result.connection.close().catch(() => undefined);
    }
  }
  if (result.kind === 'failed') {
    throw runtimeHostStartupError(result.reason, result.diagnostic);
  }
  if (result.registration.lifecycleMode !== 'ephemeral') return 4;
  return 3;
}
