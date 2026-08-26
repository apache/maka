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

import { requireEntityId, requireExactRecord, requireUtf8String } from './codec.js';
import { defineOperation } from './operation-spec.js';

const COORDINATION_TEXT_MAX_BYTES = 48 * 1024;
const COORDINATION_SUMMARY_MAX_BYTES = 8 * 1024;

const RESOLVE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

const TURN_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type WorkHubCoordinationResolveInput = Record<string, never>;

export interface WorkHubCoordinationResolveResult {
  readonly sessionId: string;
}

export interface WorkHubCoordinationAnswerInput {
  readonly turnId: string;
  readonly text: string;
}

export interface WorkHubCoordinationRecordInput {
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText: string;
}

export interface WorkHubCoordinationTurnResult {
  readonly turnId: string;
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
  'workhub.coordination.answer': defineOperation<
    WorkHubCoordinationAnswerInput,
    WorkHubCoordinationTurnResult,
    (typeof TURN_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: TURN_ERRORS,
    decodeInput: decodeWorkHubCoordinationAnswerInput,
    decodeOutput: decodeWorkHubCoordinationTurnResult,
  }),
  'workhub.coordination.record': defineOperation<
    WorkHubCoordinationRecordInput,
    WorkHubCoordinationTurnResult,
    (typeof TURN_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: TURN_ERRORS,
    decodeInput: decodeWorkHubCoordinationRecordInput,
    decodeOutput: decodeWorkHubCoordinationTurnResult,
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

export function decodeWorkHubCoordinationAnswerInput(
  value: unknown,
): WorkHubCoordinationAnswerInput {
  const input = requireExactRecord(value, 'WorkHub Coordination answer input', ['turnId', 'text']);
  return {
    turnId: requireEntityId(input.turnId, 'WorkHub Coordination Turn id'),
    text: requireUtf8String(
      input.text,
      'WorkHub Coordination answer text',
      COORDINATION_TEXT_MAX_BYTES,
    ),
  };
}

export function decodeWorkHubCoordinationRecordInput(
  value: unknown,
): WorkHubCoordinationRecordInput {
  const input = requireExactRecord(value, 'WorkHub Coordination record input', [
    'turnId',
    'userText',
    'assistantText',
  ]);
  return {
    turnId: requireEntityId(input.turnId, 'WorkHub Coordination Turn id'),
    userText: requireUtf8String(
      input.userText,
      'WorkHub Coordination user text',
      COORDINATION_TEXT_MAX_BYTES,
    ),
    assistantText: requireUtf8String(
      input.assistantText,
      'WorkHub Coordination assistant text',
      COORDINATION_SUMMARY_MAX_BYTES,
    ),
  };
}

export function decodeWorkHubCoordinationTurnResult(value: unknown): WorkHubCoordinationTurnResult {
  const result = requireExactRecord(value, 'WorkHub Coordination Turn result', ['turnId']);
  return {
    turnId: requireEntityId(result.turnId, 'WorkHub Coordination Turn id'),
  };
}
