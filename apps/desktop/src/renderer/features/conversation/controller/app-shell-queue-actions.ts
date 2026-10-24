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

import type { MessageQueueEntryProjection } from "@maka/core/events";

interface AppShellQueueActionPorts {
  activeSessionId(): string | undefined;
  entries: readonly MessageQueueEntryProjection[];
  reportFailure(sessionId: string, error: unknown): void;
  removeTransientMessage(sessionId: string, messageId: string): void;
  retract(sessionId: string, entryId: string): Promise<void>;
  promote(sessionId: string, entryId: string): Promise<void>;
  update(
    sessionId: string,
    entryId: string,
    expectedQueueRevision: number,
    text: string,
  ): Promise<void>;
  reorder(
    sessionId: string,
    entryIds: readonly string[],
    expectedQueueRevision: number,
  ): Promise<void>;
}

export function createAppShellQueueActions(ports: AppShellQueueActionPorts) {
  async function run(action: (sessionId: string) => Promise<void>): Promise<string | undefined> {
    const sessionId = ports.activeSessionId();
    if (!sessionId) return undefined;
    try {
      await action(sessionId);
      return sessionId;
    } catch (error) {
      if (ports.activeSessionId() === sessionId) ports.reportFailure(sessionId, error);
      throw error;
    }
  }

  return {
    update(entryId: string, expectedQueueRevision: number, text: string): Promise<void> {
      return run((sessionId) =>
        ports.update(sessionId, entryId, expectedQueueRevision, text),
      ).then(() => undefined);
    },
    async retract(entryId: string): Promise<void> {
      const messageId = ports.entries.find((entry) => entry.entryId === entryId)?.messageId;
      const sessionId = await run((activeSessionId) => ports.retract(activeSessionId, entryId));
      if (sessionId && messageId) ports.removeTransientMessage(sessionId, messageId);
    },
    promote(entryId: string): Promise<void> {
      return run((sessionId) => ports.promote(sessionId, entryId)).then(() => undefined);
    },
    reorder(entryIds: readonly string[], expectedQueueRevision: number): Promise<void> {
      return run((sessionId) =>
        ports.reorder(sessionId, entryIds, expectedQueueRevision),
      ).then(() => undefined);
    },
  };
}
