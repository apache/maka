/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information.
 */

import { z } from 'zod';
import type { ToolResultContent } from '@maka/core/events';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export interface BackgroundTaskHealthReader {
  readRuntimeResource(sessionId: string, ref: string, abortSignal: AbortSignal): Promise<ToolResultContent>;
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
      'Check a tracked background task and, when given its HTTP endpoint, verify that the endpoint is reachable. Process tracking and endpoint readiness are reported separately.',
    parameters: z.object({
      ref: z.string().describe('The maka://runtime/background-tasks/<id> ref returned by Bash'),
      url: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Health endpoint must use HTTP or HTTPS').optional().describe('The HTTP or HTTPS endpoint to probe'),
    }).strict(),
    impl: async ({ ref, url }, context) => {
      const resource = await reader.readRuntimeResource(context.sessionId, ref, context.abortSignal);
      if (!resource || typeof resource !== 'object' || Array.isArray(resource) || resource.kind !== 'shell_run') {
        throw new Error('BackgroundTaskHealth requires a shell_run runtime resource');
      }
      const shell = resource as Extract<ToolResultContent, { kind: 'shell_run' }>;
      const process = {
        status: shell.status,
        tracked: true,
        ...(shell.pid !== undefined ? { pid: shell.pid } : {}),
      };
      if (!url) return JSON.stringify({ process, endpoint: { status: 'not_checked' } });
      const endpoint = await probe.probe({ url, sessionId: context.sessionId, abortSignal: context.abortSignal });
      return JSON.stringify({
        process,
        endpoint: { ...endpoint, health: endpoint.status >= 200 && endpoint.status < 400 ? 'healthy' : 'unhealthy' },
      });
    },
  };
}
