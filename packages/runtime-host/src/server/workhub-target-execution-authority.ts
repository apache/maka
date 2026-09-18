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

import { createHash } from 'node:crypto';
import {
  authorizeConnectionModel,
  connectionModelChoiceValue,
  connectionEnabledModelIds,
} from '@maka/core/llm-connections';
import { isModelExplicitlyUnsupportedForChat } from '@maka/core/model-catalog';
import { thinkingVariantsForConnection } from '@maka/core/model-thinking';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { SessionHeaderSnapshot } from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { SessionModelTarget } from '../protocol/session-catalog.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
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
  > & {
    readonly connectionCatalog: Pick<RuntimePolicyStoresWriter['connectionCatalog'], 'getSnapshot'>;
  };
  readonly requestForm: HostInteractionCoordinator['requestForm'];
  readonly updateModel: (
    input: {
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly modelTarget: Extract<SessionModelTarget, { readonly kind: 'explicit' }>;
    },
    context: ConnectionContext,
  ) => Promise<'committed' | 'revision_conflict'>;
}

interface ReplacementModel {
  readonly value: string;
  readonly target: Extract<SessionModelTarget, { readonly kind: 'explicit' }>;
}

type TargetReadiness =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'model_repair_required';
      readonly record: SessionHeaderSnapshot;
      readonly replacements: readonly ReplacementModel[];
    };

/** Keeps target-model repair behind one Host-owned interface used by every WorkHub execution path. */
export class HostWorkHubTargetExecutionAuthority implements WorkHubTargetExecutionAuthority {
  readonly #options: WorkHubTargetExecutionAuthorityOptions;

  constructor(options: WorkHubTargetExecutionAuthorityOptions) {
    this.#options = options;
  }

  async prepare(
    input: WorkHubTargetExecutionPreparationInput,
    context: ConnectionContext,
  ): Promise<void> {
    const rejectedSelections: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const readiness = await this.#readiness(input.targetSessionId);
      if (readiness.kind === 'ready') return;
      if (readiness.replacements.length === 0) {
        throw new WorkHubActionEffectFailure(
          'operation_unavailable',
          `Task “${input.targetSessionName}” has no enabled replacement model`,
        );
      }
      const requestId = createHash('sha256')
        .update(
          JSON.stringify({
            kind: 'workhub_target_model_repair_v1',
            actionId: input.actionId,
            coordinationRunId: input.coordinationRunId,
            targetSessionId: input.targetSessionId,
            revision: readiness.record.revision,
            replacements: readiness.replacements.map(({ value }) => value),
            rejectedSelections,
          }),
        )
        .digest('hex');
      const choice = await this.#options.requestForm({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.coordinationTurnId,
        runId: input.coordinationRunId,
        requestId,
        create: async () => ({
          kind: 'form',
          toolUseId: input.actionId,
          message:
            rejectedSelections.length === 0
              ? `Task “${input.targetSessionName}” uses model “${readiness.record.header.model}”, which is no longer available. Choose a replacement to continue.`
              : `The selected model cannot currently run task “${input.targetSessionName}”. Choose another model to continue.`,
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'string',
              name: 'targetModel',
              label: `Model for ${input.targetSessionName}`,
              required: true,
              presentation: 'model_picker',
              minLength: 1,
            },
          ],
        }),
      });
      if (choice.answer.action !== 'accept') {
        throw new WorkHubActionEffectFailure(
          'operation_conflict',
          `Model update for task “${input.targetSessionName}” was cancelled`,
        );
      }
      const value = choice.answer.values.targetModel;
      const replacement = readiness.replacements.find(({ value: offered }) => offered === value);
      if (!replacement) {
        if (typeof value === 'string') rejectedSelections.push(value);
        continue;
      }
      const updated = await this.#options.updateModel(
        {
          sessionId: input.targetSessionId,
          expectedRevision: readiness.record.revision,
          modelTarget: replacement.target,
        },
        context,
      );
      if (updated === 'committed') {
        if ((await this.#readiness(input.targetSessionId)).kind === 'ready') return;
      }
    }
    throw new WorkHubActionEffectFailure(
      'operation_conflict',
      rejectedSelections.length > 0
        ? 'No executable replacement model was selected for this task'
        : 'Task model changed while WorkHub was preparing the delegation; try again',
    );
  }

  async assertReady(targetSessionId: string): Promise<void> {
    const readiness = await this.#readiness(targetSessionId);
    if (readiness.kind !== 'ready') {
      throw new WorkHubActionEffectFailure(
        'operation_conflict',
        'Target task model is no longer enabled; choose a replacement and try again',
      );
    }
  }

  async #readiness(targetSessionId: string): Promise<TargetReadiness> {
    const record = await this.#options.readSession(targetSessionId);
    const header = record.header;
    if (header.backend === 'plugin-executor') return { kind: 'ready' };
    const resolved = await this.#options.runtimePolicy.resolveExecutionConnection(
      header.llmConnectionId === undefined
        ? { kind: 'catalog_slug', connectionSlug: header.llmConnectionSlug }
        : {
            kind: 'bound',
            connectionId: header.llmConnectionId,
            connectionSlug: header.llmConnectionSlug,
          },
    );
    if (resolved.kind === 'ready') {
      const current = authorizeConnectionModel(resolved.connection, header.model);
      if (current && !isModelExplicitlyUnsupportedForChat(current)) return { kind: 'ready' };
    }
    const catalog = await this.#options.runtimePolicy.connectionCatalog.getSnapshot();
    const resolvedConnections = await Promise.all(
      catalog.connections.map((connection) =>
        this.#options.runtimePolicy.resolveExecutionConnection({
          kind: 'bound',
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
        }),
      ),
    );
    const replacements = resolvedConnections
      .flatMap((candidate): ReplacementModel[] => {
        if (candidate.kind !== 'ready') return [];
        const connection = candidate.connection;
        return connectionEnabledModelIds(connection).flatMap((modelId): ReplacementModel[] => {
          const model = authorizeConnectionModel(connection, modelId);
          if (!model || isModelExplicitlyUnsupportedForChat(model)) return [];
          if (
            header.thinkingLevel !== undefined &&
            !thinkingVariantsForConnection(
              {
                providerType: connection.providerType,
                modelOverrides: connection.modelOverrides,
              },
              modelId,
            ).includes(header.thinkingLevel)
          ) {
            return [];
          }
          const target = {
            kind: 'explicit' as const,
            connectionId: connection.connectionId,
            connectionSlug: connection.slug,
            model: modelId,
          };
          return [
            {
              value: connectionModelChoiceValue(
                target.connectionId,
                target.connectionSlug,
                target.model,
              ),
              target,
            },
          ];
        });
      })
      .sort((left, right) => left.value.localeCompare(right.value));
    return { kind: 'model_repair_required', record, replacements };
  }
}
