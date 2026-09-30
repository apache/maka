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

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Archived more than N days ago" thresholds the page offers. */
export const ARCHIVED_AGE_DAYS = [7, 30, 90] as const;
export type ArchivedAgeDays = (typeof ARCHIVED_AGE_DAYS)[number];

/**
 * The project a row is filed under, as the row itself states it. `null` is a
 * task with no project. `undefined` is a project this page could not name: the
 * row says nothing about it, so no project filter claims it either, and it is
 * reachable under "All projects" only.
 */
export type ArchivedTaskProject =
  | { readonly key: string; readonly label: string }
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

export interface ArchivedTaskScopeContext<T> {
  readonly now: number;
  readonly projectOf: (session: T) => ArchivedTaskProject;
  /** What the row shows for a task with no project, so search answers to it. */
  readonly noProjectLabel: string;
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
  const visible: T[] = [];
  let unknownArchiveTime = 0;
  for (const session of rows) {
    const project = context.projectOf(session);
    if (!matchesProject(project, scope.project)) continue;
    if (!matchesArchivedTaskQuery(session, scope.query, projectLabel(project, context))) continue;
    if (scope.minAgeDays !== undefined) {
      if (session.archivedAt === undefined) {
        unknownArchiveTime += 1;
        continue;
      }
      if (context.now - session.archivedAt <= scope.minAgeDays * DAY_MS) continue;
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

/** The project filter entries the archived rows can answer to. */
export function archivedProjectOptions<T>(
  rows: readonly T[],
  projectOf: (session: T) => ArchivedTaskProject,
): ArchivedProjectOptions {
  const projects = new Map<string, string>();
  let hasNoProject = false;
  for (const session of rows) {
    const project = projectOf(session);
    if (project === null) hasNoProject = true;
    else if (project) projects.set(project.key, project.label);
  }
  return {
    projects: [...projects]
      .map(([key, label]) => ({ key, label }))
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

function projectLabel<T>(
  project: ArchivedTaskProject,
  context: ArchivedTaskScopeContext<T>,
): string | undefined {
  return project === null ? context.noProjectLabel : project?.label;
}
