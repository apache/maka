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
  parentTaskStatusFromFacts,
  visibleParentTaskStatus,
  type ParentTaskLatestTurnRead,
  type VisibleParentTaskStatus,
} from '../model/parent-task-status.js';

/** First retry delay; doubles per attempt and never exceeds the cap. */
const HISTORY_READ_BACKOFF_MS = 100;
const HISTORY_READ_MAX_DELAY_MS = 2_000;
/** Bounded auto recovery: the initial read plus two retries. */
const HISTORY_READ_MAX_ATTEMPTS = 3;

type HistoryRead = {
  readonly sessionId: string;
  readonly epoch: number;
  readonly read: ParentTaskLatestTurnRead;
};

export interface ParentTaskStatusInput {
  /** The Session whose Side Conversations are reading their parent. */
  readonly sessionId: string | undefined;
  /** The owning conversation's canonical projection; `undefined` until it arrives. */
  readonly execution: SessionExecutionProjection | undefined;
  /** Producer-side counter that changes whenever the projection invalidates history. */
  readonly historyEpoch: number | undefined;
}

const pendingRead: ParentTaskLatestTurnRead = { status: 'pending' };

/**
 * Parent-task facts for the Side Conversations of one Session.
 *
 * The execution projection comes from the conversation that owns the Session;
 * this hook only adds the one fact the projection cannot carry cheaply — the
 * latest settled turn — and only while the projection is available without a
 * live root. A failed read retries on a bounded backoff and then reports real
 * unavailability, but an unseeded or still-loading read reports nothing.
 */
export function useParentTaskStatus(
  input: ParentTaskStatusInput,
): VisibleParentTaskStatus | null {
  const { sideChat } = useWorkbarServices();
  const mountedRef = useMountedRef();
  const sessionId = input.sessionId;
  const epoch = input.historyEpoch ?? 0;
  const execution = input.execution;
  const needsHistoryRead = Boolean(sessionId && execution?.available && !execution.rootTurn);
  const [historyRead, setHistoryRead] = useState<HistoryRead | null>(null);

  useEffect(() => {
    if (!sessionId || !needsHistoryRead) return;
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const publish = (read: ParentTaskLatestTurnRead) => {
      setHistoryRead({ sessionId, epoch, read });
    };
    const readLatestTurn = () => {
      attempt += 1;
      void sideChat.listTurns(sessionId).then(
        (turns: TurnRecord[]) => {
          if (cancelled || !mountedRef.current) return;
          publish({ status: 'ready', turn: turns.at(-1) ?? null });
        },
        () => {
          if (cancelled || !mountedRef.current) return;
          if (attempt >= HISTORY_READ_MAX_ATTEMPTS) {
            publish({ status: 'failed' });
            return;
          }
          retryTimer = globalThis.setTimeout(
            readLatestTurn,
            Math.min(HISTORY_READ_BACKOFF_MS * (2 ** (attempt - 1)), HISTORY_READ_MAX_DELAY_MS),
          );
        },
      );
    };
    readLatestTurn();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
    };
    // Navigating away, a new history epoch, or a live root turn all cancel the
    // read: the fence below drops any answer that still arrives.
  }, [epoch, mountedRef, needsHistoryRead, sessionId, sideChat]);

  if (!sessionId) return null;
  const current = historyRead
    && historyRead.sessionId === sessionId
    && historyRead.epoch === epoch
    ? historyRead.read
    : pendingRead;
  return visibleParentTaskStatus(
    parentTaskStatusFromFacts({
      execution,
      latestTurnRead: execution?.rootTurn ? { status: 'ready', turn: null } : current,
    }),
  );
}
