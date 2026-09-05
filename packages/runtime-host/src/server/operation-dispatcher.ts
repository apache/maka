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

import type { RootTurnAdmissionAuthorization } from '@maka/storage/execution-stores';
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
import { HOST_RESOURCE_OPERATION_SPECS } from '../protocol/host-resources.js';
import { ACCESS_AUTHORITY_OPERATION_SPECS } from '../protocol/access-authority.js';
import { SESSION_COLLABORATION_OPERATION_SPECS } from '../protocol/session-collaboration.js';
import { PEER_MESH_OPERATION_SPECS } from '../protocol/peer-mesh.js';
import { AGENT_GRAPH_OPERATION_SPECS } from '../protocol/agent-graph.js';
import { ARTIFACT_OPERATION_SPECS } from '../protocol/artifact.js';
import { CLIENT_CAPABILITY_OPERATION_SPECS } from '../protocol/client-capability.js';
import { CONFIGURATION_OPERATION_SPECS } from '../protocol/configuration.js';
import { CONNECTION_EFFECT_OPERATION_SPECS } from '../protocol/connection-effects.js';
import { CONTEXT_OPERATION_SPECS } from '../protocol/context.js';
import { DAILY_REVIEW_OPERATION_SPECS } from '../protocol/daily-review.js';
import { DEEP_RESEARCH_OPERATION_SPECS } from '../protocol/deep-research.js';
import { EXECUTION_INSPECT_OPERATION_SPECS } from '../protocol/execution-inspect.js';
import { EXTERNAL_SESSION_OPERATION_SPECS } from '../protocol/external-session.js';
import { GOAL_OPERATION_SPECS } from '../protocol/goal.js';
import { HOSTED_EXECUTION_OPERATION_SPECS } from '../protocol/hosted-execution.js';
import { INTERACTION_OPERATION_SPECS } from '../protocol/interaction.js';
import { MEMORY_OPERATION_SPECS } from '../protocol/memory.js';
import { MESSAGE_OPERATION_SPECS } from '../protocol/message.js';
import { NETWORK_PROXY_OPERATION_SPECS } from '../protocol/network-proxy.js';
import { OAUTH_OPERATION_SPECS } from '../protocol/oauth.js';
import { PLAN_OPERATION_SPECS } from '../protocol/plan.js';
import { PROJECT_CATALOG_OPERATION_SPECS } from '../protocol/project-catalog.js';
import { RUNTIME_POLICY_OPERATION_SPECS } from '../protocol/runtime-policy.js';
import { RUNTIME_RESOURCE_OPERATION_SPECS } from '../protocol/runtime-resource.js';
import { SCHEDULED_TASK_OPERATION_SPECS } from '../protocol/scheduled-task.js';
import { SESSION_CATALOG_OPERATION_SPECS } from '../protocol/session-catalog.js';
import { SESSION_CONTINUITY_OPERATION_SPECS } from '../protocol/session-continuity.js';
import { SESSION_EFFECT_OPERATION_SPECS } from '../protocol/session-effects.js';
import { SESSION_RETIREMENT_OPERATION_SPECS } from '../protocol/session-retirement.js';
import { SESSION_REVISION_OPERATION_SPECS } from '../protocol/session-revision.js';
import { SESSION_TODO_OPERATION_SPECS } from '../protocol/session-todo.js';
import { SESSION_TRANSCRIPT_OPERATION_SPECS } from '../protocol/session-transcript.js';
import { SESSION_TURNS_OPERATION_SPECS } from '../protocol/session-turns.js';
import { SKILL_CATALOG_OPERATION_SPECS } from '../protocol/skill-catalog.js';
import { TURN_OPERATION_SPECS } from '../protocol/turn.js';
import { USAGE_PRICING_OPERATION_SPECS } from '../protocol/usage-pricing.js';
import { WEB_SEARCH_OPERATION_SPECS } from '../protocol/web-search.js';
import { WORKHUB_COORDINATION_OPERATION_SPECS } from '../protocol/workhub-coordination.js';
import { PLUGIN_PLATFORM_OPERATION_SPECS } from '../protocol/plugin-platform.js';
import { boundedFailureDiagnostic } from './failure-diagnostic.js';
import { createPeerMeshOperationHandlers } from './peer-mesh-authority.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';

export interface ConnectionContext {
  hostEpoch: string;
  connectionId: string;
  principal: string;
  principalKind?: RuntimeHostConnectionAuthority['principalKind'];
  credentialId?: string;
  credentialClientInstanceId?: string;
  clientInstanceId?: string;
  turnAdmissionAuthorization?: RootTurnAdmissionAuthorization;
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

/**
 * The spec objects a Runtime Host serves from its own core — operations that
 * never route to a domain coordinator. Declared once here so both the type
 * (`HostCoreOperationKey`) and the runtime partition in
 * `createUnavailableDomainOperationHandlers` stay in agreement; adding a fifth
 * host-core spec object is a single edit.
 */
const HOST_CORE_SPEC_OBJECTS = [
  HOST_BOOTSTRAP_OPERATION_SPECS,
  HOST_RESOURCE_OPERATION_SPECS,
  ACCESS_AUTHORITY_OPERATION_SPECS,
  SESSION_COLLABORATION_OPERATION_SPECS,
  PEER_MESH_OPERATION_SPECS,
] as const;

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
export type HostCoreOperationKey = KeysOfUnion<(typeof HOST_CORE_SPEC_OBJECTS)[number]>;
export type DomainOperationKey = Exclude<OperationKey, HostCoreOperationKey>;
export type TurnOperationKey = keyof typeof TURN_OPERATION_SPECS;
export type ContextOperationKey = keyof typeof CONTEXT_OPERATION_SPECS;
export type RuntimePolicyOperationKey = keyof typeof RUNTIME_POLICY_OPERATION_SPECS;
export type ConnectionEffectOperationKey = keyof typeof CONNECTION_EFFECT_OPERATION_SPECS;
export type MessageOperationKey = keyof typeof MESSAGE_OPERATION_SPECS;
export type InteractionOperationKey = keyof typeof INTERACTION_OPERATION_SPECS;
export type GoalOperationKey = keyof typeof GOAL_OPERATION_SPECS;
export type ExecutionInspectOperationKey = keyof typeof EXECUTION_INSPECT_OPERATION_SPECS;
export type HostedExecutionOperationKey = keyof typeof HOSTED_EXECUTION_OPERATION_SPECS;
export type ExternalSessionOperationKey = keyof typeof EXTERNAL_SESSION_OPERATION_SPECS;
export type AgentGraphOperationKey = keyof typeof AGENT_GRAPH_OPERATION_SPECS;
export type SessionContinuityOperationKey =
  | keyof typeof SESSION_CONTINUITY_OPERATION_SPECS
  | keyof typeof SESSION_TRANSCRIPT_OPERATION_SPECS;
export type SessionRevisionOperationKey = keyof typeof SESSION_REVISION_OPERATION_SPECS;
export type SessionRetirementOperationKey = keyof typeof SESSION_RETIREMENT_OPERATION_SPECS;
export type SessionEffectOperationKey = keyof typeof SESSION_EFFECT_OPERATION_SPECS;
export type SessionTodoOperationKey = keyof typeof SESSION_TODO_OPERATION_SPECS;
export type SessionCatalogOperationKey =
  | keyof typeof SESSION_CATALOG_OPERATION_SPECS
  | keyof typeof SESSION_TURNS_OPERATION_SPECS;
export type ArtifactOperationKey = keyof typeof ARTIFACT_OPERATION_SPECS;
export type SkillCatalogOperationKey = keyof typeof SKILL_CATALOG_OPERATION_SPECS;
export type UsagePricingOperationKey = keyof typeof USAGE_PRICING_OPERATION_SPECS;
export type MemoryOperationKey = keyof typeof MEMORY_OPERATION_SPECS;
export type OAuthOperationKey = keyof typeof OAUTH_OPERATION_SPECS;
export type RuntimeResourceOperationKey = keyof typeof RUNTIME_RESOURCE_OPERATION_SPECS;
export type ClientCapabilityOperationKey = keyof typeof CLIENT_CAPABILITY_OPERATION_SPECS;
export type ScheduledTaskOperationKey = keyof typeof SCHEDULED_TASK_OPERATION_SPECS;
export type PlanOperationKey = keyof typeof PLAN_OPERATION_SPECS;
export type ProjectCatalogOperationKey = keyof typeof PROJECT_CATALOG_OPERATION_SPECS;
export type DeepResearchOperationKey = keyof typeof DEEP_RESEARCH_OPERATION_SPECS;
export type DailyReviewOperationKey = keyof typeof DAILY_REVIEW_OPERATION_SPECS;
export type WebSearchOperationKey = keyof typeof WEB_SEARCH_OPERATION_SPECS;
export type NetworkProxyOperationKey = keyof typeof NETWORK_PROXY_OPERATION_SPECS;
export type ConfigurationOperationKey = keyof typeof CONFIGURATION_OPERATION_SPECS;
export type WorkHubCoordinationOperationKey = keyof typeof WORKHUB_COORDINATION_OPERATION_SPECS;
export type PluginPlatformOperationKey = keyof typeof PLUGIN_PLATFORM_OPERATION_SPECS;
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
export type SessionTodoOperationHandlerMap = Pick<OperationHandlerMap, SessionTodoOperationKey>;
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
export type WorkHubCoordinationOperationHandlerMap = Pick<
  OperationHandlerMap,
  WorkHubCoordinationOperationKey
>;
export type PluginPlatformOperationHandlerMap = Pick<
  OperationHandlerMap,
  PluginPlatformOperationKey
>;
export type AccessAuthorityOperationHandlerMap = Pick<
  OperationHandlerMap,
  keyof typeof ACCESS_AUTHORITY_OPERATION_SPECS | keyof typeof SESSION_COLLABORATION_OPERATION_SPECS
>;
export type HostCoreUnavailableOperationHandlerMap = AccessAuthorityOperationHandlerMap &
  Pick<OperationHandlerMap, keyof typeof PEER_MESH_OPERATION_SPECS>;

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
    if (HOST_CORE_SPEC_OBJECTS.some((specs) => Object.hasOwn(specs, operation))) {
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
  const handlers: Partial<AccessAuthorityOperationHandlerMap> = {};
  const groups = [
    {
      specs: ACCESS_AUTHORITY_OPERATION_SPECS,
      message: 'Runtime Host access credentials are unavailable',
    },
    {
      specs: SESSION_COLLABORATION_OPERATION_SPECS,
      message: 'Runtime Host collaboration authority is unavailable',
    },
  ] as const;
  for (const { specs, message } of groups) {
    for (const operation of Object.keys(specs) as OperationKey[]) {
      const errors = HOST_OPERATION_SPECS[operation].errors as readonly HostOperationErrorCode[];
      if (!errors.includes('operation_unavailable')) {
        throw new Error(`${operation} does not declare operation_unavailable`);
      }
      Object.assign(handlers, {
        [operation]: async () => ({
          ok: false,
          error: {
            code: 'operation_unavailable',
            message,
          },
        }),
      });
    }
  }
  return handlers as AccessAuthorityOperationHandlerMap;
}

export function createUnavailableHostCoreOperationHandlers(): HostCoreUnavailableOperationHandlerMap {
  return {
    ...createUnavailableAccessAuthorityOperationHandlers(),
    ...createPeerMeshOperationHandlers(undefined),
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
      `[runtime-host] unexpected ${request.operation} failure: ${boundedFailureDiagnostic(error)}`,
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
