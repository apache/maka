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

import type { SessionWindowCommand, SessionWindowCommandResult, SessionWindowDraft, SessionWindowGroup, SessionWindowNavigation } from '../../../../shared/session-window-contract.js';

type Pending = { id: string; group: SessionWindowGroup } & (
  | { role: 'source'; activeSessionId?: string }
  | { role: 'target'; navigation: SessionWindowNavigation }
);

/** Drafts stay in the source store until Main publishes the receiving owner. */
export function createSessionWindowCommandHandler(deps: {
  freeze(value: boolean): void;
  activeSessionId(): string | undefined;
  capture(sessionIds: readonly string[]): readonly SessionWindowDraft[];
  hasUnsent(sessionIds: readonly string[]): boolean;
  clear(sessionIds: readonly string[]): void;
  restore(drafts: readonly SessionWindowDraft[]): void;
  navigate(navigation: SessionWindowNavigation): void;
  suspend(sessionIds: readonly string[]): void;
}) {
  let pending: Pending | undefined;
  const deleted = new Set<string>();
  return {
    execute(command: SessionWindowCommand): SessionWindowCommandResult | undefined {
      switch (command.kind) {
        case 'prepare': {
          if (pending) throw new Error('A window transfer is already in progress');
          deps.freeze(true);
          try {
            const drafts = deps.capture(command.group.sessionIds);
            const activeSessionId = deps.activeSessionId();
            pending = { id: command.transferId, role: 'source', group: command.group, activeSessionId };
            deps.suspend(command.group.sessionIds);
            return { drafts, activeSessionId };
          } catch (error) { deps.freeze(false); throw error; }
        }
        case 'receive':
          if (pending) throw new Error('A window transfer is already in progress');
          deps.freeze(true);
          try {
            deps.restore(command.drafts);
            pending = { id: command.transferId, role: 'target', group: command.group, navigation: command.navigation };
          } catch (error) { deps.freeze(false); throw error; }
          return;
        case 'abort': {
          if (pending?.id !== command.transferId) return;
          const current = pending;
          pending = undefined;
          if (current.role === 'target') deps.clear(current.group.sessionIds);
          else if (current.activeSessionId && current.group.sessionIds.includes(current.activeSessionId) && !deleted.has(current.activeSessionId)) deps.navigate({ sessionId: current.activeSessionId });
          deps.freeze(false);
          return;
        }
        case 'navigate':
          if (pending) throw new Error('A window transfer is already in progress');
          if (!deleted.has(command.navigation.sessionId)) deps.navigate(command.navigation);
          return;
        case 'check-close':
          deps.freeze(true);
          return { hasUnsent: deps.hasUnsent(command.group.sessionIds) };
        case 'cancel-close':
          if (!pending) deps.freeze(false);
          return;
      }
    },
    ownershipChanged(sessionIds: ReadonlySet<string>): void {
      if (!pending) return;
      const owns = pending.group.sessionIds.every((id) => sessionIds.has(id));
      if ((pending.role === 'source' && owns) || (pending.role === 'target' && !owns)) return;
      const current = pending;
      pending = undefined;
      if (current.role === 'source') deps.clear(current.group.sessionIds);
      else if (!deleted.has(current.navigation.sessionId)) deps.navigate(current.navigation);
      deps.freeze(false);
    },
    deleted(sessionId: string): void {
      deleted.add(sessionId);
      deps.clear([sessionId]);
    },
  };
}
