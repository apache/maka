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
  INLINE_REFERENCE_LABEL_MAX_LENGTH,
  INLINE_REFERENCE_MAX_COUNT,
  isInlineReference,
  type InlineReference,
} from '@maka/core/events';
import { posix } from 'node:path';

export function mergeWorkspaceFileInlineReferences(input: {
  displayText: string;
  workspaceFileReferences?: ReadonlyArray<Pick<InlineReference, 'value' | 'start'>>;
}): InlineReference[] {
  return mergeSessionInlineReferences(
    input.displayText,
    workspaceFileInlineReferenceCandidates(input),
  );
}

export function workspaceFileInlineReferenceCandidates(input: {
  workspaceFileReferences?: ReadonlyArray<Pick<InlineReference, 'value' | 'start'>>;
}): InlineReference[] {
  return (input.workspaceFileReferences ?? []).map((reference) => ({
    kind: 'workspace_file' as const,
    value: reference.value,
    label: posix.basename(reference.value.slice(1)),
    start: reference.start,
  }));
}

export function mergeSessionInlineReferences(
  displayText: string,
  candidates: readonly InlineReference[],
): InlineReference[] {
  const ordered = [...candidates].sort(
    (left, right) => left.start - right.start || right.value.length - left.value.length,
  );
  const references: InlineReference[] = [];
  let previousEnd = 0;
  for (const candidate of ordered) {
    if (references.length >= INLINE_REFERENCE_MAX_COUNT) break;
    const reference = {
      ...candidate,
      label: truncateWithoutSplittingSurrogate(candidate.label, INLINE_REFERENCE_LABEL_MAX_LENGTH),
    };
    if (
      !isInlineReference(reference) ||
      reference.start < previousEnd ||
      displayText.slice(reference.start, reference.start + reference.value.length) !==
        reference.value
    ) {
      continue;
    }
    references.push(reference);
    previousEnd = reference.start + reference.value.length;
  }
  return references;
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  const truncated = value.slice(0, maxCodeUnits);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
