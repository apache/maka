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

interface AppShellMessageQueueActionOptions {
  activeSessionId(): string | undefined;
  queueEntries(): readonly MessageQueueEntryProjection[];
  reportFailure(sessionId: string, error: unknown): void;
  removeTransientMessage(sessionId: string, messageId: string): void;
}

export function createAppShellMessageQueueActions(options: AppShellMessageQueueActionOptions) {
  async function run(action: (sessionId: string) => Promise<void>): Promise<string | undefined> {
    const sessionId = options.activeSessionId();
    if (!sessionId) return undefined;
    try {
      await action(sessionId);
      return sessionId;
    } catch (error) {
      if (options.activeSessionId() === sessionId) options.reportFailure(sessionId, error);
      throw error;
    }
  }

  return {
    update(entryId: string, expectedQueueRevision: number, text: string) {
      return run((sessionId) =>
        window.maka.sessions.updateQueueEntry(sessionId, entryId, expectedQueueRevision, text),
      ).then(() => undefined);
    },
    async remove(entryId: string): Promise<void> {
      const messageId = options.queueEntries().find((entry) => entry.entryId === entryId)?.messageId;
      const sessionId = await run((currentSessionId) =>
        window.maka.sessions.retractQueueEntry(currentSessionId, entryId),
      );
      if (sessionId && messageId) options.removeTransientMessage(sessionId, messageId);
    },
    promote(entryId: string) {
      return run((sessionId) => window.maka.sessions.promoteQueueEntry(sessionId, entryId))
        .then(() => undefined);
    },
    reorder(entryIds: readonly string[], expectedQueueRevision: number) {
      return run((sessionId) =>
        window.maka.sessions.reorderQueueEntries(sessionId, entryIds, expectedQueueRevision),
      ).then(() => undefined);
    },
  };
}
