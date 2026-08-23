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

import {
  DAILY_REVIEW_LIST_LIMIT,
  buildDailyReviewSummary,
  dailyReviewArchiveId,
  dailyUsageQuery,
  localDayBoundsAt,
  localDayBoundsForInstant,
  pickDailyReviewSessions,
  pickDailyReviewTopEntries,
  type DailyReviewArchive,
  type DailyReviewArchiveSectionContent,
  type DailyReviewRange,
  type DailyReviewSummary,
} from '@maka/core/daily-review';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { mergeUsageBuckets, mergeUsageSummary } from '@maka/core/usage-ledger-merge';
import {
  authenticateInteractiveDailyReviewAuthorityWriter,
  type InteractiveDailyReviewAuthorityWriter,
} from '@maka/storage/daily-review-authority';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import {
  authenticateInteractiveUsageStoresWriter,
  type InteractiveUsageStoresWriter,
} from '@maka/storage/usage-stores';
import {
  DAILY_REVIEW_RESULT_MAX_BYTES,
  type DailyReviewMutateInput,
  type DailyReviewQueryInput,
  type OperationOutcome,
} from '../protocol/index.js';
import type { DailyReviewOperationHandlerMap } from './operation-dispatcher.js';
import type { HostDailyReviewModel } from './execution-model-authority.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import {
  CanonicalUsageProjectionIncompleteError,
  readCompleteCanonicalUsage,
} from './canonical-usage-reader.js';

const ARCHIVE_LIMIT = 180;
const SCHEDULER_INTERVAL_MS = 60_000;

export interface HostDailyReviewCoordinatorInput {
  readonly store: InteractiveDailyReviewAuthorityWriter;
  readonly usage: InteractiveUsageStoresWriter;
  readonly sessions: Pick<ExecutionSessionWriter, 'list'>;
  readonly model: HostDailyReviewModel;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain: () => void;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
}

/** Host-owned Daily Review data, generation, archive, and scheduling boundary. */
export class HostDailyReviewCoordinator {
  readonly handlers: DailyReviewOperationHandlerMap = {
    'daily-review.query': (input) => this.#query(input),
    'daily-review.mutate': (input) => this.#mutate(input),
  };

  readonly #store: InteractiveDailyReviewAuthorityWriter;
  readonly #usage: InteractiveUsageStoresWriter;
  readonly #sessions: HostDailyReviewCoordinatorInput['sessions'];
  readonly #model: HostDailyReviewModel;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #now: () => number;
  readonly #setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly #clearInterval: (timer: unknown) => void;
  readonly #inFlight = new Map<
    string,
    {
      readonly modelKey: string;
      readonly trigger: 'cron' | 'manual';
      readonly promise: Promise<DailyReviewArchive>;
    }
  >();
  readonly #abortControllers = new Set<AbortController>();

  #prepared = false;
  #started = false;
  #schedulerEnabled = false;
  #draining = false;
  #timer: unknown;
  #residency: RuntimeHostResidency | undefined;
  #closeTask: Promise<void> | undefined;

  constructor(input: HostDailyReviewCoordinatorInput) {
    this.#store = authenticateInteractiveDailyReviewAuthorityWriter(input.store);
    this.#usage = authenticateInteractiveUsageStoresWriter(input.usage);
    this.#sessions = input.sessions;
    this.#model = input.model;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
    this.#now = input.now ?? Date.now;
    this.#setInterval =
      input.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.#clearInterval =
      input.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  }

  async recover(): Promise<void> {
    await this.prepareRecovery();
    await this.start();
  }

  async prepareRecovery(): Promise<void> {
    if (this.#prepared) return;
    const snapshot = await this.#store.readConfig();
    this.#schedulerEnabled = snapshot.config.enabled;
    this.#prepared = true;
  }

  async start(): Promise<void> {
    if (!this.#prepared) throw new Error('Daily Review recovery was not prepared');
    if (this.#started) return;
    this.#started = true;
    this.#reconcileScheduler(this.#schedulerEnabled);
    try {
      await this.#tickScheduler();
    } catch (error) {
      if (isRetryableSchedulerError(error)) return;
      throw error;
    }
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#stopScheduler();
    for (const controller of this.#abortControllers) {
      controller.abort(new DOMException('Runtime Host is draining', 'AbortError'));
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= (async () => {
      this.beginDrain();
      await Promise.allSettled([...this.#inFlight.values()].map((entry) => entry.promise));
    })();
    return this.#closeTask;
  }

  async #query(input: DailyReviewQueryInput): Promise<OperationOutcome<'daily-review.query'>> {
    if (!this.#prepared) return queryFailure('host_not_ready', 'Daily Review is not ready');
    if (this.#draining) return queryFailure('host_draining', 'Runtime Host is draining');
    try {
      switch (input.kind) {
        case 'config': {
          const snapshot = await this.#store.readConfig();
          return querySuccess({ kind: 'config', ...snapshot });
        }
        case 'summary':
          return querySuccess({
            kind: 'summary',
            summary: await this.#buildSummary(input.offsetDays, input.daySpan),
          });
        case 'archives': {
          const beforeArchiveId = input.beforeArchiveId;
          const page = await this.#store.listArchivePage(beforeArchiveId, input.limit);
          return querySuccess({
            kind: 'archives',
            archives: page.archives,
            beforeArchiveId,
            nextBeforeArchiveId: page.nextBeforeArchiveId,
          });
        }
        case 'archive':
          return querySuccess({
            kind: 'archive',
            archive: await this.#store.getArchive(input.archiveId),
          });
      }
    } catch (error) {
      return this.#readFailure(error);
    }
  }

  async #mutate(input: DailyReviewMutateInput): Promise<OperationOutcome<'daily-review.mutate'>> {
    if (!this.#prepared) return mutateFailure('host_not_ready', 'Daily Review is not ready');
    if (this.#draining) return mutateFailure('host_draining', 'Runtime Host is draining');
    try {
      if (input.kind === 'update_config') {
        const result = await this.#store.updateConfig(input.expectedRevision, input.config);
        if (result.kind === 'revision_conflict') {
          return mutateSuccess(result);
        }
        this.#reconcileScheduler(result.snapshot.config.enabled);
        void this.#tickScheduler().catch((error: unknown) => this.#handleSchedulerError(error));
        return mutateSuccess({
          kind: result.kind === 'committed' ? 'config_committed' : 'config_unchanged',
          ...result.snapshot,
        });
      }
      if (input.kind === 'delete') {
        return mutateSuccess({
          kind: 'deleted',
          archiveId: input.archiveId,
          deleted: await this.#store.deleteArchive(input.archiveId),
        });
      }
      return mutateSuccess({
        kind: 'archive',
        archive: await this.#run({
          range: input.range,
          offsetDays: input.offsetDays,
          modelKeyOverride: input.modelKeyOverride,
          trigger: 'manual',
          replaceExisting: input.replaceExisting,
        }),
      });
    } catch (error) {
      if (this.#draining || isAbort(error)) {
        return mutateFailure('host_draining', 'Runtime Host is draining');
      }
      if (error instanceof CanonicalUsageProjectionIncompleteError) {
        return mutateFailure(
          'projection_incomplete',
          'Daily Review is waiting for canonical Usage repair',
        );
      }
      if (error instanceof DailyReviewRunConflictError) {
        return mutateFailure('operation_conflict', error.message);
      }
      this.#requestDrain();
      return mutateFailure('persistence_failed', 'Daily Review mutation failed');
    }
  }

  async #buildSummary(offsetDays: number, daySpan: number): Promise<DailyReviewSummary> {
    const offset = Math.trunc(offsetDays);
    const span = Math.max(1, Math.min(30, Math.trunc(daySpan)));
    const now = this.#now();
    const endDay = offset === 0 ? localDayBoundsForInstant(now) : localDayBoundsAt(now, offset);
    const startDay = localDayBoundsAt(endDay.fromMs, -(span - 1));
    const range = { fromMs: startDay.fromMs, toMs: endDay.toMs };
    const query = dailyUsageQuery(range);
    const canonical = await readCompleteCanonicalUsage(this.#usage, query, now);
    const [usageSummary, toolBuckets, modelBuckets, sessions] = await Promise.all([
      this.#usage.telemetry.summary(query),
      this.#usage.telemetry.buckets(query, 'tool'),
      this.#usage.telemetry.buckets(query, 'model'),
      this.#sessions.list(),
    ]);
    return buildDailyReviewSummary({
      day: range,
      usageSummary: mergeUsageSummary(usageSummary, canonical, query, now),
      sessions: pickDailyReviewSessions(
        collapseSessionRevisions(sessions),
        range,
        DAILY_REVIEW_LIST_LIMIT,
      ),
      topTools: pickDailyReviewTopEntries(toolBuckets, DAILY_REVIEW_LIST_LIMIT),
      topModels: pickDailyReviewTopEntries(
        mergeUsageBuckets(modelBuckets, canonical, query, 'model', now).buckets,
        DAILY_REVIEW_LIST_LIMIT,
      ),
    });
  }

  async #run(input: {
    readonly range: DailyReviewRange;
    readonly offsetDays: number;
    readonly modelKeyOverride: string;
    readonly trigger: 'cron' | 'manual';
    readonly replaceExisting: boolean;
  }): Promise<DailyReviewArchive> {
    const summary = await this.#buildSummary(input.offsetDays, input.range);
    const archiveId = dailyReviewArchiveId(summary.day, input.range);
    const existing = await this.#store.getArchive(archiveId);
    if (existing && !input.replaceExisting) return existing;
    const config = await this.#store.readConfig();
    const modelKey = input.modelKeyOverride.trim() || config.config.modelKey;
    const inFlight = this.#inFlight.get(archiveId);
    if (inFlight) {
      if (inFlight.modelKey === modelKey && inFlight.trigger === input.trigger) {
        return inFlight.promise;
      }
      throw new DailyReviewRunConflictError(archiveId);
    }
    const pending = this.#generateArchive(archiveId, summary, modelKey, input);
    const entry = { modelKey, trigger: input.trigger, promise: pending };
    this.#inFlight.set(archiveId, entry);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(archiveId) === entry) this.#inFlight.delete(archiveId);
    }
  }

  async #generateArchive(
    archiveId: string,
    summary: DailyReviewSummary,
    modelKey: string,
    input: {
      readonly range: DailyReviewRange;
      readonly trigger: 'cron' | 'manual';
    },
  ): Promise<DailyReviewArchive> {
    const base = {
      id: archiveId,
      day: summary.day,
      range: input.range,
      generatedAt: this.#now(),
      trigger: input.trigger,
      modelKey,
      totals: summary.totals,
    } as const;
    if (summary.totals.sessionCount + summary.totals.requestCount === 0) {
      return this.#publish({
        ...base,
        status: 'no_data',
        sections: buildRuleBasedSections(summary, input.range),
        errorMessage: 'No local activity data was available for this review.',
      });
    }

    const controller = new AbortController();
    this.#abortControllers.add(controller);
    try {
      const result = await this.#model.generate({
        modelKey,
        prompt: buildModelPrompt(summary, input.range),
        abortSignal: controller.signal,
      });
      if (!result.ok) {
        if (result.errorClass === 'aborted') {
          throw (
            controller.signal.reason ?? new DOMException('Daily Review was aborted', 'AbortError')
          );
        }
        if (result.errorClass === 'persistence') {
          this.#requestDrain();
          throw new Error('Daily Review model accounting failed');
        }
        return this.#publish({
          ...base,
          status: result.errorClass === 'configuration' ? 'no_model' : 'failed',
          sections: buildRuleBasedSections(summary, input.range),
          errorMessage:
            result.errorClass === 'configuration'
              ? 'No executable analysis model is configured.'
              : result.errorClass === 'timeout'
                ? 'The analysis model timed out while generating this review.'
                : 'The analysis model failed to generate this review.',
        });
      }
      let sections: DailyReviewArchiveSectionContent;
      try {
        sections = parseSections(result.text);
      } catch {
        return this.#publish({
          ...base,
          modelKey: result.modelKey,
          status: 'failed',
          sections: buildRuleBasedSections(summary, input.range),
          errorMessage: 'The analysis model returned an invalid review.',
        });
      }
      return this.#publish({
        ...base,
        modelKey: result.modelKey,
        status: 'ok',
        sections,
      });
    } finally {
      this.#abortControllers.delete(controller);
    }
  }

  async #publish(archive: DailyReviewArchive): Promise<DailyReviewArchive> {
    const encodedBytes = Buffer.byteLength(JSON.stringify(archive), 'utf8');
    if (encodedBytes > DAILY_REVIEW_RESULT_MAX_BYTES) {
      throw new Error('Daily Review archive exceeds the protocol result budget');
    }
    return this.#store.publishArchive(archive, ARCHIVE_LIMIT);
  }

  #reconcileScheduler(enabled: boolean): void {
    if (!enabled || this.#draining) {
      this.#stopScheduler();
      return;
    }
    this.#residency ??= this.#acquireResidency();
    this.#timer ??= this.#setInterval(() => {
      void this.#tickScheduler().catch((error: unknown) => this.#handleSchedulerError(error));
    }, SCHEDULER_INTERVAL_MS);
  }

  #stopScheduler(): void {
    if (this.#timer !== undefined) {
      this.#clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#residency?.release();
    this.#residency = undefined;
  }

  async #tickScheduler(): Promise<void> {
    if (!this.#prepared || this.#draining) return;
    const { config } = await this.#store.readConfig();
    this.#reconcileScheduler(config.enabled);
    const now = this.#now();
    if (!config.enabled || !scheduledTimeHasPassed(now, config.executeTime)) return;
    // This is a latest-complete-day digest, not a historical job ledger. Without durable
    // enablement history, older backfill could generate reviews for days before scheduling began.
    const day = localDayBoundsAt(now, -1);
    const archiveId = dailyReviewArchiveId(day, 1);
    if (await this.#store.getArchive(archiveId)) return;
    await this.#run({
      range: 1,
      offsetDays: -1,
      modelKeyOverride: '',
      trigger: 'cron',
      replaceExisting: false,
    });
  }

  #readFailure(error: unknown): OperationOutcome<'daily-review.query'> {
    if (this.#draining) return queryFailure('host_draining', 'Runtime Host is draining');
    if (error instanceof CanonicalUsageProjectionIncompleteError) {
      return queryFailure(
        'projection_incomplete',
        'Daily Review is waiting for canonical Usage repair',
      );
    }
    this.#requestDrain();
    return queryFailure(
      'persistence_failed',
      error instanceof Error ? 'Daily Review data is unavailable' : 'Daily Review query failed',
    );
  }

  #handleSchedulerError(error: unknown): void {
    if (this.#draining || isAbort(error) || isRetryableSchedulerError(error)) return;
    this.#requestDrain();
  }
}

function scheduledTimeHasPassed(nowMs: number, executeTime: string): boolean {
  const now = new Date(nowMs);
  const [hours, minutes] = executeTime.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= (hours ?? 0) * 60 + (minutes ?? 0);
}

function buildModelPrompt(summary: DailyReviewSummary, range: DailyReviewRange): string {
  return [
    'You are Maka Daily Review. Use only the supplied local activity facts.',
    'Return JSON without a Markdown fence. The only allowed top-level keys are summary, gaps, usage, and code. Each value must be a string. Omit unsupported sections.',
    JSON.stringify({
      rangeDays: range,
      day: summary.day,
      totals: summary.totals,
      sessions: summary.sessions.map((session) => ({
        name: session.name,
        lastMessageAt: session.lastMessageAt,
        preview: session.lastMessagePreview ?? '',
      })),
      topModels: summary.topModels,
      topTools: summary.topTools,
    }),
  ].join('\n');
}

function parseSections(text: string): DailyReviewArchiveSectionContent {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = { summary: trimmed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Daily Review model returned an invalid result');
  }
  const record = parsed as Record<string, unknown>;
  const sections = {
    ...(typeof record.summary === 'string' && record.summary.trim()
      ? { summary: record.summary.trim() }
      : {}),
    ...(typeof record.gaps === 'string' && record.gaps.trim() ? { gaps: record.gaps.trim() } : {}),
    ...(typeof record.usage === 'string' && record.usage.trim()
      ? { usage: record.usage.trim() }
      : {}),
    ...(typeof record.code === 'string' && record.code.trim() ? { code: record.code.trim() } : {}),
  };
  if (Object.keys(sections).length === 0) {
    throw new Error('Daily Review model returned no usable sections');
  }
  return sections;
}

function buildRuleBasedSections(
  summary: DailyReviewSummary,
  range: DailyReviewRange,
): DailyReviewArchiveSectionContent {
  const topModel = summary.topModels[0];
  const topTool = summary.topTools[0];
  return {
    summary: `${range}-day activity covered ${summary.totals.sessionCount} Sessions and ${summary.totals.requestCount} requests.`,
    gaps:
      summary.totals.errorCount > 0
        ? `${summary.totals.errorCount} failed requests need review.`
        : 'No failed requests were visible in local usage data.',
    ...(topModel
      ? {
          usage: `${topModel.label} was the most-used model with ${topModel.requests} requests.`,
        }
      : {}),
    ...(topTool
      ? {
          code: `${topTool.label} was the most-used tool with ${topTool.requests} invocations.`,
        }
      : {}),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryableSchedulerError(error: unknown): boolean {
  return (
    error instanceof CanonicalUsageProjectionIncompleteError ||
    error instanceof DailyReviewRunConflictError
  );
}

class DailyReviewRunConflictError extends Error {
  constructor(archiveId: string) {
    super(`Daily Review archive ${archiveId} is already being generated with different options`);
    this.name = 'DailyReviewRunConflictError';
  }
}

function querySuccess(
  result: Extract<OperationOutcome<'daily-review.query'>, { ok: true }>['result'],
): OperationOutcome<'daily-review.query'> {
  return { ok: true, result };
}

function queryFailure(
  code: Extract<OperationOutcome<'daily-review.query'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'daily-review.query'> {
  return { ok: false, error: { code, message } };
}

function mutateSuccess(
  result: Extract<OperationOutcome<'daily-review.mutate'>, { ok: true }>['result'],
): OperationOutcome<'daily-review.mutate'> {
  return { ok: true, result };
}

function mutateFailure(
  code: Extract<OperationOutcome<'daily-review.mutate'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'daily-review.mutate'> {
  return { ok: false, error: { code, message } };
}
