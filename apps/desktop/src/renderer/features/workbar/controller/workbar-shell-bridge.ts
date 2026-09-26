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

import type {
  WorkbarController,
  WorkbarControllerCommands,
} from './use-workbar-controller.js';
import { LiveContextUsageProbe } from '../tools/inspector/live-context-usage-probe.js';

/** The Workbar state the shell body still renders from. */
export interface WorkbarShellState {
  /** Companion Sessions the rail and palette hide (mounted side-chat forks). */
  readonly hiddenSessionIds: ReadonlySet<string>;
  readonly rightCollapsed: boolean;
  /** Whether the Workbar is available with a Session to show; WorkHub's
   * navigation waits for it before opening a tool. */
  readonly ready: boolean;
}

const EMPTY_STATE: WorkbarShellState = {
  hiddenSessionIds: new Set(),
  rightCollapsed: true,
  ready: false,
};

function readonlyStringSetEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size === right.size) {
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }
  return false;
}

function shellStateEqual(left: WorkbarShellState, right: WorkbarShellState): boolean {
  return left.rightCollapsed === right.rightCollapsed &&
    left.ready === right.ready &&
    readonlyStringSetEqual(left.hiddenSessionIds, right.hiddenSessionIds);
}

const ignoreResolvedSession = (): void => undefined;

/**
 * Per-shell command port and read store; the provider alone owns the
 * controller. Commands are stable delegates, so publishing a new controller
 * never re-renders the shell. The shell's read is the small state above, and
 * it is replaced only when one of its values actually changes: tab switches,
 * resize drags and panel topology stay inside the provider.
 */
export function createWorkbarShellBridge() {
  let controller: WorkbarController | undefined;
  let state = EMPTY_STATE;
  const listeners = new Set<() => void>();
  const publishState = (next: WorkbarShellState) => {
    if (shellStateEqual(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const commands: WorkbarControllerCommands = {
    openTool: (...args) => controller?.commands.openTool(...args),
    openSideChatWithQuote: (quote) => controller?.commands.openSideChatWithQuote(quote),
    respondToClientCapability: (response) =>
      controller?.commands.respondToClientCapability(response) ?? Promise.resolve(),
    respondToUserForm: (sessionId, response) =>
      controller?.commands.respondToUserForm(sessionId, response) ?? Promise.resolve(),
    toggleRight: () => controller?.commands.toggleRight(),
    toggleTool: (kind) => controller?.commands.toggleTool(kind),
    setWorkbarCollapsed: (collapsed) => controller?.commands.setWorkbarCollapsed(collapsed),
    bindNewTaskSessionResolver: (surfaceOwnerToken) =>
      controller?.commands.bindNewTaskSessionResolver(surfaceOwnerToken) ?? ignoreResolvedSession,
  };
  return {
    commands,
    /** Forwarded so the shell gains no import edge to the inspector (#4717). */
    LiveContextUsageProbe,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: WorkbarController) {
      controller = next;
      publishState({
        hiddenSessionIds: next.selectors.hiddenSessionIds,
        rightCollapsed: next.selectors.rightCollapsed,
        ready: Boolean(next.host.activeId),
      });
    },
    disconnect() {
      controller = undefined;
      publishState(EMPTY_STATE);
    },
  };
}

export type WorkbarShellBridge = ReturnType<typeof createWorkbarShellBridge>;
