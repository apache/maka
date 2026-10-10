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

import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain } from "electron";
import type { DesktopRuntimeHostClient } from "../runtime-host-client.js";
import { registerRuntimeHostQueueMutationIpc } from "../runtime-host-queue-mutation-ipc.js";

type QueueMutationClient = Pick<
  DesktopRuntimeHostClient,
  | "promoteQueueEntry"
  | "reorderQueueEntries"
  | "retractQueueEntry"
  | "updateQueueEntry"
>;
type Handler = Parameters<Pick<IpcMain, "handle">["handle"]>[1];

test("routes queue mutations with fresh operation identities", async () => {
  const calls: unknown[] = [];
  const ipc = ipcHarness();
  let sequence = 0;
  registerRuntimeHostQueueMutationIpc(
    ipc,
    queueClient((operation, input) => calls.push({ operation, ...input })),
    () => `operation-${++sequence}`,
  );

  await ipc.invoke("sessions:retractQueueEntry", "session-1", "entry-1");
  await ipc.invoke("sessions:promoteQueueEntry", "session-1", "entry-2");
  await ipc.invoke("sessions:updateQueueEntry", "session-1", "entry-2", 4, " revised ");
  await ipc.invoke("sessions:reorderQueueEntries", "session-1", ["entry-3", "entry-2"], 5);

  assert.deepEqual(calls, [
    {
      operation: "retract",
      sessionId: "session-1",
      entryId: "entry-1",
      retractId: "operation-1",
    },
    {
      operation: "promote",
      sessionId: "session-1",
      entryId: "entry-2",
      promoteId: "operation-2",
    },
    {
      operation: "update",
      sessionId: "session-1",
      entryId: "entry-2",
      updateId: "operation-3",
      expectedQueueRevision: 4,
      text: "revised",
    },
    {
      operation: "reorder",
      sessionId: "session-1",
      reorderId: "operation-4",
      expectedQueueRevision: 5,
      entryIds: ["entry-3", "entry-2"],
    },
  ]);
});

test("rejects malformed queue mutation arguments before dispatch", async () => {
  const calls: unknown[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostQueueMutationIpc(
    ipc,
    queueClient((operation, input) => calls.push({ operation, ...input })),
    () => "operation-1",
  );

  const invalidCalls: ReadonlyArray<readonly [string, readonly unknown[], RegExp]> = [
    ["sessions:updateQueueEntry", ["session-1", "entry-1", 4, " "], /Queued message text/],
    ["sessions:promoteQueueEntry", ["session-1", 42], /queue entry identity/],
    ["sessions:reorderQueueEntries", ["session-1", ["entry-1", 42], 1], /queue entry order/],
    ["sessions:reorderQueueEntries", ["session-1", ["entry-1"], -1], /Queue sequence/],
  ];
  for (const [channel, args, error] of invalidCalls) {
    await assert.rejects(ipc.invoke(channel, ...args), error);
  }
  assert.deepEqual(calls, []);
});

function queueClient(
  record: (operation: string, input: Record<string, unknown>) => void,
): QueueMutationClient {
  return {
    async retractQueueEntry(input) {
      record("retract", input);
      return { queueRevision: 1 };
    },
    async promoteQueueEntry(input) {
      record("promote", input);
      return { queueRevision: 1 };
    },
    async updateQueueEntry(input) {
      record("update", input);
      return { queueRevision: 1 };
    },
    async reorderQueueEntries(input) {
      record("reorder", input);
      return { queueRevision: 1 };
    },
  };
}

function ipcHarness() {
  const handlers = new Map<string, Handler>();
  return {
    handle(channel: string, handler: Handler): void {
      handlers.set(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `Missing IPC handler for ${channel}`);
      return handler({} as Electron.IpcMainInvokeEvent, ...args);
    },
  };
}
