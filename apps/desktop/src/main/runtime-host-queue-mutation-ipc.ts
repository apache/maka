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

import type { ReconnectableReadIpcMain } from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

export type RuntimeHostQueueMutationClient = Pick<
  DesktopRuntimeHostClient,
  | "promoteQueueEntry"
  | "reorderQueueEntries"
  | "retractQueueEntry"
  | "updateQueueEntry"
>;

export function registerRuntimeHostQueueMutationIpc(
  ipcMain: ReconnectableReadIpcMain,
  client: RuntimeHostQueueMutationClient,
  newId: () => string,
): void {
  ipcMain.handle(
    "sessions:retractQueueEntry",
    async (_event, sessionId: string, entryId: unknown) => {
      await client.retractQueueEntry({
        sessionId,
        entryId: queueEntryId(entryId),
        retractId: newId(),
      });
    },
  );
  ipcMain.handle(
    "sessions:promoteQueueEntry",
    async (_event, sessionId: string, entryId: unknown) => {
      await client.promoteQueueEntry({
        sessionId,
        entryId: queueEntryId(entryId),
        promoteId: newId(),
      });
    },
  );
  ipcMain.handle(
    "sessions:updateQueueEntry",
    async (
      _event,
      sessionId: unknown,
      entryId: unknown,
      expectedQueueRevision: unknown,
      text: unknown,
    ) => {
      await client.updateQueueEntry({
        sessionId: requiredId(sessionId, "Session"),
        entryId: requiredId(entryId, "Queue entry"),
        updateId: newId(),
        expectedQueueRevision: queueRevision(expectedQueueRevision),
        text: queuedMessageText(text),
      });
    },
  );
  ipcMain.handle(
    "sessions:reorderQueueEntries",
    async (
      _event,
      sessionId: string,
      entryIds: unknown,
      expectedQueueRevision: unknown,
    ) => {
      await client.reorderQueueEntries({
        sessionId,
        reorderId: newId(),
        expectedQueueRevision: queueRevision(expectedQueueRevision),
        entryIds: queueEntryOrder(entryIds),
      });
    },
  );
}

function queueEntryId(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Invalid queue entry identity");
  }
  return value;
}

function queueEntryOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entryId) => typeof entryId !== "string")) {
    throw new TypeError("Invalid queue entry order");
  }
  return value;
}

function queuedMessageText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 48 * 1024
  ) {
    throw new Error("Invalid Queued message text");
  }
  return value.trim();
}

function queueRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Invalid Queue sequence");
  }
  return value as number;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`Invalid ${label} identity`);
  }
  return value;
}
