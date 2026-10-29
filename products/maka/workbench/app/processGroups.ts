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

import type { Row } from './history';
import type { ToolActivity } from './toolActivity';

/** Source identity, ordering and failure text; streamed answer text does not regroup rows. */
export type ProcessRow = Pick<
  Row,
  | 'messageId'
  | 'field'
  | 'role'
  | 'text'
  | 'position'
  | 'tool'
  | 'turnId'
  | 'timing'
  | 'finalOutput'
  | 'metadataThrough'
  | 'sequence'
  | 'startSequence'
  | 'preview'
  | 'modelPart'
>;
export type ProcessActivity = Pick<
  ToolActivity,
  'toolUseId' | 'turnId' | 'startSequence' | 'previewOrder'
>;

export type MemberRef =
  | { kind: 'row'; rowId: string; toolUseId?: string }
  | { kind: 'activity'; toolUseId: string };
export type ProcessGroup = {
  kind: 'process';
  key: string;
  turnId: string;
  members: MemberRef[];
  rowIds: string[];
  toolIds: string[];
  /** A presentation boundary, never evidence that a tool effect settled. */
  closed: boolean;
};
export type MessageEntry = {
  kind: 'message';
  key: string;
  rowId: string;
  processTurnId?: string;
  /** How many identical failures in a row this entry stands for, when more than one. */
  repeats?: number;
};
export type ProcessEntry = ProcessGroup | MessageEntry;
export type TurnPresentation = {
  turnId: string;
  timing: Row['timing'] | null;
  active: boolean;
  finalOutputIds: string[];
  interleavedInput: boolean;
  answerKey?: string;
};
export type ProcessProjection = {
  entries: ProcessEntry[];
  turns: Map<string, TurnPresentation>;
  rowsById: Map<string, ProcessRow>;
};

/** One identity across streaming fragments, canonical handoff and tool result pairing. */
export function stableRowId(row: ProcessRow): string {
  const call = row.tool?.call;
  return call
    ? `tool/${row.tool.toolUseId}/${call.position.sourceSequence}/${call.position.itemIndex}`
    : `${row.messageId}/${row.field}`;
}

export function sourceSequence(row: ProcessRow): number | undefined {
  return row.position?.sourceSequence ?? row.startSequence ?? row.sequence;
}

/** A model step occupies its canonical seat while its parts retain provider order. */
export function orderProcessRows<T extends ProcessRow>(rows: readonly T[]): T[] {
  const seats = new Map<string, number>();
  for (const row of rows) {
    const sequence = sourceSequence(row);
    if (row.modelPart && sequence !== undefined)
      seats.set(
        row.modelPart.stepId,
        Math.min(seats.get(row.modelPart.stepId) ?? sequence, sequence),
      );
  }
  return rows.toSorted((left, right) => {
    if (left.modelPart && right.modelPart && left.modelPart.stepId === right.modelPart.stepId)
      return (
        left.modelPart.ordinal - right.modelPart.ordinal ||
        Number(left.field === 'body') - Number(right.field === 'body')
      );
    const seat = (row: T) =>
      row.modelPart ? seats.get(row.modelPart.stepId) : sourceSequence(row);
    const leftSeat = seat(left);
    const rightSeat = seat(right);
    if (leftSeat !== rightSeat) return (leftSeat ?? Infinity) - (rightSeat ?? Infinity);
    if (left.preview && right.preview)
      return (
        left.preview.stepOrder - right.preview.stepOrder ||
        left.preview.ordinal - right.preview.ordinal
      );
    return (
      (left.position?.itemIndex ?? 0) - (right.position?.itemIndex ?? 0) ||
      Number(left.field === 'body') - Number(right.field === 'body')
    );
  });
}

/** Compare only the small live set; a text delta keeps its original source seat. */
export function sameProcessRows(
  left: readonly ProcessRow[],
  right: readonly ProcessRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const next = right[index];
      return (
        stableRowId(row) === stableRowId(next) &&
        row.role === next.role &&
        (row.role !== 'failure' || row.text === next.text) &&
        row.field === next.field &&
        row.turnId === next.turnId &&
        sourceSequence(row) === sourceSequence(next) &&
        row.modelPart?.stepId === next.modelPart?.stepId &&
        row.modelPart?.ordinal === next.modelPart?.ordinal &&
        row.preview?.stepOrder === next.preview?.stepOrder &&
        row.preview?.ordinal === next.preview?.ordinal &&
        (row.position?.itemIndex ?? 0) === (next.position?.itemIndex ?? 0) &&
        Boolean(row.tool) === Boolean(next.tool) &&
        row.tool?.toolUseId === next.tool?.toolUseId &&
        Boolean(row.tool?.call) === Boolean(next.tool?.call) &&
        Boolean(row.tool?.result) === Boolean(next.tool?.result) &&
        row.finalOutput === next.finalOutput &&
        row.timing === next.timing &&
        row.metadataThrough === next.metadataThrough
      );
    })
  );
}

export function sameProcessActivity(
  left: readonly ProcessActivity[],
  right: readonly ProcessActivity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((activity, index) => {
      const next = right[index];
      return (
        activity.toolUseId === next.toolUseId &&
        activity.turnId === next.turnId &&
        activity.startSequence === next.startSequence &&
        activity.previewOrder === next.previewOrder
      );
    })
  );
}

function memberId(member: MemberRef): string {
  if (member.kind === 'activity') return `tool/${member.toolUseId}`;
  return member.toolUseId ? `tool/${member.toolUseId}` : member.rowId;
}

/**
 * Segment source order before any Chat/Trajectory filtering. Rows remain Host
 * references; a live tool preview can own a header but never becomes a message.
 */
export function projectProcessGroups(input: {
  rows: readonly ProcessRow[];
  toolActivity: readonly ProcessActivity[];
  activeTurnId: string | null;
  previous?: readonly ProcessEntry[];
  /** Only caller-known missing coverage, not gaps between raw event numbers. */
  gapsBefore?: ReadonlySet<string>;
}): ProcessProjection {
  const entries: ProcessEntry[] = [];
  const turns = new Map<string, TurnPresentation>();
  const rowsById = new Map<string, ProcessRow>();
  const positions: { rowId: string; sequence: number | undefined }[] = [];
  const canonicalTools = new Set<string>();
  const timingThrough = new Map<string, number>();
  const progressed = new Set<string>();
  const turn = (turnId: string) => {
    let value = turns.get(turnId);
    if (!value) {
      value = {
        turnId,
        timing: null,
        active: input.activeTurnId === turnId,
        finalOutputIds: [],
        interleavedInput: false,
      };
      turns.set(turnId, value);
    }
    return value;
  };

  for (const row of input.rows) {
    const rowId = stableRowId(row);
    if (!rowsById.has(rowId))
      positions.push({
        rowId,
        sequence: sourceSequence(row),
      });
    // A paired result refreshes the original call's seat, not a second row.
    if (!rowsById.has(rowId) || !row.tool?.call || row.tool.result) rowsById.set(rowId, row);
    if (row.tool) canonicalTools.add(row.tool.toolUseId);
    if (!row.turnId) continue;
    const presentation = turn(row.turnId);
    const through = row.metadataThrough ?? 0;
    if (row.timing && through >= (timingThrough.get(row.turnId) ?? -1)) {
      presentation.timing = row.timing;
      timingThrough.set(row.turnId, through);
    }
    if (
      row.finalOutput &&
      row.role === 'assistant' &&
      row.field === 'body' &&
      !presentation.finalOutputIds.includes(rowId)
    ) {
      presentation.finalOutputIds.push(rowId);
      presentation.answerKey ??= rowId;
    }
  }
  if (input.activeTurnId) turn(input.activeTurnId);

  const previousMembership = new Map<string, ProcessGroup>();
  for (const entry of input.previous ?? []) {
    if (entry.kind !== 'process') continue;
    for (const member of entry.members) previousMembership.set(memberId(member), entry);
  }
  const groupKey = (turnId: string, members: MemberRef[]) => {
    const ids = members.map(memberId);
    const offset = ids.findIndex((id) => previousMembership.has(id));
    const previous = offset < 0 ? undefined : previousMembership.get(ids[offset]);
    if (previous?.turnId === turnId) {
      const oldIds = previous.members.map(memberId);
      if (
        oldIds.every((id, index) => ids[offset + index] === id) &&
        ids.slice(offset + oldIds.length).every((id) => !previousMembership.has(id))
      )
        return previous.key;
    }
    // The first semantic source owns new groups, including a preview-only
    // group's canonical handoff after a temporary history catchup gap. A split
    // retains that owner's state only in the piece containing its first source.
    return JSON.stringify(['process', turnId, ids[0]]);
  };
  let current: { turnId: string; members: MemberRef[] } | undefined;
  const flush = (closed: boolean) => {
    if (!current) return;
    const presentation = turn(current.turnId);
    const { turnId, members } = current;
    entries.push({
      kind: 'process',
      key: groupKey(turnId, members),
      turnId,
      members,
      rowIds: members.flatMap((member) => (member.kind === 'row' ? [member.rowId] : [])),
      toolIds: [
        ...new Set(members.flatMap((member) => (member.toolUseId ? [member.toolUseId] : []))),
      ],
      closed:
        closed || Boolean(presentation.timing?.finished) || presentation.finalOutputIds.length > 0,
    });
    current = undefined;
  };
  const append = (turnId: string, member: MemberRef) => {
    if (current?.turnId !== turnId) {
      flush(true);
      current = { turnId, members: [] };
    }
    current!.members.push(member);
    progressed.add(turnId);
    turn(turnId);
  };
  const activities = input.toolActivity
    .filter((activity) => !canonicalTools.has(activity.toolUseId))
    .toSorted(
      (left, right) => (left.startSequence ?? Infinity) - (right.startSequence ?? Infinity),
    );
  let nextActivity = 0;
  for (const position of positions) {
    while (
      nextActivity < activities.length &&
      (position.sequence === undefined ||
        (activities[nextActivity].startSequence ?? Infinity) <= position.sequence)
    ) {
      const activity = activities[nextActivity++];
      append(activity.turnId, { kind: 'activity', toolUseId: activity.toolUseId });
    }
    const row = rowsById.get(position.rowId)!;
    if (input.gapsBefore?.has(position.rowId)) flush(true);
    if (current && current.turnId !== row.turnId) flush(true);
    const body = row.role === 'assistant' && row.field === 'body';
    const outside =
      body || row.role === 'user' || row.role === 'failure' || row.role === 'compaction';
    if (!row.turnId || outside) {
      flush(true);
      // A provider that keeps refusing (a rate limit, an overload) fails each retry
      // with the same text; show the run once with its count.
      const last = entries.at(-1);
      const lastRow = last?.kind === 'message' ? rowsById.get(last.rowId) : undefined;
      if (
        row.role === 'failure' &&
        last?.kind === 'message' &&
        lastRow?.role === 'failure' &&
        lastRow.turnId === row.turnId &&
        lastRow.text === row.text
      ) {
        last.repeats = (last.repeats ?? 1) + 1;
        continue;
      }
      const message: MessageEntry = { kind: 'message', key: position.rowId, rowId: position.rowId };
      if (row.turnId) {
        if (row.role === 'user' && progressed.has(row.turnId))
          turn(row.turnId).interleavedInput = true;
        if (body) {
          if (!row.finalOutput) message.processTurnId = row.turnId;
          progressed.add(row.turnId);
        }
      }
      entries.push(message);
    } else {
      append(row.turnId, {
        kind: 'row',
        rowId: position.rowId,
        ...(row.tool ? { toolUseId: row.tool.toolUseId } : {}),
      });
    }
  }
  for (; nextActivity < activities.length; nextActivity++) {
    const activity = activities[nextActivity];
    append(activity.turnId, { kind: 'activity', toolUseId: activity.toolUseId });
  }
  flush(false);
  return { entries, turns, rowsById };
}
