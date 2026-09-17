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

import type {
  UsageScreenRequest,
  UsageScreenResult,
  UsageScreenQuery,
  UsageScreenFailure,
} from '@maka/core/settings';
import { requireExactRecord, requireRecord, requireShapedRecord, requireCount } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { decodeUsageProvenance } from './usage-pricing.js';

export const USAGE_SCREEN_MAX_BYTES = 640 * 1024;
export const USAGE_SCREEN_SECTION_MAX_BYTES = 48 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const fail = (): never => {
  throw invalidProtocolFrame('Invalid Usage screen');
};
function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) return fail();
  return value;
}
function token(value: unknown): string {
  const result = text(value, 8192);
  if (!result || !/^[A-Za-z0-9_-]+$/.test(result)) return fail();
  return result;
}
function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail();
  return value;
}
function query(value: unknown): UsageScreenQuery {
  const v = requireExactRecord(value, 'Usage screen query', ['range', 'search', 'status']);
  const range = requireExactRecord(v.range, 'Usage range', ['from', 'to']);
  const from = requireCount(range.from, 'Usage from');
  const to = requireCount(range.to, 'Usage to');
  if (from > to || !['all', 'success', 'error', 'aborted'].includes(String(v.status)))
    return fail();
  return {
    range: { from, to },
    search: text(v.search),
    status: v.status as UsageScreenQuery['status'],
  };
}
export function decodeUsageScreenRequest(value: unknown): UsageScreenRequest {
  const v = requireRecord(value, 'Usage screen request');
  if (v.kind === 'screen') {
    requireExactRecord(v, 'Usage screen request', ['kind', 'query']);
    return { kind: 'screen', query: query(v.query) };
  }
  requireExactRecord(v, 'Usage activity request', [
    'kind',
    'query',
    'revision',
    'queryIdentity',
    'cursor',
  ]);
  if (v.kind !== 'activity') return fail();
  return {
    kind: 'activity',
    query: query(v.query),
    revision: token(v.revision),
    queryIdentity: token(v.queryIdentity),
    cursor: token(v.cursor),
  };
}

// The only cached fact is a byte count keyed by a deeply frozen response. It
// neither retains a dataset nor gives a later request access to an old snapshot.
const measuredResults = new WeakMap<object, number>();

/** Capacity is an outcome, so an oversized answer never reaches transport. */
export function usageScreenCapacity(value: UsageScreenResult): UsageScreenFailure | undefined {
  const measured = measureResult(value);
  return typeof measured === 'number' ? undefined : measured;
}

/** Carry the measurement through in-process codec validation of this value. */
export function finalizeUsageScreenResult(value: UsageScreenResult): UsageScreenResult {
  const measured = measureResult(value);
  if (typeof measured !== 'number') return measured;
  freezeResult(value);
  measuredResults.set(value, measured);
  return value;
}

/** The result and its actual response envelope have separate wire budgets. */
export function usageScreenMessageBytes(requestId: string, result: UsageScreenResult): number {
  const measured = measuredResults.get(result) ?? measureResult(result);
  if (typeof measured !== 'number') return Number.POSITIVE_INFINITY;
  return bytes({ requestId, operation: 'usage.query', ok: true, result: null }) - 4 + measured;
}

function freezeResult(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeResult(child);
  Object.freeze(value);
}

function measureResult(value: UsageScreenResult): number | UsageScreenFailure {
  const known = measuredResults.get(value);
  if (known !== undefined) return known;
  if (value.kind !== 'screen' && value.kind !== 'activity') return bytes(value);
  const page = value.kind === 'screen' ? value.screen : value.page;
  const tooLarge = (
    section: Extract<UsageScreenFailure, { kind: 'screen_response_too_large' }>['section'],
  ): UsageScreenFailure => ({ kind: 'screen_response_too_large', section });
  let collectionBytes = 0;
  if (value.kind === 'screen') {
    for (const [key, section, limit] of [
      ['byProvider', 'provider_breakdown', 100],
      ['byModel', 'model_breakdown', 100],
      ['byTool', 'tool_breakdown', 100],
      ['pricing', 'pricing', 128],
    ] as const) {
      const items = value.screen[key];
      if (items.length > limit) return tooLarge(section);
      const size = bytes(items);
      if (size > USAGE_SCREEN_SECTION_MAX_BYTES) return tooLarge(section);
      collectionBytes += size - 2;
    }
  }
  if (page.logs.length > 100 || (page.nextCursor?.length ?? 0) > 8192)
    return tooLarge('activity_page');
  const logBytes = bytes(page.logs) - 2;
  const pageBytes =
    bytes({
      revision: page.revision,
      queryIdentity: page.queryIdentity,
      logs: [],
      nextCursor: page.nextCursor,
    }) + logBytes;
  if (pageBytes > USAGE_SCREEN_SECTION_MAX_BYTES) return tooLarge('activity_page');
  // Reuse each exact collection length when measuring its containing result.
  const resultBytes =
    value.kind === 'screen'
      ? bytes({
          kind: 'screen',
          screen: {
            ...value.screen,
            byProvider: [],
            byModel: [],
            byTool: [],
            pricing: [],
            logs: [],
          },
        }) +
        collectionBytes +
        logBytes
      : bytes({ kind: 'activity', page: { ...value.page, logs: [] } }) + logBytes;
  return resultBytes > USAGE_SCREEN_MAX_BYTES ? tooLarge('screen') : resultBytes;
}

export function decodeUsageScreenResult(value: unknown): UsageScreenResult {
  const v = requireRecord(value, 'Usage screen result');
  if (v.kind === 'revision_changed') {
    requireExactRecord(v, 'Usage revision changed', ['kind']);
    return { kind: 'revision_changed' };
  }
  if (v.kind === 'screen_response_too_large') {
    requireExactRecord(v, 'Usage capacity failure', ['kind', 'section']);
    if (
      ![
        'provider_breakdown',
        'model_breakdown',
        'tool_breakdown',
        'pricing',
        'activity_page',
        'screen',
        'message',
      ].includes(String(v.section))
    )
      return fail();
    return v as unknown as UsageScreenResult;
  }
  const isScreen = v.kind === 'screen';
  if (!isScreen && v.kind !== 'activity') return fail();
  requireExactRecord(v, 'Usage result', ['kind', isScreen ? 'screen' : 'page']);
  const p = requireExactRecord(isScreen ? v.screen : v.page, 'Usage page', [
    'revision',
    'queryIdentity',
    'logs',
    'nextCursor',
    ...(isScreen
      ? [
          'query',
          'activityTotal',
          'summary',
          'byProvider',
          'byModel',
          'byTool',
          'pricing',
          'provenance',
        ]
      : []),
  ]);
  token(p.revision);
  token(p.queryIdentity);
  if (p.nextCursor !== null) token(p.nextCursor);
  if (
    !Array.isArray(p.logs) ||
    p.logs.length > 100 ||
    (p.nextCursor !== null && p.logs.length === 0)
  )
    return fail();
  for (const log of p.logs) {
    const row = requireShapedRecord(
      log,
      'Usage activity row',
      ['id', 'ts', 'kind', 'provider', 'model', 'inputTokens', 'outputTokens', 'status'],
      [
        'sessionId',
        'sessionName',
        'turnId',
        'toolName',
        'cacheMiss',
        'cacheRead',
        'cacheCreation',
        'reasoning',
        'costUsd',
        'latencyMs',
      ],
    );
    for (const key of ['id', 'provider', 'model', 'sessionId', 'sessionName', 'turnId', 'toolName'])
      if (row[key] !== undefined) text(row[key]);
    for (const key of [
      'ts',
      'inputTokens',
      'outputTokens',
      'cacheMiss',
      'cacheRead',
      'cacheCreation',
      'reasoning',
    ])
      if (row[key] !== undefined) requireCount(row[key], key);
    for (const key of ['costUsd', 'latencyMs']) if (row[key] !== undefined) amount(row[key]);
    if (
      !['model', 'tool'].includes(String(row.kind)) ||
      !['success', 'error', 'aborted'].includes(String(row.status))
    )
      return fail();
  }
  if (isScreen) {
    query(p.query);
    requireCount(p.activityTotal, 'Usage activity total');
    const summary = requireExactRecord(p.summary, 'Usage summary', [
      'totalRequests',
      'totalCostUsd',
      'totalTokens',
      'inputTokens',
      'outputTokens',
      'cacheTokens',
      'cacheMiss',
      'cacheRead',
      'cacheCreation',
      'reasoning',
    ]);
    for (const [key, value] of Object.entries(summary))
      key === 'totalCostUsd' ? amount(value) : requireCount(value, key);
    decodeUsageProvenance(p.provenance);
    for (const [key, identity, numbers] of [
      ['byProvider', ['provider'], ['requests', 'tokens', 'costUsd']],
      ['byModel', ['model'], ['requests', 'tokens', 'costUsd']],
      ['byTool', ['tool'], ['calls', 'success', 'errors', 'avgDurationMs']],
      ['pricing', ['provider', 'model'], ['inputPerMTokUsd', 'outputPerMTokUsd']],
    ] as const) {
      if (!Array.isArray(p[key])) return fail();
      for (const item of p[key]) {
        const row = requireExactRecord(item, key, [...identity, ...numbers]);
        for (const field of identity) text(row[field]);
        for (const field of numbers) amount(row[field]);
      }
    }
  }
  const result = v as unknown as UsageScreenResult;
  if (usageScreenCapacity(result)) return fail();
  return result;
}

export function assertUsageScreenResult(
  input: UsageScreenRequest,
  output: UsageScreenResult,
): void {
  if (output.kind === 'screen_response_too_large') return;
  if (input.kind === 'screen') {
    if (
      output.kind !== 'screen' ||
      JSON.stringify(output.screen.query) !== JSON.stringify(input.query)
    )
      return fail();
  } else if (output.kind !== 'revision_changed') {
    if (
      output.kind !== 'activity' ||
      output.page.revision !== input.revision ||
      output.page.queryIdentity !== input.queryIdentity ||
      output.page.nextCursor === input.cursor
    )
      return fail();
  }
}
