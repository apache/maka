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
import { RuntimeHostReconnectingIpcMain } from "../runtime-host-reconnecting-ipc-main.js";

test("holds an invocation across a Runtime Host candidate replacement", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a");
  firstTarget.handleReconnectableRead?.("sessions:list", async () => "first");
  router.activate("target-a");
  assert.equal(await ipc.invoke("sessions:list"), "first");

  firstTarget.removeHandler("sessions:list");
  const waiting = ipc.invoke("sessions:list");
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
  const draining = ipc.invoke("sessions:list");
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
  await assert.rejects(() => ipc.invoke("sessions:list"), /was interrupted/);

  router.close();
  assert.equal(ipc.size, 0);
});

test("does not return a late read from a replaced Runtime Host candidate", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  const firstTarget = router.createTarget("target-a");
  const oldRead = deferred<string>();
  firstTarget.handleReconnectableRead?.("sessions:list", () => oldRead.promise);
  router.activate("target-a");

  const reading = ipc.invoke("sessions:list");
  firstTarget.removeHandler("sessions:list");
  const replacementTarget = router.createTarget("target-a");
  replacementTarget.handleReconnectableRead?.(
    "sessions:list",
    async () => "replacement",
  );
  assert.equal(await ipc.invoke("sessions:list"), "replacement");
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

  const reading = ipc.invoke("sessions:list");
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

  await assert.rejects(() => ipc.invoke("sessions:send"), /draining/);
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
    await assert.rejects(() => ipc.invoke(channel), failure);
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

  const readingA = ipc.invoke("skills:list");
  router.deactivate("target-a");
  targetA.removeHandler("skills:list");
  targetA.removeHandler("sessions:send");
  const targetB = router.createTarget("target-b");
  targetB.handleReconnectableRead?.("skills:list", async () => "skills-b");
  targetB.handle("sessions:send", async () => "sent-b");

  await assert.rejects(() => ipc.invoke("sessions:send"), /target changed/);
  router.activate("target-b");
  oldRead.resolve("skills-a");
  await assert.rejects(() => readingA, /target changed/);
  assert.equal(await ipc.invoke("skills:list"), "skills-b");
  assert.equal(await ipc.invoke("sessions:send"), "sent-b");
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
    async invoke(channel: string): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler);
      return handler({} as never);
    },
    get size(): number {
      return handlers.size;
    },
  };
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
