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
import type { ToolResultContent } from '@maka/core/events';
import type { MakaTool } from './tool-runtime.js';

export interface BackgroundTaskHealthReader {
  readRuntimeResource(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent>;
}

export interface BackgroundTaskEndpointProbe {
  probe(input: { url: string; sessionId: string; abortSignal: AbortSignal }): Promise<{
    status: number;
    statusText?: string;
    elapsedMs: number;
  }>;
}

/**
 * Produces an explicit two-axis result. A tracked process is never described
 * as endpoint-ready unless the caller supplied a URL and the probe succeeded.
 */
export function buildBackgroundTaskHealthTool(
  reader: BackgroundTaskHealthReader,
  probe: BackgroundTaskEndpointProbe,
): MakaTool {
  return {
    name: 'BackgroundTaskHealth',
    displayName: 'Background task health',
    categoryHint: 'web_read',
    description:
      'Check a tracked background task and an optional HTTP endpoint. Uses HEAD with one GET fallback for 405/501; discards the body. Reports HTTP status only, not browser loading or ownership of the listener. Redirects are not followed. Logs are omitted by default; use Read(ref) for full logs.',
    parameters: z
      .object({
        ref: z.string().describe('The maka://runtime/background-tasks/<id> ref returned by Bash'),
        include_logs: z.boolean().optional().describe('Include captured task logs in this report'),
        url: z
          .string()
          .url()
          .refine(
            (value) => ['http:', 'https:'].includes(new URL(value).protocol),
            'Health endpoint must use HTTP or HTTPS',
          )
          .optional()
          .describe('The HTTP or HTTPS endpoint to probe'),
      })
      .strict(),
    impl: async ({ ref, url, include_logs }, context) => {
      const resource = await reader.readRuntimeResource(
        context.sessionId,
        ref,
        context.abortSignal,
      );
      if (
        !resource ||
        typeof resource !== 'object' ||
        Array.isArray(resource) ||
        resource.kind !== 'shell_run'
      ) {
        throw new Error('BackgroundTaskHealth requires a shell_run runtime resource');
      }
      const shell = resource as Extract<ToolResultContent, { kind: 'shell_run' }>;
      const process = {
        status: shell.status,
        tracked: true,
        startedAt: shell.startedAt,
        updatedAt: shell.updatedAt,
        ...(shell.pid !== undefined ? { pid: shell.pid } : {}),
        ...(shell.completedAt !== undefined ? { completedAt: shell.completedAt } : {}),
        ...(shell.failureMessage !== undefined ? { failureMessage: shell.failureMessage } : {}),
        ...(include_logs && shell.output
          ? {
              logs:
                shell.output.mode === 'pipes'
                  ? { stdout: shell.output.stdout, stderr: shell.output.stderr }
                  : { screen: shell.output.screen, scrollback: shell.output.scrollback },
            }
          : {}),
      };
      if (!url) return JSON.stringify({ process, endpoint: { state: 'not_checked' } });
      let endpoint;
      try {
        endpoint = await probe.probe({
          url,
          sessionId: context.sessionId,
          abortSignal: context.abortSignal,
        });
      } catch (error) {
        context.abortSignal.throwIfAborted();
        return JSON.stringify({
          process,
          endpoint: {
            state: 'unknown',
            target: new URL(url).href,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return JSON.stringify({
        process,
        endpoint: {
          state: 'checked',
          httpStatus: endpoint.status,
          elapsedMs: endpoint.elapsedMs,
          target: new URL(url).href,
          health:
            endpoint.status >= 200 && endpoint.status < 300
              ? 'healthy'
              : endpoint.status < 400
                ? 'unknown'
                : 'unhealthy',
        },
      });
    },
  };
}
