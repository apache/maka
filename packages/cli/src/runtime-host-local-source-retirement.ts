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
import {
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';

const SOURCE_RETIREMENT_TIMEOUT_MS = 60_000;

interface RuntimeHostLocalSourceRetirementDeps {
  readonly connectExisting: typeof connectExistingRuntimeHost;
  readonly prepareRetirement: typeof prepareConnectedRuntimeHostRetirement;
}

export interface RuntimeHostLocalSourceRetirementInput {
  readonly rootPath: string;
  readonly expectedRootId: string;
  readonly expectedHostEpoch: string;
  readonly activeWorkPolicy: 'refuse_active_work' | 'interrupt_active_work';
}

/**
 * Runs inside the exact selected source package so its client protocol remains
 * compatible with the Host that package launched. The parent owns deployment
 * authority; this helper only exercises the authenticated retirement contract.
 */
export async function runRuntimeHostLocalSourceRetirement(
  input: RuntimeHostLocalSourceRetirementInput,
  overrides: Partial<RuntimeHostLocalSourceRetirementDeps> = {},
): Promise<number> {
  const connectExisting = overrides.connectExisting ?? connectExistingRuntimeHost;
  const prepareRetirement = overrides.prepareRetirement ?? prepareConnectedRuntimeHostRetirement;
  const connected = await connectExisting({
    rootPath: input.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  });
  if (connected.kind !== 'connected') {
    if (connected.registration && connected.registration.lifecycleMode !== 'ephemeral') return 4;
    throw new Error('The selected source package cannot control the observed Runtime Host');
  }
  try {
    if (
      connected.registration.rootId !== input.expectedRootId ||
      connected.registration.hostEpoch !== input.expectedHostEpoch
    ) {
      throw new Error('The Runtime Host changed before source-package retirement');
    }
    if (connected.registration.lifecycleMode !== 'ephemeral') return 4;
    const prepared = await prepareRetirement(connected.connection, input.activeWorkPolicy);
    if (prepared.kind === 'active_tasks') return 2;
    if (prepared.pid !== connected.registration.pid) {
      throw new Error('The Runtime Host process changed while source retirement was prepared');
    }
    return 0;
  } finally {
    await connected.connection.close().catch(() => undefined);
  }
}

export function launchRuntimeHostLocalSourceRetirement(input: {
  readonly sourceCliPath: string;
  readonly rootPath: string;
  readonly expectedRootId: string;
  readonly expectedHostEpoch: string;
  readonly activeWorkPolicy: 'refuse_active_work' | 'interrupt_active_work';
  readonly inheritableAuthorityLeaseFd: number;
}): Promise<'prepared' | 'active_work' | 'operator_required'> {
  const args = [
    input.sourceCliPath,
    'runtime-host',
    'local-source-retire',
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.expectedRootId,
    '--expected-host-epoch',
    input.expectedHostEpoch,
    ...(input.activeWorkPolicy === 'interrupt_active_work'
      ? ['--allow-interrupt-active-tasks']
      : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      // fd 4 inherits the existing owner-authority lease. The source helper
      // holds it only while the authenticated retirement request is in flight.
      stdio: ['ignore', 'ignore', 'inherit', 'ignore', input.inheritableAuthorityLeaseFd],
      timeout: SOURCE_RETIREMENT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Maka source retirement helper exited on ${signal}`));
      } else if (code === 0) {
        resolve('prepared');
      } else if (code === 2) {
        resolve('active_work');
      } else if (code === 4) {
        resolve('operator_required');
      } else {
        reject(new Error('The selected Maka source package could not retire its Runtime Host'));
      }
    });
  });
}
