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
 * Branch banner derivation helper (PR109f).
 *
 * Pure, testable function that decides whether the active session
 * should show the "分自 ${parentName}" banner above the chat surface,
 * and what the banner should say.
 *
 * Rule:
 *   - Only branched sessions (those with `parentSessionId` set on the
 *     SessionSummary) show a banner.
 *   - The parent session must be present in the visible sessions list;
 *     we look up its display name there. If the parent was archived or
 *     otherwise hidden, return undefined — we don't expose a banner that
 *     can't be clicked.
 *   - `fromAbortedTurn` is opportunistic — caller decides whether they
 *     have the parent turn loaded; if not, leave it undefined.
 *
 * This is separate from `presentSessionStatus` because the banner is a
 * cross-session concept (it bridges two SessionSummary records), not a
 * per-status visual.
 */

export interface BranchBannerSessionInput {
  /** Session id used for navigation. */
  id: string;
  /** Display name shown to the user. */
  name: string;
  /** If set, this session was created via `sessions:branchFromTurn`. */
  parentSessionId?: string;
}

export interface BranchBanner {
  parentSessionId: string;
  parentSessionName: string;
  /**
   * Set when the branch starting point was an aborted turn. Caller
   * provides this when it knows; helper does not guess.
   */
  fromAbortedTurn?: boolean;
}

/**
 * Derive the branch banner for the active session, or `undefined` if
 * the session is not branched or the parent is not visible.
 *
 * @param activeSession  the SessionSummary the chat surface is showing
 * @param sessions       visible SessionSummary list (sidebar source)
 * @param fromAbortedTurn optional caller-supplied flag (defaults to
 *                        omitted, i.e. plain "分自" copy)
 */
export function deriveBranchBanner(
  activeSession: BranchBannerSessionInput | undefined,
  sessions: ReadonlyArray<BranchBannerSessionInput>,
  fromAbortedTurn?: boolean,
): BranchBanner | undefined {
  if (!activeSession?.parentSessionId) return undefined;
  const parent = sessions.find((s) => s.id === activeSession.parentSessionId);
  if (!parent) return undefined;
  const banner: BranchBanner = {
    parentSessionId: parent.id,
    parentSessionName: parent.name,
  };
  if (fromAbortedTurn) banner.fromAbortedTurn = true;
  return banner;
}
