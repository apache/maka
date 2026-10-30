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

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Observability for the assistant's background model work (#6309).
 *
 * Every discovery run (broad heartbeat, quick discovery) and every Matter
 * activation appends one row recording what it cost and how it ended. Nothing
 * here limits, delays or reroutes a run: the ledger is written after the run has
 * finished, a write failure is swallowed, and no scheduler reads it.
 *
 * Cost is not a new metering path. The model calls are already in the Usage
 * ledger under the worker's own Session id (discovery, judgement, quick
 * discovery) or the Matter's Session; this module reads that ledger for the
 * run's time window (the technique hosted-execution settlement uses) and keeps
 * the answer next to the outcome the Usage ledger cannot know. Discovery workers
 * are dedicated background Sessions, so a user's Session cost never includes
 * them (#5691).
 */

/** Model usage a Session accrued in one time window, read from the Usage ledger. */
export interface SessionUsageWindow {
  /** Model-call attempts, retries included. */
  readonly calls: number;
  /** Input tokens including cache reads, as the Usage page counts them. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Recorded model-call time, not the run's wall-clock duration. */
  readonly modelDurationMs: number;
  /** False when the ledger had partial, missing, unreadable or unrepaired rows for the window. */
  readonly complete: boolean;
}

export type ReadSessionUsage = (
  sessionId: string,
  from: number,
  to: number,
) => Promise<SessionUsageWindow>;

export type AssistantRunKind = 'discovery' | 'quick_discovery' | 'matter_activation';

/**
 * Discovery kinds end `reported` (something was handed to the Bot), `no_report`
 * (the run finished and handed over nothing) or `failed`. A Matter activation
 * ends `completed` (it committed a settlement), `failed` (it ended without one),
 * `retried` (a transient execution failure that will run again) or
 * `interrupted` (the user paused or cancelled it); it has no report to count.
 */
export type AssistantRunOutcome =
  | 'reported'
  | 'no_report'
  | 'failed'
  | 'completed'
  | 'retried'
  | 'interrupted';

export interface RunSegment {
  readonly sessionId: string;
  readonly from: number;
  readonly to: number;
}

export interface AssistantRunInput {
  readonly kind: AssistantRunKind;
  readonly runId: string;
  readonly matterId?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: AssistantRunOutcome;
  /** One entry per Session the run drove (a heartbeat drives discovery and judgement). */
  readonly segments: readonly RunSegment[];
}

export interface RunCostTotals {
  readonly runs: number;
  readonly reported: number;
  readonly noReport: number;
  readonly failed: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly modelDurationMs: number;
  /** Runs whose usage window could not be read in full; their totals are lower bounds. */
  readonly incompleteUsageRuns: number;
}

export interface RunCostRow {
  readonly kind: AssistantRunKind;
  readonly runId: string;
  readonly matterId: string | null;
  readonly day: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly outcome: AssistantRunOutcome;
  /** Null for a Matter activation, which reports through its own settlement. */
  readonly reported: boolean | null;
  readonly calls: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly modelDurationMs: number;
  readonly usageComplete: boolean;
}

export interface RunCostSummary {
  /** Per local-calendar day and kind, newest day first. */
  readonly daily: readonly ({
    readonly day: string;
    readonly kind: AssistantRunKind;
  } & RunCostTotals)[];
  /** Activations and cost per Matter in the window, busiest first. */
  readonly matters: readonly ({ readonly matterId: string; readonly activations: number } & Omit<
    RunCostTotals,
    'runs' | 'reported' | 'noReport'
  >)[];
  /** Most recent runs, newest first. */
  readonly recent: readonly RunCostRow[];
}

const DAY_MS = 86_400_000;

/** Calendar day in the Host's local time zone, `YYYY-MM-DD`. */
export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const UNKNOWN_USAGE: SessionUsageWindow = {
  calls: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  modelDurationMs: 0,
  complete: false,
};

export class RunCostLedger {
  #db?: DatabaseSync;
  #closed = false;

  constructor(
    directory: string,
    private readonly readUsage?: ReadSessionUsage,
    private readonly now: () => number = Date.now,
  ) {
    // A damaged observability database must not keep the assistant from
    // starting: the ledger then records nothing and reads back empty.
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.#db = new DatabaseSync(join(directory, 'run-cost.sqlite'));
      this.#init(this.#db);
    } catch {
      this.#db?.close();
      this.#db = undefined;
    }
  }

  #init(db: DatabaseSync) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS run_cost(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        run_id TEXT NOT NULL,
        matter_id TEXT,
        day TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reported INTEGER,
        calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        model_duration_ms INTEGER NOT NULL,
        usage_complete INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS run_cost_day ON run_cost(day, kind);
      CREATE INDEX IF NOT EXISTS run_cost_matter ON run_cost(matter_id, started_at);`);
  }

  /**
   * Appends one finished run. Never throws: observing a run must not change it,
   * so a closed ledger, an unreadable Usage ledger or a full disk loses the row
   * and nothing else. Returns whether the row was written.
   */
  async record(run: AssistantRunInput): Promise<boolean> {
    if (this.#closed || !this.#db) return false;
    try {
      const usage = await this.#usage(run.segments);
      if (this.#closed || !this.#db) return false;
      this.#db
        .prepare(
          `INSERT INTO run_cost(kind,run_id,matter_id,day,started_at,ended_at,duration_ms,outcome,reported,
             calls,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,model_duration_ms,usage_complete)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          run.kind,
          run.runId,
          run.matterId ?? null,
          localDay(run.startedAt),
          run.startedAt,
          run.endedAt,
          Math.max(0, run.endedAt - run.startedAt),
          run.outcome,
          run.kind === 'matter_activation' ? null : run.outcome === 'reported' ? 1 : 0,
          usage.calls,
          usage.inputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.outputTokens,
          usage.modelDurationMs,
          usage.complete ? 1 : 0,
        );
      return true;
    } catch {
      return false;
    }
  }

  async #usage(segments: readonly RunSegment[]): Promise<SessionUsageWindow> {
    if (!this.readUsage || !segments.length) return UNKNOWN_USAGE;
    const sum = { ...UNKNOWN_USAGE, complete: true };
    for (const segment of segments) {
      let part: SessionUsageWindow;
      try {
        part = await this.readUsage(segment.sessionId, segment.from, segment.to);
      } catch {
        // An unreadable window is unknown, not zero.
        sum.complete = false;
        continue;
      }
      sum.calls += part.calls;
      sum.inputTokens += part.inputTokens;
      sum.cacheReadTokens += part.cacheReadTokens;
      sum.cacheWriteTokens += part.cacheWriteTokens;
      sum.outputTokens += part.outputTokens;
      sum.modelDurationMs += part.modelDurationMs;
      sum.complete &&= part.complete;
    }
    return sum;
  }

  /** Per-day totals and per-Matter activations for the last `days` calendar days, plus recent runs. */
  summary(options: { days?: number; recent?: number } = {}): RunCostSummary {
    const db = this.#db;
    if (this.#closed || !db) return { daily: [], matters: [], recent: [] };
    const days = Math.min(Math.max(options.days ?? 7, 1), 90);
    const since = localDay(this.now() - (days - 1) * DAY_MS);
    const totals = `COUNT(*) AS runs,
      COALESCE(SUM(outcome='reported'),0) AS reported,
      COALESCE(SUM(outcome='no_report'),0) AS noReport,
      COALESCE(SUM(outcome='failed'),0) AS failed,
      COALESCE(SUM(calls),0) AS calls,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(duration_ms),0) AS durationMs,
      COALESCE(SUM(model_duration_ms),0) AS modelDurationMs,
      COALESCE(SUM(usage_complete=0),0) AS incompleteUsageRuns`;
    const daily = db
      .prepare(
        `SELECT day, kind, ${totals} FROM run_cost WHERE day >= ? GROUP BY day, kind ORDER BY day DESC, kind`,
      )
      .all(since)
      .map((row) => ({ ...row })) as unknown as RunCostSummary['daily'][number][];
    const matters = db
      .prepare(
        `SELECT matter_id AS matterId, ${totals} FROM run_cost
         WHERE kind='matter_activation' AND matter_id IS NOT NULL AND day >= ?
         GROUP BY matter_id ORDER BY runs DESC, matter_id`,
      )
      .all(since)
      .map((row: Record<string, unknown>) => {
        const { runs, reported: _reported, noReport: _noReport, ...rest } = row;
        return { ...rest, activations: runs };
      }) as unknown as RunCostSummary['matters'][number][];
    const recent = db
      .prepare('SELECT * FROM run_cost ORDER BY seq DESC LIMIT ?')
      .all(Math.min(Math.max(options.recent ?? 20, 0), 100))
      .map(
        (row: Record<string, any>): RunCostRow => ({
          kind: row.kind,
          runId: row.run_id,
          matterId: row.matter_id,
          day: row.day,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          durationMs: row.duration_ms,
          outcome: row.outcome,
          reported: row.reported === null ? null : row.reported === 1,
          calls: row.calls,
          inputTokens: row.input_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheWriteTokens: row.cache_write_tokens,
          outputTokens: row.output_tokens,
          modelDurationMs: row.model_duration_ms,
          usageComplete: row.usage_complete === 1,
        }),
      );
    return { daily, matters, recent };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db?.close();
  }
}
