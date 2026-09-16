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
import type { IpcMain, WebContents } from "electron";
import { createDefaultSettings } from "@maka/core/settings";
import { WORKHUB_COORDINATION_SESSION_ID } from "@maka/core/session";
import { createWorkHubControl } from "../workhub-control.js";
import { WorkHubSurface } from "../workhub-surface.js";
import { WorkHubUi } from "../workhub-ui.js";
import type { DesktopRuntimeHostClient } from "../runtime-host-client.js";
import { desktopSessionResourceKey } from "../../shared/runtime-host-identity.js";
import type { MakaTool } from "@maka/runtime/tool-runtime";

const scope = { hostId: "host", targetEpoch: "epoch" };
function harness(prepareWindow: () => Promise<void> = async () => {}) {
  let command!: Parameters<IpcMain["handle"]>[1];
  let current = true;
  let activeTurn = "turn";
  const interrupted: string[] = [];
  const window = {
    mainFrame: {},
    isDestroyed: () => false,
    send() {},
  } as unknown as WebContents;
  const control = createWorkHubControl({
    ipcMain: {
      handle: (_name, handler) => {
        command = handler;
      },
      removeHandler() {},
    },
    window: () => window,
    prepareWindow,
    authorizedRenderer: (contents) => contents === window,
    send() {},
    readSettings: async () => createDefaultSettings(),
    client: () => ({}) as DesktopRuntimeHostClient,
    isCurrent: () => current,
    assertTurn: async (_scope, turnId) => {
      if (turnId !== activeTurn) throw new Error("Inactive turn");
    },
    interrupt: async (_scope, turnId) => {
      interrupted.push(turnId);
    },
    actTasks: async (_scope, turnId, callId, input) => ({
      turnId,
      callId,
      input,
    }),
  });
  const tool = control.group(scope).tools[0] as MakaTool;
  const ctx = (turnId = activeTurn) => ({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId,
    toolCallId: "call",
    cwd: "/tmp",
    abortSignal: new AbortController().signal,
    emitOutput() {},
  });
  return {
    control,
    tool,
    ctx,
    interrupted,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setTurn: (value: string) => {
      activeTurn = value;
    },
    command: (name: string) =>
      command(
        {
          sender: window,
          senderFrame: window.mainFrame,
        } as Electron.IpcMainInvokeEvent,
        name,
      ),
  };
}

test("control rejects ordinary Sessions, stale turns and switched Host epochs before observation", async (t) => {
  const h = harness();
  t.after(() => h.control.close());
  t.mock.method(WorkHubUi.prototype, "observe", async () => {
    throw new Error("Must not observe");
  });
  await assert.rejects(
    async () =>
      h.tool.impl(
        { status: "Checking Maka", request: { operation: "observe" } },
        { ...h.ctx(), sessionId: "ordinary" },
      ),
    /Only the active WorkHub/,
  );
  await assert.rejects(
    async () => h.tool.impl({ status: "Checking Maka", request: { operation: "observe" } }, h.ctx("stale")),
    /Inactive turn/,
  );
  h.setCurrent(false);
  await assert.rejects(
    async () => h.tool.impl({ status: "Checking Maka", request: { operation: "observe" } }, h.ctx()),
    /Host changed/,
  );
});

test("partial batches never replay input and the failure budget belongs to the real turn", async (t) => {
  const h = harness();
  t.after(() => h.control.close());
  t.mock.method(WorkHubUi.prototype, "observe", async () => ({
    section: null,
    language: "en",
    theme: "light",
    accessibility: "",
    controls: [],
  }));
  t.mock.method(WorkHubUi.prototype, "begin", async () => {});
  let attempts = 0;
  let failAfterInput = false;
  t.mock.method(
    WorkHubUi.prototype,
    "execute",
    async function (this: WorkHubUi) {
      attempts++;
      if (attempts === 1) return { verified: false, dispatched: true };
      if (failAfterInput) this.dispatchedInputs++;
      throw new Error("Control changed");
    },
  );
  const act = async (refs = ["current"]) =>
    (await h.tool.impl(
      {
        status: "Checking Maka", request: {
          operation: "act",
          actions: refs.map((ref) => ({ kind: "click", ref })),
        },
      },
      h.ctx(),
    )) as {
      completed: unknown[];
      recoverable: boolean;
      error: string;
      inputDispatched: boolean;
      requiresNewTurn?: boolean;
    };
  const partial = await act(["one", "two", "three"]);
  assert.equal(partial.completed.length, 1);
  assert.equal(attempts, 2);
  assert.equal(partial.inputDispatched, false);
  assert.equal(partial.error, "Control changed", "the model still receives the recoverable error");
  assert.equal((await h.command("snapshot")).error, undefined, "recoverable tool failures are not conversation errors");
  failAfterInput = true;
  assert.equal((await act()).inputDispatched, true);
  assert.equal((await act()).recoverable, false);
  const blocked = await act();
  assert.equal(blocked.requiresNewTurn, true);
  assert.equal(blocked.error, "Control changed");
  assert.equal((await h.command("snapshot")).phase, "error");
  assert.equal(attempts, 4);
  h.control.complete(
    desktopSessionResourceKey({
      ...scope,
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
    }),
  );
  h.setTurn("new-turn");
  assert.equal((await act()).recoverable, true);
  assert.equal((await h.command("snapshot")).error, undefined, "a new turn does not inherit the previous terminal error");
});

test("takeover cancels waiting and interrupts the exact owning turn", async (t) => {
  const h = harness();
  t.after(() => h.control.close());
  const pending = assert.rejects(
    async () => h.tool.impl({ status: "Checking Maka", request: { operation: "observe", waitMs: 5000 } }, h.ctx()),
    /abort|User took control/i,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await h.command("stop");
  await pending;
  assert.deepEqual(h.interrupted, ["turn"]);
  await assert.rejects(
    async () => h.tool.impl({ status: "Checking Maka", request: { operation: "observe" } }, h.ctx()),
    /User took control/,
  );
});

test("observations exclude browser, terminal, password and marked descendants and reject replaced or stale handles", async () => {
  const surface = new WorkHubSurface();
  const metadata = {
    ref: "fresh",
    name: "Rename",
    role: "",
    tag: "button",
    type: "",
    section: "",
    navigation: false,
    external: false,
    editable: false,
  };
  let preparing = true;
  let backend = 2;
  const ax = (id: number, name: string, role = "button") => ({
    nodeId: String(id),
    backendDOMNodeId: id,
    name: { value: name },
    role: { value: role },
  });
  const wc = {
    executeJavaScript: async () => (preparing ? [{ ...metadata }] : true),
    debugger: {
      sendCommand: async (method: string) => {
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 2 };
        if (method === "DOM.describeNode")
          return { node: { backendNodeId: backend } };
        return { nodes: [ax(2, "Rename")] };
      },
    },
  } as unknown as WebContents;
  await surface.prepare(wc);
  const result = surface.filter(
    {
      nodeName: "HTML",
      backendNodeId: 1,
      children: [
        {
          nodeName: "BUTTON",
          backendNodeId: 2,
          attributes: ["data-maka-assistant-ref", "fresh"],
        },
        {
          nodeName: "DIV",
          backendNodeId: 3,
          attributes: ["data-maka-assistant-exclude", ""],
          children: [{ nodeName: "BUTTON", backendNodeId: 4 }],
        },
        {
          nodeName: "IFRAME",
          backendNodeId: 5,
          children: [{ nodeName: "BUTTON", backendNodeId: 6 }],
        },
        {
          nodeName: "INPUT",
          backendNodeId: 7,
          attributes: ["type", "password"],
        },
        {
          nodeName: "DIV",
          backendNodeId: 8,
          attributes: ["class", "xterm"],
          children: [{ nodeName: "BUTTON", backendNodeId: 9 }],
        },
      ],
    },
    {
      nodes: [
        ax(2, "Rename"),
        ...[3, 4, 5, 6, 7, 8, 9].map((id) => ax(id, "excluded content")),
      ],
    },
  );
  assert.equal(JSON.stringify(result).includes("excluded content"), false);
  assert.deepEqual(
    surface.list().map((entry) => entry.name),
    ["Rename"],
  );
  preparing = false;
  assert.equal((await surface.resolve(wc, "fresh", "click")).name, "Rename");
  await assert.rejects(surface.resolve(wc, "fresh", "type"), /not an editable/);
  await assert.rejects(
    surface.resolve(wc, "fresh", "key"),
    /requires an editor/,
  );
  backend = 20;
  await assert.rejects(surface.resolve(wc, "fresh", "click"), /replaced/);
  preparing = true;
  await surface.prepare(wc);
  await assert.rejects(surface.resolve(wc, "fresh", "click"), /Stale/);
});

test("native input passes through only the assistant and restores hit testing after failure", async () => {
  let passing = false;
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      if (script.includes("getComputedStyle")) return null;
      if (script.includes("getBoundingClientRect")) return { x: 20, y: 20 };
      if (script.startsWith("!!document.querySelector")) return true;
      if (script.includes("classList.add('desktopAssistantInput')"))
        passing = true;
      if (script.includes("classList.remove('desktopAssistantInput')"))
        passing = false;
    },
    sendInputEvent: (event: { type: string }) => {
      assert.equal(passing, true);
      if (event.type === "mouseDown") throw new Error("Injected input failure");
    },
  } as unknown as WebContents;
  const ui = new WorkHubUi(
    () => wc,
    async () => createDefaultSettings(),
    () => {},
    async () => "",
  );
  await assert.rejects(
    ui.execute(
      { kind: "navigate", section: "general" },
      new AbortController().signal,
    ),
    /Injected input failure/,
  );
  assert.equal(passing, false);
});

test("typed Settings navigation reveals clipped sidebar controls through native wheel input", async () => {
  const events: { type: string; deltaY?: number }[] = [];
  let clipped = true;
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      if (script.includes("getComputedStyle"))
        return clipped ? { x: 80, y: 120, deltaY: -340 } : null;
      if (script.includes("getBoundingClientRect")) return { x: 80, y: 120 };
      if (script.startsWith("!!document.querySelector")) return true;
    },
    sendInputEvent: (event: { type: string; deltaY?: number }) => {
      events.push(event);
      if (event.type === "mouseWheel") clipped = false;
      if (event.type === "mouseDown")
        throw new Error("Reached revealed section");
    },
  } as unknown as WebContents;
  const ui = new WorkHubUi(
    () => wc,
    async () => createDefaultSettings(),
    () => {},
    async () => "",
  );
  await assert.rejects(
    ui.execute(
      { kind: "navigate", section: "general" },
      new AbortController().signal,
    ),
    /Reached revealed section/,
  );
  assert.equal(
    events.find((event) => event.type === "mouseWheel")?.deltaY,
    -340,
  );
  assert.ok(
    events.findIndex((event) => event.type === "mouseWheel") <
      events.findIndex((event) => event.type === "mouseDown"),
  );
  assert.equal(
    ui.dispatchedInputs,
    2,
    "wheel and click both count as dispatched input",
  );
});

test("window preparation cannot admit input after takeover or a Host switch", async (t) => {
  let calls = 0;
  t.mock.method(WorkHubUi.prototype, "observe", async () => {
    calls++;
    return {
      section: null,
      language: "en",
      theme: "light",
      accessibility: "",
      controls: [],
    };
  });
  t.mock.method(WorkHubUi.prototype, "begin", async () => {
    calls++;
  });
  t.mock.method(WorkHubUi.prototype, "execute", async () => {
    calls++;
    return { verified: true };
  });
  for (const cause of ["takeover", "host"] as const) {
    let ready!: () => void;
    let preparing!: () => void;
    const entered = new Promise<void>((resolve) => {
      preparing = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const h = harness(async () => {
      preparing();
      await gate;
    });
    t.after(() => h.control.close());
    const pending = assert.rejects(
      async () =>
        h.tool.impl(
          {
            status: "Checking Maka", request: {
              operation: "act",
              actions: [{ kind: "navigate", section: "general" }],
            },
          },
          h.ctx(),
        ),
      /User took control|Host changed/,
    );
    await entered;
    if (cause === "takeover") await h.command("stop");
    else h.setCurrent(false);
    ready();
    await pending;
  }
  assert.equal(
    calls,
    0,
    "preparing a visible main window grants no input authority",
  );
});

test("task coordination does not open or focus the controlled main window", async (t) => {
  const h = harness(async () => {
    throw new Error("Must not prepare the window");
  });
  t.after(() => h.control.close());
  const tasks = h.control.group(scope).tools[1] as MakaTool;
  assert.deepEqual(await tasks.impl({ request: { operation: "candidates" } }, h.ctx()), {
    turnId: "turn",
    callId: "call",
    input: { operation: "candidates" },
  });
});


test("takeover stops an action without exposing its internal abort reason as a conversation error", async (t) => {
  const h = harness();
  t.after(() => h.control.close());
  t.mock.method(WorkHubUi.prototype, "begin", async () => {});
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(WorkHubUi.prototype, "execute", async (_action: Parameters<WorkHubUi['execute']>[0], signal: AbortSignal) => {
    entered();
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const action = h.tool.impl({ status: "Checking Maka", request: { operation: "act", actions: [{ kind: "navigate", section: "general" }] } }, h.ctx());
  await executing;
  await h.command('stop');
  const result = await action as { interrupted: boolean; error: string };
  assert.equal(result.interrupted, true);
  assert.equal(result.error, 'User took control', 'the model still receives the interruption reason');
  const snapshot = await h.command('snapshot');
  assert.equal(snapshot.phase, 'paused');
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.cursor, undefined);
  assert.deepEqual(h.interrupted, ['turn']);
});

test("cancelling undo is a normal completion for the renderer", async (t) => {
  const h = harness();
  t.after(() => h.control.close());
  t.mock.method(WorkHubUi.prototype, "begin", async () => {});
  t.mock.method(WorkHubUi.prototype, "observe", async () => ({ section: null, language: 'en', theme: 'light', accessibility: '', controls: [] }));
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  t.mock.method(WorkHubUi.prototype, "execute", async (_action: Parameters<WorkHubUi['execute']>[0], signal: AbortSignal) => {
    if (++calls === 1) return { previous: 'dark', verified: true };
    entered();
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await h.tool.impl({ status: "Checking Maka", request: { operation: 'act', actions: [{ kind: 'set', target: 'theme', value: createDefaultSettings().appearance.theme }] } }, h.ctx());
  h.control.complete(desktopSessionResourceKey({ ...scope, sessionId: WORKHUB_COORDINATION_SESSION_ID }));
  const undoing = h.command('undo');
  await executing;
  await h.command('stop');
  await undoing;
  assert.equal((await h.command('snapshot')).error, undefined);
  assert.equal((await h.command('snapshot')).phase, 'paused');
});


test('control requires a short status before preparing the window and publishes the same text', async (t) => {
  let prepared = 0;
  const h = harness(async () => { prepared++; });
  t.after(() => h.control.close());
  t.mock.method(WorkHubUi.prototype, 'observe', async () => ({ section: null, language: 'en', theme: 'light', accessibility: '', controls: [] }));
  for (const status of [undefined, '', '  ', 'a'.repeat(81), 'first\nsecond']) {
    await assert.rejects(async () => h.tool.impl({ status, request: { operation: 'observe' } }, h.ctx()));
  }
  assert.equal(prepared, 0);
  await h.tool.impl({ status: '  正在检查项目设置  ', request: { operation: 'observe' } }, h.ctx());
  assert.equal((await h.command('snapshot')).status, '正在检查项目设置');
  assert.equal(prepared, 1);
  h.control.complete(desktopSessionResourceKey({ ...scope, sessionId: WORKHUB_COORDINATION_SESSION_ID }));
  assert.equal((await h.command('snapshot')).status, undefined);
});
