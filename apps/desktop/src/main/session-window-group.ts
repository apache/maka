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

import { linkedSubagentParentSessionId, sessionRevisionFamilyId, type SessionSummary } from '@maka/core/session';
import { isSideConversationSession } from '@maka/core/side-conversation';
import { desktopSessionKey, parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import type { SessionWindowGroup } from '../shared/session-window-contract.js';

export type WindowGroupSession = Pick<SessionSummary,
  'id' | 'revisionRootSessionId' | 'subagentParent' | 'subagent' | 'parentSessionId' | 'labels'>;

/** Retain ancestry for this app lifetime so deleting a parent cannot split its open family. */
export class SessionWindowGroups {
  readonly #catalogs = new Map<string, Map<string, WindowGroupSession>>();
  readonly #groups = new Map<string, Map<string, SessionWindowGroup>>();

  has(sessionKey: string): boolean {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    return this.#catalogs.get(hostId)?.has(sessionId) ?? false;
  }

  update(hostId: string, sessions: readonly WindowGroupSession[]): void {
    let catalog = this.#catalogs.get(hostId);
    if (!catalog) this.#catalogs.set(hostId, catalog = new Map());
    for (const session of sessions) {
      const previous = catalog.get(session.id);
      if (!previous || sessionRevisionFamilyId(previous) !== sessionRevisionFamilyId(session)
        || linkedSubagentParentSessionId(previous) !== linkedSubagentParentSessionId(session)
        || previous.parentSessionId !== session.parentSessionId
        || isSideConversationSession(previous.labels) !== isSideConversationSession(session.labels)) this.#groups.delete(hostId);
      catalog.set(session.id, session);
    }
  }

  all(): SessionWindowGroup[] {
    return [...this.#catalogs.keys()].flatMap((hostId) => [...new Set(this.#forHost(hostId).values())]);
  }

  resolve(sessionKey: string, sessions: readonly WindowGroupSession[]): SessionWindowGroup {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    this.update(hostId, sessions);
    const group = this.#forHost(hostId).get(sessionId);
    if (!group) throw new Error('Session is unavailable');
    return group;
  }

  #forHost(hostId: string): Map<string, SessionWindowGroup> {
    const cached = this.#groups.get(hostId);
    if (cached) return cached;
    const catalog = this.#catalogs.get(hostId) ?? new Map<string, WindowGroupSession>();
    const familyOf = (id: string): string => {
      const session = catalog.get(id);
      return session ? sessionRevisionFamilyId(session) : id;
    };
    const parents = new Map<string, string>();
    for (const session of catalog.values()) {
      const parent = linkedSubagentParentSessionId(session)
        ?? (isSideConversationSession(session.labels) ? session.parentSessionId : undefined);
      const family = familyOf(session.id);
      if (parent && familyOf(parent) !== family) parents.set(family, familyOf(parent));
    }
    const rootOf = (id: string): string => {
      let current = familyOf(id);
      const seen: string[] = [];
      while (parents.has(current)) {
        const cycleStart = seen.indexOf(current);
        if (cycleStart >= 0) return seen.slice(cycleStart).sort()[0]!;
        seen.push(current);
        current = parents.get(current)!;
      }
      return current;
    };
    const members = new Map<string, string[]>();
    for (const id of catalog.keys()) {
      const root = rootOf(id);
      const group = members.get(root) ?? [];
      group.push(id);
      members.set(root, group);
    }
    const result = new Map<string, SessionWindowGroup>();
    for (const [root, ids] of members) {
      // A deleted parent retains its identity while the family window is open.
      if (!ids.includes(root)) ids.push(root);
      const group = { hostId, groupId: desktopSessionKey({ hostId, sessionId: root }),
        sessionIds: ids.sort().map((id) => desktopSessionKey({ hostId, sessionId: id })) };
      for (const id of ids) result.set(id, group);
    }
    this.#groups.set(hostId, result);
    return result;
  }

  forgetHost(hostId: string): void { this.#catalogs.delete(hostId); this.#groups.delete(hostId); }
}
