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
 * Map a tool_result onto the UI activity status used by cards/trows.
 * Cancel / abort are user-or-system stops, not tool failures.
 */
import type { ToolResultContent } from './events.js';
import type { TurnStatus } from './session.js';

export type SettledToolActivityStatus = 'completed' | 'errored' | 'interrupted';

/**
 * A call that has not settled. `pending` is where `tool_start` opens one; it
 * only reaches `running` once output arrives, so a tool that never streams
 * stays `pending` for its whole life and both must read as in flight.
 */
export type InFlightToolActivityStatus = 'pending' | 'running';

/** The whole tool-row status vocabulary, owned here so it is spelled once. */
export type ToolActivityStatus = InFlightToolActivityStatus | SettledToolActivityStatus;

export function isInFlightToolStatus(
  status: ToolActivityStatus,
): status is InFlightToolActivityStatus {
  return status === 'pending' || status === 'running';
}

/**
 * Status for a `tool_call` with no `tool_result`. The missing result is not
 * evidence of a terminal state — it is the absence of evidence, and the turn
 * says which: while the turn is still `running` the tool is running too, and
 * only a turn that has itself ended makes the missing result mean the tool
 * never finished. Sessions written before `turn_state` fall back to
 * `inferLegacyTurnStatus`, which never returns `running`, so they keep reading
 * as `interrupted`.
 *
 * Lives beside `toolResultActivityStatus` because it is the same kind of rule —
 * evidence to status — for the case where the evidence never arrived. Both
 * materializers read it so the TUI transcript and the desktop renderer cannot
 * drift.
 */
export function unfinishedToolActivityStatus(
  turnStatus: TurnStatus | undefined,
): ToolActivityStatus {
  return turnStatus === 'running' ? 'running' : 'interrupted';
}

/** Terminal / shell_run results whose runtime status is explicit cancel. */
export function isCancelledToolResultContent(content: ToolResultContent | undefined): boolean {
  if (!content) return false;
  if (content.kind === 'terminal' || content.kind === 'shell_run') {
    return content.status === 'cancelled';
  }
  if (content.kind === 'agent_swarm') return content.status === 'cancelled';
  return false;
}

/**
 * Derive settled ToolActivityItem.status from tool_result flags + content.
 *
 * `isError` is the call-level contract: a successful observation of a
 * cancelled background task (`StopBackgroundTask` → shell_run cancelled,
 * isError:false) is `completed`, not interrupted. Only failed cancels and
 * aborted explore agents map to `interrupted`.
 */
export function toolResultActivityStatus(
  isError: boolean,
  content: ToolResultContent | undefined,
): SettledToolActivityStatus {
  if (!isError) return 'completed';
  // Failed cancel (user stop / kill) — not a tool failure banner.
  if (isCancelledToolResultContent(content)) return 'interrupted';
  if (content?.kind === 'explore_agent' && content.reason === 'aborted') {
    return 'interrupted';
  }
  return 'errored';
}
