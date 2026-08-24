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

export interface BootstrapSelectionLease<Summary extends { id: string; lastMessageAt?: number }> {
  reconcile(sessions: readonly Summary[]): boolean;
  release(): void;
}

export function createBootstrapSelectionLease<Summary extends { id: string; lastMessageAt?: number }>(options: {
  readActiveId: () => string | undefined;
  readSelectionRevision: () => number;
  select: (sessionId: string | undefined) => void;
}): BootstrapSelectionLease<Summary> {
  let ownedRevision = options.readSelectionRevision();
  let active = true;

  return {
    reconcile(sessions): boolean {
      if (!active || options.readSelectionRevision() !== ownedRevision) {
        active = false;
        return false;
      }

      const current = options.readActiveId();
      const next = current && sessions.some((session) => session.id === current)
        ? current
        : sessions[0]?.lastMessageAt
          ? sessions[0].id
          : undefined;
      if (next !== current) options.select(next);
      ownedRevision = options.readSelectionRevision();
      return true;
    },
    release(): void {
      active = false;
    },
  };
}
