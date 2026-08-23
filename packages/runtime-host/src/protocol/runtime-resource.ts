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
  SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
  type ShellRunSnapshotResult,
  type ShellRunUpdate,
  type ShellRunUpdateOwnership,
} from '@maka/core/events';
import { decodeCanonicalShellToolResultContent } from '@maka/core/shell-run-result';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const RUNTIME_RESOURCE_RESULT_MAX_BYTES = 52 * 1024;
export const RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES = 90 * 1024;
export const RUNTIME_RESOURCE_PAGE_MAX_ITEMS = 64;
export const RUNTIME_RESOURCE_CURSOR_MAX_BYTES = 32;
export const RUNTIME_RESOURCE_REF_MAX_BYTES = 256;
export const RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES = 32 * 1024;
export const RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;
export const RUNTIME_RESOURCE_MIN_PTY_COLS = 2;
export const RUNTIME_RESOURCE_MAX_PTY_COLS = 240;
export const RUNTIME_RESOURCE_MIN_PTY_ROWS = 1;
export const RUNTIME_RESOURCE_MAX_PTY_ROWS = 100;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'invalid_request',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'operation_conflict',
  'invalid_request',
  'internal_failure',
] as const;

export type RuntimeResourceRevision = `sha256:${string}`;

export type RuntimeResourceQueryInput =
  | { readonly kind: 'list_start'; readonly sessionId: string }
  | {
      readonly kind: 'list_continue';
      readonly sessionId: string;
      readonly revision: RuntimeResourceRevision;
      readonly cursor: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string; readonly ref: string };

export type RuntimeResourceQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly revision: RuntimeResourceRevision;
      readonly resources: readonly ShellRunUpdate[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: RuntimeResourceRevision;
      readonly actual: RuntimeResourceRevision;
    }
  | {
      readonly kind: 'resource';
      readonly sessionId: string;
      readonly revision: RuntimeResourceRevision;
      readonly resource: ShellRunUpdate | null;
    };

export interface RuntimeResourceControllerAcquireInput {
  readonly sessionId: string;
  readonly ref: string;
  readonly controllerId: string;
}

export interface RuntimeResourceControllerAcquireResult {
  readonly controllerId: string;
  readonly nextSequence: number;
  readonly pty: RuntimeResourcePtySnapshot;
}

export interface RuntimeResourcePtySnapshot {
  readonly sessionId: string;
  readonly ref: string;
  readonly sequence: number;
  readonly buffer: string;
  readonly size: { readonly cols: number; readonly rows: number };
}

export type RuntimeResourcePtyControl =
  | { readonly kind: 'input'; readonly input: string }
  | { readonly kind: 'resize'; readonly cols: number; readonly rows: number }
  | {
      readonly kind: 'input_and_resize';
      readonly input: string;
      readonly cols: number;
      readonly rows: number;
    };

export interface RuntimeResourceControllerControlInput {
  readonly sessionId: string;
  readonly ref: string;
  readonly controllerId: string;
  readonly sequence: number;
  readonly control: RuntimeResourcePtyControl;
}

export interface RuntimeResourceControllerControlResult {
  readonly controllerId: string;
  readonly sequence: number;
  readonly resource: ShellRunSnapshotResult;
}

export interface RuntimeResourceControllerReleaseInput {
  readonly sessionId: string;
  readonly ref: string;
  readonly controllerId: string;
}

export interface RuntimeResourceControllerReleaseResult {
  readonly controllerId: string;
  readonly released: boolean;
}

export interface RuntimeResourceStopInput {
  readonly sessionId: string;
  readonly ref: string;
}

export interface RuntimeResourceStartInput {
  readonly sessionId: string;
  readonly launchId: string;
}

export interface RuntimeResourceStartResult {
  readonly resource: ShellRunSnapshotResult;
}

export interface RuntimeResourceStopResult {
  readonly resource: ShellRunSnapshotResult;
}

export const RUNTIME_RESOURCE_OPERATION_SPECS = {
  'runtime.resource.query': defineOperation<
    RuntimeResourceQueryInput,
    RuntimeResourceQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeRuntimeResourceQueryInput,
    decodeOutput: decodeRuntimeResourceQueryResult,
  }),
  'runtime.resource.start': defineOperation<
    RuntimeResourceStartInput,
    RuntimeResourceStartResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRuntimeResourceStartInput,
    decodeOutput: decodeRuntimeResourceStartResult,
  }),
  'runtime.resource.controller.acquire': defineOperation<
    RuntimeResourceControllerAcquireInput,
    RuntimeResourceControllerAcquireResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRuntimeResourceControllerAcquireInput,
    decodeOutput: decodeRuntimeResourceControllerAcquireResult,
  }),
  'runtime.resource.controller.control': defineOperation<
    RuntimeResourceControllerControlInput,
    RuntimeResourceControllerControlResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRuntimeResourceControllerControlInput,
    decodeOutput: decodeRuntimeResourceControllerControlResult,
  }),
  'runtime.resource.controller.release': defineOperation<
    RuntimeResourceControllerReleaseInput,
    RuntimeResourceControllerReleaseResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRuntimeResourceControllerReleaseInput,
    decodeOutput: decodeRuntimeResourceControllerReleaseResult,
  }),
  'runtime.resource.stop': defineOperation<
    RuntimeResourceStopInput,
    RuntimeResourceStopResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeRuntimeResourceStopInput,
    decodeOutput: decodeRuntimeResourceStopResult,
  }),
} as const;

export function decodeRuntimeResourceStartInput(value: unknown): RuntimeResourceStartInput {
  const input = requireExactRecord(value, 'Runtime Resource start input', [
    'sessionId',
    'launchId',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    launchId: requireId(input.launchId, 'launchId'),
  };
}

export function decodeRuntimeResourceStartResult(value: unknown): RuntimeResourceStartResult {
  const result = requireExactRecord(value, 'Runtime Resource start result', ['resource']);
  const decoded = { resource: decodeRuntimeResourceSnapshot(result.resource) };
  requireEncodedByteLimit(
    decoded,
    'Runtime Resource start result',
    RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeRuntimeResourceQueryInput(value: unknown): RuntimeResourceQueryInput {
  const record = requireRecord(value, 'Runtime Resource query input');
  if (record.kind === 'list_start') {
    const input = requireExactRecord(record, 'Runtime Resource list start input', [
      'kind',
      'sessionId',
    ]);
    return { kind: 'list_start', sessionId: requireEntityId(input.sessionId, 'sessionId') };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'Runtime Resource list continuation input', [
      'kind',
      'sessionId',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      revision: runtimeResourceRevision(input.revision, 'Runtime Resource revision'),
      cursor: boundedCursor(input.cursor, 'Runtime Resource cursor'),
    };
  }
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'Runtime Resource get input', [
      'kind',
      'sessionId',
      'ref',
    ]);
    return {
      kind: 'get',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      ref: decodeRuntimeResourceRef(input.ref),
    };
  }
  throw invalidProtocolFrame('Invalid Runtime Resource query kind');
}

export function decodeRuntimeResourceQueryResult(value: unknown): RuntimeResourceQueryResult {
  const record = requireRecord(value, 'Runtime Resource query result');
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'Runtime Resource revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: runtimeResourceRevision(result.expected, 'expected Runtime Resource revision'),
      actual: runtimeResourceRevision(result.actual, 'actual Runtime Resource revision'),
    };
  }
  if (record.kind === 'resource') {
    const result = requireExactRecord(record, 'Runtime Resource result', [
      'kind',
      'sessionId',
      'revision',
      'resource',
    ]);
    const decoded: RuntimeResourceQueryResult = {
      kind: 'resource',
      sessionId: requireEntityId(result.sessionId, 'sessionId'),
      revision: runtimeResourceRevision(result.revision, 'Runtime Resource revision'),
      resource: result.resource === null ? null : decodeRuntimeResourceUpdate(result.resource),
    };
    requireEncodedByteLimit(decoded, 'Runtime Resource result', RUNTIME_RESOURCE_RESULT_MAX_BYTES);
    return decoded;
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid Runtime Resource result kind');
  const result = requireExactRecord(record, 'Runtime Resource page result', [
    'kind',
    'sessionId',
    'revision',
    'resources',
    'nextCursor',
  ]);
  if (
    !Array.isArray(result.resources) ||
    result.resources.length > RUNTIME_RESOURCE_PAGE_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Runtime Resource page exceeds item limit');
  }
  const decoded: RuntimeResourceQueryResult = {
    kind: 'page',
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    revision: runtimeResourceRevision(result.revision, 'Runtime Resource revision'),
    resources: result.resources.map(decodeRuntimeResourceUpdate),
    nextCursor:
      result.nextCursor === null
        ? null
        : boundedCursor(result.nextCursor, 'Runtime Resource next cursor'),
  };
  requireEncodedByteLimit(decoded, 'Runtime Resource page', RUNTIME_RESOURCE_RESULT_MAX_BYTES);
  return decoded;
}

export function decodeRuntimeResourceControllerAcquireInput(
  value: unknown,
): RuntimeResourceControllerAcquireInput {
  return decodeControllerIdentity(value, 'Runtime Resource controller acquire input');
}

export function decodeRuntimeResourceControllerAcquireResult(
  value: unknown,
): RuntimeResourceControllerAcquireResult {
  const result = requireExactRecord(value, 'Runtime Resource controller acquire result', [
    'controllerId',
    'nextSequence',
    'pty',
  ]);
  const decoded = {
    controllerId: requireEntityId(result.controllerId, 'controllerId'),
    nextSequence: positiveCount(result.nextSequence, 'nextSequence'),
    pty: decodeRuntimeResourcePtySnapshot(result.pty),
  };
  requireEncodedByteLimit(
    decoded,
    'Runtime Resource controller acquire result',
    RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES,
  );
  return decoded;
}

function decodeRuntimeResourcePtySnapshot(value: unknown): RuntimeResourcePtySnapshot {
  const snapshot = requireExactRecord(value, 'Runtime Resource PTY snapshot', [
    'sessionId',
    'ref',
    'sequence',
    'buffer',
    'size',
  ]);
  const size = requireExactRecord(snapshot.size, 'Runtime Resource PTY size', ['cols', 'rows']);
  const decodedSize = decodeSize(size.cols, size.rows);
  return {
    sessionId: requireEntityId(snapshot.sessionId, 'sessionId'),
    ref: decodeRuntimeResourceRef(snapshot.ref),
    sequence: requireCount(snapshot.sequence, 'PTY sequence'),
    buffer: ptyBuffer(snapshot.buffer),
    size: decodedSize,
  };
}

function ptyBuffer(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 80 * 1024) {
    throw invalidProtocolFrame('Invalid PTY buffer');
  }
  return value;
}

export function decodeRuntimeResourceControllerControlInput(
  value: unknown,
): RuntimeResourceControllerControlInput {
  const input = requireExactRecord(value, 'Runtime Resource controller control input', [
    'sessionId',
    'ref',
    'controllerId',
    'sequence',
    'control',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    ref: decodeRuntimeResourceRef(input.ref),
    controllerId: requireEntityId(input.controllerId, 'controllerId'),
    sequence: controlSequence(input.sequence, 'controller sequence'),
    control: decodePtyControl(input.control),
  };
}

export function decodeRuntimeResourceControllerControlResult(
  value: unknown,
): RuntimeResourceControllerControlResult {
  const result = requireExactRecord(value, 'Runtime Resource controller control result', [
    'controllerId',
    'sequence',
    'resource',
  ]);
  const decoded = {
    controllerId: requireEntityId(result.controllerId, 'controllerId'),
    sequence: controlSequence(result.sequence, 'controller sequence'),
    resource: decodeRuntimeResourceSnapshot(result.resource),
  };
  requireEncodedByteLimit(
    decoded,
    'Runtime Resource controller control result',
    RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeRuntimeResourceControllerReleaseInput(
  value: unknown,
): RuntimeResourceControllerReleaseInput {
  return decodeControllerIdentity(value, 'Runtime Resource controller release input');
}

export function decodeRuntimeResourceControllerReleaseResult(
  value: unknown,
): RuntimeResourceControllerReleaseResult {
  const result = requireExactRecord(value, 'Runtime Resource controller release result', [
    'controllerId',
    'released',
  ]);
  if (typeof result.released !== 'boolean') {
    throw invalidProtocolFrame('Invalid Runtime Resource controller release result');
  }
  return {
    controllerId: requireEntityId(result.controllerId, 'controllerId'),
    released: result.released,
  };
}

export function decodeRuntimeResourceStopInput(value: unknown): RuntimeResourceStopInput {
  const input = requireExactRecord(value, 'Runtime Resource stop input', ['sessionId', 'ref']);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    ref: decodeRuntimeResourceRef(input.ref),
  };
}

export function decodeRuntimeResourceStopResult(value: unknown): RuntimeResourceStopResult {
  const result = requireExactRecord(value, 'Runtime Resource stop result', ['resource']);
  const decoded = { resource: decodeRuntimeResourceSnapshot(result.resource) };
  requireEncodedByteLimit(
    decoded,
    'Runtime Resource stop result',
    RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeRuntimeResourceUpdate(value: unknown): ShellRunUpdate {
  const update = requireExactRecord(value, 'Runtime Resource update', [
    'sessionId',
    'ownership',
    'sourceTurnId',
    'sourceToolCallId',
    'result',
  ]);
  return {
    sessionId: requireEntityId(update.sessionId, 'sessionId'),
    ownership: decodeOwnership(update.ownership),
    sourceTurnId: requireEntityId(update.sourceTurnId, 'sourceTurnId'),
    sourceToolCallId: requireUtf8String(
      update.sourceToolCallId,
      'sourceToolCallId',
      SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
    ),
    result: decodeRuntimeResourceState(update.result),
  };
}

export function decodeRuntimeResourceState(value: unknown): ShellRunUpdate['result'] {
  const decoded = decodeCanonicalShellToolResultContent(value);
  if (
    decoded.state !== 'valid' ||
    decoded.content.kind !== 'shell_run' ||
    decoded.content.operation !== undefined
  ) {
    throw invalidProtocolFrame('Invalid Runtime Resource state');
  }
  return decoded.content;
}

export function decodeRuntimeResourceSnapshot(value: unknown): ShellRunSnapshotResult {
  const decoded = decodeRuntimeResourceState(value);
  if (decoded.output === undefined) {
    throw invalidProtocolFrame('Invalid Runtime Resource snapshot');
  }
  return decoded;
}

function decodeControllerIdentity(
  value: unknown,
  label: string,
): RuntimeResourceControllerAcquireInput {
  const input = requireExactRecord(value, label, ['sessionId', 'ref', 'controllerId']);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    ref: decodeRuntimeResourceRef(input.ref),
    controllerId: requireEntityId(input.controllerId, 'controllerId'),
  };
}

function decodePtyControl(value: unknown): RuntimeResourcePtyControl {
  const control = requireRecord(value, 'Runtime Resource PTY control');
  if (control.kind === 'input') {
    const input = requireExactRecord(control, 'Runtime Resource PTY input control', [
      'kind',
      'input',
    ]);
    return { kind: 'input', input: controlInput(input.input) };
  }
  if (control.kind === 'resize') {
    const resize = requireExactRecord(control, 'Runtime Resource PTY resize control', [
      'kind',
      'cols',
      'rows',
    ]);
    return { kind: 'resize', ...decodeSize(resize.cols, resize.rows) };
  }
  if (control.kind === 'input_and_resize') {
    const combined = requireExactRecord(control, 'Runtime Resource PTY combined control', [
      'kind',
      'input',
      'cols',
      'rows',
    ]);
    return {
      kind: 'input_and_resize',
      input: controlInput(combined.input),
      ...decodeSize(combined.cols, combined.rows),
    };
  }
  throw invalidProtocolFrame('Invalid Runtime Resource PTY control kind');
}

function decodeSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (
    !Number.isInteger(cols) ||
    (cols as number) < RUNTIME_RESOURCE_MIN_PTY_COLS ||
    (cols as number) > RUNTIME_RESOURCE_MAX_PTY_COLS ||
    !Number.isInteger(rows) ||
    (rows as number) < RUNTIME_RESOURCE_MIN_PTY_ROWS ||
    (rows as number) > RUNTIME_RESOURCE_MAX_PTY_ROWS
  ) {
    throw invalidProtocolFrame('Invalid Runtime Resource PTY size');
  }
  return { cols: cols as number, rows: rows as number };
}

function decodeOwnership(value: unknown): ShellRunUpdateOwnership {
  const ownership = requireRecord(value, 'Runtime Resource ownership');
  if (ownership.kind === 'local') {
    requireExactRecord(ownership, 'local Runtime Resource ownership', ['kind']);
    return { kind: 'local' };
  }
  if (ownership.kind === 'source_owned') {
    const source = requireExactRecord(ownership, 'source-owned Runtime Resource ownership', [
      'kind',
      'sourceSessionId',
      'ownerSessionId',
    ]);
    return {
      kind: 'source_owned',
      sourceSessionId: requireEntityId(source.sourceSessionId, 'sourceSessionId'),
      ownerSessionId: requireEntityId(source.ownerSessionId, 'ownerSessionId'),
    };
  }
  if (ownership.kind === 'source_unavailable') {
    const source = requireExactRecord(ownership, 'unavailable Runtime Resource ownership', [
      'kind',
      'sourceSessionId',
    ]);
    return {
      kind: 'source_unavailable',
      sourceSessionId: requireEntityId(source.sourceSessionId, 'sourceSessionId'),
    };
  }
  throw invalidProtocolFrame('Invalid Runtime Resource ownership kind');
}

function runtimeResourceRevision(value: unknown, label: string): RuntimeResourceRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as RuntimeResourceRevision;
}

function boundedCursor(value: unknown, label: string): string {
  return requireUtf8String(value, label, RUNTIME_RESOURCE_CURSOR_MAX_BYTES);
}

export function decodeRuntimeResourceRef(value: unknown): string {
  return requireUtf8String(value, 'Runtime Resource ref', RUNTIME_RESOURCE_REF_MAX_BYTES);
}

function controlInput(value: unknown): string {
  return requireUtf8String(
    value,
    'Runtime Resource PTY input',
    RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES,
  );
}

function positiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count < 1) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function controlSequence(value: unknown, label: string): number {
  const sequence = positiveCount(value, label);
  if (sequence > RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return sequence;
}
