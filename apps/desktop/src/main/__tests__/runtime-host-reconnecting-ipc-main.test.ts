import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain } from "electron";
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from "@maka/runtime-host/client";
import { RuntimeHostReconnectingIpcMain } from "../runtime-host-reconnecting-ipc-main.js";

test("holds an invocation across a Runtime Host candidate replacement", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  router.handleReconnectableRead("sessions:list", async () => "first");
  assert.equal(await ipc.invoke("sessions:list"), "first");

  router.removeHandler("sessions:list");
  const waiting = ipc.invoke("sessions:list");
  let settled = false;
  void waiting.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  router.handleReconnectableRead("sessions:list", async () => "replacement");
  assert.equal(await waiting, "replacement");

  router.removeHandler("sessions:list");
  const failed = deferred();
  router.handleReconnectableRead("sessions:list", async () => {
    await failed.promise;
    throw new RuntimeHostOperationError(
      "session.catalog.query",
      "host_draining",
      "Runtime Host is draining",
    );
  });
  const draining = ipc.invoke("sessions:list");
  router.removeHandler("sessions:list");
  router.handleReconnectableRead("sessions:list", async () => "after-drain");
  failed.resolve();
  assert.equal(await draining, "after-drain");

  router.removeHandler("sessions:list");
  router.handleReconnectableRead("sessions:list", async () => {
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

test("does not replay a command IPC handler after a draining rejection", async () => {
  const ipc = ipcHarness();
  const router = new RuntimeHostReconnectingIpcMain(ipc);
  let calls = 0;
  router.handle("sessions:send", async () => {
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
