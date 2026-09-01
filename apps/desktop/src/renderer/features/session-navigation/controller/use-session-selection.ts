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
import type { SessionRailRowSelection, SessionRailSelection } from '@maka/ui';
import {
  EMPTY_SESSION_SELECTION,
  enterSessionSelection,
  exitSessionSelection,
  pruneSessionSelection,
  setAllSessionsSelected,
} from '../model/session-selection.js';
import type { SessionNavigationRowActions } from './session-row-actions.js';

/**
 * The rail's multi-select: which rows are marked, and the two sweeps they feed.
 *
 * The selection is reconciled against the catalog on every change to it, not
 * only after a sweep. Another window deleting a task, a Host going away, or a
 * grouping change that drops rows all leave ids behind, and a count that
 * includes them is a count that does not match what the confirm names.
 */
export function useSessionSelection(input: {
  sessions: readonly SessionSummary[];
  commands: SessionNavigationRowActions;
}): { selection: SessionRailSelection; rowSelection: SessionRailRowSelection } {
  const { sessions, commands } = input;
  const [selection, setSelection] = useState(EMPTY_SESSION_SELECTION);
  const [busy, setBusy] = useState(false);

  const listedIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  useEffect(() => {
    // `pruneSessionSelection` returns its input untouched when nothing was
    // dropped, so this settles after one pass instead of looping on a new Set.
    setSelection((current) => pruneSessionSelection(current, listedIds));
  }, [listedIds]);

  // The sweep reads the ids at the moment it runs, and the state it reads is
  // the one the confirm was built from — held in a ref so the callbacks below
  // do not change identity per selection change and re-render the bar's buttons.
  const selectionRef = useRef(selection);
  const busyRef = useRef(busy);
  // Published on commit, not during render: a render React throws away must not
  // leave a ref pointing at a selection that was never shown.
  useLayoutEffect(() => {
    selectionRef.current = selection;
    busyRef.current = busy;
    listedRef.current = listedSessionIds;
  });

  const listedSessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
  const listedRef = useRef(listedSessionIds);

  const onToggleRow = useCallback<SessionRailSelection['onToggleRow']>((sessionId, selected) => {
    setSelection((current) => {
      if (current.selectedIds.has(sessionId) === selected) return current;
      const selectedIds = new Set(current.selectedIds);
      if (selected) selectedIds.add(sessionId);
      else selectedIds.delete(sessionId);
      return { active: true, selectedIds };
    });
  }, []);

  const onEnter = useCallback<SessionRailSelection['onEnter']>((sessionId) => {
    setSelection((current) => {
      const entered = enterSessionSelection(current);
      if (sessionId === undefined) return entered;
      return { active: true, selectedIds: new Set([...entered.selectedIds, sessionId]) };
    });
  }, []);

  const onExit = useCallback(() => setSelection(exitSessionSelection()), []);

  const onToggleAll = useCallback<SessionRailSelection['onToggleAll']>((selected) => {
    setSelection((current) => setAllSessionsSelected(current, listedRef.current, selected));
  }, []);

  /**
   * One sweep at a time, over the ids the user could see when they pressed.
   *
   * Frozen at the click for the reason the archived-task purge freezes its own
   * set: a confirm names a number to a person, and a set re-read after the
   * dialog can be a different one. The confirm, the sweep and the report all
   * live in `session-row-actions`, which is where this feature keeps its copy.
   */
  const runSweep = useCallback(
    async (run: (sessionIds: readonly string[]) => Promise<void>) => {
      if (busyRef.current) return;
      const sessionIds = [...selectionRef.current.selectedIds];
      if (sessionIds.length === 0) return;
      setBusy(true);
      try {
        await run(sessionIds);
      } finally {
        setBusy(false);
        // Unmark exactly what this sweep asked about — never whatever happens
        // to be marked when it lands.
        //
        // `Done` stays enabled during a sweep, so a person can leave the mode,
        // re-enter it from another row's menu and mark B while A's request is
        // still with the Host. Clearing the whole set here would then answer
        // A's completion by discarding B, which the user never asked about.
        //
        // The MODE stays on. The person was in the middle of tidying up, and
        // taking the checkboxes away after each sweep would make them re-enter
        // for the next one.
        setSelection((current) => {
          const remaining = new Set(current.selectedIds);
          let changed = false;
          for (const sessionId of sessionIds) {
            if (remaining.delete(sessionId)) changed = true;
          }
          return changed ? { active: current.active, selectedIds: remaining } : current;
        });
      }
    },
    [],
  );

  const onArchiveSelected = useCallback(
    () => runSweep((ids) => commands.archiveSelected(ids)),
    [commands, runSweep],
  );
  const onDeleteSelected = useCallback(
    () => runSweep((ids) => commands.deleteSelected(ids)),
    [commands, runSweep],
  );

  /**
   * The rows' half, memoized on the selection ALONE.
   *
   * Every row subscribes to this, and a context consumer re-renders whenever
   * the value it reads changes — `memo` cannot stop it. Keeping
   * `listedSessionIds` out of it is the whole point: that array is derived from
   * the catalog and moves on a session switch, which would re-render all of the
   * rail's rows for a switch that changed two of them (#4109).
   */
  const rowSelection = useMemo<SessionRailRowSelection>(
    () => ({
      active: selection.active,
      selectedIds: selection.selectedIds,
      onToggleRow,
      onEnter,
    }),
    [onEnter, onToggleRow, selection.active, selection.selectedIds],
  );

  const wholeSelection = useMemo<SessionRailSelection>(
    () => ({
      active: selection.active,
      selectedIds: selection.selectedIds,
      listedSessionIds,
      onToggleRow,
      onEnter,
      onExit,
      onToggleAll,
      onArchiveSelected,
      onDeleteSelected,
      busy,
    }),
    [
      busy,
      listedSessionIds,
      onArchiveSelected,
      onDeleteSelected,
      onEnter,
      onExit,
      onToggleAll,
      onToggleRow,
      selection.active,
      selection.selectedIds,
    ],
  );

  return useMemo(
    () => ({ selection: wholeSelection, rowSelection }),
    [rowSelection, wholeSelection],
  );
}
