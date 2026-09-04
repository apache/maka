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

import { allResourceAuthority, noneResourceAuthority } from './placeholder-authorities.js';
import {
  processResourceAdmissions,
  type ProcessResourceAdmissionCoordinator,
} from '../process-resource-admission.js';
import type { ToolAuthorityRegistration } from './tool-authority-registry.js';

/** Stable Kimi-policy decisions for tools outside the filesystem domain. */
export const EXPLICIT_NONE_TOOL_AUTHORITY_IDS = Object.freeze([
  'WebSearch',
  'WebFetch',
  // Code Mode is an orchestration container. Its nested leaf calls prepare and
  // acquire their own authorities; the container itself owns only cell capacity.
  'exec',
  'agent_spawn',
  'agent_list',
  'agent_output',
  'view_agent_graph',
  'agent_swarm_status',
  // Turn-scoped immutable inventory + in-memory ranking: no resource lease.
  'SkillSearch',
  // These implementations already own their cross-call correctness through
  // domain admission lanes, transactions, leases, or state-machine gates.
  // Keep them outside Scheduler ordering until their precise ResourceAuthority
  // adapters are completed; execute still enters the real implementation.
  'StopBackgroundTask',
  'WriteStdin',
  'todo_read',
  'todo_write',
  'SearchHistory',
  'ReadHistory',
  'ScheduledTask',
  'GoalSet',
  'GoalClear',
  'GoalStatus',
  'GoalPause',
  'GoalResume',
  'SubmitPlan',
  'update_plan',
  'cancel_plan',
] as const);

export const EXPLICIT_ALL_TOOL_AUTHORITY_IDS = Object.freeze([
  'Bash',
  'update_agent_graph',
  'yield_agent_graph',
  'AskUserQuestion',
  'request_sandbox_boundary',
  'Skill',
  'tool_search',
  'maka_tool_search',
  // The implementation queues by Session, but two Sessions can still drive
  // one physical window. Keep the global fallback until host/window identity
  // is resolved before execution.
  'maka_computer',
] as const);

/**
 * Static policy registrations are composed once into the process registry.
 * Dynamic and newly introduced tools remain safe through registry-miss all().
 */
export function defaultToolAuthorityRegistrations(
  processAdmission: ProcessResourceAdmissionCoordinator = processResourceAdmissions,
): readonly ToolAuthorityRegistration[] {
  return Object.freeze([
    ...EXPLICIT_NONE_TOOL_AUTHORITY_IDS.map((toolId) => [toolId, noneResourceAuthority()] as const),
    ...EXPLICIT_ALL_TOOL_AUTHORITY_IDS.map(
      (toolId) => [toolId, allResourceAuthority(processAdmission)] as const,
    ),
  ]);
}
