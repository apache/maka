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

import type { Readable, Writable } from 'node:stream';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { openRuntimeHostManagedStdioBridge } from '@maka/runtime-host/client';
import { activateRuntimeHostManagedDeploymentWithReconciliation } from './runtime-host-activation-command.js';

export async function runRuntimeHostManagedConnectCli(
  input: { readonly rootId: string; readonly repairRootAfterRemount?: true },
  overrides: {
    readonly openBridge?: typeof openRuntimeHostManagedStdioBridge;
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly writeError?: (value: string) => unknown;
  } = {},
): Promise<number> {
  const stdin = overrides.stdin ?? process.stdin;
  const stdout = overrides.stdout ?? process.stdout;
  let socket: Awaited<ReturnType<typeof openRuntimeHostManagedStdioBridge>> | undefined;
  try {
    socket = await (overrides.openBridge ?? openRuntimeHostManagedStdioBridge)(
      {
        rootId: input.rootId,
        ...(input.repairRootAfterRemount
          ? { authority: { repairRootAfterRemount: true as const } }
          : {}),
      },
      { activate: activateRuntimeHostManagedDeploymentWithReconciliation },
    );
    stdin.pipe(socket);
    socket.pipe(stdout, { end: false });
    await new Promise<void>((resolve, reject) => {
      socket!.once('close', resolve);
      socket!.once('error', reject);
    });
    return 0;
  } catch (error) {
    (overrides.writeError ?? ((value) => process.stderr.write(value)))(
      `${generalizedErrorMessage(error, 'Runtime Host stdio bridge failed')}\n`,
    );
    return 1;
  } finally {
    if (socket) {
      stdin.unpipe(socket);
      socket.unpipe(stdout);
      socket.destroy();
    }
  }
}
