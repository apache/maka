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
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from "@maka/runtime-host/client";
import {
  readWithFallback,
  tryReconnectableReadResult,
} from "../ipc-reconnect-policy.js";
import * as ipcReconnectPolicy from "../ipc-reconnect-policy.js";
import {
  RuntimeHostHandlerUnavailableError,
  RuntimeHostReconnectingIpcMain,
  RuntimeHostTargetChangedError,
} from "../runtime-host-reconnecting-ipc-main.js";

test("classifies only dispatched control connection loss for reconciliation", () => {
  const predicate = (
    ipcReconnectPolicy as typeof ipcReconnectPolicy & {
      isDispatchedControlConnectionLoss?: (error: unknown) => boolean;
    }
  ).isDispatchedControlConnectionLoss;
  assert.equal(typeof predicate, "function");
  assert.equal(
    predicate?.(
      new RuntimeHostRequestInterruptedError(
        "goal.arm",
        "control",
        "dispatched",
        "connection_lost",
      ),
    ),
    true,
  );
  for (const error of [
    new RuntimeHostRequestInterruptedError(
      "goal.arm",
      "control",
      "not_dispatched",
      "connection_lost",
    ),
    new RuntimeHostRequestInterruptedError(
      "goal.arm",
      "control",
      "dispatched",
      "timeout",
    ),
    new RuntimeHostRequestInterruptedError(
      "goal.query",
      "query",
      "dispatched",
      "connection_lost",
    ),
    new RuntimeHostRequestInterruptedError(
      "web-search.execute",
      "command",
      "dispatched",
      "connection_lost",
    ),
    new Error("ordinary failure"),
  ]) {
    assert.equal(predicate?.(error), false);
  }
});

test("reconciles a dispatched control on a replacement without replaying it", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a") as ReconciledControlTarget;
  assert.equal(typeof firstTarget.handleReconciledControl, "function");
  let dispatches = 0;
  firstTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => {
      dispatches += 1;
      return {
        kind: "reconcile",
        context: { condition: "All tests pass" },
      };
    },
    reconcile: async () => assert.fail("The closed candidate must not reconcile"),
  });
  router.activate("target-a");

  const arming = ipc.invoke("goal:arm", scope("target-a"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstTarget.removeHandler("goal:arm");
  const replacementTarget = router.createTarget("target-a") as ReconciledControlTarget;
  let reconciliations = 0;
  replacementTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => assert.fail("The mutation must not be replayed"),
    reconcile: async (context) => {
      reconciliations += 1;
      assert.deepEqual(context, { condition: "All tests pass" });
      return { kind: "reconciled", currentGoal: "goal-1" };
    },
  });

  assert.deepEqual(await arming, {
    kind: "reconciled",
    currentGoal: "goal-1",
  });
  assert.equal(dispatches, 1);
  assert.equal(reconciliations, 1);
  router.close();
});

test("bounds reconciliation when no replacement candidate becomes available", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc, {
    replacementWaitTimeoutMs: 5,
  });
  const firstTarget = router.createTarget("target-a") as ReconciledControlTarget;
  let dispatches = 0;
  firstTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => {
      dispatches += 1;
      return { kind: "reconcile", context: { sessionId: "session-1" } };
    },
    reconcile: async () => assert.fail("The unavailable candidate must not reconcile"),
    reconciliationUnavailable: async () => ({ kind: "reconciliation_unavailable" }),
  });
  router.activate("target-a");

  const arming = ipc.invoke("goal:arm", scope("target-a"));
  const settled = arming.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstTarget.removeHandler("goal:arm");

  try {
    assert.deepEqual(
      await Promise.race([
        settled,
        new Promise<{ readonly timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 25),
        ),
      ]),
      {
        ok: true,
        value: { kind: "reconciliation_unavailable" },
      },
    );
    assert.equal(dispatches, 1);
  } finally {
    router.close();
    await settled;
  }
});

test("retries only reconciliation when its replacement connection is lost", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a") as ReconciledControlTarget;
  let dispatches = 0;
  firstTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => {
      dispatches += 1;
      return { kind: "reconcile", context: { sessionId: "session-1" } };
    },
    reconcile: async () => assert.fail("The closed candidate must not reconcile"),
  });
  router.activate("target-a");

  const arming = ipc.invoke("goal:arm", scope("target-a"));
  const settled = arming.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstTarget.removeHandler("goal:arm");
  const failedTarget = router.createTarget("target-a") as ReconciledControlTarget;
  const reconciliationEntered = deferred();
  const failReconciliation = deferred();
  failedTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => assert.fail("The mutation must not be replayed"),
    reconcile: async () => {
      reconciliationEntered.resolve();
      await failReconciliation.promise;
      throw new RuntimeHostRequestInterruptedError(
        "goal.query",
        "query",
        "dispatched",
        "connection_lost",
      );
    },
  });
  await reconciliationEntered.promise;
  failReconciliation.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  failedTarget.removeHandler("goal:arm");
  const recoveredTarget = router.createTarget("target-a") as ReconciledControlTarget;
  let reconciliations = 0;
  recoveredTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => assert.fail("The mutation must not be replayed"),
    reconcile: async (context) => {
      reconciliations += 1;
      assert.deepEqual(context, { sessionId: "session-1" });
      return { kind: "reconciled", currentGoal: "goal-1" };
    },
  });

  assert.deepEqual(await settled, {
    ok: true,
    value: { kind: "reconciled", currentGoal: "goal-1" },
  });
  assert.equal(dispatches, 1);
  assert.equal(reconciliations, 1);
  router.close();
});

test("never reconciles a control through a different target epoch", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a") as ReconciledControlTarget;
  let dispatches = 0;
  firstTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => {
      dispatches += 1;
      return { kind: "reconcile", context: { sessionId: "session-1" } };
    },
    reconcile: async () => assert.fail("The closed candidate must not reconcile"),
  });
  router.activate("target-a");

  const arming = ipc.invoke("goal:arm", scope("target-a"));
  const settled = arming.then(
    () => ({ settled: true }),
    (error: unknown) => ({ settled: true, error }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstTarget.removeHandler("goal:arm");
  const otherTarget = router.createTarget("target-b") as ReconciledControlTarget;
  let otherReconciliations = 0;
  otherTarget.handleReconciledControl("goal:arm", {
    dispatch: async () => assert.fail("The mutation must not be replayed"),
    reconcile: async () => {
      otherReconciliations += 1;
      return { kind: "reconciled" };
    },
  });
  router.activate("target-b");
  const pending = Promise.race([
    settled,
    new Promise<{ settled: false }>((resolve) =>
      setImmediate(() => resolve({ settled: false })),
    ),
  ]);
  assert.deepEqual(await pending, { settled: false });

  router.deactivate("target-a");
  const result = await settled;
  assert.equal(result.settled, true);
  assert.ok(
    "error" in result && result.error instanceof RuntimeHostTargetChangedError,
  );
  assert.equal(dispatches, 1);
  assert.equal(otherReconciliations, 0);
  router.close();
});

test("holds an invocation across a Runtime Host candidate replacement", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a");
  firstTarget.handleReconnectableRead?.("sessions:list", async () => "first");
  router.activate("target-a");
  assert.equal(await ipc.invoke("sessions:list", scope("target-a")), "first");

  firstTarget.removeHandler("sessions:list");
  const waiting = ipc.invoke("sessions:list", scope("target-a"));
  let settled = false;
  void waiting.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  const replacementTarget = router.createTarget("target-a");
  replacementTarget.handleReconnectableRead?.("sessions:list", async () => "replacement");
  assert.equal(await waiting, "replacement");

  replacementTarget.removeHandler("sessions:list");
  const failed = deferred();
  const drainingTarget = router.createTarget("target-a");
  drainingTarget.handleReconnectableRead?.("sessions:list", async () => {
    await failed.promise;
    throw new RuntimeHostOperationError(
      "session.catalog.query",
      "host_draining",
      "Runtime Host is draining",
    );
  });
  const draining = ipc.invoke("sessions:list", scope("target-a"));
  drainingTarget.removeHandler("sessions:list");
  const afterDrainTarget = router.createTarget("target-a");
  afterDrainTarget.handleReconnectableRead?.("sessions:list", async () => "after-drain");
  failed.resolve();
  assert.equal(await draining, "after-drain");

  afterDrainTarget.removeHandler("sessions:list");
  const timedOutTarget = router.createTarget("target-a");
  timedOutTarget.handleReconnectableRead?.("sessions:list", async () => {
    throw new RuntimeHostRequestInterruptedError(
      "session.catalog.query",
      "query",
      "dispatched",
      "timeout",
    );
  });
  await assert.rejects(
    () => ipc.invoke("sessions:list", scope("target-a")),
    /was interrupted/,
  );

  router.close();
  assert.equal(ipc.size, 0);
});

test("bounds an invocation while an active Runtime Host has no handler", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc, {
    replacementWaitTimeoutMs: 5,
  });
  const target = router.createTarget("target-a");
  target.handle("sessions:send", async () => "sent");
  router.activate("target-a");
  target.removeHandler("sessions:send");

  await assert.rejects(
    () => ipc.invoke("sessions:send", scope("target-a")),
    RuntimeHostHandlerUnavailableError,
  );
  target.handle("sessions:send", async () => "retried");
  assert.equal(await ipc.invoke("sessions:send", scope("target-a")), "retried");
  router.close();
});

test("bounds reconnectable reads when no replacement handler becomes available", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc, {
    replacementWaitTimeoutMs: 5,
  });
  const target = router.createTarget("target-a");
  const failRead = deferred();
  target.handleReconnectableRead?.("taskReadiness:getSnapshot", async () => {
    await failRead.promise;
    throw new RuntimeHostOperationError(
      "session.catalog.query",
      "host_draining",
      "Runtime Host is draining",
    );
  });
  router.activate("target-a");

  const reading = ipc.invoke("taskReadiness:getSnapshot", scope("target-a"));
  target.removeHandler("taskReadiness:getSnapshot");
  failRead.resolve();

  await assert.rejects(
    () => reading,
    RuntimeHostHandlerUnavailableError,
  );
  router.close();
});

test("settles concurrent invocations after one bounded replacement window", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc, {
    replacementWaitTimeoutMs: 5,
  });
  const target = router.createTarget("target-a");
  target.handleReconnectableRead?.("projects:getSnapshot", async () => ({ projects: [] }));
  router.activate("target-a");
  target.removeHandler("projects:getSnapshot");

  const reads = Array.from({ length: 200 }, (_, index) =>
    ipc.invoke("projects:getSnapshot", scope("target-a"), { index }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );
  const settled = Promise.all(reads);
  try {
    const result = await Promise.race([
      settled,
      new Promise<{ readonly timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 100),
      ),
    ]);
    assert.ok(Array.isArray(result), "Runtime Host invocations did not settle");
    assert.equal(result.length, 200);
    for (const read of result) {
      assert.equal(read.ok, false);
      if (!read.ok) assert.ok(read.error instanceof RuntimeHostHandlerUnavailableError);
    }
  } finally {
    router.close();
    await settled;
  }
});

test("does not reset one reconnectable read deadline across failed replacements", async (t) => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc, {
    replacementWaitTimeoutMs: 15,
  });
  let monotonicNow = 0;
  t.mock.method(performance, "now", () => monotonicNow);
  router.activate("target-a");
  let attempts = 0;
  const maximumAttempts = 20;
  const installFailingTarget = (): void => {
    const target = router.createTarget("target-a");
    target.handleReconnectableRead?.("projects:getSnapshot", async () => {
      attempts += 1;
      monotonicNow += 5;
      target.removeHandler("projects:getSnapshot");
      if (attempts < maximumAttempts) installFailingTarget();
      throw new RuntimeHostOperationError(
        "project.catalog.query",
        "host_draining",
        "Runtime Host is draining",
      );
    });
  };
  installFailingTarget();

  try {
    await assert.rejects(
      () => ipc.invoke("projects:getSnapshot", scope("target-a")),
      RuntimeHostHandlerUnavailableError,
    );
    assert.equal(attempts, 4);
  } finally {
    router.close();
  }
});

test("does not return a late read from a replaced Runtime Host candidate", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a");
  const oldRead = deferred<string>();
  firstTarget.handleReconnectableRead?.("sessions:list", () => oldRead.promise);
  router.activate("target-a");

  const reading = ipc.invoke("sessions:list", scope("target-a"));
  firstTarget.removeHandler("sessions:list");
  const replacementTarget = router.createTarget("target-a");
  replacementTarget.handleReconnectableRead?.(
    "sessions:list",
    async () => "replacement",
  );
  assert.equal(
    await ipc.invoke("sessions:list", scope("target-a")),
    "replacement",
  );
  oldRead.resolve("stale");

  assert.equal(await reading, "replacement");
  router.close();
});

test("does not return a late failure from a replaced Runtime Host candidate", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a");
  const oldRead = deferred<string>();
  firstTarget.handleReconnectableRead?.("sessions:list", () => oldRead.promise);
  router.activate("target-a");

  const reading = ipc.invoke("sessions:list", scope("target-a"));
  firstTarget.removeHandler("sessions:list");
  const replacementTarget = router.createTarget("target-a");
  replacementTarget.handleReconnectableRead?.(
    "sessions:list",
    async () => "replacement",
  );
  oldRead.reject(new Error("stale ordinary failure"));

  assert.equal(await reading, "replacement");
  router.close();
});

test("does not replay a command IPC handler after a draining rejection", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const target = router.createTarget("target-a");
  router.activate("target-a");
  let calls = 0;
  target.handle("sessions:send", async () => {
    calls += 1;
    throw new RuntimeHostOperationError(
      "turn.start",
      "host_draining",
      "Runtime Host is draining",
    );
  });

  await assert.rejects(
    () => ipc.invoke("sessions:send", scope("target-a")),
    /draining/,
  );
  assert.equal(calls, 1);
  router.close();
});

test("does not replay Host commands through a read-marked IPC boundary", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const target = router.createTarget("target-a");
  router.activate("target-a");
  const failures = [
    new RuntimeHostRequestInterruptedError(
      "turn.start",
      "command",
      "dispatched",
      "connection_lost",
    ),
    new RuntimeHostOperationError(
      "turn.start",
      "host_draining",
      "Runtime Host is draining",
    ),
  ];
  for (const [index, failure] of failures.entries()) {
    const channel = `mixed:handler:${index}`;
    target.handleReconnectableRead?.(channel, async () => {
      throw failure;
    });
    await assert.rejects(() => ipc.invoke(channel, scope("target-a")), failure);
  }
  router.close();
});

test("never dispatches or completes an invocation across target epochs", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const targetA = router.createTarget("target-a");
  const oldRead = deferred<string>();
  targetA.handleReconnectableRead?.("skills:list", async () => oldRead.promise);
  targetA.handle("sessions:send", async () => "sent-a");
  router.activate("target-a");

  const readingA = ipc.invoke("skills:list", scope("target-a"));
  router.deactivate("target-a");
  targetA.removeHandler("skills:list");
  targetA.removeHandler("sessions:send");
  const targetB = router.createTarget("target-b");
  targetB.handleReconnectableRead?.("skills:list", async () => "skills-b");
  targetB.handle("sessions:send", async () => "sent-b");

  await assert.rejects(
    () => ipc.invoke("sessions:send", scope("target-a")),
    /target changed/,
  );
  router.activate("target-b");
  oldRead.resolve("skills-a");
  await assert.rejects(() => readingA, /target changed/);
  assert.equal(await ipc.invoke("skills:list", scope("target-b")), "skills-b");
  assert.equal(await ipc.invoke("sessions:send", scope("target-b")), "sent-b");
  router.close();
});

test("routes concurrent Runtime Host targets by explicit scope", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const targetA = router.createTarget("target-a");
  const targetB = router.createTarget("target-b");
  targetA.handleReconnectableRead?.("sessions:list", async () => "sessions-a");
  targetB.handleReconnectableRead?.("sessions:list", async () => "sessions-b");
  router.activate("target-a");
  router.activate("target-b");

  assert.equal(await ipc.invoke("sessions:list", scope("target-a")), "sessions-a");
  assert.equal(await ipc.invoke("sessions:list", scope("target-b")), "sessions-b");

  router.deactivate("target-a");
  await assert.rejects(
    () => ipc.invoke("sessions:list", scope("target-a")),
    /target changed/,
  );
  assert.equal(await ipc.invoke("sessions:list", scope("target-b")), "sessions-b");
  router.close();
});

test("read adapters project ordinary failures without hiding reconnectable failures", async () => {
  assert.equal(
    await readWithFallback(async () => {
      throw new Error("credential unavailable");
    }, false),
    false,
  );
  const result = await tryReconnectableReadResult(async () => {
    throw new Error("trace unavailable");
  }, "TRACE_FAILED");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "TRACE_FAILED");
    assert.equal(result.error.message, "trace unavailable");
    assert.ok(result.error.details instanceof Error);
  }

  const failure = new RuntimeHostOperationError(
    "session.transcript.page",
    "host_draining",
    "Runtime Host is draining",
  );
  await assert.rejects(
    () =>
      readWithFallback(async () => {
        throw failure;
      }, null),
    failure,
  );
  await assert.rejects(
    () =>
      tryReconnectableReadResult(async () => {
        throw failure;
      }, "TRACE_FAILED"),
    failure,
  );
});

type IpcHandler = Parameters<IpcMain["handle"]>[1];

type ReconciledControlTarget = ReturnType<
  RuntimeHostReconnectingIpcMain["createTarget"]
> & {
  handleReconciledControl(
    channel: string,
    handlers: {
      dispatch: IpcHandler;
      reconcile: (context: unknown, ...args: Parameters<IpcHandler>) => Promise<unknown>;
      reconciliationUnavailable?: (
        context: unknown,
        ...args: Parameters<IpcHandler>
      ) => Promise<unknown>;
    },
  ): void;
};

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handle(channel: string, handler: IpcHandler): void {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler);
      return handler({} as never, ...args);
    },
    get size(): number {
      return handlers.size;
    },
  };
}

function scope(targetEpoch: string) {
  return { hostId: `host-${targetEpoch}`, targetEpoch };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}
