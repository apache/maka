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

import { createHash } from 'node:crypto';
import type {
  ShellRunSnapshotResult,
  ShellRunStateResult,
  ShellRunUpdate,
  ToolResultContent,
} from '@maka/core/events';
import {
  decodeRuntimeResourceQueryResult,
  RUNTIME_RESOURCE_PAGE_MAX_ITEMS,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  type RuntimeResourceQueryResult,
  type RuntimeResourceRevision,
} from '../protocol/index.js';

const RUNTIME_RESOURCE_SNAPSHOT_MAX_BYTES = 48 * 1024;
const TRUNCATED_FIELD_MARKER = '[runtime resource field truncated]';

export function canonicalRuntimeResources(resources: readonly ShellRunUpdate[]): ShellRunUpdate[] {
  return resources
    .map(boundedRuntimeResourceUpdate)
    .sort(
      (left, right) =>
        left.result.ref.localeCompare(right.result.ref) ||
        left.sourceToolCallId.localeCompare(right.sourceToolCallId),
    );
}

function boundedRuntimeResourceUpdate(update: ShellRunUpdate): ShellRunUpdate {
  return {
    ...structuredClone(update),
    result: boundedState(update.result),
  };
}

export function runtimeResourceRevision(
  resources: readonly ShellRunUpdate[],
): RuntimeResourceRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(resources)).digest('hex')}`;
}

export function createRuntimeResourcePage(
  sessionId: string,
  revision: RuntimeResourceRevision,
  resources: readonly ShellRunUpdate[],
  offset: number,
): RuntimeResourceQueryResult {
  const pageResources: ShellRunUpdate[] = [];
  for (let index = offset; index < resources.length; index += 1) {
    if (pageResources.length >= RUNTIME_RESOURCE_PAGE_MAX_ITEMS) break;
    const resource = resources[index];
    if (!resource) throw new Error('Runtime Resource projection index was out of bounds');
    const candidateResources = [...pageResources, resource];
    const nextOffset = index + 1;
    const candidate = {
      kind: 'page' as const,
      sessionId,
      revision,
      resources: candidateResources,
      nextCursor: nextOffset < resources.length ? String(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > RUNTIME_RESOURCE_RESULT_MAX_BYTES) {
      break;
    }
    pageResources.push(resource);
  }
  if (pageResources.length === 0 && offset < resources.length) {
    throw new Error('A canonical Runtime Resource cannot fit in one page');
  }
  const nextOffset = offset + pageResources.length;
  return decodeRuntimeResourceQueryResult({
    kind: 'page',
    sessionId,
    revision,
    resources: pageResources,
    nextCursor: nextOffset < resources.length ? String(nextOffset) : null,
  });
}

export function boundedRuntimeResourceSnapshot(
  snapshot: ShellRunSnapshotResult,
): ShellRunSnapshotResult {
  const bounded = structuredClone(snapshot);
  shrinkStateToFit(bounded);
  if (bounded.output === undefined) throw new Error('Runtime Resource snapshot lost its output');
  return bounded;
}

export function runtimeResourceSnapshotFromResult(
  result: ToolResultContent,
): ShellRunSnapshotResult {
  if (result.kind !== 'shell_run' || result.output === undefined) {
    throw new Error('Runtime Resource operation did not produce a ShellRun snapshot');
  }
  const { operation: _operation, ...snapshot } = result;
  return snapshot;
}

function boundedState(state: ShellRunStateResult): ShellRunStateResult {
  const bounded = structuredClone(state);
  shrinkStateToFit(bounded);
  return bounded;
}

function shrinkStateToFit(state: ShellRunStateResult): void {
  while (Buffer.byteLength(JSON.stringify(state), 'utf8') > RUNTIME_RESOURCE_SNAPSHOT_MAX_BYTES) {
    const fields = mutableTextFields(state).sort(
      (left, right) =>
        Buffer.byteLength(right.value(), 'utf8') - Buffer.byteLength(left.value(), 'utf8'),
    );
    const largest = fields[0];
    if (!largest || largest.value().length === 0) {
      throw new Error('Runtime Resource metadata exceeds the wire snapshot limit');
    }
    const current = largest.value();
    largest.replace(
      truncateField(current, Math.floor(Buffer.byteLength(current, 'utf8') / 2), largest.direction),
    );
  }
}

interface MutableTextField {
  value: () => string;
  replace: (value: string) => void;
  direction: 'head' | 'tail';
}

function mutableTextFields(state: ShellRunStateResult): MutableTextField[] {
  const fields: MutableTextField[] = [
    {
      value: () => state.cmd,
      replace: (value: string) => {
        state.cmd = value;
      },
      direction: 'head',
    },
    {
      value: () => state.cwd,
      replace: (value: string) => {
        state.cwd = value;
      },
      direction: 'head',
    },
  ];
  if (state.failureMessage !== undefined) {
    fields.push({
      value: () => state.failureMessage ?? '',
      replace: (value) => {
        state.failureMessage = value;
      },
      direction: 'head',
    });
  }
  if (state.output?.mode === 'pipes') {
    const output = state.output;
    fields.push(
      {
        value: () => output.stdout,
        replace: (value) => {
          output.stdout = value;
          output.stdoutTruncated = true;
        },
        direction: 'tail',
      },
      {
        value: () => output.stderr,
        replace: (value) => {
          output.stderr = value;
          output.stderrTruncated = true;
        },
        direction: 'tail',
      },
    );
  } else if (state.output?.mode === 'pty') {
    const output = state.output;
    fields.push(
      {
        value: () => output.screen,
        replace: (value) => {
          output.screen = value;
          output.truncated = true;
        },
        direction: 'tail',
      },
      {
        value: () => output.scrollback,
        replace: (value) => {
          output.scrollback = value;
          output.truncated = true;
        },
        direction: 'tail',
      },
    );
    if (output.lastAlternateScreen !== undefined) {
      fields.push({
        value: () => output.lastAlternateScreen ?? '',
        replace: (value) => {
          output.lastAlternateScreen = value;
          output.truncated = true;
        },
        direction: 'tail',
      });
    }
  }
  return fields;
}

function truncateField(value: string, maxBytes: number, direction: 'head' | 'tail'): string {
  if (maxBytes <= 0) return '';
  const markerBytes = Buffer.byteLength(TRUNCATED_FIELD_MARKER, 'utf8');
  if (maxBytes <= markerBytes + 1) return '';
  const contentBytes = maxBytes - markerBytes - 1;
  const buffer = Buffer.from(value, 'utf8');
  const slice =
    direction === 'head'
      ? buffer.subarray(0, contentBytes).toString('utf8').replace(/�+$/, '')
      : buffer
          .subarray(Math.max(0, buffer.length - contentBytes))
          .toString('utf8')
          .replace(/^�+/, '');
  return direction === 'head'
    ? `${slice}\n${TRUNCATED_FIELD_MARKER}`
    : `${TRUNCATED_FIELD_MARKER}\n${slice}`;
}
