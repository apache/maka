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
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_ACTIVATION_ERROR_MESSAGE_MAX_BYTES,
  encodeRuntimeHostActivationFrame,
} from '@maka/runtime-host/operator';

export interface RuntimeHostManagedActivationCliOptions {
  readonly rootId: string;
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
    const result = await (overrides.activate ?? activateRuntimeHostManagedDeployment)({
      rootId: options.rootId,
    });
    writeOutput(encodeRuntimeHostActivationFrame(result));
    return 0;
  } catch (error) {
    const code =
      error instanceof RuntimeHostManagedActivationError ? error.code : 'activation_failed';
    const message = truncateUtf8(
      generalizedErrorMessage(error, 'Runtime Host activation failed'),
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
