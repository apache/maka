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
}): SessionRailSelection {
  const { sessions, commands } = input;
  const [selection, setSelection] = useState(EMPTY_SESSION_SELECTION);

  const listedIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  useEffect(() => {
    // `pruneSessionSelection` returns its input untouched when nothing was
    // dropped, so this settles after one pass instead of looping on a new Set.
    setSelection((current) => pruneSessionSelection(current, listedIds));
  }, [listedIds]);

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
    () => ({ pick, clear, archiveSelected, flagSelected }),
    [archiveSelected, clear, flagSelected, pick],
  );

  return useMemo<SessionRailSelection>(
    () => ({ selectedIds: selection.selectedIds, commands: selectionCommands }),
    [selection.selectedIds, selectionCommands],
  );
}
