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

import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import type { IpcMain, WebContents } from "electron";
import type { AppSettings } from "@maka/core/settings";
import { WORKHUB_COORDINATION_SESSION_ID } from "@maka/core/session";
import type { MakaTool } from "@maka/runtime/tool-runtime";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type { DesktopCapabilityGroup } from "./runtime-host-native-capabilities.js";
import { WorkHubUi } from "./workhub-ui.js";
import {
  desktopSessionResourceKey,
  type DesktopTargetScope,
} from "../shared/runtime-host-identity.js";
import {
  workHubControlSchema,
  workHubTasksSchema,
  type WorkHubAction,
  type WorkHubTasksInput,
} from "../shared/workhub-tool-schema.js";
import type { WorkHubControlSnapshot } from '../shared/workhub-control.js';

// Tool protocols require an object root; keep each operation's exact shape
// inside it so models cannot combine arguments from incompatible operations.
const controlParameters = z.object({ request: workHubControlSchema }).strict();
const tasksParameters = z.object({ request: workHubTasksSchema }).strict();

interface WorkHubControlDeps {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  window(): WebContents;
  prepareWindow(): Promise<void>;
  authorizedRenderer(contents: WebContents): boolean;
  send(channel: string, payload: unknown): void;
  readSettings(): Promise<AppSettings>;
  client(scope: DesktopTargetScope): DesktopRuntimeHostClient;
  isCurrent(scope: DesktopTargetScope): boolean;
  assertTurn(scope: DesktopTargetScope, turnId: string): Promise<void>;
  interrupt(scope: DesktopTargetScope, turnId: string): Promise<void>;
  actTasks(
    scope: DesktopTargetScope,
    turnId: string,
    toolCallId: string,
    input: WorkHubTasksInput,
  ): Promise<unknown>;
}
interface Owner {
  readonly scope: DesktopTargetScope;
  readonly resourceKey: string;
  readonly turnId: string;
  readonly controller: AbortController;
  failures: number;
}
interface Undo {
  readonly scope: DesktopTargetScope;
  readonly action: Extract<WorkHubAction, { kind: "set" }>;
  readonly expected: string;
}

/** Owns native input presentation only; the Host owns the conversation and turn. */
export function createWorkHubControl(deps: WorkHubControlDeps) {
  let snapshot: WorkHubControlSnapshot = {
    revision: 0,
    phase: "idle",
    canUndo: false,
  };
  let owner: Owner | undefined;
  let undo: Undo | undefined;
  let busy = false;
  let undoController: AbortController | undefined;
  let closed = false;
  const update = (patch: Partial<WorkHubControlSnapshot>) => {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    deps.send("workhub-control:changed", snapshot);
  };
  const requireCurrent = (scope: DesktopTargetScope) => {
    if (closed || !deps.isCurrent(scope))
      throw new Error("Runtime Host changed");
  };
  let uiScope: DesktopTargetScope | undefined;
  const ui = new WorkHubUi(
    () => {
      if (!uiScope) throw new Error("No WorkHub input owner");
      requireCurrent(uiScope);
      return deps.window();
    },
    deps.readSettings,
    update,
    async () => {
      if (!uiScope) throw new Error("No WorkHub input owner");
      requireCurrent(uiScope);
      return (await deps.client(uiScope).queryRuntimePolicy()).policy
        .personalization.displayName;
    },
  );
  const claim = async (
    scope: DesktopTargetScope,
    ctx: Parameters<MakaTool["impl"]>[1],
  ) => {
    requireCurrent(scope);
    if (ctx.sessionId !== WORKHUB_COORDINATION_SESSION_ID || !ctx.turnId)
      throw new Error("Only the active WorkHub turn may control Maka");
    await deps.assertTurn(scope, ctx.turnId);
    requireCurrent(scope);
    ctx.abortSignal.throwIfAborted();
    const resourceKey = desktopSessionResourceKey({
      ...scope,
      sessionId: ctx.sessionId,
    });
    if (
      owner &&
      (owner.resourceKey !== resourceKey || owner.turnId !== ctx.turnId)
    ) {
      owner.controller.abort(new Error("WorkHub turn changed"));
      owner = undefined;
      update({ cursor: undefined });
    }
    owner ??= {
      scope,
      resourceKey,
      turnId: ctx.turnId,
      controller: new AbortController(),
      failures: 0,
    };
    uiScope = scope;
    return owner;
  };
  const stop = async () => {
    const active = owner;
    if (!active) {
      undoController?.abort(new Error("User took control"));
      if (undoController) update({ phase: "paused", cursor: undefined });
      return;
    }
    active.controller.abort(new Error("User took control"));
    update({ phase: "paused", cursor: undefined });
    // This callback must compare the exact turn before sending sessions.stop.
    await deps.interrupt(active.scope, active.turnId);
  };
  const group = (scope?: DesktopTargetScope): DesktopCapabilityGroup => {
    if (!scope)
      throw new Error("WorkHub capability requires a Desktop target scope");
    const control: MakaTool = {
      name: "control",
      description:
        "Operate this Maka window with verified native input and a visible cursor. Inspect completed steps and fresh observations; dispatched input alone is not success. Terminal, embedded browser, external links and secret fields are excluded. Three consecutive failed action batches stop input for this turn.",
      parameters: controlParameters,
      impl: async (input, ctx) => {
        if (busy)
          throw new Error("Another WorkHub control call is still running");
        busy = true;
        try {
          const active = await claim(scope, ctx);
          const signal = AbortSignal.any([
            active.controller.signal,
            ctx.abortSignal,
          ]);
          signal.throwIfAborted();
          const args = controlParameters.parse(input).request;
          await deps.prepareWindow();
          signal.throwIfAborted();
          requireCurrent(scope);
          await deps.assertTurn(scope, active.turnId);
          signal.throwIfAborted();
          requireCurrent(scope);
          if (args.operation === "observe") {
            if (args.waitMs) await wait(args.waitMs, undefined, { signal });
            signal.throwIfAborted();
            return ui.observe();
          }
          if (args.operation === "visual") return { image: await ui.visual() };
          if (active.failures >= 3)
            return {
              interrupted: true,
              error: snapshot.error,
              requiresNewTurn: true,
            };
          const completed = [];
          let inputBeforeAction = ui.dispatchedInputs;
          update({ phase: "acting", error: undefined });
          try {
            if (!snapshot.cursor) await ui.begin(signal);
            for (const action of args.actions) {
              signal.throwIfAborted();
              requireCurrent(scope);
              await deps.assertTurn(scope, active.turnId);
              signal.throwIfAborted();
              inputBeforeAction = ui.dispatchedInputs;
              const result = await ui.execute(action, signal);
              completed.push(result);
              if (action.kind === "set" && result.previous !== undefined) {
                undo = {
                  scope,
                  action: {
                    ...action,
                    value: result.previous,
                  } as Undo["action"],
                  expected: action.value,
                };
                update({ canUndo: true });
              }
            }
            const observation = await ui.observe();
            active.failures = 0;
            return { completed, observation };
          } catch (error) {
            active.failures++;
            const message =
              error instanceof Error ? error.message : String(error);
            const recoverable =
              !signal.aborted && deps.isCurrent(scope) && active.failures < 3;
            const inputDispatched = ui.dispatchedInputs > inputBeforeAction;
            update({
              error: message,
              phase: signal.aborted ? "paused" : "error",
              ...(!recoverable ? { cursor: undefined } : {}),
            });
            return {
              completed,
              interrupted: !recoverable,
              error: message,
              recoverable,
              inputDispatched,
              retry: recoverable
                ? inputDispatched
                  ? "Input was dispatched. Inspect the fresh observation before retrying; do not repeat send or delete without proof it did not take effect."
                  : "No click or text input was dispatched for the failed action. Retry using a fresh observed reference."
                : "Do not retry input in this turn.",
              ...(recoverable
                ? { observation: await ui.observe().catch(() => undefined) }
                : {}),
            };
          }
        } finally {
          busy = false;
        }
      },
      toModelOutput: ({ output }) => {
        if (
          typeof output === "object" &&
          output !== null &&
          "image" in output &&
          typeof output.image === "string"
        )
          return {
            type: "content",
            value: [
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data: output.image },
              },
            ],
          };
        return { type: "text", value: JSON.stringify(output) };
      },
    };
    const tasks: MakaTool = {
      name: "tasks",
      description:
        "Discover or coordinate Host tasks through the WorkHub action gate. Delegate actual work with text; original user intent and destructive authorization are checked by the Host. Use candidates before choosing an existing task. Never invent a candidate or delegation identity.",
      parameters: tasksParameters,
      impl: async (input, ctx) => {
        if (busy)
          throw new Error("Another WorkHub control call is still running");
        busy = true;
        try {
          const active = await claim(scope, ctx);
          active.controller.signal.throwIfAborted();
          return await deps.actTasks(
            scope,
            active.turnId,
            ctx.toolCallId,
            tasksParameters.parse(input).request,
          );
        } finally {
          busy = false;
        }
      },
    };
    return {
      offerId: "desktop_workhub",
      label: "WorkHub",
      description: "Operate Maka and coordinate its tasks.",
      tools: [control, tasks],
    };
  };
  const complete = (resourceKey: string) => {
    if (owner?.resourceKey !== resourceKey) return;
    owner.controller.abort(new Error("WorkHub turn finished"));
    owner = undefined;
    update({
      cursor: undefined,
      phase: snapshot.phase === "acting" ? "idle" : snapshot.phase,
    });
  };
  deps.ipcMain.handle(
    "workhub-control:command",
    async (event, command: unknown) => {
      if (
        !deps.authorizedRenderer(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("WorkHub control requires the main window");
      if (command === "snapshot") {
        if (undo && !deps.isCurrent(undo.scope)) {
          undo = undefined;
          update({ canUndo: false });
        }
        return snapshot;
      }
      if (command === "stop") return stop();
      if (command !== "undo")
        throw new Error("Unknown WorkHub control command");
      const previous = undo;
      if (busy || owner || !previous)
        throw new Error("No change can be undone now");
      requireCurrent(previous.scope);
      busy = true;
      uiScope = previous.scope;
      const controller = new AbortController();
      undoController = controller;
      try {
        await deps.prepareWindow();
        controller.signal.throwIfAborted();
        requireCurrent(previous.scope);
        const saved = await deps.readSettings();
        const value =
          previous.action.target === "displayName"
            ? (await deps.client(previous.scope).queryRuntimePolicy()).policy
                .personalization.displayName
            : previous.action.target === "language"
              ? saved.personalization.uiLocale
              : saved.appearance.theme;
        requireCurrent(previous.scope);
        if (value !== previous.expected) {
          undo = undefined;
          update({ canUndo: false });
          throw new Error(
            "Preference changed after WorkHub; undo is unavailable",
          );
        }
        update({ phase: "acting", error: undefined });
        await ui.begin(controller.signal);
        await ui.execute(previous.action, controller.signal);
        undo = undefined;
        update({ canUndo: false, phase: "idle" });
      } catch (error) {
        update({
          phase: controller.signal.aborted ? "paused" : "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        busy = false;
        undoController = undefined;
        update({ cursor: undefined });
      }
    },
  );
  return {
    group,
    complete,
    close: async () => {
      closed = true;
      undoController?.abort(new Error("WorkHub control closed"));
      owner?.controller.abort(new Error("WorkHub control closed"));
      owner = undefined;
      undo = undefined;
      update({ cursor: undefined, phase: "idle", canUndo: false });
      deps.ipcMain.removeHandler("workhub-control:command");
    },
  };
}
