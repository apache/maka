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

import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { generalizedErrorMessage } from '@maka/core/redaction';
import {
  RuntimeHostManagedActivationError,
  activateRuntimeHostManagedDeployment,
  type ActivateRuntimeHostManagedDeploymentInput,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_ACTIVATION_ERROR_MESSAGE_MAX_BYTES,
  encodeRuntimeHostActivationFrame,
  prepareRuntimeHostManagedRoot,
  type RuntimeHostManagedDeploymentAuthorityOptions,
} from '@maka/runtime-host/operator';
import { reconcileRuntimeHostUpdateOnActivation } from './runtime-host-update-reconciliation.js';
import { resolveRecoverableRuntimeHostManagedDeployment } from './runtime-host-lifecycle-transaction.js';
import {
  convergeRuntimeHostManagedOperator,
  verifyRuntimeHostManagedOperator,
  resolveRuntimeHostManagedControlRoot,
} from './runtime-host-managed-deployment.js';
import { resolveRuntimeHostLifecycleProvider } from './runtime-host-service-management-command.js';
import {
  storageRootErrorDetail,
  withRuntimeHostManagedServiceDeploymentLock,
} from './runtime-host-service-manager.js';

export interface RuntimeHostManagedActivationCliOptions {
  readonly rootId: string;
  readonly repairRootAfterRemount?: true;
}

export async function recoverRuntimeHostManagedDeploymentState(
  rootId: string,
  options: {
    readonly authority?: RuntimeHostManagedDeploymentAuthorityOptions;
    readonly deploymentLockHeld?: boolean;
  } = {},
): Promise<void> {
  const recover = async () => {
    // Settle the source transaction first: a pending legacy transition is
    // resolved by its installed package before the root format can migrate.
    await resolveRecoverableRuntimeHostManagedDeployment(rootId, {
      convergeOperator: convergeRuntimeHostManagedOperator,
      verifyOperator: verifyRuntimeHostManagedOperator,
      resolveProvider: resolveRuntimeHostLifecycleProvider,
    });
    await prepareRuntimeHostManagedRoot(rootId, options.authority);
  };
  if (options.deploymentLockHeld) return recover();
  await withRuntimeHostManagedServiceDeploymentLock(
    resolveRuntimeHostManagedControlRoot(rootId),
    recover,
  );
}

export async function activateRuntimeHostManagedDeploymentWithReconciliation(
  input: ActivateRuntimeHostManagedDeploymentInput,
  options: { readonly deploymentLockHeld?: boolean } = {},
) {
  await recoverRuntimeHostManagedDeploymentState(input.rootId, {
    ...(input.authority ? { authority: input.authority } : {}),
    ...(options.deploymentLockHeld ? { deploymentLockHeld: true } : {}),
  });
  return activateRuntimeHostManagedDeployment(input, {
    reconcileActivation: (config) => reconcileRuntimeHostUpdateOnActivation(config, options),
  });
}

export async function runRuntimeHostManagedActivationCli(
  options: RuntimeHostManagedActivationCliOptions,
  overrides: {
    readonly activate?: typeof activateRuntimeHostManagedDeployment;
    readonly writeOutput?: (value: string) => unknown;
  } = {},
): Promise<number> {
  const writeOutput = overrides.writeOutput ?? ((value: string) => process.stdout.write(value));
  try {
    const result = await (
      overrides.activate ?? activateRuntimeHostManagedDeploymentWithReconciliation
    )({
      rootId: options.rootId,
      ...(options.repairRootAfterRemount
        ? { authority: { repairRootAfterRemount: true as const } }
        : {}),
    });
    writeOutput(encodeRuntimeHostActivationFrame(result));
    return 0;
  } catch (error) {
    const authority = storageRootErrorDetail(error);
    const code =
      error instanceof RuntimeHostManagedActivationError
        ? error.code
        : (authority?.code ?? 'activation_failed');
    const message = truncateUtf8(
      authority?.message ?? generalizedErrorMessage(error, 'Runtime Host activation failed'),
      RUNTIME_HOST_ACTIVATION_ERROR_MESSAGE_MAX_BYTES,
    );
    writeOutput(
      encodeRuntimeHostActivationFrame({
        schemaVersion: 1,
        kind: 'error',
        error: { code, message: message || 'Runtime Host activation failed' },
      }),
    );
    return 1;
  }
}
