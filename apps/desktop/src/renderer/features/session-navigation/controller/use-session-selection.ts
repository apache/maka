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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@maka/core/session';
import type { SessionRailSelection, SessionRailSelectionCommands } from '@maka/ui';
import {
  EMPTY_SESSION_SELECTION,
  pickSessionRow,
  pruneSessionSelection,
} from '../model/session-selection.js';
import type { SessionNavigationRowActions } from './session-row-actions.js';

/**
 * The rail's multi-select: which rows are picked, and the sweeps they feed.
 *
 * One state, and it is the whole feature. There is no mode flag beside it, no
 * "what does all mean" list, and no second half for the rows — the rows are
 * handed what they need as props, because the picked set now changes on an
 * ordinary session switch and a context they subscribed to would redraw all of
 * them for a switch that moved two (#4109).
 *
 * The selection is reconciled against the catalog on every change to it, not
 * only after a sweep. Another window deleting a task, a Host going away, or a
 * grouping change that drops rows all leave ids behind, and a count that
 * includes them is a count that does not match what the menu named.
 */
export function useSessionSelection(input: {
  sessions: readonly SessionSummary[];
  commands: SessionNavigationRowActions;
  /** The open task, as the rail paints it. */
  activeId?: string;
}): SessionRailSelection {
  const { sessions, commands, activeId } = input;
  const [selection, setSelection] = useState(EMPTY_SESSION_SELECTION);

  const listedIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  useEffect(() => {
    // `pruneSessionSelection` returns its input untouched when nothing was
    // dropped, so this settles after one pass instead of looping on a new Set.
    setSelection((current) => pruneSessionSelection(current, listedIds));
  }, [listedIds]);

  /**
   * The set drops when the open task is not one of its members.
   *
   * A picked row and the open row are painted on the same ground, so a set that
   * does not hold the open row can be read as a set around it, and the next ⋯
   * on a picked row sweeps something other than what the user was looking at.
   * ⌘K, the Module Hub and 新建任务 all move the open task without touching the
   * set, which is how that misreading gets built.
   *
   * Membership is the rule, not a stand-in for where the navigation came from.
   * When the open row IS in the set, every row on that ground is genuinely
   * picked, so nothing is misread and there is nothing to drop — the same
   * answer whether the user clicked that row or reached it through ⌘K, and the
   * verb still names its own count before it sweeps. Correlating the click with
   * the active id would be a second account of the same question, and a lossier
   * one: it would drop a set the user can plainly see is still theirs.
   *
   * Cleared, not `replace`d onto the new row: an empty selection ALREADY reads
   * as "just the open row", because the rail paints that row whether or not it
   * is picked (see `EMPTY_SESSION_SELECTION`). A set of one that happens to
   * equal the open row would be a second way to say the same thing.
   */
  useEffect(() => {
    if (activeId === undefined) return;
    setSelection((current) =>
      current.selectedIds.has(activeId) ? current : EMPTY_SESSION_SELECTION,
    );
  }, [activeId]);

  // A sweep reads the ids at the moment it runs, and the state it reads is the
  // one the menu's verb was counted from — held in a ref so the commands below
  // never change identity, because every row carries them as a prop.
  const selectionRef = useRef(selection);
  const busyRef = useRef(false);
  // Published on commit, not during render: a render React throws away must not
  // leave a ref pointing at a selection that was never shown.
  useLayoutEffect(() => {
    selectionRef.current = selection;
  });

  const pick = useCallback<SessionRailSelectionCommands['pick']>((request) => {
    setSelection((current) => pickSessionRow(current, request));
  }, []);

  const clear = useCallback(() => setSelection(EMPTY_SESSION_SELECTION), []);

  /**
   * The same reconciliation the catalog gets, against a narrower list: the rows
   * the rail can see and act on right now. The menu asks for it as it opens,
   * because a collapsed project keeps its rows mounted and a shared projection
   * keeps its row listed — neither is gone from the catalog, and neither may be
   * swept. `useCallback` because every row carries these commands as a prop
   * (#4109), and `pruneSessionSelection` returns its input untouched when
   * nothing was dropped, so the common case is not a state change at all.
   */
  const retain = useCallback<SessionRailSelectionCommands['retain']>((sessionIds) => {
    setSelection((current) => pruneSessionSelection(current, sessionIds));
  }, []);

  /**
   * One sweep at a time, over the ids the user could see when they pressed.
   *
   * Frozen at the click for the reason the archived-task purge freezes its own
   * set: a verb names a number to a person, and a set re-read afterwards can be
   * a different one. The sweeps and their reports live in `session-row-actions`,
   * which is where this feature already keeps its copy.
   *
   * It does not unmark what it swept. The rule is "the selection follows the
   * catalog", and the prune above already owns it: an archive refreshes the
   * catalog before it resolves, so those rows leave the set by leaving the
   * rail. Unmarking here would be that rule stated a second time — right for
   * archive, wrong for pin, which leaves the rows exactly where they are and
   * would drop a set the user was still working with. When a refresh fails and
   * the rows stay listed, keeping them picked is the consistent answer: the
   * rail still shows them.
   */
  const runSweep = useCallback(
    async (run: (sessionIds: readonly string[]) => Promise<void>) => {
      if (busyRef.current) return;
      const sessionIds = [...selectionRef.current.selectedIds];
      if (sessionIds.length === 0) return;
      busyRef.current = true;
      try {
        await run(sessionIds);
      } finally {
        busyRef.current = false;
      }
    },
    [],
  );

  const archiveSelected = useCallback(
    () => runSweep((ids) => commands.archiveSelected(ids)),
    [commands, runSweep],
  );
  const flagSelected = useCallback(
    (flagged: boolean) => runSweep((ids) => commands.flagSelected(ids, flagged)),
    [commands, runSweep],
  );

  const selectionCommands = useMemo<SessionRailSelectionCommands>(
    () => ({ pick, clear, retain, archiveSelected, flagSelected }),
    [archiveSelected, clear, flagSelected, pick, retain],
  );

  return useMemo<SessionRailSelection>(
    () => ({ selectedIds: selection.selectedIds, commands: selectionCommands }),
    [selection.selectedIds, selectionCommands],
  );
}
