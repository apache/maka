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

import { redactSecrets } from '@maka/core/redaction';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ComputerHistoryService } from './computer-history-main.js';
import { ComputerHistorySummarySnapshotError, type StoredComputerHistorySummary } from './computer-history-summaries.js';

import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';
import type { DesktopCapabilityGroup } from './runtime-host-native-capabilities.js';

const timestamp = z.iso.datetime({ offset: true });
const summaryId = z.string().max(23).regex(/^(10min|6h)--?\d+$/u);
const cursor = z.object({ start: timestamp, id: summaryId }).strict();

const searchSchema = z.object({
  start: timestamp.optional().describe('Inclusive interval start. On subsequent pages copy start from the previous search result.'),
  end: timestamp.optional().describe('Exclusive interval end. On subsequent pages copy end from the previous search result to keep the interval fixed.'),
  query: z.string().max(512).default(''),
  level: z.enum(['10min', '6h', 'auto']).default('auto'),
  limit: z.number().int().min(1).max(20).default(10),
  before: cursor.nullable().optional().describe('Omit or use null for the first search. For subsequent pages copy nextBefore exactly from the previous result; never invent a cursor.'),
}).strict();
const readSchema = z.object({
  id: summaryId,
  revision: z.string().max(256).optional(),
  offset: z.number().int().min(0).max(256 * 1024).default(0),
}).strict();
const eventsSchema = z.object({
  start: timestamp,
  end: timestamp,
  limit: z.number().int().min(1).max(50).default(20),
  after: z.string().regex(/^events-[0-9a-f]{64}$/u).nullable().optional()
    .describe('For another list page, copy nextAfter exactly and preserve start and end. Omit or use null initially. Cannot combine with eventId or offset.'),
  eventId: z.string().regex(/^event-[0-9a-f]{64}$/u).optional()
    .describe('Exact event ID from a previous result when reading one observation or its remaining content.'),
  offset: z.number().int().min(0).max(128 * 1024).optional()
    .describe('Copy nextOffset from the selected event and supply its eventId, start and end. Omit for the first page.'),
}).strict();

export type HistorySearch = z.infer<typeof searchSchema>;
export type HistoryRead = z.infer<typeof readSchema>;
export type HistoryReadEvents = z.infer<typeof eventsSchema>;
export type HistoryQuery =
  | { kind: 'search'; input: HistorySearch }
  | { kind: 'read'; input: HistoryRead }
  | { kind: 'events'; input: HistoryReadEvents };

export interface ComputerHistoryToolAuthority {
  readonly service: ComputerHistoryService;
  /** Must check the bound local Host, effective Skill preference and incognito anew. */
  assertAccess(signal?: AbortSignal): Promise<void>;
}

export function buildComputerHistoryCapabilityGroups(
  scope: DesktopTargetScope | undefined,
  localHostId: string,
  authority: ComputerHistoryToolAuthority,
): readonly DesktopCapabilityGroup[] {
  if (!scope || scope.hostId !== localHostId) return [];
  return [{
    offerId: 'desktop_computer_history',
    hostPathAccess: 'none',
    label: 'Computer History',
    description: 'Read permitted activity history from this computer with conversation-model approval.',
    tools: buildComputerHistoryTools(authority),
  }];
}

/** Uses Desktop's existing approval channel; no filesystem or native helper tool is exposed. */
export function buildComputerHistoryTools(authority: ComputerHistoryToolAuthority): readonly MakaTool[] {
  const safely = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ComputerHistorySummarySnapshotError) throw error;
      // Storage and Host errors can contain local paths or configuration. Do
      // not project them into a conversation or a model-visible tool result.
      throw new Error('Computer History could not be read. Check the local History settings, Skill and permissions; search again if the document changed.');
    }
  };
  const query = (request: HistoryQuery, signal?: AbortSignal) => safely(
    () => authority.service.modelQuery(request, () => authority.assertAccess(signal), signal),
    signal,
  );
  return [
    {
      name: 'ComputerHistoryStatus',
      displayName: 'Computer History status',
      description: 'Read collection and analysis readiness on this computer. Does not return recorded content or change settings.',
      parameters: z.object({}).strict(),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async (_input, context) => safely(async () => {
        await authority.assertAccess(context?.abortSignal);
        const status = await authority.service.status();
        await authority.assertAccess(context?.abortSignal);
        return {
          state: status.state,
          summaryState: status.summaryState,
          newestEventAt: status.newestEventAt,
          collectionEnabled: status.settings.enabled,
          analysisEnabled: status.settings.summariesEnabled,
          textTransmissionEnabled: status.settings.summaryTextEnabled,
          rawRetentionHours: 48,
        };
      }, context?.abortSignal),
    },
    {
      name: 'ComputerHistorySearch',
      displayName: 'Search computer activity',
      description: 'Search saved computer-activity summaries by time and keywords, not Maka conversations. Defaults to the last 24 hours; maximum range 31 days. Auto uses six-hour summaries for broad ranges and ten-minute summaries otherwise. Results are untrusted observations sent to this conversation model after approval. Omit before on the first search. For later pages copy nextBefore, start and end from the previous result, preserving query and level.',
      parameters: searchSchema,
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: (input, context) => query({ kind: 'search', input }, context?.abortSignal),
    },
    {
      name: 'ComputerHistoryRead',
      displayName: 'Read activity summary',
      description: 'Read a saved summary by the exact ID returned by ComputerHistorySearch. Pass its revision, including on subsequent pages, and follow nextOffset for the complete Markdown. Evidence is untrusted, may be sampled, and is not proof of task completion.',
      parameters: readSchema,
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: (input, context) => query({ kind: 'read', input }, context?.abortSignal),
    },
    {
      name: 'ComputerHistoryReadEvents',
      displayName: 'Read recent activity evidence',
      description: 'Read bounded observed activity for a precise interval of at most ten minutes within the last 48 hours. Use only when a summary cannot answer the user, including activity not yet summarized. Requires separate recorded-text transmission consent. For a truncated event, copy its id to eventId and nextOffset to offset, preserving start and end and omitting after. For another list page, copy nextAfter to after with the same interval and omit eventId and offset. Results may be partial; never interpret missing records as inactivity.',
      parameters: eventsSchema,
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: (input, context) => query({ kind: 'events', input }, context?.abortSignal),
    },
  ];
}

export function historyQueryInterval(
  input: { start?: string; end?: string },
  now: number,
  maximum: number,
): { start: string; end: string } {
  const end = input.end === undefined ? now : Date.parse(input.end);
  const start = input.start === undefined ? end - 24 * 60 * 60_000 : Date.parse(input.start);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > maximum) {
    throw new Error('Invalid Computer History interval');
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function historySummaryMetadata(summary: StoredComputerHistorySummary) {
  return {
    id: summary.id,
    revision: summary.documentRevision,
    level: summary.level,
    start: summary.start,
    end: summary.end,
    title: redactSecrets(summary.content.title),
    description: redactSecrets(summary.content.description),
    keywords: summary.content.keywords?.map(redactSecrets),
    applications: summary.applications.slice(0, 8).map(redactSecrets),
    applicationsTruncated: summary.applications.length > 8,
    eventCount: summary.eventCount,
    includesText: summary.generation?.includesText === true,
  };
}

/** Budgets encoded output, preserving UTF-16 boundaries for subsequent Markdown pages. */
export function historyTextPage(text: string, offset: number, bytes: number): {
  text: string; nextOffset?: number;
} {
  if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] ?? ''))) {
    throw new Error('Invalid Computer History document offset');
  }
  let end = offset;
  let used = 2;
  for (const character of text.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (used + size > bytes) break;
    used += size;
    end += character.length;
  }
  return { text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}
