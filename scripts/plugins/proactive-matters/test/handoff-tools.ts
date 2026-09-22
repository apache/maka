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
export function buildHandoffTools(fixture: any) {
  const invoke = async (method, path, input = {}) => {
    let response;
    try {
      response = await fetch(
        fixture.baseUrl + path + (method === 'GET' ? '?' + new URLSearchParams(input) : ''),
        {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new Error(
        `${method} ${path}: connection ended before confirmation; outcome unknown. clientRequestId=${input.clientRequestId ?? ''}`,
      );
    }
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const tool = (name, description, method, path, parameters) => ({
    name,
    description,
    parameters,
    categoryHint: method === 'GET' ? 'read' : 'network_send',
    ...(method === 'GET' ? {} : { executionSemantics: 'exclusive_step' }),
    impl: (input) => invoke(method, path, input),
  });
  return [
    tool(
      'ProjectFiles',
      'List the current project files, their versions, checksums and upload times.',
      'GET',
      '/files',
      z.object({ projectId: z.literal('brand-refresh') }),
    ),
    tool(
      'ReviewRecords',
      'Read review records. Every record identifies the exact file and review category it concerns. Omit fileId to list all current records.',
      'GET',
      '/reviews',
      z.object({ fileId: z.string().optional() }),
    ),
    tool(
      'CalendarFreeBusy',
      'Read common free half-hour slots for the user and design lead on the requested date, with participant IDs. Availability may change before creation.',
      'GET',
      '/calendar/freebusy',
      z.object({ date: z.string() }),
    ),
    tool(
      'CalendarEvents',
      'Read actual calendar events and their confirmation status. Optionally filter by the creation request ID.',
      'GET',
      '/calendar/events',
      z.object({ clientRequestId: z.string().optional() }),
    ),
    tool(
      'CalendarCreate',
      'Create a meeting in the calendar with an attached project file. Set sendInvites to choose whether to send invitations. clientRequestId deduplicates identical creation retries; reusing it with different arguments after a committed creation is rejected.',
      'POST',
      '/calendar/events',
      z.object({
        title: z.string(),
        date: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        participantIds: z.array(z.string()),
        fileId: z.string(),
        sendInvites: z.boolean(),
        clientRequestId: z.string().min(1),
      }),
    ),
    tool(
      'ProjectTask',
      'Read the current project task including its revision, linked file and calendar event.',
      'GET',
      '/task',
      z.object({ taskId: z.literal('BRAND-42') }),
    ),
    tool(
      'ProjectTaskUpdate',
      'Update the task status and linked resources. expectedVersion protects concurrent edits; a conflict requires reading the latest task. clientRequestId deduplicates identical update retries.',
      'PATCH',
      '/task',
      z.object({
        taskId: z.literal('BRAND-42'),
        expectedVersion: z.number().int().positive(),
        status: z.enum(['in_progress', 'ready_for_review']),
        fileId: z.string(),
        calendarEventId: z.string(),
        clientRequestId: z.string().min(1),
      }),
    ),
  ];
}
