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

import {
  decodeGoalEventProvenance,
  type LegacyEventWaitProvenance,
  type GoalWaitingProvenance,
} from './event-wait-delivery.js';
import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

/** Non-user trigger source for a turn. */
export interface WorkHubResultOrigin {
  kind: 'workhub_result';
  eventId: string;
  actionId: string;
  delegationId: string;
  targetSessionId: string;
  targetTurnId: string;
}

export interface CloudActivationOrigin {
  kind: 'cloud_activation';
  activationId: string;
}

export type TurnOrigin =
  // External text stays non-owner input even when its transport has no sender identity.
  | { kind: 'external_connector'; connectorId: string; senderId?: string }
  | WorkHubResultOrigin
  | CloudActivationOrigin
  | { kind: 'scheduled_task'; scheduledTaskId: string }
  | { kind: 'legacy_automation'; automationId: string }
  | {
      kind: 'goal';
      goalId: string;
      goalWaiting?: GoalWaitingProvenance;
      /** PR3/PR4 historical provenance; not a new execution authority. */
      eventWait?: LegacyEventWaitProvenance;
    }
  | {
      kind: 'agent_graph';
      graphId: string;
      /** Durable, graph-snapshot-scoped idempotency key for this supervisor wake. */
      wakeId: string;
      /** Durable identity of one delivery attempt for the wake. */
      attemptId: string;
    };

const EXTERNAL_CONNECTOR_ORIGIN_SHAPE = defineObjectShape<
  Extract<TurnOrigin, { kind: 'external_connector' }>
>()(['kind', 'connectorId'], ['senderId']);

type ScheduledTaskOrigin = Extract<TurnOrigin, { kind: 'scheduled_task' }>;
type CloudActivationOriginType = Extract<TurnOrigin, { kind: 'cloud_activation' }>;
type LegacyAutomationOrigin = Extract<TurnOrigin, { kind: 'legacy_automation' }>;
type GoalOrigin = Extract<TurnOrigin, { kind: 'goal' }>;
type AgentGraphOrigin = Extract<TurnOrigin, { kind: 'agent_graph' }>;

const SCHEDULED_TASK_ORIGIN_SHAPE = defineObjectShape<ScheduledTaskOrigin>()(
  ['kind', 'scheduledTaskId'],
  [],
);
const CLOUD_ACTIVATION_ORIGIN_SHAPE = defineObjectShape<CloudActivationOriginType>()(
  ['kind', 'activationId'],
  [],
);
const LEGACY_AUTOMATION_ORIGIN_SHAPE = defineObjectShape<LegacyAutomationOrigin>()(
  ['kind', 'automationId'],
  [],
);
const GOAL_ORIGIN_SHAPE = defineObjectShape<GoalOrigin>()(
  ['kind', 'goalId'],
  ['goalWaiting', 'eventWait'],
);
const AGENT_GRAPH_ORIGIN_SHAPE = defineObjectShape<AgentGraphOrigin>()(
  ['kind', 'graphId', 'wakeId', 'attemptId'],
  [],
);

/** Decode a persisted or runtime turn origin, normalizing released Automation rows. */
export function decodeTurnOrigin(value: unknown): TurnOrigin | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'external_connector') {
    if (
      !hasExactShape(value, EXTERNAL_CONNECTOR_ORIGIN_SHAPE) ||
      typeof value.connectorId !== 'string' ||
      !value.connectorId.length ||
      (value.senderId !== undefined &&
        (typeof value.senderId !== 'string' || !value.senderId.length))
    )
      return undefined;
    return {
      kind: 'external_connector',
      connectorId: value.connectorId,
      ...(value.senderId !== undefined ? { senderId: value.senderId as string } : {}),
    };
  }
  if (value.kind === 'workhub_result') {
    const keys = ['kind', 'eventId', 'actionId', 'delegationId', 'targetSessionId', 'targetTurnId'];
    if (
      Object.keys(value).length !== keys.length ||
      !keys.every(
        (key) =>
          typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256,
      )
    )
      return undefined;
    return {
      kind: 'workhub_result',
      eventId: value.eventId as string,
      actionId: value.actionId as string,
      delegationId: value.delegationId as string,
      targetSessionId: value.targetSessionId as string,
      targetTurnId: value.targetTurnId as string,
    };
  }
  if (
    hasExactShape(value, SCHEDULED_TASK_ORIGIN_SHAPE) &&
    value.kind === 'scheduled_task' &&
    typeof value.scheduledTaskId === 'string' &&
    value.scheduledTaskId.length > 0
  ) {
    return { kind: 'scheduled_task', scheduledTaskId: value.scheduledTaskId };
  }
  if (
    hasExactShape(value, CLOUD_ACTIVATION_ORIGIN_SHAPE) &&
    value.kind === 'cloud_activation' &&
    typeof value.activationId === 'string' &&
    value.activationId.length > 0
  ) {
    return { kind: 'cloud_activation', activationId: value.activationId };
  }
  if (
    hasExactShape(value, LEGACY_AUTOMATION_ORIGIN_SHAPE) &&
    (value.kind === 'automation' || value.kind === 'legacy_automation') &&
    typeof value.automationId === 'string' &&
    value.automationId.length > 0
  ) {
    return { kind: 'legacy_automation', automationId: value.automationId };
  }
  if (
    hasExactShape(value, GOAL_ORIGIN_SHAPE) &&
    value.kind === 'goal' &&
    typeof value.goalId === 'string' &&
    value.goalId.length > 0
  ) {
    try {
      return {
        kind: 'goal',
        goalId: value.goalId,
        ...decodeGoalEventProvenance(value),
      };
    } catch {
      return undefined;
    }
  }
  if (
    hasExactShape(value, AGENT_GRAPH_ORIGIN_SHAPE) &&
    value.kind === 'agent_graph' &&
    typeof value.graphId === 'string' &&
    value.graphId.length > 0 &&
    typeof value.wakeId === 'string' &&
    value.wakeId.length > 0 &&
    typeof value.attemptId === 'string' &&
    value.attemptId.length > 0
  ) {
    return {
      kind: 'agent_graph',
      graphId: value.graphId,
      wakeId: value.wakeId,
      attemptId: value.attemptId,
    };
  }
  return undefined;
}
