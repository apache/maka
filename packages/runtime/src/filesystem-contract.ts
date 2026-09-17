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
import { readContinuationSchema, readPageSchema } from './read-page.js';
import { GREP_MAX_LINES, GREP_MAX_LINES_PER_FILE, GREP_MAX_MATCH_BYTES } from './grep-search.js';
const path = z.string().min(1).max(4096);
const cwd = z.string().min(1).max(4096);
export const FilesystemOperationSchema = z.union([
  z
    .object({
      kind: z.literal('read'),
      cwd,
      path,
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      continuation: readContinuationSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('write'), cwd, path, content: z.string() }).strict(),
  z
    .object({
      kind: z.literal('apply_patch'),
      cwd,
      path,
      action: z.enum(['create', 'update']),
      diff: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('apply_patch'), cwd, path, action: z.literal('delete') }).strict(),
  z
    .object({
      kind: z.literal('edit'),
      cwd,
      path,
      oldString: z.string(),
      newString: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('format_json'),
      cwd,
      path,
      sortKeys: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('glob'),
      cwd,
      path,
      pattern: z.string().min(1),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('grep'),
      cwd,
      path,
      pattern: z.string(),
      glob: z.string().min(1).optional(),
      maxCountPerFile: z.number().int().positive().max(GREP_MAX_LINES_PER_FILE),
      limit: z.number().int().positive().max(GREP_MAX_LINES),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
]);

export const FilesystemResultSchema = z.discriminatedUnion('kind', [
  readPageSchema.extend({ kind: z.literal('read') }).strict(),
  z
    .object({
      kind: z.literal('read_image'),
      bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('write'),
      ok: z.literal(true),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      diff: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('apply_patch'), ok: z.literal(true), path: z.string() }).strict(),
  z
    .object({
      kind: z.literal('edit'),
      ok: z.literal(true),
      path: z.string(),
      replacements: z.literal(1),
      matchedVia: z.enum(['exact', 'line-trimmed', 'whitespace', 'escape']),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      diff: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('format_json'),
      ok: z.boolean(),
      valid: z.boolean(),
      path: z.string(),
      error: z.string().optional(),
      bytesBefore: z.number().int().nonnegative(),
      bytesAfter: z.number().int().nonnegative().optional(),
      byteDelta: z.number().int(),
      changed: z.boolean(),
      diff: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('glob'), files: z.array(z.string()) }).strict(),
  z
    .object({
      kind: z.literal('grep'),
      matchedLines: z.number().int().nonnegative(),
      returnedLines: z.number().int().nonnegative(),
      omittedLines: z.number().int().nonnegative(),
      truncated: z.boolean(),
      matches: z
        .array(z.string())
        .max(GREP_MAX_LINES)
        .refine((matches) => Buffer.byteLength(JSON.stringify(matches)) <= GREP_MAX_MATCH_BYTES),
    })
    .strict()
    .refine(
      (result) =>
        result.returnedLines === result.matches.length &&
        result.matchedLines === result.returnedLines + result.omittedLines &&
        result.truncated === result.omittedLines > 0,
    ),
]);

export type FilesystemOperationWithCwd = z.infer<typeof FilesystemOperationSchema>;
export type FilesystemBackendOperation = FilesystemOperationWithCwd extends infer Operation
  ? Operation extends { cwd: string }
    ? Omit<Operation, 'cwd'>
    : never
  : never;
export type FilesystemResult = z.infer<typeof FilesystemResultSchema>;
export function operationAccess(kind: FilesystemOperationWithCwd['kind']): 'read' | 'write' {
  return kind === 'write' || kind === 'apply_patch' || kind === 'edit' || kind === 'format_json'
    ? 'write'
    : 'read';
}
