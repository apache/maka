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

import { useEffect, useState } from 'react';
import { useMountedRef } from '@maka/ui';
import type { TurnRecord } from '@maka/core/session';
import type { SessionExecutionProjection } from '../../../application/contracts/session-execution.js';
import { useWorkbarServices } from '../services-context.js';
import {
  hostExecutionProjection,
  parentTaskStatusFromFacts,
  visibleParentTaskStatus,
  type ParentTaskLatestTurnRead,
  type VisibleParentTaskStatus,
} from '../model/parent-task-status.js';

type ParentObservation = {
  readonly sessionId: string;
  readonly execution: SessionExecutionProjection | undefined;
  readonly latestTurnRead: ParentTaskLatestTurnRead;
  readonly historyEpoch: number;
};

function emptyObservation(sessionId: string): ParentObservation {
  return {
    sessionId,
    execution: undefined,
    latestTurnRead: { status: 'pending' },
    historyEpoch: 0,
  };
}

/** History must be reread when availability returns or the live root disappears. */
function shouldInvalidateHistoryRead(
  previous: SessionExecutionProjection | undefined,
  next: SessionExecutionProjection | undefined,
): boolean {
  const nextAvailable = next?.available === true;
  const nextRoot = next?.rootTurn ?? null;
  if (!nextAvailable || nextRoot) return false;
  const previousAvailable = previous?.available === true;
  const previousRoot = previous?.rootTurn ?? null;
  if (!previousAvailable) return true;
  if (previousRoot) return true;
  return false;
}

function applyExecution(
  current: ParentObservation,
  projection: SessionExecutionProjection | undefined,
): ParentObservation {
  const refresh = shouldInvalidateHistoryRead(current.execution, projection);
  let latestTurnRead = current.latestTurnRead;
  if (!projection?.available) {
    latestTurnRead = { status: 'failed' };
  } else if (refresh) {
    latestTurnRead = { status: 'pending' };
  }
  return {
    sessionId: current.sessionId,
    execution: projection,
    latestTurnRead,
    historyEpoch: current.historyEpoch + (refresh ? 1 : 0),
  };
}

/**
 * Shared parent-task facts for every Side Conversation on this Workbar.
 * One Host observation via the existing Session execution port; companion
 * interaction queues are never treated as the parent.
 */
export function useParentTaskStatus(
  sessionId: string | undefined,
): VisibleParentTaskStatus | null {
  const { sideChat } = useWorkbarServices();
  const mountedRef = useMountedRef();
  const [observation, setObservation] = useState<ParentObservation | null>(null);
  if ((observation?.sessionId ?? null) !== (sessionId ?? null)) {
    setObservation(sessionId ? emptyObservation(sessionId) : null);
  }
  const bound = observation?.sessionId === sessionId ? observation : null;
  const historyEpoch = bound?.historyEpoch ?? 0;
  const shouldReadLatestTurn = Boolean(
    sessionId &&
      bound?.execution?.available &&
      !bound.execution.rootTurn &&
      historyEpoch > 0,
  );

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const unsubscribe = sideChat.subscribeEvents(
      sessionId,
      () => undefined,
      undefined,
      () => {
        if (disposed || !mountedRef.current) return;
        setObservation((current) => {
          if (current?.sessionId !== sessionId) return current;
          return applyExecution(
            current,
            current.execution
              ? { ...current.execution, available: false }
              : hostExecutionProjection(false, null),
          );
        });
      },
      (projection) => {
        if (disposed || !mountedRef.current) return;
        setObservation((current) => {
          if (current?.sessionId !== sessionId) return current;
          return applyExecution(current, projection);
        });
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [mountedRef, sessionId, sideChat]);

  useEffect(() => {
    if (!sessionId || !shouldReadLatestTurn) return;
    const requestedEpoch = historyEpoch;
    let cancelled = false;
    void sideChat.listTurns(sessionId).then(
      (turns: TurnRecord[]) => {
        if (cancelled || !mountedRef.current) return;
        const latest = turns.at(-1) ?? null;
        setObservation((current) => {
          if (current?.sessionId !== sessionId) return current;
          if (current.historyEpoch !== requestedEpoch) return current;
          return {
            ...current,
            latestTurnRead: { status: 'ready', turn: latest },
          };
        });
      },
      () => {
        if (cancelled || !mountedRef.current) return;
        setObservation((current) => {
          if (current?.sessionId !== sessionId) return current;
          if (current.historyEpoch !== requestedEpoch) return current;
          return { ...current, latestTurnRead: { status: 'failed' } };
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [historyEpoch, mountedRef, sessionId, shouldReadLatestTurn, sideChat]);

  if (!sessionId) return null;
  return visibleParentTaskStatus(
    parentTaskStatusFromFacts({
      execution: bound?.execution,
      latestTurnRead: bound?.execution?.rootTurn
        ? { status: 'ready', turn: null }
        : (bound?.latestTurnRead ?? { status: 'pending' }),
    }),
  );
}
