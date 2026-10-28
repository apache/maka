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

import { tr } from './locale';
import { toolPresentation, webPresentation } from '../../../../plugins/shared/tool-presentation';
export const cardFamily = (key: string | null | undefined) =>
  toolPresentation(key) ?? webPresentation(key);
export type ToolFamily = ReturnType<typeof cardFamily>;
export type ToolSection = {
  label: string;
  text: string;
  tone?: 'added' | 'removed' | 'warning' | 'error';
};
export type ToolRead = {
  content: string;
  offset: number;
  returnedLines: number;
  totalLines: number;
  partialLine: boolean;
  hasMore: boolean;
};
type ProcessStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'orphaned';
export type ToolProcess = {
  command: string;
  cwd: string;
  status: ProcessStatus;
  exitCode: number | null;
  failure: string | null;
  output:
    | {
        mode: 'pipes';
        stdout: string;
        stderr: string;
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
        redacted: boolean;
      }
    | {
        mode: 'pty';
        scrollback: string;
        screen: string;
        lastAlternateScreen: string | null;
        truncated: boolean;
        redacted: boolean;
      }
    | null;
};
export type ToolChange =
  | { phase: 'requested'; operation: 'write'; path: string; content: string }
  | { phase: 'requested'; operation: 'edit'; path: string; before: string; after: string }
  | { phase: 'requested'; operation: 'patch'; path: string; type: string; diff: string | null }
  | { phase: 'recorded'; operation: 'write'; path: string; bytes: number; previous: string | null }
  | {
      phase: 'recorded';
      operation: 'edit';
      path: string;
      replacements: number;
      matchedVia: string | null;
      startLine: number | null;
      endLine: number | null;
    }
  | { phase: 'recorded'; operation: 'patch' };
export type ToolProjection =
  | { kind: 'sections'; sections: ToolSection[] }
  | { kind: 'read'; value: ToolRead }
  | { kind: 'process'; value: ToolProcess }
  | { kind: 'change'; value: ToolChange }
  | { kind: 'failure'; message: string };
export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((part) => typeof part === 'string');
export const processFamily = (kind: ToolFamily) =>
  ['execute', 'processRead', 'stdin', 'stop'].includes(kind ?? '');

export function toolArguments(kind: ToolFamily, input: unknown): ToolProjection | null {
  const args = record(input);
  if (!kind || !args) return null;
  if (processFamily(kind)) {
    const value = kind === 'execute' ? args.command : args.ref;
    return typeof value === 'string'
      ? {
          kind: 'sections',
          sections: [
            {
              label: kind === 'execute' ? tr('Requested command') : tr('Process reference'),
              text: value,
            },
          ],
        }
      : null;
  }
  if (kind === 'fetch')
    return typeof args.url === 'string'
      ? { kind: 'sections', sections: [{ label: tr('Requested URL'), text: args.url }] }
      : null;
  if (kind === 'webSearch') {
    const value = args.query;
    return typeof value === 'string'
      ? {
          kind: 'sections',
          sections: [{ label: tr('Web query'), text: value }],
        }
      : null;
  }
  const operation = record(args.operation);
  const path = kind === 'patch' ? operation?.path : args.path;
  if (typeof path !== 'string') return null;
  if (kind === 'write') {
    if (typeof args.content !== 'string') return null;
    return {
      kind: 'change',
      value: { phase: 'requested', operation: 'write', path, content: args.content },
    };
  } else if (kind === 'edit') {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return null;
    return {
      kind: 'change',
      value: {
        phase: 'requested',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
    };
  } else if (kind === 'patch') {
    if (!operation || typeof operation.type !== 'string') return null;
    if (operation.diff !== undefined && typeof operation.diff !== 'string') return null;
    return {
      kind: 'change',
      value: {
        phase: 'requested',
        operation: 'patch',
        path,
        type: operation.type,
        diff: typeof operation.diff === 'string' ? operation.diff : null,
      },
    };
  }
  return { kind: 'sections', sections: [{ label: tr('File'), text: path }] };
}

// Only complete originals under the explicitly recorded display contract are
// decoded. A malformed or unfamiliar value keeps the literal original view.
export function toolResult(kind: ToolFamily, input: unknown): ToolProjection | null {
  const result = record(input);
  if (!kind || !result) return null;
  if (result.kind === 'failed' && typeof result.message === 'string')
    return { kind: 'failure', message: result.message };
  const value = record(result.value);
  if (result.kind !== 'completed' || !value) return null;
  if (processFamily(kind)) {
    if (
      !['terminal', 'shell_run'].includes(String(value.kind)) ||
      typeof value.status !== 'string' ||
      ![
        'starting',
        'running',
        'completed',
        'failed',
        'timed_out',
        'cancelled',
        'orphaned',
      ].includes(value.status) ||
      typeof value.cwd !== 'string' ||
      typeof value.cmd !== 'string' ||
      (value.exitCode !== undefined &&
        !(typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))) ||
      (value.failureMessage !== undefined && typeof value.failureMessage !== 'string')
    )
      return null;
    const output = record(value.output);
    if (value.output !== undefined && value.output !== null && !output) return null;
    let captured: ToolProcess['output'] = null;
    if (output?.mode === 'pipes') {
      if (
        typeof output.stdout !== 'string' ||
        typeof output.stderr !== 'string' ||
        typeof output.stdoutTruncated !== 'boolean' ||
        typeof output.stderrTruncated !== 'boolean' ||
        typeof output.redacted !== 'boolean'
      )
        return null;
      captured = {
        mode: 'pipes',
        stdout: output.stdout,
        stderr: output.stderr,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
        redacted: output.redacted,
      };
    } else if (output?.mode === 'pty') {
      if (
        typeof output.scrollback !== 'string' ||
        typeof output.screen !== 'string' ||
        typeof output.truncated !== 'boolean' ||
        typeof output.redacted !== 'boolean' ||
        (output.lastAlternateScreen !== undefined && typeof output.lastAlternateScreen !== 'string')
      )
        return null;
      captured = {
        mode: 'pty',
        scrollback: output.scrollback,
        screen: output.screen,
        lastAlternateScreen:
          typeof output.lastAlternateScreen === 'string' ? output.lastAlternateScreen : null,
        truncated: output.truncated,
        redacted: output.redacted,
      };
    } else if (output !== null) return null;
    return {
      kind: 'process',
      value: {
        command: value.cmd,
        cwd: value.cwd,
        status: value.status as ProcessStatus,
        exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
        failure: typeof value.failureMessage === 'string' ? value.failureMessage : null,
        output: captured,
      },
    };
  }
  if (kind === 'read') {
    if (
      typeof value.content !== 'string' ||
      !integer(value.offset) ||
      !integer(value.returnedLines) ||
      !integer(value.totalLines) ||
      (value.partialLine !== undefined && typeof value.partialLine !== 'boolean')
    )
      return null;
    return {
      kind: 'read',
      value: {
        content: value.content,
        offset: value.offset,
        returnedLines: value.returnedLines,
        totalLines: value.totalLines,
        partialLine: value.partialLine === true,
        hasMore: value.next !== null && value.next !== undefined,
      },
    };
  }

  if (kind === 'write') {
    if (
      value.kind !== 'file_write' ||
      typeof value.path !== 'string' ||
      !integer(value.bytes) ||
      (value.previousContent !== undefined && typeof value.previousContent !== 'string')
    )
      return null;
    return {
      kind: 'change',
      value: {
        phase: 'recorded',
        operation: 'write',
        path: value.path,
        bytes: value.bytes,
        previous: typeof value.previousContent === 'string' ? value.previousContent : null,
      },
    };
  }
  if (kind === 'edit') {
    if (
      value.ok !== true ||
      typeof value.path !== 'string' ||
      !integer(value.replacements) ||
      (value.matchedVia !== undefined && typeof value.matchedVia !== 'string') ||
      (value.startLine !== undefined && !integer(value.startLine)) ||
      (value.endLine !== undefined && !integer(value.endLine))
    )
      return null;
    return {
      kind: 'change',
      value: {
        phase: 'recorded',
        operation: 'edit',
        path: value.path,
        replacements: value.replacements,
        matchedVia: typeof value.matchedVia === 'string' ? value.matchedVia : null,
        startLine: typeof value.startLine === 'number' ? value.startLine : null,
        endLine: typeof value.endLine === 'number' ? value.endLine : null,
      },
    };
  }
  if (kind === 'patch')
    return value.status === 'completed'
      ? { kind: 'change', value: { phase: 'recorded', operation: 'patch' } }
      : null;
  if (kind === 'fetch') {
    if (
      typeof value.url !== 'string' ||
      !(value.title === null || typeof value.title === 'string') ||
      !['markdown', 'text'].includes(String(value.format)) ||
      typeof value.content !== 'string'
    )
      return null;
    return {
      kind: 'sections',
      sections: [
        {
          label: typeof value.title === 'string' && value.title ? value.title : tr('Web page'),
          text: value.url,
        },
        { label: tr('Recorded page content'), text: value.content },
      ],
    };
  }
  if (kind === 'webSearch') {
    if (
      typeof value.query !== 'string' ||
      !Array.isArray(value.rows) ||
      typeof value.truncated !== 'boolean' ||
      !integer(value.omittedResults)
    )
      return null;
    const sections: ToolSection[] = [];
    for (const candidate of value.rows) {
      const row = record(candidate);
      if (
        !row ||
        typeof row.title !== 'string' ||
        typeof row.url !== 'string' ||
        typeof row.snippet !== 'string'
      )
        return null;
      sections.push({
        label: row.title || tr('Web result'),
        text: `${row.url}\n${row.snippet}`,
      });
    }
    if (!sections.length) sections.push({ label: tr('Web results'), text: tr('No results.') });
    if (value.truncated)
      sections.push({
        label: tr('Web notice'),
        text: tr('The search result is truncated · {count} omitted results.', {
          count: value.omittedResults,
        }),
        tone: 'warning',
      });
    return { kind: 'sections', sections };
  }
  return null;
}
