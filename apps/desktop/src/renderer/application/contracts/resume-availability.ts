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
 * One fail-closed guard extends that rule: a fresh read retracts the previous
 * offer while it is in flight. The cached answer went stale the moment the
 * new question was asked (a session switch, a rebound, a status boundary), so
 * the offer hides until the authority answers again instead of rendering a
 * clickable stale offer whose click can only park (#5904).
 *
 * A Turn the user just stopped is offered like any other resumable
 * interruption (#5923): the slot only renders Resume after a fresh `ready`
 * answer — i.e. after the stop's terminal transition completed — so a click
 * during the settle window lands on a disabled Send, and the resumed Turn
 * can simply be stopped again.
 */
export function createResumeAvailabilityTracker(options: {
  query(sessionId: string): Promise<{ readonly disposition: 'ready' | 'parked' }>;
  onAvailability(sessionId: string, available: boolean): void;
}) {
  /** Per-session sequence of the newest request; answers older than it are stale. */
  const latestRequestBySession = new Map<string, number>();
  /** Per-session last emitted offer, so a re-read retracts only a visible one. */
  const lastEmittedBySession = new Map<string, boolean>();
  const inFlight = new Set<string>();
  const rerequestWhenSettled = new Set<string>();
  let sequence = 0;

  function emit(sessionId: string, available: boolean): void {
    lastEmittedBySession.set(sessionId, available);
    options.onAvailability(sessionId, available);
  }

  async function run(sessionId: string, requestId: number): Promise<void> {
    try {
      const plan = await options.query(sessionId);
      if (latestRequestBySession.get(sessionId) !== requestId) return;
      emit(sessionId, plan.disposition === 'ready');
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
  };
}
