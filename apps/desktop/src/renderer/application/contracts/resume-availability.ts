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
 * Authoritative resume availability behind the composer's Resume offer
 * (#5903). The renderer never derives resumability from local turn state —
 * the Runtime Host's safe-boundary planner is the only authority, and the
 * read-only `turn.resume.query` preview it answers is side-effect free.
 *
 * The tracker owns the round trips behind one rule: the latest request for a
 * session wins. A stale answer (an event burst, a session switch mid-flight)
 * is dropped rather than applied out of order; a parked plan or a failed read
 * both mean "not offered", keeping the affordance fail-closed. Clicking still
 * re-runs the full admission inside `turn.resume.start`, so a stale offer can
 * only ever park, never resume the wrong thing.
 *
 * Two fail-closed guards extend that rule:
 *
 * - A fresh read retracts the previous offer while it is in flight. The
 *   cached answer went stale the moment the new question was asked (a
 *   session switch, a rebound, a status boundary), so the offer hides until
 *   the authority answers again instead of rendering a clickable stale
 *   offer whose click can only park (#5904).
 *
 * - `noteUserStopped` suppresses the resume candidate the stop produces.
 *   The composer's send slot is where the Stop button just sat: offering
 *   Resume there a moment later means a repeated or late click on Stop
 *   restarts the very Turn the user stopped, tool calls and spend included.
 *   The interrupted-Turn banner remains the deliberate resume path for that
 *   Turn; the slot offers it only for interruptions the user did not just
 *   cause. The suppression is bound to the candidate's identity, not to a
 *   count of answers: while a Turn runs the planner only answers
 *   `session_busy`, so the first `ready` answer after a user stop names the
 *   stopped Turn, and its (sourceTurnId, sourceRunId) pair is suppressed
 *   for as long as it remains the candidate — one stop emits the terminal
 *   notification twice (observer frame and stop IPC both publish), and the
 *   trailing re-read must not resurrect the offer (#5904). The pair releases
 *   on its own when the candidate's lifecycle moves on: a resumed-then-
 *   interrupted Turn comes back under a new source run.
 */
export function createResumeAvailabilityTracker(options: {
  query(sessionId: string): Promise<
    | {
        readonly disposition: 'ready';
        readonly sourceTurnId?: string;
        readonly sourceRunId?: string;
      }
    | { readonly disposition: 'parked' }
  >;
  onAvailability(sessionId: string, available: boolean): void;
}) {
  /** Per-session sequence of the newest request; answers older than it are stale. */
  const latestRequestBySession = new Map<string, number>();
  /** Per-session last emitted offer, so a re-read retracts only a visible one. */
  const lastEmittedBySession = new Map<string, boolean>();
  /** Sessions whose next ready answer identifies the Turn the user just stopped. */
  const stopCaptureArmedBySession = new Set<string>();
  /**
   * Per-session stopped candidates (`sourceTurnId` ⏎ `sourceRunId`) the send
   * slot must not offer. Identity-keyed, so repeated observations of the same
   * stopped Turn stay suppressed while a different candidate offers normally.
   */
  const suppressedSourcesBySession = new Map<string, Set<string>>();
  const inFlight = new Set<string>();
  const rerequestWhenSettled = new Set<string>();
  let sequence = 0;

  function emit(sessionId: string, available: boolean): void {
    lastEmittedBySession.set(sessionId, available);
    options.onAvailability(sessionId, available);
  }

  function suppressedSourceKey(plan: {
    sourceTurnId?: string;
    sourceRunId?: string;
  }): string | undefined {
    if (plan.sourceTurnId === undefined || plan.sourceRunId === undefined) return undefined;
    return `${plan.sourceTurnId}\n${plan.sourceRunId}`;
  }

  async function run(sessionId: string, requestId: number): Promise<void> {
    try {
      const plan = await options.query(sessionId);
      if (latestRequestBySession.get(sessionId) !== requestId) return;
      if (plan.disposition === 'ready') {
        const sourceKey = suppressedSourceKey(plan);
        if (stopCaptureArmedBySession.delete(sessionId)) {
          // The first ready answer after a user stop is the stopped Turn
          // (a running Turn only ever answers session_busy): bind the
          // suppression to its identity so every later observation of it —
          // the terminal notification arrives twice — stays hidden.
          if (sourceKey !== undefined) {
            const suppressed = suppressedSourcesBySession.get(sessionId) ?? new Set<string>();
            suppressed.add(sourceKey);
            suppressedSourcesBySession.set(sessionId, suppressed);
          }
          emit(sessionId, false);
          return;
        }
        if (sourceKey !== undefined && suppressedSourcesBySession.get(sessionId)?.has(sourceKey)) {
          emit(sessionId, false);
          return;
        }
        emit(sessionId, true);
        return;
      }
      emit(sessionId, false);
    } catch {
      if (latestRequestBySession.get(sessionId) !== requestId) return;
      emit(sessionId, false);
    } finally {
      inFlight.delete(sessionId);
      if (rerequestWhenSettled.delete(sessionId)) {
        request(sessionId);
      }
    }
  }

  function request(sessionId: string): void {
    if (inFlight.has(sessionId)) {
      rerequestWhenSettled.add(sessionId);
      return;
    }
    const requestId = ++sequence;
    latestRequestBySession.set(sessionId, requestId);
    inFlight.add(sessionId);
    if (lastEmittedBySession.get(sessionId) === true) {
      // The answer this offer rests on is being re-asked: hide the offer
      // until the fresh answer lands rather than render a stale one.
      emit(sessionId, false);
    }
    void run(sessionId, requestId);
  }

  return {
    /** Fire-and-forget authoritative read; coalesces bursts into one trailing read. */
    request,
    /**
     * A click-time answer outranks any read still in flight: the resume
     * attempt just asked the authority directly, so its outcome hides or
     * keeps the offer immediately instead of waiting for the next event.
     */
    settle(sessionId: string, available: boolean): void {
      latestRequestBySession.set(sessionId, ++sequence);
      emit(sessionId, available);
    },
    /**
     * The user just stopped a Turn in this session from the send slot. The
     * offer that stop produces — the same Turn — must not appear in the slot
     * the Stop button occupied, or a repeated click would restart it. A
     * currently visible offer hides at once; the next ready answer identifies
     * the stopped candidate, whose (sourceTurnId, sourceRunId) pair then
     * stays suppressed until the candidate's lifecycle moves on.
     */
    noteUserStopped(sessionId: string): void {
      stopCaptureArmedBySession.add(sessionId);
      if (lastEmittedBySession.get(sessionId) === true) {
        emit(sessionId, false);
      }
    },
  };
}
