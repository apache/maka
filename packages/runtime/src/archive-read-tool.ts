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

import { jsonSchema, zodSchema } from 'ai';
import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';
import {
  readToolResultArchiveResource,
  TOOL_RESULT_ARCHIVE_MAX_LIMIT,
  type ToolResultArchiveResourceReader,
} from './tool-result-archive-resource.js';

export const ARCHIVE_READ_TOOL_NAME = 'ArchiveRead';

export function buildArchiveReadTool(reader: ToolResultArchiveResourceReader): MakaTool {
  const parameters = z.preprocess(
    cleanArchiveReadInput,
    z
      .object({
        ref: z
          .string()
          .describe('A maka://archive/... ref returned in an archived tool-result placeholder'),
        operation: z
          .enum(['inspect', 'read', 'query'])
          .default('inspect')
          .describe(
            'inspect lists archive metadata/items; query reads one structured item; read returns one bounded raw page',
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Zero-based character offset for read/query pagination'),
        limit: z
          .number()
          .int()
          .positive()
          .max(TOOL_RESULT_ARCHIVE_MAX_LIMIT)
          .optional()
          .describe(`Maximum returned characters, capped at ${TOOL_RESULT_ARCHIVE_MAX_LIMIT}`),
        itemId: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe('Structured item id returned by inspect; required for query'),
      })
      .strip()
      .superRefine((value, ctx) => {
        if (value.operation === 'query' && !value.itemId) {
          ctx.addIssue({
            code: 'custom',
            path: ['itemId'],
            message: 'itemId is required for query',
          });
        }
      }),
  );
  const providerSchema = zodSchema(parameters);
  return {
    name: ARCHIVE_READ_TOOL_NAME,
    displayName: 'Read archived result',
    activityKind: 'read',
    description:
      'Inspect or page through a tool-result archive returned as a maka://archive/... ref. Start with inspect. For agent_swarm archives, query one itemId at a time. Results are strictly bounded so reading an archive cannot immediately trigger another archive.',
    parameters: jsonSchema(async () => await providerSchema.jsonSchema, {
      validate: async (value) => {
        const result = await parameters.safeParseAsync(value);
        return result.success
          ? { success: true, value: result.data }
          : { success: false, error: result.error };
      },
    }),
    impl: async (input, ctx) =>
      readToolResultArchiveResource(reader, ctx.sessionId, input, ctx.abortSignal),
  };
}

function cleanArchiveReadInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const cleaned = { ...(input as Record<string, unknown>) };
  const operation = cleaned.operation ?? 'inspect';
  if (operation !== 'query') delete cleaned.itemId;
  if (operation === 'inspect') {
    delete cleaned.offset;
    delete cleaned.limit;
  }
  return cleaned;
}
