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

import type { FollowUpMode, InlineReference } from '@maka/core/events';

export interface WorkspaceFileReferencePosition {
  value: string;
  start: number;
}

export function hasActiveTurnAtSubmit(input: {
  liveTurn?: { turnId: string; terminal?: boolean };
  runningTurnIds?: readonly string[];
}): boolean {
  if (input.liveTurn?.terminal !== true && input.liveTurn !== undefined) return true;
  return input.runningTurnIds?.some((turnId) => turnId !== input.liveTurn?.turnId) === true;
}

export function resolveFollowUpModeAtSubmit(input: {
  requestedMode?: FollowUpMode;
  hasActiveTurn: boolean;
}): FollowUpMode | undefined {
  if (input.requestedMode) return input.requestedMode;
  // Mid-turn submits always queue; Shift+Enter carries the one-shot steer as
  // the requested mode.
  return input.hasActiveTurn ? 'queue' : undefined;
}

export function mergeWorkspaceReferences(
  text: string,
  live: readonly WorkspaceFileReferencePosition[] | undefined,
  restored: readonly InlineReference[] | undefined,
): WorkspaceFileReferencePosition[] {
  const merged = new Map<string, WorkspaceFileReferencePosition>();
  for (const reference of live ?? []) {
    merged.set(`${reference.start}:${reference.value}`, { ...reference });
  }
  let cursor = 0;
  for (const reference of restored ?? []) {
    if (reference.kind !== 'workspace_file') continue;
    let start = reference.start;
    if (text.slice(start, start + reference.value.length) !== reference.value) {
      start = text.indexOf(reference.value, cursor);
    }
    if (start < 0) continue;
    cursor = start + reference.value.length;
    merged.set(`${start}:${reference.value}`, { value: reference.value, start });
  }
  return [...merged.values()].sort((left, right) => left.start - right.start);
}

export function rebaseWorkspaceFileReferences(
  sourceText: string,
  projectedText: string,
  references: readonly WorkspaceFileReferencePosition[],
): WorkspaceFileReferencePosition[] {
  const offset = sourceText.lastIndexOf(projectedText);
  if (offset < 0) return [];
  return references
    .filter(
      (reference) =>
        reference.start >= offset &&
        reference.start + reference.value.length <= offset + projectedText.length,
    )
    .map((reference) => ({ ...reference, start: reference.start - offset }));
}
