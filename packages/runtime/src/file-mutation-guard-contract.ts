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

import { z } from 'zod';

/** Transient execution preconditions, never persisted as recovery authority. */
export const FILE_MUTATION_MAX_BYTES = 1_048_576;
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes('\0'));
const identity = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict();
export const FileMutationGuardSchema = z
  .object({
    kind: z.enum(['write', 'edit']),
    workspace: z.object({ path, identity }).strict(),
    target: z.object({ path, parentIdentity: identity }).strict(),
    before: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('missing') }).strict(),
      z
        .object({
          kind: z.literal('file'),
          identity,
          bytes: z.number().int().min(0).max(FILE_MUTATION_MAX_BYTES),
          digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((value) => value.kind !== 'edit' || value.before.kind === 'file');
export type FileMutationGuard = z.infer<typeof FileMutationGuardSchema>;
export type FileIdentity = z.infer<typeof identity>;
export interface FileMutationDirectories {
  workspace: FileIdentity;
  parent: FileIdentity;
}
export type FileMutation =
  | { kind: 'write'; content: string }
  | { kind: 'edit'; oldString: string; newString: string };
export interface FileWriteResult {
  kind: 'write';
  ok: true;
  path: string;
  bytes: number;
  diff?: string;
}
export interface FileEditResult {
  kind: 'edit';
  ok: true;
  path: string;
  replacements: 1;
  matchedVia: 'exact' | 'line-trimmed' | 'whitespace' | 'escape';
  startLine: number;
  endLine: number;
  diff?: string;
}
