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
  ARCHIVE_RETENTION_DAY_MS,
  ARCHIVE_RETENTION_HOLD_MS,
  type ArchiveRetentionDeletion,
  type ArchiveRetentionSweep,
  archiveRetentionClockStart,
  archiveRetentionDeadline,
  archiveRetentionGapThreshold,
} from '@maka/core/archive-retention';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { sessionRevisionFamilyId } from '@maka/core/session';
import type {
  ArchiveRetentionDocument,
  InteractiveArchiveRetentionStore,
} from '@maka/storage/archive-retention-store';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import { RuntimePolicyStoreError } from '@maka/storage/runtime-policy-stores';
import type {
  OperationOutcome,
  StorageRetentionSetInput,
  StorageRetentionSetting,
} from '../protocol/index.js';
import type { StorageRetentionOperationHandlerMap } from './operation-dispatcher.js';
import type {
  HostSessionRetirementCoordinator,
  RetentionHoldReason,
  RetentionRemovalOutcome,
  RetentionRemovalPlan,
} from './session-retirement-coordinator.js';

/** Revision families a sweep tick may delete. */
export const ARCHIVE_RETENTION_FAMILIES_PER_TICK = 8;
const CANDIDATE_PAGE = 64;

const DISABLED: ArchiveRetentionDocument = Object.freeze({
  version: 1,
  revision: 0,
  enabled: false,
  days: 30,
});

type RetentionCatalog = Pick<
  ExecutionSessionWriter,
  | 'listArchiveRetentionCandidates'
  | 'countArchiveRetentionCandidates'
  | 'readLatestSessionMetadataTime'
  | 'readCatalogRecord'
>;

export interface HostArchiveRetentionCoordinatorOptions {
  readonly document: InteractiveArchiveRetentionStore;
  readonly catalog: RetentionCatalog;
  readonly retirement: Pick<HostSessionRetirementCoordinator, 'removeForRetention'>;
  /** The Host wall clock. */
  readonly now?: () => number;
  /** Diagnostics. Counts only, never a task's name. */
  readonly log?: (message: string) => void;
}

interface EnabledSetting {
  readonly revision: number;
  readonly days: ArchiveRetentionDocument['days'];
  readonly enabledAt: number;
}

interface SweepPass {
  /** The setting revision the pass started under; its results belong to it alone. */
  readonly revision: number;
  /** Resume the candidate order strictly after this row. */
  cursor?: { readonly archivedAt?: number; readonly sessionId: string };
  /** Families (and undecodable rows) this pass already tried; none is retried before the next pass. */
  readonly seen: Set<string>;
  deleted: number;
  skippedBusy: number;
  needsReview: number;
  failed: number;
  /** Undefined once any deleted family could not be measured. */
  bytes: number | undefined;
}

/**
 * The opt-in retention for archived tasks (#5899). One Host document holds the
 * setting and the latest results; the `storage.retention.*` operations are the
 * only writer of the setting, and a maintenance lane runs the sweep.
 *
 * A sweep deletes nothing before `enabledAt + days`, pauses while the wall
 * clock reads earlier than a time the Host has already seen, and deletes each
 * family through `session.remove`'s own path with a guard that rechecks the
 * policy, the archive and pin state, the elapsed time and the plan under the
 * removal admission. A setting change waits for the family in flight, so once
 * `storage.retention.set` answers, no deletion admitted under the old setting
 * is still running.
 */
export class HostArchiveRetentionCoordinator {
  readonly handlers: StorageRetentionOperationHandlerMap = {
    'storage.retention.query': () => this.#query(),
    'storage.retention.set': (input) => this.#set(input),
  };

  readonly #store: InteractiveArchiveRetentionStore;
  readonly #catalog: RetentionCatalog;
  readonly #retirement: HostArchiveRetentionCoordinatorOptions['retirement'];
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #document: ArchiveRetentionDocument | undefined;
  #loading: Promise<ArchiveRetentionDocument> | undefined;
  /** Serializes every read-modify-write of the document. */
  #writes: Promise<unknown> = Promise.resolve();
  /** Setting changes in flight; while one is pending a sweep admits and starts nothing. */
  #changing = 0;
  /** The sweep step running now, which a setting change waits for. */
  #ticking: Promise<boolean> | undefined;
  /**
   * The latest Host time observed, in memory only. After a restart the floor
   * is `enabledAt`, the last sweep's time and, on every sweep, the newest time
   * Session metadata recorded.
   */
  #observedAt = 0;
  /** Whether `#observedAt` is a time this process saw, rather than the persisted floor. */
  #observedThisRun = false;
  #pass: SweepPass | undefined;
  #draining = false;

  constructor(options: HostArchiveRetentionCoordinatorOptions) {
    this.#store = options.document;
    this.#catalog = options.catalog;
    this.#retirement = options.retirement;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((message) => console.info(`[runtime-host] ${message}`));
  }

  beginDrain(): void {
    this.#draining = true;
  }

  /** One bounded sweep step; true while candidates remain. */
  async sweep(): Promise<boolean> {
    if (this.#draining) return false;
    // A setting change is waiting for this lane; look again shortly.
    if (this.#changing > 0) return true;
    const tick = this.#tick();
    this.#ticking = tick;
    try {
      return await tick;
    } finally {
      if (this.#ticking === tick) this.#ticking = undefined;
    }
  }

  async #tick(): Promise<boolean> {
    const document = await this.#load();
    if (!document.enabled || document.enabledAt === undefined) {
      this.#pass = undefined;
      return false;
    }
    const setting: EnabledSetting = {
      revision: document.revision,
      days: document.days,
      enabledAt: document.enabledAt,
    };
    const now = this.#now();
    const previous = this.#observedAt;
    const observedThisRun = this.#observedThisRun;
    this.#observedAt = Math.max(previous, now);
    this.#observedThisRun = true;
    const deadline = archiveRetentionDeadline(setting.enabledAt, setting.days);
    const gap = archiveRetentionGapThreshold(setting.days);
    // A forward jump is caught even when it lands short of the deadline. Before
    // the deadline no SQL runs, so a fresh process measures from the persisted
    // floor alone.
    if ((observedThisRun || now <= deadline) && now - previous > gap) {
      return this.#hold(previous, now);
    }
    // Nothing can be eligible before the policy itself is `days` old.
    if (now <= deadline) return false;
    if (now < previous) return this.#pause(now);
    const newest = await this.#catalog.readLatestSessionMetadataTime();
    if (newest !== undefined && now < newest) return this.#pause(now);
    if (!observedThisRun) {
      // After a restart, the newest metadata time says when the Host last ran.
      const since = Math.max(previous, newest ?? 0);
      if (now - since > gap) return this.#hold(since, now);
    }
    const hold = document.latest?.hold;
    if (hold) {
      if (now < hold.until) return false;
      await this.#update(({ latest, ...rest }) => {
        const { hold: _hold, ...kept } = latest ?? {};
        return { ...rest, ...(Object.keys(kept).length > 0 ? { latest: kept } : {}) };
      });
    }

    if (this.#pass?.revision !== setting.revision) {
      this.#pass = {
        revision: setting.revision,
        seen: new Set(),
        deleted: 0,
        skippedBusy: 0,
        needsReview: 0,
        failed: 0,
        bytes: 0,
      };
    }
    const pass = this.#pass;
    const page = await this.#catalog.listArchiveRetentionCandidates({
      archivedBefore: now - setting.days * ARCHIVE_RETENTION_DAY_MS,
      ...(pass.cursor ? { after: pass.cursor } : {}),
      limit: CANDIDATE_PAGE,
    });
    const deletedBefore = pass.deleted;
    let tried = 0;
    let stopped = false;
    for (const row of page) {
      // Draining or a pending setting change: stop before the next family.
      if (this.#draining || this.#changing > 0) {
        stopped = true;
        break;
      }
      if ('undecodable' in row) {
        // A row that no longer decodes is counted once and passed over.
        if (!pass.seen.has(`row:${row.sessionId}`)) {
          pass.seen.add(`row:${row.sessionId}`);
          pass.failed += 1;
        }
      } else {
        const family = sessionRevisionFamilyId(row.header);
        if (!pass.seen.has(family)) {
          if (tried === ARCHIVE_RETENTION_FAMILIES_PER_TICK) {
            stopped = true;
            break;
          }
          tried += 1;
          pass.seen.add(family);
          tally(
            pass,
            await this.#retirement.removeForRetention(
              { sessionId: row.header.id, expectedRevision: row.revision },
              (plan) => this.#guard(plan, setting),
            ),
          );
        }
      }
      const sessionId = 'undecodable' in row ? row.sessionId : row.header.id;
      pass.cursor = {
        ...(row.archivedAt === undefined ? {} : { archivedAt: row.archivedAt }),
        sessionId,
      };
    }
    if (stopped || page.length === CANDIDATE_PAGE) {
      // A deletion is recorded as it happens, not only when the pass ends.
      if (pass.deleted > deletedBefore) await this.#record(now, pass);
      return !this.#draining;
    }
    if (this.#pass === pass) this.#pass = undefined;
    await this.#finishPass(now, pass);
    return false;
  }

  /**
   * Runs under the removal admission, after the plan is stable and before any
   * retirement work: anything that changed since the sweep read the task keeps
   * it for this pass. Every setting change moves the revision.
   */
  async #guard(
    plan: RetentionRemovalPlan,
    setting: EnabledSetting,
  ): Promise<RetentionHoldReason | undefined> {
    if (this.#changing > 0 || this.#document?.revision !== setting.revision) {
      return 'ineligible';
    }
    if (plan.remove.some(({ header }) => !header.isArchived || header.isFlagged)) {
      return 'ineligible';
    }
    // The archive time through the reader `requireArchivedForMs` judges by.
    const archivedAt = await Promise.all(
      plan.remove.map(
        async ({ header }) => (await this.#catalog.readCatalogRecord(header.id)).summary.archivedAt,
      ),
    );
    const now = this.#now();
    if (now < this.#observedAt) return 'ineligible';
    // A family is as young as its most recently archived member.
    const start = Math.max(
      ...archivedAt.map((time) => archiveRetentionClockStart(time, setting.enabledAt)),
    );
    if (now <= archiveRetentionDeadline(start, setting.days)) return 'ineligible';
    // Unattended cleanup is more conservative than a manual delete.
    if (plan.archiveSessionIds.length > 0 || plan.worktreeCount > 0) return 'needs_review';
    return undefined;
  }

  /**
   * The wall clock moved ahead further than a sweep expects, whether set wrong
   * or after a long time offline: delete nothing for a day, so a wrong clock
   * can be noticed and the setting turned off. A further jump re-arms it.
   */
  async #hold(since: number, now: number): Promise<false> {
    this.#pass = undefined;
    this.#log('archive retention held: the clock moved ahead further than a sweep expects');
    await this.#update((document) => ({
      ...document,
      latest: {
        ...document.latest,
        hold: { since, detectedAt: now, until: now + ARCHIVE_RETENTION_HOLD_MS },
      },
    }));
    return false;
  }

  async #pause(now: number): Promise<false> {
    this.#pass = undefined;
    // Recorded once: a clock that stays behind writes nothing further.
    if (this.#document?.latest?.lastSweep?.paused) return false;
    this.#log('archive retention paused: the clock reads earlier than a time already recorded');
    await this.#update((document) => ({
      ...document,
      latest: {
        ...document.latest,
        lastSweep: { at: now, deleted: 0, skippedBusy: 0, needsReview: 0, failed: 0, paused: true },
      },
    }));
    return false;
  }

  async #finishPass(now: number, pass: SweepPass): Promise<void> {
    const previous = this.#document?.latest?.lastSweep;
    const unchanged =
      pass.deleted === 0 &&
      pass.skippedBusy === (previous?.skippedBusy ?? 0) &&
      pass.needsReview === (previous?.needsReview ?? 0) &&
      pass.failed === (previous?.failed ?? 0) &&
      previous?.paused !== true;
    if (unchanged) return;
    if (pass.deleted + pass.skippedBusy + pass.needsReview + pass.failed > 0) {
      this.#log(
        `archive retention deleted ${pass.deleted} tasks; kept ${pass.skippedBusy} busy and ` +
          `${pass.needsReview} for review; ${pass.failed} failed`,
      );
    }
    await this.#record(now, pass);
  }

  #record(now: number, pass: SweepPass): Promise<void> {
    const lastSweep: ArchiveRetentionSweep = {
      at: now,
      deleted: pass.deleted,
      skippedBusy: pass.skippedBusy,
      needsReview: pass.needsReview,
      failed: pass.failed,
    };
    const lastDeletion: ArchiveRetentionDeletion | undefined =
      pass.deleted > 0
        ? {
            at: now,
            count: pass.deleted,
            ...(pass.bytes === undefined ? {} : { bytes: pass.bytes }),
          }
        : undefined;
    return this.#serialized(async () => {
      const document = await this.#load();
      // A pass belongs to the setting it started under; a newer one starts afresh.
      if (document.revision !== pass.revision) return;
      await this.#write({
        ...document,
        latest: {
          ...document.latest,
          lastSweep,
          ...(lastDeletion ? { lastDeletion } : {}),
        },
      });
    });
  }

  async #query(): Promise<OperationOutcome<'storage.retention.query'>> {
    if (this.#draining) return draining();
    try {
      const document = await this.#load();
      const enabledAt = document.enabled ? document.enabledAt : undefined;
      const { families, firstStart } = await this.#catalog.countArchiveRetentionCandidates(
        enabledAt ?? this.#now(),
      );
      return {
        ok: true,
        result: {
          ...settingOf(document),
          preview: {
            count: families,
            ...(enabledAt !== undefined && families > 0 && firstStart !== undefined
              ? { eligibleAt: archiveRetentionDeadline(firstStart, document.days) }
              : {}),
          },
          ...(document.latest?.lastSweep ? { lastSweep: document.latest.lastSweep } : {}),
          ...(document.latest?.lastDeletion ? { lastDeletion: document.latest.lastDeletion } : {}),
          ...(document.latest?.hold ? { hold: document.latest.hold } : {}),
        },
      };
    } catch (error) {
      reportFailure('read', error);
      return {
        ok: false,
        error: { code: 'persistence_failed', message: 'Retention setting could not be read' },
      };
    }
  }

  async #set(input: StorageRetentionSetInput): Promise<OperationOutcome<'storage.retention.set'>> {
    if (this.#draining) return draining();
    this.#changing += 1;
    try {
      // A family admitted under the current setting finishes, and is recorded,
      // before the setting changes; nothing new is admitted meanwhile.
      await this.#ticking?.catch(() => undefined);
      return await this.#serialized(async () => {
        const current = await this.#load();
        if (current.revision !== input.expectedRevision) {
          return {
            ok: true,
            result: {
              kind: 'revision_conflict',
              expectedRevision: input.expectedRevision,
              actualRevision: current.revision,
            },
          } as const;
        }
        if (current.enabled === input.enabled && current.days === input.days) {
          return { ok: true, result: { kind: 'committed', setting: settingOf(current) } } as const;
        }
        // Any change restarts the clock: enabling, or new days while enabled.
        // A clock behind a time already recorded never backdates the deadline.
        const newest = input.enabled
          ? await this.#catalog.readLatestSessionMetadataTime()
          : undefined;
        const now = this.#now();
        const enabledAt = Math.max(now, this.#observedAt, newest ?? 0);
        this.#observedAt = Math.max(this.#observedAt, now);
        this.#observedThisRun = true;
        const { enabledAt: _previous, latest, ...rest } = current;
        const lastSweep = latest?.lastSweep && withoutPause(latest.lastSweep);
        const nextLatest = {
          ...(lastSweep ? { lastSweep } : {}),
          ...(latest?.lastDeletion ? { lastDeletion: latest.lastDeletion } : {}),
        };
        const next: ArchiveRetentionDocument = {
          ...rest,
          revision: current.revision + 1,
          enabled: input.enabled,
          days: input.days,
          ...(input.enabled ? { enabledAt } : {}),
          ...(Object.keys(nextLatest).length > 0 ? { latest: nextLatest } : {}),
        };
        await this.#write(next);
        this.#pass = undefined;
        return { ok: true, result: { kind: 'committed', setting: settingOf(next) } } as const;
      });
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown') {
        return {
          ok: false,
          error: {
            code: 'commit_outcome_unknown',
            message: 'Retention setting commit outcome is unknown',
          },
        };
      }
      reportFailure('save', error);
      return {
        ok: false,
        error: { code: 'persistence_failed', message: 'Retention setting could not be saved' },
      };
    } finally {
      this.#changing -= 1;
    }
  }

  #update(change: (document: ArchiveRetentionDocument) => ArchiveRetentionDocument): Promise<void> {
    return this.#serialized(async () => this.#write(change(await this.#load())));
  }

  async #write(next: ArchiveRetentionDocument): Promise<void> {
    try {
      await this.#store.write(next);
    } catch (error) {
      // The file may or may not hold `next`; read it again before trusting either.
      this.#document = undefined;
      throw error;
    }
    this.#document = next;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(operation, operation);
    this.#writes = run.catch(() => undefined);
    return run;
  }

  #load(): Promise<ArchiveRetentionDocument> {
    if (this.#document) return Promise.resolve(this.#document);
    this.#loading ??= this.#read().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #read(): Promise<ArchiveRetentionDocument> {
    const read = await this.#store.read();
    let document: ArchiveRetentionDocument;
    if (read.kind === 'valid') {
      document = read.document;
    } else {
      // Never act on a document that cannot be fully validated: off, until
      // the setting is written again.
      if (read.kind === 'invalid') {
        this.#log('archive retention is off: its setting document could not be read');
      }
      document = DISABLED;
    }
    this.#observedAt = Math.max(
      this.#observedAt,
      document.enabledAt ?? 0,
      document.latest?.lastSweep?.at ?? 0,
      document.latest?.hold?.detectedAt ?? 0,
    );
    this.#document = document;
    return document;
  }
}

function withoutPause(sweep: ArchiveRetentionSweep): ArchiveRetentionSweep {
  const { paused: _paused, ...rest } = sweep;
  return rest;
}

function settingOf(document: ArchiveRetentionDocument): StorageRetentionSetting {
  return {
    revision: document.revision,
    enabled: document.enabled,
    days: document.days,
    ...(document.enabledAt === undefined ? {} : { enabledAt: document.enabledAt }),
  };
}

function tally(pass: SweepPass, outcome: RetentionRemovalOutcome): void {
  switch (outcome.kind) {
    case 'removed':
      pass.deleted += 1;
      pass.bytes =
        pass.bytes === undefined || outcome.bytes === undefined
          ? undefined
          : pass.bytes + outcome.bytes;
      return;
    case 'held':
      if (outcome.reason === 'needs_review') pass.needsReview += 1;
      return;
    case 'busy':
      pass.skippedBusy += 1;
      return;
    case 'failed':
      pass.failed += 1;
      return;
    case 'skipped':
      return;
  }
}

function reportFailure(action: 'read' | 'save', error: unknown): void {
  console.error(
    `[runtime-host] archive retention could not ${action} its setting: ${generalizedErrorMessage(error)}`,
  );
}

function draining(): { ok: false; error: { code: 'host_draining'; message: string } } {
  return { ok: false, error: { code: 'host_draining', message: 'Runtime Host is draining' } };
}
