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

import type { SessionSummary } from '@maka/core/session';
import { runtimeHostProjectKey } from '../../../application/contracts/runtime-host-project-key.js';
import { deriveSessionRail } from './session-rail.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Archived more than N days ago" thresholds the page offers. */
export const ARCHIVED_AGE_DAYS = [7, 30, 90] as const;
export type ArchivedAgeDays = (typeof ARCHIVED_AGE_DAYS)[number];

/**
 * The project a row is filed under. `null` is a task with no project.
 * `undefined` is a project no known Host scope names: the row says nothing
 * about it, so no project filter claims it and only "All projects" shows it.
 */
export type ArchivedTaskProject =
  | { readonly key: string; readonly label: string; readonly hostLabel: string }
  | null
  | undefined;

export type ArchivedProjectFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly key: string };

export interface ArchivedTaskScope {
  readonly query: string;
  /** Only tasks archived more than this many days ago; absent means any time. */
  readonly minAgeDays?: ArchivedAgeDays;
  readonly project: ArchivedProjectFilter;
}

export const UNSCOPED_ARCHIVED_TASKS: ArchivedTaskScope = { query: '', project: { kind: 'all' } };

/** A Project together with the Runtime Host that owns its identity, as the rail sees it. */
export interface ArchivedTaskProjectScope {
  /** `runtimeHostProjectKey(hostId, project.id)`. */
  readonly key: string;
  readonly hostId: string;
  readonly profileName: string;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly aliases?: readonly string[];
  };
}

/**
 * The archived tasks, counted the way the rail counts tasks.
 *
 * `sessions.list()` returns the physical session catalog, which is not the set
 * of things a person calls a task: edit-and-resend produces one session per
 * revision, and a linked subagent session belongs to the task that spawned it.
 * `deriveSessionRail` already owns both rules — including the one that is easy
 * to get wrong on a second pass, that a linked child whose parent is gone stays
 * a row of its own instead of vanishing from every surface at once. Reusing it
 * is what makes a row here mean what a row there means; a second projection
 * would only mean it approximately.
 *
 * No active session is passed. The rail passes one so it can highlight the row
 * you are on, but that also pins a family's representative to whichever
 * revision happens to be open — which would move a row's name, date and
 * position here for a reason this page never shows. The rail additionally hides
 * in-flight companion forks, another property of its own view rather than of
 * the archived catalog.
 *
 * Rows are then ordered by when they were archived, most recent first: this
 * page is where you look for what you just put away. A task archived before
 * the Host recorded the time has no place in that order, so those go last,
 * and any tie keeps the rail's store order (`sort` is stable).
 */
export function archivedTaskRows<T extends SessionSummary>(sessions: readonly T[]): T[] {
  const rows = deriveSessionRail(sessions, undefined, (session) => session.isArchived).sessions;
  return [...rows].sort((a, b) => (b.archivedAt ?? -1) - (a.archivedAt ?? -1));
}

/**
 * Resolves a task's project the way the rail groups it: by the Host that owns
 * the id, through that Project's aliases. Equal ids on two Hosts are two
 * projects, and a task filed under a retired alias lands on its project.
 */
export function archivedTaskProjectResolver(
  scopes: readonly ArchivedTaskProjectScope[],
): (session: SessionSummary & { readonly runtimeHostId: string }) => ArchivedTaskProject {
  const byIdentity = new Map<string, ArchivedTaskProjectScope>();
  for (const scope of scopes) {
    for (const id of [scope.project.id, ...(scope.project.aliases ?? [])]) {
      byIdentity.set(runtimeHostProjectKey(scope.hostId, id), scope);
    }
  }
  return (session) => {
    if (!session.projectId) return null;
    const scope = byIdentity.get(runtimeHostProjectKey(session.runtimeHostId, session.projectId));
    return scope && { key: scope.key, label: scope.project.name, hostLabel: scope.profileName };
  };
}

export interface ArchivedTaskScopeContext<T> {
  readonly now: number;
  readonly projectOf: (session: T) => ArchivedTaskProject;
  /** What the row shows beside the name, so search answers to it. */
  readonly labelOf: (session: T) => string | undefined;
}

export interface ScopedArchivedTasks<T> {
  /** The rows on screen — and therefore exactly the set a bulk delete removes. */
  readonly visible: T[];
  /**
   * Rows that match everything else but were left out only because their
   * archive time is unknown. Zero unless an age filter is on.
   */
  readonly unknownArchiveTime: number;
}

/** Whether anything narrows the list, so a bulk delete no longer means all of it. */
export function isArchivedTaskScopeNarrowed(scope: ArchivedTaskScope): boolean {
  return (
    scope.query.trim().length > 0 || scope.minAgeDays !== undefined || scope.project.kind !== 'all'
  );
}

/**
 * The age a bulk delete asks the Host to hold, on its own clock, or nothing
 * when no age filter is on. The filter above runs on this machine's clock and
 * only decides what is shown; the Host has the final say.
 */
export function archivedAgeThresholdMs(scope: ArchivedTaskScope): number | undefined {
  return scope.minAgeDays === undefined ? undefined : scope.minAgeDays * DAY_MS;
}

/**
 * The archived rows a scope keeps, in their given order.
 *
 * Age is measured from `archivedAt` only. A task archived before the Host
 * recorded that time has no age to compare, so an age filter leaves it out and
 * says how many it left out; borrowing another timestamp would delete tasks on
 * a guess. "More than N days" is strict: a task archived exactly N days ago is
 * not yet older than N days.
 */
export function scopeArchivedTasks<T extends SessionSummary>(
  rows: readonly T[],
  scope: ArchivedTaskScope,
  context: ArchivedTaskScopeContext<T>,
): ScopedArchivedTasks<T> {
  const threshold = archivedAgeThresholdMs(scope);
  const visible: T[] = [];
  let unknownArchiveTime = 0;
  for (const session of rows) {
    if (!matchesProject(context.projectOf(session), scope.project)) continue;
    if (!matchesArchivedTaskQuery(session, scope.query, context.labelOf(session))) continue;
    if (threshold !== undefined) {
      if (session.archivedAt === undefined) {
        unknownArchiveTime += 1;
        continue;
      }
      if (context.now - session.archivedAt <= threshold) continue;
    }
    visible.push(session);
  }
  return { visible, unknownArchiveTime };
}

export interface ArchivedProjectOptions {
  /** Each project at least one row is filed under, by label. */
  readonly projects: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  /** Whether any row has no project, so "No project" is worth offering. */
  readonly hasNoProject: boolean;
}

/**
 * The project filter entries the archived rows can answer to. Two projects of
 * the same name on different Hosts stay two entries, told apart by Host.
 */
export function archivedProjectOptions<T>(
  rows: readonly T[],
  projectOf: (session: T) => ArchivedTaskProject,
): ArchivedProjectOptions {
  const projects = new Map<string, { label: string; hostLabel: string }>();
  let hasNoProject = false;
  for (const session of rows) {
    const project = projectOf(session);
    if (project === null) hasNoProject = true;
    else if (project) projects.set(project.key, project);
  }
  const labels = [...projects.values()].map((project) => project.label);
  return {
    projects: [...projects]
      .map(([key, { label, hostLabel }]) => ({
        key,
        label:
          labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label} · ${hostLabel}`,
      }))
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
      ),
    hasNoProject,
  };
}

/**
 * A chosen project filter that the rows no longer offer — its last task was
 * deleted or restored — falls back to all projects rather than to an empty
 * list whose filter the reader can no longer see.
 */
export function availableProjectFilter(
  filter: ArchivedProjectFilter,
  options: ArchivedProjectOptions,
): ArchivedProjectFilter {
  if (filter.kind === 'none') return options.hasNoProject ? filter : { kind: 'all' };
  if (filter.kind === 'project') {
    return options.projects.some((project) => project.key === filter.key)
      ? filter
      : { kind: 'all' };
  }
  return filter;
}

/**
 * Whether a task answers to what was typed in the search box.
 *
 * The project name is searchable because it is on screen: a row reads "name"
 * over "project · date", so both halves answer to the same box. They are
 * joined by a newline rather than a space so a query can never match across
 * the seam and produce a row whose highlight the reader cannot find. A task
 * whose project could not be resolved answers to its name alone — `join`
 * renders the missing half as nothing, never as the word "undefined".
 */
export function matchesArchivedTaskQuery(
  session: SessionSummary,
  query: string,
  projectLabel: string | undefined,
): boolean {
  const haystack = [session.name, projectLabel].join('\n');
  return haystack.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function matchesProject(project: ArchivedTaskProject, filter: ArchivedProjectFilter): boolean {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'none') return project === null;
  return project?.key === filter.key;
}
