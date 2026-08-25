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

import { requireEntityId, requireExactRecord } from './codec.js';
import { defineOperation } from './operation-spec.js';

const RESOLVE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type WorkHubCoordinationResolveInput = Record<string, never>;

export interface WorkHubCoordinationResolveResult {
  readonly sessionId: string;
}

export const WORKHUB_COORDINATION_OPERATION_SPECS = {
  'workhub.coordination.resolve': defineOperation<
    WorkHubCoordinationResolveInput,
    WorkHubCoordinationResolveResult,
    (typeof RESOLVE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: RESOLVE_ERRORS,
    decodeInput: decodeWorkHubCoordinationResolveInput,
    decodeOutput: decodeWorkHubCoordinationResolveResult,
  }),
} as const;

export function decodeWorkHubCoordinationResolveInput(
  value: unknown,
): WorkHubCoordinationResolveInput {
  requireExactRecord(value, 'WorkHub Coordination resolve input', []);
  return {};
}

export function decodeWorkHubCoordinationResolveResult(
  value: unknown,
): WorkHubCoordinationResolveResult {
  const result = requireExactRecord(value, 'WorkHub Coordination resolve result', ['sessionId']);
  return {
    sessionId: requireEntityId(result.sessionId, 'WorkHub Coordination Session id'),
  };
}
