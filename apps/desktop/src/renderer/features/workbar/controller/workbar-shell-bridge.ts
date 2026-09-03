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
  WorkbarControllerCommands,
  WorkbarControllerSelectors,
} from './use-workbar-controller.js';

const EMPTY_HIDDEN_SESSION_IDS: ReadonlySet<string> = new Set();

function readonlyStringSetEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export interface WorkbarShellBridgePublication {
  readonly commands: WorkbarControllerCommands;
  readonly selectors: WorkbarControllerSelectors;
}

/**
 * The deliberately small seam between the Workbar owner and AppShell.
 *
 * Commands are stable imperative delegates: publishing a new controller does
 * not re-render the shell. Hidden companion Sessions are the one reactive
 * value another feature genuinely reads, so they use an external-store
 * projection that Session Navigation can equality-select at its own boundary.
 */
export function createWorkbarShellBridge() {
  let hiddenSessionIds: ReadonlySet<string> = EMPTY_HIDDEN_SESSION_IDS;
  const hiddenSessionIdListeners = new Set<() => void>();
  let publication: WorkbarShellBridgePublication | null = null;

  const replaceHiddenSessionIds = (next: ReadonlySet<string>): void => {
    if (readonlyStringSetEqual(hiddenSessionIds, next)) return;
    hiddenSessionIds = next;
    for (const listener of [...hiddenSessionIdListeners]) listener();
  };

  const commands: WorkbarControllerCommands = {
    openTool: (...args) => publication?.commands.openTool(...args),
    openSideChatWithQuote: (...args) =>
      publication?.commands.openSideChatWithQuote(...args),
    respondToClientCapability: (...args) =>
      publication?.commands.respondToClientCapability(...args) ??
      Promise.resolve(),
    toggleRight: () => publication?.commands.toggleRight(),
  };

  return {
    commands,
    hiddenSessionIds: {
      getState: () => hiddenSessionIds,
      subscribe(listener: () => void): () => void {
        hiddenSessionIdListeners.add(listener);
        return () => hiddenSessionIdListeners.delete(listener);
      },
    },
    getRightCollapsed: (): boolean =>
      publication?.selectors.rightCollapsed ?? true,
    publish(next: WorkbarShellBridgePublication): void {
      publication = next;
      replaceHiddenSessionIds(next.selectors.hiddenSessionIds);
    },
    disconnect(): void {
      publication = null;
      replaceHiddenSessionIds(EMPTY_HIDDEN_SESSION_IDS);
    },
  };
}

export type WorkbarShellBridge = ReturnType<typeof createWorkbarShellBridge>;
