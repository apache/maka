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

import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import type { ConfigurationCredentialExportInput, OperationOutcome } from '../protocol/index.js';
import type { ConfigurationOperationHandlerMap } from './operation-dispatcher.js';

export class HostConfigurationCoordinator {
  readonly handlers: ConfigurationOperationHandlerMap = {
    'configuration.credentials.export': (input) => this.#exportCredentials(input),
  };

  constructor(
    private readonly policy: Pick<RuntimePolicyOperationCoordinator, 'exportCredentialMaterial'>,
  ) {}

  async #exportCredentials(
    input: ConfigurationCredentialExportInput,
  ): Promise<OperationOutcome<'configuration.credentials.export'>> {
    try {
      const material = await this.policy.exportCredentialMaterial(input.locator);
      const credential = material
        ? {
            locator: material.locator,
            secretBase64: Buffer.from(material.secret, 'utf8').toString('base64'),
          }
        : null;
      return { ok: true, result: { credential } };
    } catch {
      return {
        ok: false,
        error: {
          code: 'internal_failure',
          message: 'Configuration credential export failed',
        },
      };
    }
  }
}
