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

/**
 * Opt-in retention for archived tasks (#5899): when a Runtime Host enables it,
 * the Host deletes archived tasks once they have been archived for longer than
 * the chosen number of days. These are the rules both the Host and its Clients
 * read; the Host alone decides and deletes.
 */

/** The retention periods a Host offers. */
export const ARCHIVE_RETENTION_DAYS = [30, 60, 90] as const;

export type ArchiveRetentionDays = (typeof ARCHIVE_RETENTION_DAYS)[number];

export const ARCHIVE_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

export function isArchiveRetentionDays(value: unknown): value is ArchiveRetentionDays {
  return ARCHIVE_RETENTION_DAYS.some((days) => days === value);
}

/**
 * When a task's retention clock starts: when it was archived, but never before
 * the policy was enabled. Enabling therefore never deletes a backlog at once,
 * and a task archived before the Host recorded the time counts from enablement.
 */
export function archiveRetentionClockStart(
  archivedAt: number | undefined,
  enabledAt: number,
): number {
  return Math.max(archivedAt ?? enabledAt, enabledAt);
}

/** A task whose clock started at `start` is eligible once the clock passes this instant. */
export function archiveRetentionDeadline(start: number, days: ArchiveRetentionDays): number {
  return start + days * ARCHIVE_RETENTION_DAY_MS;
}

/** The latest automatic sweep, as the Host last recorded it. */
export interface ArchiveRetentionSweep {
  /** Host clock, epoch milliseconds. */
  readonly at: number;
  /** Tasks (revision families) deleted. */
  readonly deleted: number;
  /** Tasks kept because something was still running in them. */
  readonly skippedBusy: number;
  /**
   * Tasks kept because deleting them would also reclaim a subagent worktree or
   * archive a still-active subtask; they stay for manual cleanup.
   */
  readonly needsReview: number;
  /** Tasks whose deletion failed. */
  readonly failed: number;
  /** Present when the sweep paused because the clock moved backwards. */
  readonly paused?: true;
}

/** The latest sweep that deleted anything. */
export interface ArchiveRetentionDeletion {
  readonly at: number;
  readonly count: number;
  /** Measured before deletion; an estimate, and absent when it could not be measured. */
  readonly bytes?: number;
}
