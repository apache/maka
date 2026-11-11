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

import type { AgentHistoryRequestsOutput_AgentHistoryRequest as AgentHistoryRequest } from '../../../../packages/plugin-sdk/src/generated/methods.js';
export type { AgentHistoryRequest };
import { compareHistoryOrder, historyTurnKey } from './history.ts';
import type { ProcessProjection, ProcessRow, TurnPresentation } from './processGroups.ts';

export type ScopedTrajectoryRequest = { turnKey: string; request: AgentHistoryRequest };
export type TrajectoryDetailEntry =
  | { kind: 'trajectory-request'; key: string; turnKey: string; request: AgentHistoryRequest }
  | {
      kind: 'trajectory-record';
      key: string;
      turnKey: string | null;
      rowId: string;
      toolKey?: string;
      ancestorToolKeys: string[];
    };
export type TrajectoryEntry =
  | TrajectoryDetailEntry
  | {
      kind: 'trajectory-turn';
      key: string;
      turnKey: string;
      turn: TurnPresentation;
      rowId: string;
    };

export const trajectoryTurnKey = (turnKey: string) => `trajectory/turn/${turnKey}`;
export const trajectoryRecordKey = (rowId: string) => `trajectory/record/${rowId}`;
const trajectoryToolKey = (turnKey: string | null, toolId: string) =>
  JSON.stringify([turnKey, toolId]);

/** The ordered rows precede Chat's grouping, folding, and retry coalescing. */
export function projectTrajectory(
  projection: ProcessProjection,
  requests: readonly ScopedTrajectoryRequest[],
): TrajectoryEntry[] {
  const entries: TrajectoryEntry[] = [];
  const orderedRequests = requests.toSorted((a, b) =>
    compareHistoryOrder(a.request.order, b.request.order),
  );
  const firstRows = new Map<string, string>();
  for (const [rowId, row] of projection.rowsById) {
    const turn = historyTurnKey(row);
    if (turn !== undefined && !firstRows.has(turn)) firstRows.set(turn, rowId);
  }
  const turns = new Set<string>();
  const beginTurn = (turnKey: string) => {
    if (turns.has(turnKey)) return;
    turns.add(turnKey);
    entries.push({
      kind: 'trajectory-turn',
      key: trajectoryTurnKey(turnKey),
      turnKey,
      turn: projection.turns.get(turnKey)!,
      rowId: firstRows.get(turnKey)!,
    });
  };
  let nextRequest = 0;
  const emitRequest = ({ turnKey, request }: ScopedTrajectoryRequest) => {
    if (!firstRows.has(turnKey)) return;
    beginTurn(turnKey);
    entries.push({
      kind: 'trajectory-request',
      key: `trajectory/request/${JSON.stringify([turnKey, request.attemptId])}`,
      turnKey,
      request,
    });
  };
  for (const [rowId, row] of projection.rowsById) {
    const sequence = row.startSequence ?? row.sequence;
    const order =
      row.order ?? (sequence === undefined ? undefined : { path: [sequence], itemIndex: 0 });
    while (
      nextRequest < orderedRequests.length &&
      (order === undefined ||
        compareHistoryOrder(orderedRequests[nextRequest].request.order, order) <= 0)
    ) {
      emitRequest(orderedRequests[nextRequest++]);
    }
    const turnKey = historyTurnKey(row) ?? null;
    if (turnKey !== null) beginTurn(turnKey);
    if (row.field === 'thinking' && !row.text.trim()) continue;
    const tool = row.tool;
    entries.push({
      kind: 'trajectory-record',
      key: trajectoryRecordKey(rowId),
      rowId,
      turnKey,
      toolKey: tool ? trajectoryToolKey(turnKey, tool.toolUseId) : undefined,
      ancestorToolKeys:
        tool?.call?.ancestorToolUseIds.map((id) => trajectoryToolKey(turnKey, id)) ?? [],
    });
  }
  for (; nextRequest < orderedRequests.length; nextRequest++)
    emitRequest(orderedRequests[nextRequest]);
  return entries;
}

export function visibleTrajectory(
  entries: readonly TrajectoryEntry[],
  collapsed: ReadonlySet<string>,
  collapsedTools: ReadonlySet<string>,
  matches?: (entry: TrajectoryDetailEntry) => boolean,
): TrajectoryEntry[] {
  if (!matches)
    return entries.filter(
      (entry) =>
        entry.kind === 'trajectory-turn' ||
        ((entry.turnKey === null || !collapsed.has(entry.turnKey)) &&
          (entry.kind !== 'trajectory-record' ||
            !entry.ancestorToolKeys.some((key) => collapsedTools.has(key)))),
    );

  const visible = new Set<string>();
  const toolRows = new Map<string, string>();
  for (const entry of entries)
    if (entry.kind === 'trajectory-record' && entry.toolKey) toolRows.set(entry.toolKey, entry.key);
  let request: Extract<TrajectoryEntry, { kind: 'trajectory-request' }> | undefined;
  for (const entry of entries) {
    if (entry.kind === 'trajectory-turn') {
      request = undefined;
      continue;
    }
    if (entry.kind === 'trajectory-request') request = entry;
    if (!matches(entry)) continue;
    visible.add(entry.key);
    if (entry.kind === 'trajectory-record') {
      for (const ancestor of entry.ancestorToolKeys) {
        const key = toolRows.get(ancestor);
        if (key) visible.add(key);
      }
    }
    if (entry.turnKey !== null) {
      visible.add(trajectoryTurnKey(entry.turnKey));
      if (request?.turnKey === entry.turnKey) visible.add(request.key);
    }
  }
  return entries.filter((entry) => visible.has(entry.key));
}

export function trajectoryRecordMatches(
  row: Pick<ProcessRow, 'role' | 'field' | 'text' | 'tool'>,
  query: string,
  label: string,
): boolean {
  const fields = [label, row.role, row.field, row.text, row.tool?.call?.name];
  return fields.some((field) => field?.toLocaleLowerCase().includes(query));
}

export type TrajectoryRange = { start: number; end: number };

export function trajectoryOverlaps(range: TrajectoryRange, start: number, end = start): boolean {
  return start <= range.end && end >= range.start;
}

export function trajectoryZoom(
  domain: TrajectoryRange,
  center: number,
  span: number,
): TrajectoryRange {
  const fullSpan = domain.end - domain.start;
  const width = Math.min(fullSpan, Math.max(1, Math.round(span)));
  const start = Math.max(
    domain.start,
    Math.min(domain.end - width, Math.round(center - width / 2)),
  );
  return { start, end: start + width };
}

export function trajectoryTimeline(entries: readonly TrajectoryEntry[]) {
  type Point = {
    key: string;
    start: number;
    end?: number;
    firstToken?: number;
    outcome?: 'error' | 'aborted';
  };
  const turns: Point[] = [];
  const requests: Point[] = [];
  for (const entry of entries) {
    if (entry.kind === 'trajectory-turn' && entry.turn.timing) {
      const { startedAt, finished } = entry.turn.timing;
      turns.push({
        key: entry.key,
        start: startedAt,
        end: finished?.at,
        outcome:
          finished?.outcome === 'failed'
            ? 'error'
            : finished?.outcome === 'aborted'
              ? 'aborted'
              : undefined,
      });
    }
    if (entry.kind === 'trajectory-request' && entry.request.startedAt != null) {
      const { startedAt, firstTokenAt, finished } = entry.request;
      requests.push({
        key: entry.key,
        start: startedAt,
        end: finished?.at,
        firstToken: firstTokenAt ?? undefined,
        outcome:
          finished?.outcome === 'error' || finished?.outcome === 'aborted'
            ? finished.outcome
            : undefined,
      });
    }
  }
  let first = Infinity;
  let last = -Infinity;
  for (const points of [turns, requests]) {
    for (const point of points) {
      first = Math.min(first, point.start);
      last = Math.max(last, point.start, point.end ?? point.firstToken ?? point.start);
    }
  }
  const domain = Number.isFinite(first) ? { start: first, end: Math.max(first + 1, last) } : null;
  return { domain, turns, requests };
}
