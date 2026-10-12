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

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isUsageScreenSearch,
  isUsageTimestamp,
  type UsageScreen,
  type UsageScreenQuery,
  type UsageScreenRequest,
  type UsageScreenResult,
  type UsageRequestLog,
} from '@maka/core/settings';
import { acquireOperationalStateDatabase } from './operational-state-store.js';
import { CACHE_READ_TOKENS } from './model-call-usage-sql.js';
import { TelemetryQueryValidationError } from './telemetry-repo.js';

const json = (key: string) => `json_extract(record_json, '$.${key}')`;
const num = (key: string) => `COALESCE(${json(key)}, 0)`;

// The three sources share accounting/filter expressions, but activity pages and
// counts select only the rows/columns they need. Aggregates remain range-wide.
const SOURCES = [
  {
    name: 'canonical',
    table: 'usage_model_call_attempts',
    time: 'completed_at',
    identity: 'attempt_id',
    filters: `provider_id AS provider, model_id AS model, NULL AS toolName,
      CASE status WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'error' ELSE 'aborted' END AS status`,
    columns: `completed_at AS ts, 'canonical' AS source, attempt_id AS identity,
    attempt_id AS id, 'model' AS kind, session_id AS sessionId, turn_id AS turnId,
    COALESCE(connection_slug, provider_id) AS connection,
    COALESCE(input_tokens, 0) AS inputTokens, COALESCE(output_tokens, 0) AS outputTokens,
    COALESCE(cache_miss_input_tokens, 0) AS cacheMiss, ${CACHE_READ_TOKENS} AS cacheRead,
    COALESCE(cache_write_input_tokens, 0) AS cacheCreation, COALESCE(reasoning_tokens, 0) AS reasoning,
    COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS totalTokens,
    cost_usd AS costUsd, latency_ms AS latencyMs,
    cost_basis AS costBasis, usage_basis AS usageBasis`,
  },
  {
    name: 'legacy',
    table: 'usage_llm_calls',
    time: 'ts',
    identity: 'storage_key',
    filters: `${json('providerId')} AS provider, ${json('modelId')} AS model,
      NULL AS toolName, ${json('status')} AS status`,
    columns: `ts, 'legacy' AS source, storage_key AS identity, id, 'model' AS kind,
    ${json('sessionId')} AS sessionId, ${json('turnId')} AS turnId,
    COALESCE(${json('connectionSlug')}, ${json('providerId')}) AS connection,
    ${num('inputTokens')} AS inputTokens, ${num('outputTokens')} AS outputTokens,
    ${num('cacheMissInputTokens')} AS cacheMiss,
    MIN(${num('inputTokens')}, ${num('cacheHitInputTokens')}) AS cacheRead,
    ${num('cacheWriteInputTokens')} AS cacheCreation, ${num('reasoningTokens')} AS reasoning,
    ${num('totalTokens')} AS totalTokens, ${num('costUsd')} AS costUsd,
    ${num('latencyMs')} AS latencyMs, NULL AS costBasis, NULL AS usageBasis`,
  },
  {
    name: 'tool',
    table: 'usage_tool_invocations',
    time: 'ts',
    identity: 'storage_key',
    filters: `COALESCE(${json('providerId')}, '') AS provider,
      COALESCE(${json('modelId')}, '') AS model, ${json('toolName')} AS toolName,
      ${json('status')} AS status`,
    columns: `ts, 'tool' AS source, storage_key AS identity, id, 'tool' AS kind,
    ${json('sessionId')} AS sessionId, ${json('turnId')} AS turnId,
    '' AS connection,
    0 AS inputTokens, 0 AS outputTokens, 0 AS cacheMiss, 0 AS cacheRead,
    0 AS cacheCreation, 0 AS reasoning, 0 AS totalTokens, NULL AS costUsd,
    ${num('durationMs')} AS latencyMs, NULL AS costBasis, NULL AS usageBasis`,
  },
] as const;
type Source = (typeof SOURCES)[number];
interface Position {
  ts: number;
  source: Source['name'];
  identity: string;
}

function rangeRows(source: Source): string {
  return `SELECT ${source.columns}, ${source.filters} FROM ${source.table}
    WHERE ${source.time} >= ? AND ${source.time} <= ?${source.name === 'canonical' ? ' AND cost_basis IS NOT NULL' : ''}`;
}
const MODEL_ROWS = `${rangeRows(SOURCES[0])} UNION ALL ${rangeRows(SOURCES[1])}`;
const TOOL_ROWS = rangeRows(SOURCES[2]);

type Row = Record<string, string | number | null>;
const n = (value: unknown): number => Number(value ?? 0);
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

type RangeStatistics = Pick<
  UsageScreen,
  'summary' | 'byProvider' | 'byModel' | 'byTool' | 'pricing' | 'provenance'
>;
interface CachedRangeStatistics {
  revision: string;
  from: number;
  to: number;
  statistics: RangeStatistics;
}

export function createUsageScreenReader(root: string) {
  const lease = acquireOperationalStateDatabase(root);
  // A restore/reopen can repeat both the durable counter and incarnation from a
  // backup. This lifecycle fence prevents tokens from surviving that reopen.
  const generation = randomUUID();
  const db = lease.database;
  // One complete range per reader; changing filters does not retain history or
  // grow the cache. Revision includes the database incarnation and lifecycle.
  let cached: CachedRangeStatistics | undefined;
  let closed = false;
  return {
    close: () => {
      closed = true;
      cached = undefined;
      lease.close();
    },
    read: (input: UsageScreenRequest): UsageScreenResult =>
      lease.transaction('read', () => {
        validateQuery(input.query);
        const state = db
          .prepare(
            'SELECT incarnation, CAST(revision AS TEXT) AS revision FROM usage_screen_revision WHERE singleton = 1',
          )
          .get();
        if (!state || typeof state.incarnation !== 'string' || typeof state.revision !== 'string')
          throw new Error('Invalid Usage revision authority');
        const revision = hash([generation, state.incarnation, state.revision]);
        const queryIdentity = hash(input.query);
        if (input.kind === 'activity') {
          if (revision !== input.revision) return { kind: 'revision_changed' };
          if (queryIdentity !== input.queryIdentity)
            throw new TelemetryQueryValidationError('Usage query changed');
          return {
            kind: 'activity',
            page: { revision, queryIdentity, ...activity(db, input.query, input.cursor) },
          };
        }
        const { from, to } = input.query.range;
        const hit =
          cached?.revision === revision && cached.from === from && cached.to === to
            ? cached
            : undefined;
        const statistics = hit?.statistics ?? readRangeStatistics(db, input.query.range);
        if ('kind' in statistics) return statistics;
        // Complete range statistics already counted every readable model/tool
        // row. Only activity filters need a separate exact count.
        const activityTotal =
          !input.query.search && input.query.status === 'all'
            ? statistics.summary.totalRequests +
              statistics.byTool.reduce((sum, row) => sum + row.calls, 0)
            : activityCount(db, input.query);
        const screen: UsageScreen = {
          revision,
          queryIdentity,
          query: input.query,
          activityTotal,
          // Host projects identities and freezes replies; returned objects must
          // never share mutable rows or arrays with another cached response.
          ...structuredClone(statistics),
          // Count and page share this read snapshot: zero proves there is no
          // matching activity, so an empty search needs only one range scan.
          ...(activityTotal === 0 ? { logs: [], nextCursor: null } : activity(db, input.query)),
        };
        if (!hit) {
          // A nested read can observe writes that later roll back and reuse the
          // same revision counter. Publish only after the outermost commit.
          lease.onTransactionSettled((committed) => {
            if (committed && !closed) cached = { revision, from, to, statistics };
          });
        }
        return { kind: 'screen', screen };
      }),
  };
}

function readRangeStatistics(
  db: DatabaseSync,
  range: UsageScreenQuery['range'],
): RangeStatistics | Extract<UsageScreenResult, { kind: 'screen_response_too_large' }> {
  const rangeArgs = [range.from, range.to];
  const modelArgs = [...rangeArgs, ...rangeArgs];
  const aggregate = db
    .prepare(`WITH rows AS (${MODEL_ROWS}) SELECT
  COUNT(*) AS totalRequests, COALESCE(SUM(costUsd), 0) AS totalCostUsd,
  ${['totalTokens', 'inputTokens', 'outputTokens', 'cacheMiss', 'cacheRead', 'cacheCreation', 'reasoning'].map((k) => `COALESCE(SUM(${k}), 0) AS ${k}`).join(', ')},
  SUM(source = 'legacy') AS legacyRecords,
  SUM(source = 'canonical') AS attempts, SUM(costBasis = 'priced') AS pricedAttempts,
  SUM(costBasis = 'unpriced') AS unpricedAttempts, SUM(usageBasis = 'reported') AS usageReportedAttempts,
  SUM(usageBasis = 'partial') AS usagePartialAttempts, SUM(usageBasis = 'missing') AS usageMissingAttempts
  FROM rows`)
    .get(...modelArgs) as Row;
  const breakdown = (column: 'connection' | 'model') =>
    db
      .prepare(`WITH rows AS (${MODEL_ROWS})
  SELECT ${column} AS name, COUNT(*) AS requests, SUM(inputTokens + outputTokens) AS tokens,
  COALESCE(SUM(costUsd), 0) AS costUsd FROM rows GROUP BY ${column} ORDER BY requests DESC, name LIMIT 101`)
      .all(...modelArgs) as Row[];
  const tools = db
    .prepare(`WITH rows AS (${TOOL_ROWS}) SELECT toolName AS tool,
  COUNT(*) AS calls, SUM(status = 'success') AS success, SUM(status = 'error') AS errors,
  ROUND(AVG(latencyMs)) AS avgDurationMs FROM rows GROUP BY toolName ORDER BY calls DESC, toolName LIMIT 101`)
    .all(...rangeArgs) as Row[];
  const providers = breakdown('connection');
  const models = breakdown('model');
  // Read one sentinel past each wire count. It can only become a whole-screen
  // failure, never a successful truncated collection. No history array is built.
  for (const [rows, section] of [
    [providers, 'provider_breakdown'],
    [models, 'model_breakdown'],
    [tools, 'tool_breakdown'],
  ] as const) {
    if (rows.length > 100) return { kind: 'screen_response_too_large', section };
  }
  const pricing = db
    .prepare('SELECT record_json FROM usage_pricing_overrides ORDER BY model_key LIMIT 129')
    .all()
    .map((row) => {
      const value = JSON.parse(String(row.record_json));
      const separator = value.modelKey.indexOf(':');
      return {
        provider: separator < 0 ? '' : value.modelKey.slice(0, separator),
        model: separator < 0 ? value.modelKey : value.modelKey.slice(separator + 1),
        inputPerMTokUsd: value.inputUsdPer1M,
        outputPerMTokUsd: value.outputUsdPer1M,
      };
    });
  if (pricing.length > 128) return { kind: 'screen_response_too_large', section: 'pricing' };
  const unreadable =
    n(
      db
        .prepare(`SELECT COUNT(*) AS count FROM usage_model_call_attempts
  WHERE completed_at >= ? AND completed_at <= ? AND cost_basis IS NULL`)
        .get(...rangeArgs)?.count,
    ) +
    n(
      db
        .prepare(
          'SELECT SUM(unreadable_events) AS count FROM usage_model_call_projection_checkpoints',
        )
        .get()?.count,
    );
  const pending = n(
    db
      .prepare(`SELECT COUNT(*) AS count FROM core_agent_runs AS source
  LEFT JOIN usage_model_call_projection_checkpoints AS checkpoint
    ON checkpoint.session_id = source.session_id AND checkpoint.run_id = source.run_id
  WHERE source.latest_model_call_sequence > COALESCE(checkpoint.applied_through_sequence, -1)`)
      .get()?.count,
  );
  return {
    summary: {
      totalRequests: n(aggregate.totalRequests),
      totalCostUsd: n(aggregate.totalCostUsd),
      totalTokens: n(aggregate.totalTokens),
      inputTokens: n(aggregate.inputTokens),
      outputTokens: n(aggregate.outputTokens),
      cacheTokens: n(aggregate.cacheRead) + n(aggregate.cacheCreation),
      cacheMiss: n(aggregate.cacheMiss),
      cacheRead: n(aggregate.cacheRead),
      cacheCreation: n(aggregate.cacheCreation),
      reasoning: n(aggregate.reasoning),
    },
    byProvider: providers.map((row) => ({
      provider: String(row.name),
      requests: n(row.requests),
      tokens: n(row.tokens),
      costUsd: n(row.costUsd),
    })),
    byModel: models.map((row) => ({
      model: String(row.name),
      requests: n(row.requests),
      tokens: n(row.tokens),
      costUsd: n(row.costUsd),
    })),
    byTool: tools.map((row) => ({
      tool: String(row.tool),
      calls: n(row.calls),
      success: n(row.success),
      errors: n(row.errors),
      avgDurationMs: n(row.avgDurationMs),
    })),
    pricing,
    provenance: {
      coverage: {
        attempts: n(aggregate.attempts),
        pricedAttempts: n(aggregate.pricedAttempts),
        unpricedAttempts: n(aggregate.unpricedAttempts),
        usageReportedAttempts: n(aggregate.usageReportedAttempts),
        usagePartialAttempts: n(aggregate.usagePartialAttempts),
        usageMissingAttempts: n(aggregate.usageMissingAttempts),
      },
      legacyRecords: n(aggregate.legacyRecords),
      unreadableRecords: unreadable,
      pendingRepairs: pending,
    },
  };
}

function validateQuery(query: UsageScreenQuery): void {
  if (
    !isUsageTimestamp(query.range.from) ||
    !isUsageTimestamp(query.range.to) ||
    query.range.to < query.range.from ||
    !isUsageScreenSearch(query.search) ||
    !['all', 'success', 'error', 'aborted'].includes(query.status)
  ) {
    throw new TelemetryQueryValidationError('Invalid Usage screen query');
  }
}

function activityPredicate(query: UsageScreenQuery) {
  const args: (string | number)[] = [];
  const filters: string[] = [];
  if (query.status !== 'all') {
    filters.push('status = ?');
    args.push(query.status);
  }
  if (query.search) {
    // JS lowercasing is also used by the original renderer, including Unicode.
    filters.push(
      `(instr(usage_screen_lower(model), ?) > 0 OR instr(usage_screen_lower(provider), ?) > 0 OR instr(usage_screen_lower(COALESCE(toolName, '')), ?) > 0)`,
    );
    args.push(query.search.toLowerCase(), query.search.toLowerCase(), query.search.toLowerCase());
  }
  return { args, filters };
}

function activitySourceQuery(
  source: Source,
  query: UsageScreenQuery,
  columns: string,
  position?: Position,
) {
  const bounds = [`${source.time} >= ?`];
  const args: (string | number)[] = [query.range.from];
  if (!position) {
    bounds.push(`${source.time} <= ?`);
    args.push(query.range.to);
  } else if (source.name === position.source) {
    // The cursor is validated inside the fixed range. Replacing its redundant
    // upper bound lets SQLite seek on both index columns, even on deep pages.
    bounds.push(`(${source.time}, ${source.identity}) < (?, ?)`);
    args.push(position.ts, position.identity);
  } else {
    // Source names are ASCII and follow the existing SQLite BINARY ordering.
    bounds.push(`${source.time} ${source.name < position.source ? '<=' : '<'} ?`);
    args.push(position.ts);
  }
  if (source.name === 'canonical') bounds.push('cost_basis IS NOT NULL');
  const predicate = activityPredicate(query);
  args.push(...predicate.args);
  return {
    sql: `SELECT * FROM (SELECT ${columns} FROM ${source.table} WHERE ${bounds.join(' AND ')})
      ${predicate.filters.length ? `WHERE ${predicate.filters.join(' AND ')}` : ''}`,
    args,
  };
}

function activityCount(db: DatabaseSync, query: UsageScreenQuery): number {
  const sources = SOURCES.map((source) => activitySourceQuery(source, query, source.filters));
  return n(
    db
      .prepare(
        `SELECT ${sources.map(({ sql }) => `(SELECT COUNT(*) FROM (${sql}))`).join(' + ')} AS count`,
      )
      .get(...sources.flatMap(({ args }) => args))?.count,
  );
}

function activity(db: DatabaseSync, query: UsageScreenQuery, cursor?: string) {
  let position: Position | undefined;
  if (cursor) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new TelemetryQueryValidationError('Invalid Usage cursor');
    }
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== hash(query) ||
      !isUsageTimestamp(value[1]) ||
      value[1] < query.range.from ||
      value[1] > query.range.to ||
      !['canonical', 'legacy', 'tool'].includes(value[2]) ||
      typeof value[3] !== 'string'
    ) {
      throw new TelemetryQueryValidationError('Invalid Usage cursor');
    }
    const [table, key, time] =
      value[2] === 'canonical'
        ? ['usage_model_call_attempts', 'attempt_id', 'completed_at']
        : value[2] === 'legacy'
          ? ['usage_llm_calls', 'storage_key', 'ts']
          : ['usage_tool_invocations', 'storage_key', 'ts'];
    if (
      !db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ? AND ${time} = ?`).get(value[3], value[1])
    ) {
      throw new TelemetryQueryValidationError('Invalid Usage cursor position');
    }
    position = { ts: value[1], source: value[2], identity: value[3] };
  }
  const sources = SOURCES.map((source) =>
    activitySourceQuery(source, query, `${source.columns}, ${source.filters}`, position),
  );
  // A source's 52nd matching row cannot be in the global first 51. Each local
  // ORDER BY matches its index; the final sort sees at most 3 * 51 candidates.
  const rows = db
    .prepare(`WITH candidates AS (${sources
      .map(({ sql }) => `SELECT * FROM (${sql} ORDER BY ts DESC, identity DESC LIMIT 51)`)
      .join(' UNION ALL ')})
    SELECT * FROM candidates
    ORDER BY ts DESC, source DESC, identity DESC LIMIT 51`)
    .all(...sources.flatMap(({ args }) => args)) as Row[];
  const selected = rows.slice(0, 50);
  const last = selected.at(-1);
  // Resolve only this bounded page inside the same read transaction as its
  // revision. Metadata title mutations invalidate subsequent continuations.
  const title = db.prepare('SELECT name FROM session_metadata WHERE session_id = ?');
  return {
    logs: selected.map((row) => {
      const {
        source: _source,
        identity: _identity,
        connection: _connection,
        totalTokens: _total,
        costBasis: _cost,
        usageBasis: _usage,
        ...log
      } = row;
      const sessionName = row.sessionId ? String(title.get(row.sessionId)?.name ?? '').trim() : '';
      if (sessionName) log.sessionName = sessionName;
      return Object.fromEntries(
        Object.entries(log).filter(([, value]) => value !== null),
      ) as unknown as UsageRequestLog;
    }),
    nextCursor:
      rows.length > 50 && last
        ? Buffer.from(JSON.stringify([hash(query), last.ts, last.source, last.identity])).toString(
            'base64url',
          )
        : null,
  };
}
