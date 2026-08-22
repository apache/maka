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

import type {
  ShellRunSnapshotResult,
  ShellRunStateResult,
  ShellRunUpdate,
  SandboxDenialSignal,
  SandboxDenialRecovery,
  ToolResultContent,
} from './events.js';
import { defineObjectShape, hasExactShape } from './record-schema.js';
import {
  isShellOutput,
  isShellRunStatus,
  isValidShellRunState,
  type ShellOutput,
  type ShellRunStatus,
} from './shell-run.js';

export type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;
type TerminalToolResult = Extract<ToolResultContent, { kind: 'terminal' }>;
type ShellToolResult = TerminalToolResult | ShellRunToolResult;
type ShellRunToolResultRecord = Omit<ShellRunToolResult, 'output' | 'operation'> & {
  output?: ShellOutput;
  operation?: ShellRunToolResult extends { operation?: infer Operation } ? Operation : never;
};

/** Bounds observer updates retained while a durable ShellRun view is hydrating. */
export const SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES = 256;

export interface ShellRunUpdateBufferDrain {
  updates: ShellRunUpdate[];
  overflowed: boolean;
}

export class ShellRunUpdateBuffer {
  private readonly updates = new Map<string, ShellRunUpdate>();
  private overflowed = false;

  constructor(
    private readonly context: string,
    private readonly maxEntries = SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('ShellRun update buffer capacity must be a positive integer');
    }
  }

  get size(): number {
    return this.updates.size;
  }

  add(candidate: ShellRunUpdate): void {
    const key = `${candidate.sessionId}\0${candidate.result.ref}`;
    const current = this.updates.get(key);
    const merged = mergeShellRunUpdate(current, candidate, this.context);
    if (current && !merged.changed) return;
    this.updates.delete(key);
    this.updates.set(key, merged.update);
    if (this.updates.size <= this.maxEntries) return;
    const oldestKey = this.updates.keys().next().value;
    if (oldestKey !== undefined) {
      this.updates.delete(oldestKey);
      this.overflowed = true;
    }
  }

  drain(): ShellRunUpdateBufferDrain {
    const drained = {
      updates: [...this.updates.values()],
      overflowed: this.overflowed,
    };
    this.updates.clear();
    this.overflowed = false;
    return drained;
  }

  clear(): void {
    this.updates.clear();
    this.overflowed = false;
  }
}

export type ShellToolResultNormalization =
  | { state: 'not_shell' }
  | { state: 'invalid' }
  | { state: 'valid'; content: ShellToolResult };

const CURRENT_TERMINAL_RESULT_SHAPE = defineObjectShape<TerminalToolResult>()(
  ['kind', 'cwd', 'cmd', 'status', 'output'],
  ['exitCode', 'failureMessage', 'sandboxDenial'],
);

const CURRENT_SHELL_RUN_RESULT_SHAPE = defineObjectShape<ShellRunToolResultRecord>()(
  ['kind', 'ref', 'mode', 'status', 'cwd', 'cmd', 'startedAt', 'updatedAt', 'revision'],
  [
    'completedAt',
    'exitCode',
    'failureMessage',
    'timeoutMs',
    'output',
    'operation',
    'sandboxDenial',
  ],
);

const SANDBOX_DENIAL_SIGNAL_SHAPE = defineObjectShape<SandboxDenialSignal>()(
  ['likely'],
  ['backend'],
);

const SANDBOX_DENIAL_RECOVERY_SHAPE = defineObjectShape<SandboxDenialRecovery>()(
  ['likely', 'recovery'],
  ['backend'],
);

const STOP_OPERATION_KEYS = new Set(['kind', 'applied']);
const PTY_CONTROL_OPERATION_KEYS = new Set(['kind', 'failed', 'input', 'resize']);
const PTY_CONTROL_INPUT_KEYS = new Set(['bytes', 'queued']);
const PTY_CONTROL_RESIZE_KEYS = new Set(['cols', 'rows', 'applied', 'changed']);

export function decodeCanonicalShellToolResultContent(
  value: unknown,
): ShellToolResultNormalization {
  if (!isRecord(value) || (value.kind !== 'terminal' && value.kind !== 'shell_run')) {
    return { state: 'not_shell' };
  }
  const current =
    value.kind === 'terminal' ? currentTerminalResult(value) : currentShellRunResult(value);
  return current ? { state: 'valid', content: current } : { state: 'invalid' };
}

function currentTerminalResult(value: Record<string, unknown>): TerminalToolResult | undefined {
  if (
    !hasExactShape(value, CURRENT_TERMINAL_RESULT_SHAPE) ||
    typeof value.cwd !== 'string' ||
    typeof value.cmd !== 'string' ||
    !isTerminalStatus(value.status) ||
    !isOptionalFiniteNumber(value.exitCode) ||
    !isOptionalString(value.failureMessage) ||
    !isOptionalSandboxDenial(value.sandboxDenial) ||
    !isShellOutput(value.output) ||
    !isValidTerminalState(value)
  )
    return undefined;
  return value as TerminalToolResult;
}

function isValidTerminalState(value: Record<string, unknown>): boolean {
  switch (value.status) {
    case 'completed':
      return value.exitCode === 0 && value.failureMessage === undefined;
    case 'failed':
      return (
        (isFiniteNumber(value.exitCode) && value.exitCode !== 0) ||
        (value.exitCode === undefined &&
          typeof value.failureMessage === 'string' &&
          value.failureMessage.length > 0)
      );
    case 'timed_out':
      return value.exitCode === 124;
    case 'cancelled':
      return value.exitCode === 130;
    default:
      return false;
  }
}

function currentShellRunResult(value: Record<string, unknown>): ShellRunToolResult | undefined {
  if (
    !hasExactShape(value, CURRENT_SHELL_RUN_RESULT_SHAPE) ||
    typeof value.ref !== 'string' ||
    (value.mode !== 'pipes' && value.mode !== 'pty') ||
    !isShellRunStatus(value.status) ||
    typeof value.cwd !== 'string' ||
    typeof value.cmd !== 'string' ||
    !isFiniteNumber(value.startedAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !isPositiveInteger(value.revision) ||
    !isOptionalFiniteNumber(value.completedAt) ||
    !isOptionalFiniteNumber(value.exitCode) ||
    !isOptionalFiniteNumber(value.timeoutMs) ||
    !isOptionalString(value.failureMessage) ||
    !isOptionalSandboxDenial(value.sandboxDenial) ||
    (value.output !== undefined &&
      (!isShellOutput(value.output) || value.output.mode !== value.mode)) ||
    !isCurrentShellRunOperation(value.operation, value.mode, value.output !== undefined) ||
    !isValidShellRunState(value)
  )
    return undefined;
  return value as ShellRunToolResult;
}

function isTerminalStatus(
  value: unknown,
): value is Exclude<ShellRunStatus, 'starting' | 'running' | 'orphaned'> {
  return (
    value === 'completed' || value === 'failed' || value === 'timed_out' || value === 'cancelled'
  );
}

function isCurrentShellRunOperation(value: unknown, mode: unknown, hasOutput: boolean): boolean {
  if (value === undefined) return true;
  if (!hasOutput || !isRecord(value)) return false;
  if (value.kind === 'stop') {
    return hasOnlyKeys(value, STOP_OPERATION_KEYS) && typeof value.applied === 'boolean';
  }
  if (
    value.kind !== 'pty_control' ||
    mode !== 'pty' ||
    !hasOnlyKeys(value, PTY_CONTROL_OPERATION_KEYS) ||
    typeof value.failed !== 'boolean' ||
    (value.input === undefined && value.resize === undefined)
  )
    return false;
  if (
    value.input !== undefined &&
    (!isRecord(value.input) ||
      !hasOnlyKeys(value.input, PTY_CONTROL_INPUT_KEYS) ||
      !isNonNegativeInteger(value.input.bytes) ||
      typeof value.input.queued !== 'boolean')
  )
    return false;
  return (
    value.resize === undefined ||
    (isRecord(value.resize) &&
      hasOnlyKeys(value.resize, PTY_CONTROL_RESIZE_KEYS) &&
      isPositiveInteger(value.resize.cols) &&
      isPositiveInteger(value.resize.rows) &&
      typeof value.resize.applied === 'boolean' &&
      typeof value.resize.changed === 'boolean')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isSandboxDenialSignal(value: unknown): value is SandboxDenialSignal {
  return (
    isRecord(value) &&
    hasExactShape(value, SANDBOX_DENIAL_SIGNAL_SHAPE) &&
    value.likely === true &&
    (value.backend === undefined ||
      value.backend === 'macos-seatbelt' ||
      value.backend === 'linux' ||
      value.backend === 'windows')
  );
}

function isOptionalSandboxDenial(value: unknown): boolean {
  return (
    value === undefined ||
    isSandboxDenialSignal(value) ||
    (isRecord(value) &&
      hasExactShape(value, SANDBOX_DENIAL_RECOVERY_SHAPE) &&
      value.likely === true &&
      (value.backend === undefined ||
        value.backend === 'macos-seatbelt' ||
        value.backend === 'linux' ||
        value.backend === 'windows') &&
      value.recovery === 'require_escalated')
  );
}

export interface ShellRunStateMerge<Result extends ShellRunStateResult = ShellRunStateResult> {
  result: Result;
  changed: boolean;
  invariantViolation?: 'ref_mismatch' | 'same_revision_conflict';
}

export interface ShellRunMergeDiagnostic {
  context: string;
  violation: NonNullable<ShellRunStateMerge['invariantViolation']>;
  currentRef?: string;
  candidateRef: string;
  currentRevision?: number;
  candidateRevision: number;
}

export type ShellRunMergeDiagnosticReporter = (diagnostic: ShellRunMergeDiagnostic) => void;

export interface ShellRunUpdateMerge {
  update: ShellRunUpdate;
  changed: boolean;
}

export function shellRunStateProjection(result: ShellRunToolResult): ShellRunStateResult {
  const { operation: _operation, ...state } = result;
  return state;
}

export function mergeShellRunState(
  current: ShellRunSnapshotResult | undefined,
  candidate: ShellRunSnapshotResult,
): ShellRunStateMerge<ShellRunSnapshotResult>;
export function mergeShellRunState(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
): ShellRunStateMerge;
export function mergeShellRunState(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
): ShellRunStateMerge {
  const next = shellRunStateProjection(candidate);
  if (!current) return { result: next, changed: true };

  const previous = shellRunStateProjection(current);
  if (previous.ref !== next.ref) {
    return { result: previous, changed: false, invariantViolation: 'ref_mismatch' };
  }
  if (next.revision > previous.revision) return { result: next, changed: true };
  if (next.revision < previous.revision) return { result: previous, changed: false };

  if (!sameMetadata(previous, next)) {
    return { result: previous, changed: false, invariantViolation: 'same_revision_conflict' };
  }
  if (previous.output === undefined && next.output !== undefined) {
    return { result: next, changed: true };
  }
  if (previous.output !== undefined && next.output === undefined) {
    return { result: previous, changed: false };
  }
  if (shellOutputEqual(previous.output, next.output)) {
    return { result: previous, changed: false };
  }
  return { result: previous, changed: false, invariantViolation: 'same_revision_conflict' };
}

export function mergeShellRunStateWithDiagnostics(
  current: ShellRunSnapshotResult | undefined,
  candidate: ShellRunSnapshotResult,
  context: string,
  report?: ShellRunMergeDiagnosticReporter,
): ShellRunStateMerge<ShellRunSnapshotResult>;
export function mergeShellRunStateWithDiagnostics(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
  context: string,
  report?: ShellRunMergeDiagnosticReporter,
): ShellRunStateMerge;
export function mergeShellRunStateWithDiagnostics(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
  context: string,
  report: ShellRunMergeDiagnosticReporter = reportShellRunMergeDiagnostic,
): ShellRunStateMerge {
  const merged = mergeShellRunState(current, candidate);
  if (merged.invariantViolation) {
    report({
      context,
      violation: merged.invariantViolation,
      ...(current ? { currentRef: current.ref, currentRevision: current.revision } : {}),
      candidateRef: candidate.ref,
      candidateRevision: candidate.revision,
    });
  }
  return merged;
}

export function mergeShellRunUpdate(
  current: ShellRunUpdate | undefined,
  candidate: ShellRunUpdate,
  context: string,
  report?: ShellRunMergeDiagnosticReporter,
): ShellRunUpdateMerge {
  if (!current) return { update: candidate, changed: true };
  const merged = mergeShellRunStateWithDiagnostics(
    current.result,
    candidate.result,
    context,
    report,
  );
  const candidateMetadataIsCurrent =
    current.result.ref === candidate.result.ref &&
    candidate.result.revision >= current.result.revision;
  const metadata = candidateMetadataIsCurrent ? candidate : current;
  const update = { ...metadata, result: merged.result };
  return {
    update,
    changed: merged.changed || !shellRunUpdateMetadataEqual(current, update),
  };
}

export function projectShellRunUpdateForSession(
  sessionId: string,
  current: readonly ShellRunUpdate[],
  source: ShellRunUpdate,
): ShellRunUpdate[] {
  if (source.sessionId === sessionId) return [source];
  return current.flatMap((view) =>
    view.sessionId === sessionId &&
    view.ownership.kind === 'source_owned' &&
    view.ownership.ownerSessionId === source.sessionId &&
    view.result.ref === source.result.ref
      ? [{ ...view, result: source.result }]
      : [],
  );
}

function reportShellRunMergeDiagnostic(diagnostic: ShellRunMergeDiagnostic): void {
  console.warn('[shell-run] state reconciliation invariant violation', diagnostic);
}

function shellRunUpdateMetadataEqual(left: ShellRunUpdate, right: ShellRunUpdate): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sourceTurnId === right.sourceTurnId &&
    left.sourceToolCallId === right.sourceToolCallId &&
    shellRunOwnershipEqual(left.ownership, right.ownership)
  );
}

function shellRunOwnershipEqual(
  left: ShellRunUpdate['ownership'],
  right: ShellRunUpdate['ownership'],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'local' && right.kind === 'local') return true;
  if (left.kind === 'source_owned' && right.kind === 'source_owned') {
    return (
      left.sourceSessionId === right.sourceSessionId && left.ownerSessionId === right.ownerSessionId
    );
  }
  return (
    left.kind === 'source_unavailable' &&
    right.kind === 'source_unavailable' &&
    left.sourceSessionId === right.sourceSessionId
  );
}

function sameMetadata(left: ShellRunStateResult, right: ShellRunStateResult): boolean {
  return (
    left.mode === right.mode &&
    left.status === right.status &&
    left.cwd === right.cwd &&
    left.cmd === right.cmd &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt &&
    left.completedAt === right.completedAt &&
    left.timeoutMs === right.timeoutMs &&
    left.exitCode === right.exitCode &&
    left.failureMessage === right.failureMessage &&
    left.revision === right.revision
  );
}

function shellOutputEqual(left: ShellOutput | undefined, right: ShellOutput | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.mode !== right.mode) return false;
  if (left.mode === 'pipes' && right.mode === 'pipes') {
    return (
      left.stdout === right.stdout &&
      left.stderr === right.stderr &&
      left.latestStream === right.latestStream &&
      left.stdoutTruncated === right.stdoutTruncated &&
      left.stderrTruncated === right.stderrTruncated &&
      left.redacted === right.redacted
    );
  }
  if (left.mode !== 'pty' || right.mode !== 'pty') return false;
  return (
    left.screen === right.screen &&
    left.scrollback === right.scrollback &&
    left.lastAlternateScreen === right.lastAlternateScreen &&
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.cursor.x === right.cursor.x &&
    left.cursor.y === right.cursor.y &&
    left.cursor.visible === right.cursor.visible &&
    left.alternateScreen === right.alternateScreen &&
    left.truncated === right.truncated &&
    left.redacted === right.redacted
  );
}
