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
import { test } from "node:test";
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import {
  clearPrivateTerminalSurfaces,
  hasPrivateTerminalSurface,
} from "../private-terminal-surfaces.js";
import { registerRuntimeHostShellRunsIpc } from "../runtime-host-shell-runs-ipc-main.js";

const identity = {
  action: "ready" as const,
  sessionId: "session-1",
  requestId: "request-1",
  controllerId: "controller-1",
};

function harness(controlTerminalHandoff: (input: unknown) => Promise<unknown>) {
  const handlers = new Map<string, IpcHandler>();
  const registration = registerRuntimeHostShellRunsIpc(
    {
      client: { controlTerminalHandoff } as never,
      terminalCloses: {} as never,
      sessionObserver: {
        async observe() {},
        async unobserve() {},
      },
    },
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
  );
  const handler = handlers.get("shell-runs:handoff");
  assert.ok(handler);
  const sender = {
    id: 5309,
    once() {},
    on() {},
  };
  return {
    invoke: (input: unknown) => handler({ sender } as never, input),
    close: () => registration.close(),
  };
}

test("ready rolls back the private-surface fence when Host admission fails", async () => {
  clearPrivateTerminalSurfaces(5309);
  const fixture = harness(async () => {
    throw new Error("controller conflict");
  });
  try {
    await assert.rejects(fixture.invoke(identity), /controller conflict/);
    assert.equal(hasPrivateTerminalSurface(), false);
  } finally {
    await fixture.close();
    clearPrivateTerminalSurfaces(5309);
  }
});

test("ready retains the fence for human and resumed private displays", async () => {
  clearPrivateTerminalSurfaces(5309);
  const replies = [
    { status: "closed", phase: "closed", nextSequence: 1, closure: "exited" },
    { status: "ready", phase: "human", nextSequence: 1 },
    { status: "observed", phase: "human", nextSequence: 1 },
    { status: "ready", phase: "resumed", nextSequence: 1 },
    { status: "observed", phase: "resumed", nextSequence: 1 },
  ];
  const fixture = harness(async () => replies.shift());
  try {
    await fixture.invoke(identity);
    assert.equal(hasPrivateTerminalSurface(), false);
    await fixture.invoke(identity);
    assert.equal(hasPrivateTerminalSurface(), true);
    await fixture.invoke({ ...identity, action: "release" });
    assert.equal(hasPrivateTerminalSurface(), false);
    await fixture.invoke(identity);
    assert.equal(hasPrivateTerminalSurface(), true);
    await fixture.invoke({ ...identity, action: "release" });
    assert.equal(hasPrivateTerminalSurface(), false);
  } finally {
    await fixture.close();
    clearPrivateTerminalSurfaces(5309);
  }
});
