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

import type { SessionSummary } from '@maka/core/session';
import { isSideConversationSession } from '@maka/core/side-conversation';
import type { SessionCatalogState } from './session-catalog-state.js';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';

/**
 * Which sessions the rail lists. Archived tasks are managed in Settings › 活动 ›
 * 已归档任务 (#2985). Side-conversation forks belong to their Workbar panels,
 * not the main task catalog; filtering their durable label here prevents the
 * `sessions:changed(created)` broadcast from flashing a row before the panel's
 * renderer-local hidden-id update arrives.
 *
 * This used to switch on `NavSelection.filter`. That filter is gone (#2984): its
 * last two values were a destination that moved to Settings and a value nothing
 * ever selected, which left one branch reachable — this one.
 */
export function sessionMatchesRail(session: SessionSummary): boolean {
  return !session.isArchived && !isSideConversationSession(session.labels);
}

/** The command palette lists the rail's membership minus its hidden rows. */
export const selectPaletteSessions = (
  state: SessionCatalogState,
  hiddenSessionIds: ReadonlySet<string>,
) =>
  state.sessions.filter(
    (session) => sessionMatchesRail(session) && !hiddenSessionIds.has(session.id),
  );

const EMPTY_PALETTE_SESSIONS: readonly DesktopSessionSummary[] = [];
export const selectClosedPaletteSessions = () => EMPTY_PALETTE_SESSIONS;

/** A palette command shows id, name and the flag glyph; nothing else re-lists it. */
export function paletteSessionsEqual(
  left: readonly DesktopSessionSummary[],
  right: readonly DesktopSessionSummary[],
): boolean {
  return left.length === right.length
    && left.every((session, index) =>
      session.id === right[index]!.id
      && session.name === right[index]!.name
      && session.isFlagged === right[index]!.isFlagged);
}
