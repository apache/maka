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
import { redactSecrets } from '@maka/core/redaction';
import {
  HOST_OPERATION_SPECS,
  decodeOperationOutcome,
  type HostOperationErrorCode,
  type OperationInput,
  type OperationKey,
  type OperationOutcome,
  type RequestFrame,
  type RequestFrameFor,
  type ResponseFrame,
  type ResponseFrameFor,
} from '../protocol/index.js';
import { HOST_BOOTSTRAP_OPERATION_SPECS } from '../protocol/host-status.js';
import { ACCESS_AUTHORITY_OPERATION_SPECS } from '../protocol/access-authority.js';

export interface ConnectionContext {
  hostEpoch: string;
  connectionId: string;
  principal: string;
  credentialId?: string;
  acquireResidency(): OperationResidency;
}

export interface OperationResidency {
  release(): void;
}

export type OperationHandler<K extends OperationKey> = (
  input: OperationInput<K>,
  context: ConnectionContext,
) => Promise<OperationOutcome<K>>;

export type OperationHandlerMap = {
  [K in OperationKey]: OperationHandler<K>;
};

export type HostCoreOperationKey =
  | keyof typeof HOST_BOOTSTRAP_OPERATION_SPECS
  | keyof typeof ACCESS_AUTHORITY_OPERATION_SPECS;
export type DomainOperationKey = Exclude<OperationKey, HostCoreOperationKey>;
export type TurnOperationKey = Extract<
  OperationKey,
  | 'turn.start'
  | 'turn.query'
  | 'turn.stop'
  | 'turn.regenerate'
  | 'turn.resume.query'
  | 'turn.resume.start'
>;
export type ContextOperationKey = Extract<OperationKey, `context.${string}`>;
export type RuntimePolicyOperationKey = Extract<
  OperationKey,
  | `runtime.policy.${string}`
  | `connection.catalog.${string}`
  | `connection.request-headers.${string}`
  | `credential.vault.${string}`
>;
export type ConnectionEffectOperationKey = Extract<
  OperationKey,
  | 'connection.models.fetch'
  | 'connection.test.run'
  | 'connection.onboarding.verify'
  | 'connection.onboarding.save'
>;
export type MessageOperationKey = Extract<
  OperationKey,
  'turn.message.submit' | 'queue.retract' | 'turn.interrupt'
>;
export type InteractionOperationKey = Extract<OperationKey, `interaction.${string}`>;
export type GoalOperationKey = Extract<OperationKey, `goal.${string}`>;
export type ExecutionInspectOperationKey = Extract<OperationKey, `execution.inspect.${string}`>;
export type HostedExecutionOperationKey = Extract<OperationKey, `hosted.execution.${string}`>;
export type ExternalSessionOperationKey = Extract<OperationKey, `external-session.${string}`>;
export type AgentGraphOperationKey = Extract<OperationKey, `agent.graph.${string}`>;
export type SessionContinuityOperationKey = Extract<
  OperationKey,
  | 'subscription.open'
  | 'subscription.close'
  | 'session.transcript.page'
  | 'session.transcript.overlay.release'
>;
export type SessionRevisionOperationKey = Extract<
  OperationKey,
  'session.branch.create' | 'session.revision.create' | 'session.revision.abandon'
>;
export type SessionRetirementOperationKey = Extract<
  OperationKey,
  'session.lifecycle.set' | 'session.remove'
>;
export type SessionEffectOperationKey = Extract<OperationKey, 'session.recap.generate'>;
export type SessionCatalogOperationKey = Exclude<
  Extract<OperationKey, `session.${string}`>,
  | SessionContinuityOperationKey
  | SessionRevisionOperationKey
  | SessionRetirementOperationKey
  | SessionEffectOperationKey
>;
export type TaskLedgerOperationKey = Extract<OperationKey, 'task.ledger.query'>;
export type ArtifactOperationKey = Extract<OperationKey, `artifact.${string}`>;
export type SkillCatalogOperationKey = Extract<OperationKey, `skill.catalog.${string}`>;
export type UsagePricingOperationKey = Extract<OperationKey, 'usage.query' | `pricing.${string}`>;
export type MemoryOperationKey = Extract<OperationKey, `memory.${string}`>;
export type OAuthOperationKey = Extract<OperationKey, `oauth.${string}`>;
export type RuntimeResourceOperationKey = Extract<OperationKey, `runtime.resource.${string}`>;
export type ClientCapabilityOperationKey = Extract<OperationKey, `client.capability.${string}`>;
export type ScheduledTaskOperationKey = Extract<OperationKey, `scheduled-task.${string}`>;
export type PlanOperationKey = Extract<OperationKey, `plan.${string}`>;
export type ProjectCatalogOperationKey = Extract<OperationKey, `project.catalog.${string}`>;
export type DeepResearchOperationKey = Extract<OperationKey, `deep-research.${string}`>;
export type DailyReviewOperationKey = Extract<OperationKey, `daily-review.${string}`>;
export type WebSearchOperationKey = Extract<OperationKey, `web-search.${string}`>;
export type NetworkProxyOperationKey = Extract<OperationKey, `network-proxy.${string}`>;
export type ConfigurationOperationKey = Extract<OperationKey, `configuration.${string}`>;
export type DomainOperationHandlerMap = Pick<OperationHandlerMap, DomainOperationKey>;
export type TurnOperationHandlerMap = Pick<OperationHandlerMap, TurnOperationKey>;
export type ContextOperationHandlerMap = Pick<OperationHandlerMap, ContextOperationKey>;
export type RuntimePolicyOperationHandlerMap = Pick<OperationHandlerMap, RuntimePolicyOperationKey>;
export type ConnectionEffectOperationHandlerMap = Pick<
  OperationHandlerMap,
  ConnectionEffectOperationKey
>;
export type MessageOperationHandlerMap = Pick<OperationHandlerMap, MessageOperationKey>;
export type InteractionOperationHandlerMap = Pick<OperationHandlerMap, InteractionOperationKey>;
export type GoalOperationHandlerMap = Pick<OperationHandlerMap, GoalOperationKey>;
export type ExecutionInspectOperationHandlerMap = Pick<
  OperationHandlerMap,
  ExecutionInspectOperationKey
>;
export type HostedExecutionOperationHandlerMap = Pick<
  OperationHandlerMap,
  HostedExecutionOperationKey
>;
export type ExternalSessionOperationHandlerMap = Pick<
  OperationHandlerMap,
  ExternalSessionOperationKey
>;
export type AgentGraphOperationHandlerMap = Pick<OperationHandlerMap, AgentGraphOperationKey>;
export type SessionContinuityOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionContinuityOperationKey
>;
export type SessionCatalogOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionCatalogOperationKey
>;
export type SessionRevisionOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionRevisionOperationKey
>;
export type SessionRetirementOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionRetirementOperationKey
>;
export type SessionEffectOperationHandlerMap = Pick<OperationHandlerMap, SessionEffectOperationKey>;
export type TaskLedgerOperationHandlerMap = Pick<OperationHandlerMap, TaskLedgerOperationKey>;
export type ArtifactOperationHandlerMap = Pick<OperationHandlerMap, ArtifactOperationKey>;
export type SkillCatalogOperationHandlerMap = Pick<OperationHandlerMap, SkillCatalogOperationKey>;
export type UsagePricingOperationHandlerMap = Pick<OperationHandlerMap, UsagePricingOperationKey>;
export type MemoryOperationHandlerMap = Pick<OperationHandlerMap, MemoryOperationKey>;
export type OAuthOperationHandlerMap = Pick<OperationHandlerMap, OAuthOperationKey>;
export type RuntimeResourceOperationHandlerMap = Pick<
  OperationHandlerMap,
  RuntimeResourceOperationKey
>;
export type ClientCapabilityOperationHandlerMap = Pick<
  OperationHandlerMap,
  ClientCapabilityOperationKey
>;
export type ScheduledTaskOperationHandlerMap = Pick<OperationHandlerMap, ScheduledTaskOperationKey>;
export type PlanOperationHandlerMap = Pick<OperationHandlerMap, PlanOperationKey>;
export type ProjectCatalogOperationHandlerMap = Pick<
  OperationHandlerMap,
  ProjectCatalogOperationKey
>;
export type DeepResearchOperationHandlerMap = Pick<OperationHandlerMap, DeepResearchOperationKey>;
export type DailyReviewOperationHandlerMap = Pick<OperationHandlerMap, DailyReviewOperationKey>;
export type WebSearchOperationHandlerMap = Pick<OperationHandlerMap, WebSearchOperationKey>;
export type NetworkProxyOperationHandlerMap = Pick<OperationHandlerMap, NetworkProxyOperationKey>;
export type ConfigurationOperationHandlerMap = Pick<OperationHandlerMap, ConfigurationOperationKey>;
export type AccessAuthorityOperationHandlerMap = Pick<
  OperationHandlerMap,
  keyof typeof ACCESS_AUTHORITY_OPERATION_SPECS
>;

export function composeOperationHandlers(
  ...handlerMaps: readonly Partial<OperationHandlerMap>[]
): OperationHandlerMap {
  const combined: Partial<OperationHandlerMap> = {};
  for (const handlers of handlerMaps) {
    for (const key of Object.keys(handlers)) {
      if (!Object.hasOwn(HOST_OPERATION_SPECS, key)) {
        throw new Error(`Unknown Runtime Host operation handler: ${key}`);
      }
      if (Object.hasOwn(combined, key)) {
        throw new Error(`Duplicate Runtime Host operation handler: ${key}`);
      }
      const handler = handlers[key as OperationKey];
      if (typeof handler !== 'function') {
        throw new Error(`Invalid Runtime Host operation handler: ${key}`);
      }
      Object.assign(combined, { [key]: handler });
    }
  }
  const missing = Object.keys(HOST_OPERATION_SPECS).filter((key) => !Object.hasOwn(combined, key));
  if (missing.length > 0) {
    throw new Error(`Missing Runtime Host operation handlers: ${missing.join(', ')}`);
  }
  return combined as OperationHandlerMap;
}

export function createUnavailableDomainOperationHandlers(): DomainOperationHandlerMap {
  const handlers: Partial<DomainOperationHandlerMap> = {};
  for (const operation of Object.keys(HOST_OPERATION_SPECS) as OperationKey[]) {
    if (
      Object.hasOwn(HOST_BOOTSTRAP_OPERATION_SPECS, operation) ||
      Object.hasOwn(ACCESS_AUTHORITY_OPERATION_SPECS, operation)
    ) {
      continue;
    }
    const errors = HOST_OPERATION_SPECS[operation].errors as readonly HostOperationErrorCode[];
    if (!errors.includes('operation_unavailable')) {
      throw new Error(`${operation} does not declare operation_unavailable`);
    }
    Object.assign(handlers, {
      [operation]: async () => ({
        ok: false,
        error: {
          code: 'operation_unavailable',
          message: 'Runtime Host operation is unavailable in this composition',
        },
      }),
    });
  }
  return handlers as DomainOperationHandlerMap;
}

export function createUnavailableAccessAuthorityOperationHandlers(): AccessAuthorityOperationHandlerMap {
  return {
    'access.credential.issue': async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Runtime Host access credentials are unavailable',
      },
    }),
    'access.credential.replace': async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Runtime Host access credentials are unavailable',
      },
    }),
    'access.credential.prepare': async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Runtime Host access credentials are unavailable',
      },
    }),
    'access.credential.revoke': async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Runtime Host access credentials are unavailable',
      },
    }),
    'access.credential.finalize': async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Runtime Host access credentials are unavailable',
      },
    }),
  };
}

export async function dispatchOperation(
  request: RequestFrame,
  handlers: OperationHandlerMap,
  context: ConnectionContext,
): Promise<ResponseFrame> {
  return dispatchTypedOperation(
    request as RequestFrameFor<OperationKey>,
    handlers,
    context,
  ) as Promise<ResponseFrame>;
}

export function operationFailureResponse(
  request: RequestFrame,
  code: HostOperationErrorCode,
  message: string,
): ResponseFrame {
  const declaredErrors = HOST_OPERATION_SPECS[request.operation]
    .errors as readonly HostOperationErrorCode[];
  if (code !== 'unauthorized' && !declaredErrors.includes(code)) {
    throw new Error(`${request.operation} does not declare ${code}`);
  }
  return {
    requestId: request.requestId,
    operation: request.operation,
    ok: false,
    error: { code, message },
  } as ResponseFrame;
}

async function dispatchTypedOperation<K extends OperationKey>(
  request: RequestFrameFor<K>,
  handlers: OperationHandlerMap,
  context: ConnectionContext,
): Promise<ResponseFrameFor<K>> {
  const handler = handlers[request.operation] as OperationHandler<K>;
  let outcome: OperationOutcome<K>;
  try {
    outcome = decodeOperationOutcome(request.operation, await handler(request.input, context));
  } catch (error) {
    console.error(
      `[runtime-host] unexpected ${request.operation} failure: ${boundedUnexpectedFailure(error)}`,
    );
    return operationFailureResponse(
      request as RequestFrame,
      'internal_failure',
      'Runtime Host operation failed',
    ) as ResponseFrameFor<K>;
  }
  return outcome.ok
    ? {
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        result: outcome.result,
      }
    : {
        requestId: request.requestId,
        operation: request.operation,
        ok: false,
        error: outcome.error,
      };
}

function boundedUnexpectedFailure(error: unknown): string {
  const details =
    error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
  return truncateUtf8(redactSecrets(details), 8 * 1024, '\n<diagnostic truncated>');
}
