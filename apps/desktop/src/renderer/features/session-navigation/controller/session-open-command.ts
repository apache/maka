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

export type SessionNavigationSearchTarget = {
  sessionId: string;
  turnId: string;
  sequence?: number;
  nonce: number;
};

export interface SessionOpenCommandDeps {
  activateSession(sessionId: string): void;
  exitWorkHub(): void;
  selectSessionSurface(): void;
  setSearchTarget(target: SessionNavigationSearchTarget | null): void;
}

/**
 * Opening a Session is four intents in one order, spelled out.
 *
 * Leave the Work Hub, show the Session surface, move the selection, then aim
 * the search scroll — or clear it, when no turn was named. The rail calls this;
 * it subscribes to none of the four. Keeping the composition in one named
 * factory is what lets the order stay asserted after the controller's call site
 * moved below the shell (#4109).
 */
export function createSessionOpenCommand(deps: SessionOpenCommandDeps) {
  return (sessionId: string, turnId?: string, sequence?: number): void => {
    deps.exitWorkHub();
    deps.selectSessionSurface();
    deps.activateSession(sessionId);
    deps.setSearchTarget(
      turnId ? { sessionId, turnId, sequence, nonce: Date.now() } : null,
    );
  };
}
