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
  PtyShellOutput,
  ShellOutput,
  ShellRunOperation,
  ShellRunRecord,
  ShellRunStatus,
} from '@maka/core/shell-run';
import type {
  ShellRunCompactResult,
  ShellRunSnapshotResult,
  ShellRunStateResult,
  ShellRunUpdate,
  ToolResultContent,
} from '@maka/core/events';
import { encodedTerminalInputActionsByteLength } from '@maka/core/terminal-input';

import { isActiveShellRunStatus } from '@maka/core/shell-run';

import { shellRunResourceRef, type ShellRunWriteInput } from './shell-run-contract.js';
import { truncateToolOutput } from './tool-output.js';
import { isLikelySandboxDenial } from './sandbox/detect.js';

export const PTY_MODEL_TEXT_BUDGET_BYTES = 50 * 1024;

const TRUNCATED_MARKER = '[terminal snapshot truncated to fit the output limit]';

export type TerminalToolResult = Extract<ToolResultContent, { kind: 'terminal' }>;
export type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;

export function shellRunUpdate(record: ShellRunRecord): ShellRunUpdate {
  return {
    sessionId: record.sessionId,
    ownership: { kind: 'local' },
    sourceTurnId: record.sourceTurnId,
    sourceToolCallId: record.sourceToolCallId,
    result: shellRunSnapshotContent(record),
  };
}

export function terminalContent(record: ShellRunRecord): TerminalToolResult {
  if (isActiveShellRunStatus(record.status) || record.status === 'orphaned') {
    throw new Error(`ShellRun status ${record.status} cannot be returned as a terminal result`);
  }
  return {
    kind: 'terminal',
    cwd: record.cwd,
    cmd: record.command,
    status: terminalResultStatus(record.status),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.failureMessage !== undefined ? { failureMessage: record.failureMessage } : {}),
    output: projectShellOutputForModel(record.output),
    ...(sandboxDenialForRecord(record) ? { sandboxDenial: sandboxDenialForRecord(record) } : {}),
  };
}

export function shellRunContent(
  record: ShellRunRecord,
  operation?: ShellRunOperation,
): ShellRunToolResult {
  const state = shellRunSnapshotContent(record);
  if (!operation) return state;
  if (operation.kind === 'stop') return { ...state, operation };
  if (state.mode !== 'pty') {
    throw new Error('PTY control operation requires PTY ShellRun state');
  }
  return { ...state, operation };
}

export function compactShellRunContent(record: ShellRunRecord): ShellRunToolResult {
  return shellRunStateContent(record);
}

export function ptyControlOperation(
  input: ShellRunWriteInput,
  outcome: {
    inputQueued: boolean;
    resizeApplied: boolean;
    resizeChanged: boolean;
    failed?: boolean;
  },
): Extract<ShellRunOperation, { kind: 'pty_control' }> {
  const terminalInput =
    input.input !== undefined
      ? Buffer.byteLength(input.input, 'utf8')
      : input.actions
        ? encodedTerminalInputActionsByteLength(input.actions)
        : undefined;
  return {
    kind: 'pty_control',
    failed: outcome.failed === true,
    ...(terminalInput !== undefined
      ? { input: { bytes: terminalInput, queued: outcome.inputQueued } }
      : {}),
    ...(input.size
      ? {
          resize: {
            cols: input.size.cols,
            rows: input.size.rows,
            applied: outcome.resizeApplied,
            changed: outcome.resizeChanged,
          },
        }
      : {}),
  };
}

function terminalResultStatus(status: ShellRunStatus): TerminalToolResult['status'] {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'timed_out':
    case 'cancelled':
      return status;
    case 'starting':
    case 'running':
    case 'orphaned':
      throw new Error(`ShellRun status ${status} cannot be returned as a terminal result`);
  }
}

function shellRunStateContent(record: ShellRunRecord): ShellRunCompactResult {
  const state = {
    kind: 'shell_run',
    ref: shellRunResourceRef(record.shellRunId),
    status: record.status,
    cwd: record.cwd,
    cmd: record.command,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.failureMessage !== undefined ? { failureMessage: record.failureMessage } : {}),
    revision: record.revision,
  } as const;
  return record.output.mode === 'pipes' ? { ...state, mode: 'pipes' } : { ...state, mode: 'pty' };
}

function shellRunSnapshotContent(record: ShellRunRecord): ShellRunSnapshotResult {
  const state = shellRunStateContent(record);
  const output = projectShellOutputForModel(record.output);
  return output.mode === 'pipes'
    ? {
        ...state,
        mode: 'pipes',
        output,
        ...(sandboxDenialForRecord(record)
          ? { sandboxDenial: sandboxDenialForRecord(record) }
          : {}),
      }
    : {
        ...state,
        mode: 'pty',
        output,
        ...(sandboxDenialForRecord(record)
          ? { sandboxDenial: sandboxDenialForRecord(record) }
          : {}),
      };
}

function sandboxDenialForRecord(record: ShellRunRecord):
  | {
      likely: true;
      backend?: 'macos-seatbelt' | 'linux' | 'windows';
    }
  | undefined {
  if (record.status !== 'failed' || record.sandboxExecution?.enforced !== true) return undefined;
  const flat = flattenSandboxDenialText(record.output);
  if (!isLikelySandboxDenial({ ...flat, sandboxed: true })) return undefined;
  const backend = record.sandboxExecution.type;
  return {
    likely: true,
    ...(backend === 'macos-seatbelt' || backend === 'linux' || backend === 'windows'
      ? { backend }
      : {}),
  };
}

function flattenSandboxDenialText(output: ShellOutput): {
  stdout: string;
  stderr: string;
} {
  if (output.mode === 'pipes') return { stdout: output.stdout, stderr: output.stderr };
  return {
    stdout: `${output.scrollback}\n${output.screen}\n${output.lastAlternateScreen ?? ''}`,
    stderr: '',
  };
}

function projectShellOutputForModel(output: ShellOutput): ShellOutput {
  if (output.mode === 'pty') return projectPtyOutputForModel(output);
  const stdout = truncateToolOutput(output.stdout, { direction: 'tail' });
  const stderr = truncateToolOutput(output.stderr, { direction: 'tail' });
  return {
    ...output,
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: output.stdoutTruncated || stdout.truncated,
    stderrTruncated: output.stderrTruncated || stderr.truncated,
  };
}

export function projectPtyOutputForModel(
  output: PtyShellOutput,
  maxBytes = PTY_MODEL_TEXT_BUDGET_BYTES,
): PtyShellOutput {
  let remaining = Math.max(0, Math.trunc(maxBytes));
  let truncated = output.truncated;
  const screen = takePrioritizedText(output.screen, remaining);
  remaining = screen.truncated ? 0 : remaining - Buffer.byteLength(screen.text, 'utf8');
  truncated ||= screen.truncated;

  const alternate =
    output.lastAlternateScreen === undefined
      ? undefined
      : takePrioritizedText(output.lastAlternateScreen, remaining);
  if (alternate) {
    remaining = alternate.truncated ? 0 : remaining - Buffer.byteLength(alternate.text, 'utf8');
    truncated ||= alternate.truncated;
  }

  const scrollback = takeTailText(output.scrollback, remaining);
  truncated ||= scrollback.truncated;
  const { lastAlternateScreen: _lastAlternateScreen, ...base } = output;
  return {
    ...base,
    screen: screen.text,
    scrollback: scrollback.text,
    ...(alternate?.text ? { lastAlternateScreen: alternate.text } : {}),
    truncated,
  };
}

function takePrioritizedText(text: string, budget: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= budget) return { text, truncated: false };
  return takeTailText(text, budget);
}

function takeTailText(text: string, budget: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= budget) return { text, truncated: false };
  if (budget <= 0) return { text: '', truncated: text.length > 0 };
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf8');
  if (budget <= markerBytes) return { text: '', truncated: true };
  const tail = sliceUtf8Tail(text, budget - markerBytes - 1);
  return { text: `${TRUNCATED_MARKER}\n${tail}`, truncated: true };
}

function sliceUtf8Tail(text: string, budget: number): string {
  const characters = Array.from(text);
  let result = '';
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    result = character + result;
    bytes += size;
  }
  return result;
}
