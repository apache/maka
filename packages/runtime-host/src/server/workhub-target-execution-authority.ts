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

import { authorizeConnectionModel } from '@maka/core/llm-connections';
import { isModelExplicitlyUnsupportedForChat } from '@maka/core/model-catalog';
import type { SessionHeaderSnapshot } from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { ConnectionContext } from './operation-dispatcher.js';
import { WorkHubActionEffectFailure } from './workhub-coordination-action-gate.js';

export interface WorkHubTargetExecutionPreparationInput {
  readonly actionId: string;
  readonly coordinationTurnId: string;
  readonly coordinationRunId: string;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
}

export interface WorkHubTargetExecutionAuthority {
  prepare(input: WorkHubTargetExecutionPreparationInput, context: ConnectionContext): Promise<void>;
  assertReady(targetSessionId: string): Promise<void>;
}

export interface WorkHubTargetExecutionAuthorityOptions {
  readonly readSession: (sessionId: string) => Promise<SessionHeaderSnapshot>;
  readonly runtimePolicy: Pick<
    RuntimePolicyStoresWriter['operations'],
    'resolveExecutionConnection'
  >;
}

/** Validates the selected model without changing the target's configuration. */
export class HostWorkHubTargetExecutionAuthority implements WorkHubTargetExecutionAuthority {
  constructor(private readonly options: WorkHubTargetExecutionAuthorityOptions) {}

  prepare(
    input: WorkHubTargetExecutionPreparationInput,
    _context: ConnectionContext,
  ): Promise<void> {
    return this.assertReady(input.targetSessionId);
  }

  async assertReady(targetSessionId: string): Promise<void> {
    const { header } = await this.options.readSession(targetSessionId);
    if (header.backend === 'plugin-executor') return;
    const resolved = await this.options.runtimePolicy.resolveExecutionConnection(
      header.llmConnectionId === undefined
        ? { kind: 'catalog_slug', connectionSlug: header.llmConnectionSlug }
        : {
            kind: 'bound',
            connectionId: header.llmConnectionId,
            connectionSlug: header.llmConnectionSlug,
          },
    );
    const model =
      resolved.kind === 'ready'
        ? authorizeConnectionModel(resolved.connection, header.model)
        : undefined;
    if (!model || isModelExplicitlyUnsupportedForChat(model)) {
      throw new WorkHubActionEffectFailure(
        'operation_unavailable',
        `Task “${header.name}” uses unavailable model “${header.model}”. Update its model in the task settings, then retry.`,
      );
    }
  }
}
