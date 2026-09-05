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
import {
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  type WebSearchErrorReason,
  type WebSearchResponse,
} from '@maka/core/web-search';
import type { MakaTool } from './tool-runtime.js';

const WEB_SEARCH_TOOL_NAME = 'WebSearch';

interface WebSearchExecutor {
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<WebSearchResponse>;
}

/** Builds the canonical model tool while leaving policy and transport ownership to its executor. */
export function buildWebSearchTool(executor: WebSearchExecutor): MakaTool {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    categoryHint: 'web_read',
    displayName: 'Web search',
    description:
      'Query the live web through the configured search provider. Returns bounded source rows. Use it only when the task requires current external information.',
    parameters: z
      .object({
        query: z.string().min(1).max(200).describe('Search query, max 200 characters.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(WEB_SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Maximum result count; defaults to ${WEB_SEARCH_DEFAULT_LIMIT}.`),
      })
      .strict(),
    impl: async ({ query, limit }, context) => {
      const normalizedQuery = normalizeWebSearchQuery(query);
      if (!normalizedQuery) {
        return webSearchError('invalid_query', 'Web search requires a valid query.');
      }
      const response = await executor.search({
        query: normalizedQuery,
        limit: normalizeWebSearchLimit(limit),
        sessionId: context.sessionId,
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
      if (!response.ok) return webSearchError(response.reason, response.message, normalizedQuery);
      return {
        kind: 'web_search' as const,
        provider: response.provider ?? response.results[0]?.provider ?? ('tavily' as const),
        query: normalizedQuery,
        rows: response.results.map((row) => ({
          title: row.title,
          url: row.url,
          snippet: row.snippet,
          source: row.source,
        })),
      };
    },
  };
}

function webSearchError(reason: WebSearchErrorReason, message: string, query?: string) {
  return {
    kind: 'web_search_error' as const,
    ok: false as const,
    provider: 'tavily' as const,
    ...(query ? { query } : {}),
    reason,
    message,
  };
}
