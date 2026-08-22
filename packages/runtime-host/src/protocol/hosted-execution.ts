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

import type { MessageContent } from '@maka/core/events';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { decodeSessionCreateInput, type SessionCreateInput } from './session-catalog.js';
import { decodeMessageContent } from './turn.js';

const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'operation_conflict',
  'internal_failure',
] as const;

export interface HostedExecutionStartInput {
  readonly executionId: string;
  readonly session: Omit<SessionCreateInput, 'sessionId'>;
  readonly content: MessageContent;
  readonly maxSteps?: number;
}

export interface HostedExecutionReferenceInput {
  readonly executionId: string;
}

export interface HostedExecutionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export type HostedExecutionProjection =
  | {
      readonly executionId: string;
      readonly kind: 'settled';
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly failureReason?: string;
      readonly usage: HostedExecutionUsage;
      readonly costUsd: number | null;
    }
  | {
      readonly executionId: string;
      readonly kind: 'indeterminate';
      readonly failureReason: string;
    };

export function preservesHostedExecutionEnvironment(
  projection: HostedExecutionProjection,
): boolean {
  return (
    projection.kind === 'settled' &&
    (projection.status === 'completed' || projection.status === 'failed')
  );
}

export const HOSTED_EXECUTION_OPERATION_SPECS = {
  'hosted.execution.start': defineOperation<
    HostedExecutionStartInput,
    HostedExecutionProjection,
    (typeof ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ERRORS,
    usesHostPaths: () => true,
    decodeInput: decodeHostedExecutionStartInput,
    decodeOutput: decodeHostedExecutionProjection,
  }),
  'hosted.execution.cancel': defineOperation<
    HostedExecutionReferenceInput,
    HostedExecutionProjection,
    (typeof ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: decodeHostedExecutionReferenceInput,
    decodeOutput: decodeHostedExecutionProjection,
  }),
} as const;

export function decodeHostedExecutionStartInput(value: unknown): HostedExecutionStartInput {
  const input = requireShapedRecord(
    value,
    'Hosted execution start input',
    ['executionId', 'session', 'content'],
    ['maxSteps'],
  );
  const executionId = requireEntityId(input.executionId, 'executionId');
  const { sessionId: _sessionId, ...session } = decodeSessionCreateInput({
    ...requireRecord(input.session, 'Hosted execution Session'),
    sessionId: executionId,
  });
  return {
    executionId,
    session,
    content: decodeMessageContent(input.content),
    ...(input.maxSteps === undefined
      ? {}
      : { maxSteps: requirePositiveCount(input.maxSteps, 'maxSteps') }),
  };
}

export function decodeHostedExecutionReferenceInput(value: unknown): HostedExecutionReferenceInput {
  const input = requireExactRecord(value, 'Hosted execution reference', ['executionId']);
  return { executionId: requireEntityId(input.executionId, 'executionId') };
}

export function decodeHostedExecutionProjection(value: unknown): HostedExecutionProjection {
  const result = requireRecord(value, 'Hosted execution projection');
  const executionId = requireEntityId(result.executionId, 'executionId');
  if (result.kind === 'indeterminate') {
    const exact = requireExactRecord(result, 'Indeterminate Hosted execution projection', [
      'executionId',
      'kind',
      'failureReason',
    ]);
    return {
      executionId,
      kind: 'indeterminate',
      failureReason: failureReason(exact.failureReason),
    };
  }
  if (result.kind !== 'settled') throw invalidProtocolFrame('Invalid Hosted execution kind');
  if (
    result.status !== 'completed' &&
    result.status !== 'failed' &&
    result.status !== 'cancelled'
  ) {
    throw invalidProtocolFrame('Invalid Hosted execution status');
  }
  const exact = requireShapedRecord(
    result,
    'Settled Hosted execution projection',
    ['executionId', 'kind', 'status', 'usage', 'costUsd'],
    ['failureReason'],
  );
  return {
    executionId,
    kind: 'settled',
    status: result.status,
    ...(exact.failureReason === undefined
      ? {}
      : { failureReason: failureReason(exact.failureReason) }),
    usage: decodeUsage(exact.usage),
    costUsd: decodeCost(exact.costUsd),
  };
}

function decodeUsage(value: unknown): HostedExecutionUsage {
  const usage = requireExactRecord(value, 'Hosted execution usage', [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]);
  return {
    inputTokens: requireCount(usage.inputTokens, 'inputTokens'),
    outputTokens: requireCount(usage.outputTokens, 'outputTokens'),
    cacheReadTokens: requireCount(usage.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: requireCount(usage.cacheWriteTokens, 'cacheWriteTokens'),
    reasoningTokens: requireCount(usage.reasoningTokens, 'reasoningTokens'),
    totalTokens: requireCount(usage.totalTokens, 'totalTokens'),
  };
}

function decodeCost(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidProtocolFrame('Invalid Hosted execution cost');
  }
  return value;
}

function requirePositiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function failureReason(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw invalidProtocolFrame('Invalid Hosted execution failure reason');
  }
  return value;
}
