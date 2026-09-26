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
  requireRecord,
  requireExactRecord,
  requireShapedRecord,
  requireEntityId,
  requireCount,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export type RuntimeResourceHandoffInput =
  | { readonly action: 'lookup'; readonly sessionId: string; readonly ref: string }
  | { readonly action: 'surface'; readonly sessionId: string; readonly available: boolean }
  | {
      readonly action: 'ready' | 'observe' | 'release';
      readonly sessionId: string;
      readonly requestId: string;
      readonly controllerId: string;
    }
  | {
      readonly action: 'input';
      readonly sessionId: string;
      readonly requestId: string;
      readonly controllerId: string;
      readonly sequence: number;
      readonly input: string;
    }
  | {
      readonly action: 'share';
      readonly sessionId: string;
      readonly requestId: string;
      readonly controllerId: string;
      readonly sequence: number;
      readonly text: string;
    };

export interface RuntimeResourceHandoffResult {
  readonly status:
    | 'available'
    | 'unavailable'
    | 'ready'
    | 'written'
    | 'outcome_unknown'
    | 'shared'
    | 'observed';
  readonly nextSequence: number;
  readonly phase: 'waiting' | 'human' | 'resumed' | 'closed';
  /** Private live projection: never journal or attach to a model tool result. */
  readonly display?: {
    readonly sequence: number;
    readonly text: string;
    readonly inputOpen: boolean;
  };
  readonly request?: {
    readonly requestId: string;
    readonly ref: string;
    readonly message: string;
    readonly command: string;
  };
}

export function decodeRuntimeResourceHandoffInput(value: unknown): RuntimeResourceHandoffInput {
  const record = requireRecord(value, 'Terminal handoff');
  const sessionId = requireEntityId(record.sessionId, 'sessionId');
  if (record.action === 'lookup') {
    requireExactRecord(record, 'Terminal handoff lookup', ['action', 'sessionId', 'ref']);
    return { action: 'lookup', sessionId, ref: requireUtf8String(record.ref, 'ref', 256) };
  }
  if (record.action === 'surface') {
    requireExactRecord(record, 'Terminal surface', ['action', 'sessionId', 'available']);
    if (typeof record.available !== 'boolean')
      throw invalidProtocolFrame('Invalid terminal surface readiness');
    return { action: 'surface', sessionId, available: record.available };
  }
  const requestId = requireEntityId(record.requestId, 'requestId');
  const controllerId = requireEntityId(record.controllerId, 'controllerId');
  const base = { sessionId, requestId, controllerId };
  if (record.action === 'ready' || record.action === 'observe' || record.action === 'release') {
    requireExactRecord(record, 'Terminal handoff control', [
      'action',
      'sessionId',
      'requestId',
      'controllerId',
    ]);
    return { ...base, action: record.action };
  }
  const sequence = requireCount(record.sequence, 'sequence');
  if (sequence >= Number.MAX_SAFE_INTEGER)
    throw invalidProtocolFrame('Invalid terminal input sequence');
  if (record.action === 'input') {
    requireExactRecord(record, 'Private terminal input', [
      'action',
      'sessionId',
      'requestId',
      'controllerId',
      'sequence',
      'input',
    ]);
    return {
      ...base,
      action: 'input',
      sequence,
      input: requireUtf8String(record.input, 'private input', 32 * 1024),
    };
  }
  if (record.action === 'share') {
    requireExactRecord(record, 'Terminal observation', [
      'action',
      'sessionId',
      'requestId',
      'controllerId',
      'sequence',
      'text',
    ]);
    return {
      ...base,
      action: 'share',
      sequence,
      text: requireUtf8String(record.text, 'reviewed observation', 8_000),
    };
  }
  throw invalidProtocolFrame('Unsupported terminal handoff action');
}

export function decodeRuntimeResourceHandoffResult(value: unknown): RuntimeResourceHandoffResult {
  const record = requireShapedRecord(
    value,
    'Terminal handoff result',
    ['status', 'nextSequence', 'phase'],
    ['display', 'request'],
  );
  if (
    ![
      'available',
      'unavailable',
      'ready',
      'written',
      'outcome_unknown',
      'shared',
      'observed',
    ].includes(record.status as string) ||
    !['waiting', 'human', 'resumed', 'closed'].includes(record.phase as string)
  ) {
    throw invalidProtocolFrame('Invalid terminal handoff state');
  }
  let display: RuntimeResourceHandoffResult['display'];
  let request: RuntimeResourceHandoffResult['request'];
  if (record.request !== undefined) {
    const item = requireExactRecord(record.request, 'Terminal handoff request', [
      'requestId',
      'ref',
      'message',
      'command',
    ]);
    request = {
      requestId: requireEntityId(item.requestId, 'requestId'),
      ref: requireUtf8String(item.ref, 'ref', 256),
      message: requireUtf8String(item.message, 'message', 2_048),
      command: requireUtf8String(item.command, 'command', 4_096),
    };
  }
  if (record.display !== undefined) {
    const screen = requireExactRecord(record.display, 'Private terminal display', [
      'sequence',
      'text',
      'inputOpen',
    ]);
    if (typeof screen.inputOpen !== 'boolean')
      throw invalidProtocolFrame('Invalid terminal input state');
    display = {
      sequence: requireCount(screen.sequence, 'sequence'),
      text: requireUtf8String(screen.text, 'private display', 48 * 1024),
      inputOpen: screen.inputOpen,
    };
  }
  return {
    status: record.status as RuntimeResourceHandoffResult['status'],
    phase: record.phase as RuntimeResourceHandoffResult['phase'],
    nextSequence: requireCount(record.nextSequence, 'nextSequence'),
    ...(display ? { display } : {}),
    ...(request ? { request } : {}),
  };
}

export const TERMINAL_HANDOFF_OPERATION_SPECS = {
  'runtime.resource.handoff': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'operation_conflict',
      'invalid_request',
      'internal_failure',
    ] as const,
    decodeInput: decodeRuntimeResourceHandoffInput,
    decodeOutput: decodeRuntimeResourceHandoffResult,
  }),
} as const;
