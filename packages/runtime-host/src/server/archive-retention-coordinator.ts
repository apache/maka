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
  type ArchiveRetentionDays,
  type ArchiveRetentionDeletion,
  type ArchiveRetentionSweep,
  archiveRetentionClockStart,
  archiveRetentionDeadline,
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
  StorageRetentionPreview,
  StorageRetentionQueryInput,
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
const PREVIEW_PAGE = 256;

const DISABLED: ArchiveRetentionDocument = Object.freeze({
  version: 1,
  revision: 0,
  enabled: false,
  days: 30,
});

type RetentionCatalog = Pick<
  ExecutionSessionWriter,
  'listArchiveRetentionCandidates' | 'readSessionArchiveTimes' | 'readLatestSessionMetadataTime'
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
  readonly days: ArchiveRetentionDays;
  readonly enabledAt: number;
}

interface SweepPass {
  /** Resume the candidate order strictly after this row. */
  cursor?: { readonly archivedAt?: number; readonly sessionId: string };
  /** Families this pass already tried; a kept family is not retried until the next pass. */
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
 * removal admission.
 */
export class HostArchiveRetentionCoordinator {
  readonly handlers: StorageRetentionOperationHandlerMap = {
    'storage.retention.query': (input) => this.#query(input),
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
  /** Setting changes in flight; a sweep deletes nothing while one is pending. */
  #changing = 0;
  /** The latest Host time a sweep observed: the clock must not read below it. */
  #observedAt = 0;
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
    const wentBack = now < this.#observedAt;
    this.#observedAt = Math.max(this.#observedAt, now);
    // Nothing can be eligible before the policy itself is `days` old.
    if (now <= archiveRetentionDeadline(setting.enabledAt, setting.days)) return false;
    if (wentBack) return this.#pause(now);
    const newest = await this.#catalog.readLatestSessionMetadataTime();
    if (newest !== undefined && now < newest) return this.#pause(now);

    this.#pass ??= {
      seen: new Set(),
      deleted: 0,
      skippedBusy: 0,
      needsReview: 0,
      failed: 0,
      bytes: 0,
    };
    const pass = this.#pass;
    const page = await this.#catalog.listArchiveRetentionCandidates({
      archivedBefore: now - setting.days * ARCHIVE_RETENTION_DAY_MS,
      ...(pass.cursor ? { after: pass.cursor } : {}),
      limit: CANDIDATE_PAGE,
    });
    const deletedBefore = pass.deleted;
    let tried = 0;
    let full = false;
    for (const candidate of page) {
      const family = sessionRevisionFamilyId(candidate.header);
      if (!pass.seen.has(family)) {
        if (tried === ARCHIVE_RETENTION_FAMILIES_PER_TICK) {
          full = true;
          break;
        }
        tried += 1;
        pass.seen.add(family);
        tally(
          pass,
          await this.#retirement.removeForRetention(
            { sessionId: candidate.header.id, expectedRevision: candidate.revision },
            (plan) => this.#guard(plan, setting),
          ),
        );
      }
      pass.cursor = {
        ...(candidate.archivedAt === undefined ? {} : { archivedAt: candidate.archivedAt }),
        sessionId: candidate.header.id,
      };
    }
    if (full || page.length === CANDIDATE_PAGE) {
      // A deletion is recorded as it happens, not only when the pass ends.
      if (pass.deleted > deletedBefore) await this.#record(now, pass);
      return true;
    }
    if (this.#pass === pass) this.#pass = undefined;
    await this.#finishPass(now, pass);
    return false;
  }

  /**
   * Runs under the removal admission, after the plan is stable and before any
   * retirement work: anything that changed since the sweep read the task keeps
   * it for this pass.
   */
  async #guard(
    plan: RetentionRemovalPlan,
    setting: EnabledSetting,
  ): Promise<RetentionHoldReason | undefined> {
    const current = this.#document;
    if (
      this.#changing > 0 ||
      !current?.enabled ||
      current.revision !== setting.revision ||
      current.days !== setting.days ||
      current.enabledAt !== setting.enabledAt
    ) {
      return 'ineligible';
    }
    if (plan.remove.some(({ header }) => !header.isArchived || header.isFlagged)) {
      return 'ineligible';
    }
    const archivedAt = await this.#catalog.readSessionArchiveTimes(
      plan.remove.map(({ header }) => header.id),
    );
    const now = this.#now();
    if (now < this.#observedAt) return 'ineligible';
    // A family is as young as its most recently archived member.
    const start = Math.max(
      ...plan.remove.map(({ header }) =>
        archiveRetentionClockStart(archivedAt.get(header.id), setting.enabledAt),
      ),
    );
    if (now <= archiveRetentionDeadline(start, setting.days)) return 'ineligible';
    // Unattended cleanup is more conservative than a manual delete.
    if (
      plan.archiveSessionIds.length > 0 ||
      plan.remove.some(({ header }) => header.subagentWorkspace !== undefined)
    ) {
      return 'needs_review';
    }
    return undefined;
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
    return this.#update((document) => ({
      ...document,
      latest: {
        ...document.latest,
        lastSweep,
        ...(lastDeletion ? { lastDeletion } : {}),
      },
    }));
  }

  async #query(
    input: StorageRetentionQueryInput,
  ): Promise<OperationOutcome<'storage.retention.query'>> {
    if (this.#draining) return draining();
    try {
      const document = await this.#load();
      const now = this.#now();
      const preview =
        input.previewDays !== undefined
          ? await this.#preview(now, input.previewDays)
          : document.enabled && document.enabledAt !== undefined
            ? await this.#preview(document.enabledAt, document.days)
            : undefined;
      return {
        ok: true,
        result: {
          ...settingOf(document),
          ...(preview ? { preview } : {}),
          ...(document.latest?.lastSweep ? { lastSweep: document.latest.lastSweep } : {}),
          ...(document.latest?.lastDeletion ? { lastDeletion: document.latest.lastDeletion } : {}),
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

  /**
   * Every current candidate, counted by family, and when the first becomes
   * eligible under a policy enabled at `enabledAt`. The conservative skips a
   * sweep applies to worktrees and active subtasks are not applied here.
   */
  async #preview(enabledAt: number, days: ArchiveRetentionDays): Promise<StorageRetentionPreview> {
    const starts = new Map<string, number>();
    let after: { readonly archivedAt?: number; readonly sessionId: string } | undefined;
    for (;;) {
      const page = await this.#catalog.listArchiveRetentionCandidates({
        ...(after ? { after } : {}),
        limit: PREVIEW_PAGE,
      });
      for (const candidate of page) {
        const family = sessionRevisionFamilyId(candidate.header);
        const start = archiveRetentionClockStart(candidate.archivedAt, enabledAt);
        starts.set(family, Math.max(starts.get(family) ?? start, start));
      }
      const last = page.at(-1);
      if (page.length < PREVIEW_PAGE || !last) break;
      after = {
        ...(last.archivedAt === undefined ? {} : { archivedAt: last.archivedAt }),
        sessionId: last.header.id,
      };
      await new Promise((resolve) => setImmediate(resolve));
    }
    let first: number | undefined;
    for (const start of starts.values()) first = Math.min(first ?? start, start);
    if (first === undefined) return { count: 0 };
    return { count: starts.size, eligibleAt: archiveRetentionDeadline(first, days) };
  }

  async #set(input: StorageRetentionSetInput): Promise<OperationOutcome<'storage.retention.set'>> {
    if (this.#draining) return draining();
    this.#changing += 1;
    try {
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
        const { enabledAt: _previous, ...rest } = current;
        const now = this.#now();
        this.#observedAt = Math.max(this.#observedAt, now);
        const next: ArchiveRetentionDocument = {
          ...rest,
          revision: current.revision + 1,
          enabled: input.enabled,
          days: input.days,
          ...(input.enabled ? { enabledAt: now } : {}),
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
    const document: ArchiveRetentionDocument = {
      ...next,
      ...(this.#observedAt > (next.observedAt ?? 0) ? { observedAt: this.#observedAt } : {}),
    };
    try {
      await this.#store.write(document);
    } catch (error) {
      // The file may or may not hold `document`; read it again before trusting either.
      this.#document = undefined;
      throw error;
    }
    this.#document = document;
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
    this.#observedAt = Math.max(this.#observedAt, document.observedAt ?? 0);
    this.#document = document;
    return document;
  }
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
