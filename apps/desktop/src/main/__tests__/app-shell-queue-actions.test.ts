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
import { createAppShellQueueActions } from "../../renderer/features/conversation/index.js";

test("queue actions capture the active session and retract its transient message", async () => {
  const calls: unknown[] = [];
  const removed: unknown[] = [];
  const actions = createAppShellQueueActions({
    activeSessionId: () => "session-1",
    entries: [
      {
        entryId: "entry-1",
        messageId: "message-1",
        content: { text: "queued" },
        placement: "next_turn",
        state: "queued",
      },
    ],
    reportFailure: () => assert.fail("successful queue actions must not report a failure"),
    removeTransientMessage: (sessionId, messageId) => removed.push({ sessionId, messageId }),
    retract: async (sessionId, entryId) => {
      calls.push({ command: "retract", sessionId, entryId });
    },
    promote: async (sessionId, entryId) => {
      calls.push({ command: "promote", sessionId, entryId });
    },
    update: async (sessionId, entryId, expectedQueueRevision, text) => {
      calls.push({ command: "update", sessionId, entryId, expectedQueueRevision, text });
    },
    reorder: async (sessionId, entryIds, expectedQueueRevision) => {
      calls.push({ command: "reorder", sessionId, entryIds, expectedQueueRevision });
    },
  });

  await actions.promote("entry-1");
  await actions.update("entry-1", 4, "revised");
  await actions.reorder(["entry-2", "entry-1"], 5);
  await actions.retract("entry-1");

  assert.deepEqual(calls, [
    { command: "promote", sessionId: "session-1", entryId: "entry-1" },
    {
      command: "update",
      sessionId: "session-1",
      entryId: "entry-1",
      expectedQueueRevision: 4,
      text: "revised",
    },
    {
      command: "reorder",
      sessionId: "session-1",
      entryIds: ["entry-2", "entry-1"],
      expectedQueueRevision: 5,
    },
    { command: "retract", sessionId: "session-1", entryId: "entry-1" },
  ]);
  assert.deepEqual(removed, [{ sessionId: "session-1", messageId: "message-1" }]);
});

test("a failed action reports only while its captured session remains active", async () => {
  let activeSessionId: string | undefined = "session-1";
  const pending = deferred<void>();
  const failures: unknown[] = [];
  const actions = createAppShellQueueActions({
    activeSessionId: () => activeSessionId,
    entries: [],
    reportFailure: (sessionId, error) => failures.push({ sessionId, error }),
    removeTransientMessage: () => assert.fail("failed retract must preserve transient state"),
    retract: () => pending.promise,
    promote: async () => undefined,
    update: async () => undefined,
    reorder: async () => undefined,
  });

  const retracting = actions.retract("entry-1");
  activeSessionId = "session-2";
  const error = new Error("operation_conflict");
  pending.reject(error);
  await assert.rejects(retracting, error);
  assert.deepEqual(failures, []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}
