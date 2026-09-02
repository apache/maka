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
import { runtimeHostStartupError } from "@maka/runtime-host/client";
import { startDesktopRuntimeHostWithRecovery } from "../runtime-host-startup-recovery.js";

test("repairs a managed Host once and resumes startup without asking the user", async () => {
  let starts = 0;
  const repairModes: Array<{
    readonly allowManualUpdate: boolean;
    readonly allowInterruptActiveTasks: boolean;
  }> = [];
  let prompts = 0;

  const result = await startDesktopRuntimeHostWithRecovery({
    start: async () => {
      starts += 1;
      if (starts === 1)
        throw runtimeHostStartupError("managed_root_requires_operator");
      return "ready";
    },
    repair: async (authority) => {
      repairModes.push(authority);
      return { kind: "repaired" };
    },
    prompt: async () => {
      prompts += 1;
      return "exit";
    },
  });

  assert.equal(result, "ready");
  assert.equal(starts, 2);
  assert.deepEqual(repairModes, [
    { allowManualUpdate: false, allowInterruptActiveTasks: false },
  ]);
  assert.equal(prompts, 0);
});

test("separates manual update consent from active-work interruption", async () => {
  let starts = 0;
  const repairModes: Array<{
    readonly allowManualUpdate: boolean;
    readonly allowInterruptActiveTasks: boolean;
  }> = [];
  const prompts: boolean[] = [];

  const result = await startDesktopRuntimeHostWithRecovery({
    start: async () => {
      starts += 1;
      if (starts === 1)
        throw runtimeHostStartupError("managed_root_requires_operator");
      return "ready";
    },
    repair: async (authority) => {
      repairModes.push(authority);
      if (!authority.allowManualUpdate) throw new Error("manual update confirmation required");
      return authority.allowInterruptActiveTasks
        ? { kind: "repaired" }
        : { kind: "active_tasks" };
    },
    prompt: async (input) => {
      prompts.push(input.activeTasks);
      return "repair";
    },
  });

  assert.equal(result, "ready");
  assert.deepEqual(repairModes, [
    { allowManualUpdate: false, allowInterruptActiveTasks: false },
    { allowManualUpdate: true, allowInterruptActiveTasks: false },
    { allowManualUpdate: true, allowInterruptActiveTasks: true },
  ]);
  assert.deepEqual(prompts, [false, true]);
});

test("does not offer managed repair for an unrelated startup failure", async () => {
  const failure = new Error("renderer prerequisites failed");
  let repairs = 0;
  let prompts = 0;

  await assert.rejects(
    startDesktopRuntimeHostWithRecovery({
      start: async () => {
        throw failure;
      },
      repair: async () => {
        repairs += 1;
        return { kind: "repaired" };
      },
      prompt: async () => {
        prompts += 1;
        return "repair";
      },
    }),
    failure,
  );
  assert.equal(repairs, 0);
  assert.equal(prompts, 0);
});
