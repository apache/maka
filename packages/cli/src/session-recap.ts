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

/** Idle gap (ms) after which the first normal prompt on return triggers an automatic recap. */
export const AUTO_RECAP_IDLE_MS = 180_000;
/** Minimum main-turn count (user-prompted turns) before an automatic recap may fire. */
export const AUTO_RECAP_MIN_TURNS = 3;
/** Raw-output size (bytes) above which an automatic recap is not surfaced in the transcript (still persisted). */
export const AUTO_RECAP_DISPLAY_LIMIT_BYTES = 500;

export interface ShouldAutoRecapInput {
  /** Milliseconds since the last recorded user activity. */
  idleMs: number;
  /** Current main (user-prompted) turn count. */
  mainTurnCount: number;
  /** Main turn count as of the last recap (manual or automatic). */
  lastRecapMainTurnCount: number;
}

/**
 * Whether a normal-prompt submission after an idle gap should trigger an
 * automatic recap: idle for at least `AUTO_RECAP_IDLE_MS`, at least
 * `AUTO_RECAP_MIN_TURNS` main turns so far, and progress since the last recap
 * (a per-main-turn watermark).
 */
export function shouldAutoRecap(input: ShouldAutoRecapInput): boolean {
  return (
    input.idleMs >= AUTO_RECAP_IDLE_MS &&
    input.mainTurnCount >= AUTO_RECAP_MIN_TURNS &&
    input.mainTurnCount > input.lastRecapMainTurnCount
  );
}
