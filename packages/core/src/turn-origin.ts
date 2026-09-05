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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

/** Non-user trigger source for a turn. */
export type TurnOrigin =
  | { kind: 'scheduled_task'; scheduledTaskId: string }
  | { kind: 'legacy_automation'; automationId: string }
  | { kind: 'goal'; goalId: string }
  | {
      kind: 'agent_graph';
      graphId: string;
      /** Durable, graph-snapshot-scoped idempotency key for this supervisor wake. */
      wakeId: string;
      /** Durable identity of one delivery attempt for the wake. */
      attemptId: string;
    };

type ScheduledTaskOrigin = Extract<TurnOrigin, { kind: 'scheduled_task' }>;
type LegacyAutomationOrigin = Extract<TurnOrigin, { kind: 'legacy_automation' }>;
type GoalOrigin = Extract<TurnOrigin, { kind: 'goal' }>;
type AgentGraphOrigin = Extract<TurnOrigin, { kind: 'agent_graph' }>;

const SCHEDULED_TASK_ORIGIN_SHAPE = defineObjectShape<ScheduledTaskOrigin>()(
  ['kind', 'scheduledTaskId'],
  [],
);
const LEGACY_AUTOMATION_ORIGIN_SHAPE = defineObjectShape<LegacyAutomationOrigin>()(
  ['kind', 'automationId'],
  [],
);
const GOAL_ORIGIN_SHAPE = defineObjectShape<GoalOrigin>()(['kind', 'goalId'], []);
const AGENT_GRAPH_ORIGIN_SHAPE = defineObjectShape<AgentGraphOrigin>()(
  ['kind', 'graphId', 'wakeId', 'attemptId'],
  [],
);

/** Decode a persisted or runtime turn origin, normalizing released Automation rows. */
export function decodeTurnOrigin(value: unknown): TurnOrigin | undefined {
  if (!isRecord(value)) return undefined;
  if (
    hasExactShape(value, SCHEDULED_TASK_ORIGIN_SHAPE) &&
    value.kind === 'scheduled_task' &&
    typeof value.scheduledTaskId === 'string'
  ) {
    return { kind: 'scheduled_task', scheduledTaskId: value.scheduledTaskId };
  }
  if (
    hasExactShape(value, LEGACY_AUTOMATION_ORIGIN_SHAPE) &&
    (value.kind === 'automation' || value.kind === 'legacy_automation') &&
    typeof value.automationId === 'string'
  ) {
    return { kind: 'legacy_automation', automationId: value.automationId };
  }
  if (
    hasExactShape(value, GOAL_ORIGIN_SHAPE) &&
    value.kind === 'goal' &&
    typeof value.goalId === 'string'
  ) {
    return { kind: 'goal', goalId: value.goalId };
  }
  if (
    hasExactShape(value, AGENT_GRAPH_ORIGIN_SHAPE) &&
    value.kind === 'agent_graph' &&
    typeof value.graphId === 'string' &&
    typeof value.wakeId === 'string' &&
    typeof value.attemptId === 'string'
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
