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

import { computeEditedSource } from './edit-replace.js';
import { createUnifiedDiff } from './unified-diff.js';

export interface ManagedMutationTransformResult {
  readonly content: string;
  readonly providerResult: unknown;
  readonly changed: boolean;
}

export const MANAGED_MUTATION_CANDIDATE_REJECTED_MESSAGE =
  'Managed workspace candidate was rejected before publication' as const;

/**
 * Pure Write/Edit transform for Git-backed managed workspaces. It never reads
 * or writes a checkout: the accepted Git tree supplies the sole base content.
 */
export function transformManagedMutation(input: {
  readonly toolName: 'Write' | 'Edit';
  readonly canonicalPath: string;
  readonly baseContent: string | null;
  readonly args: unknown;
}): ManagedMutationTransformResult {
  const args = requireArgs(input.args);
  if (args.path !== input.canonicalPath) {
    throw new Error('Managed mutation path does not match its canonical path');
  }
  if (input.toolName === 'Write') {
    if (typeof args.content !== 'string') throw new Error('Managed Write content is invalid');
    const diff = createUnifiedDiff(
      input.canonicalPath,
      input.baseContent ?? undefined,
      args.content,
    );
    return Object.freeze({
      content: args.content,
      changed: input.baseContent !== args.content,
      providerResult:
        diff === undefined
          ? Object.freeze({
              kind: 'file_write' as const,
              path: input.canonicalPath,
              bytes: Buffer.byteLength(args.content, 'utf8'),
            })
          : Object.freeze({
              kind: 'file_diff' as const,
              paths: Object.freeze([input.canonicalPath]),
              diff,
            }),
    });
  }
  if (input.baseContent === null) throw new Error('Managed Edit target does not exist');
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
    throw new Error('Managed Edit arguments are invalid');
  }
  const edited = computeEditedSource(
    input.baseContent,
    args.old_string,
    args.new_string,
    input.canonicalPath,
  );
  const diff = createUnifiedDiff(input.canonicalPath, input.baseContent, edited.content);
  return Object.freeze({
    content: edited.content,
    changed: edited.content !== input.baseContent,
    providerResult:
      diff === undefined
        ? Object.freeze({
            ok: true,
            path: input.canonicalPath,
            replacements: 1,
            matchedVia: edited.matchedVia,
            startLine: edited.startLine,
            endLine: edited.endLine,
          })
        : Object.freeze({
            kind: 'file_diff' as const,
            paths: Object.freeze([input.canonicalPath]),
            diff,
          }),
  });
}

function requireArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed mutation arguments are invalid');
  }
  return value as Record<string, unknown>;
}
