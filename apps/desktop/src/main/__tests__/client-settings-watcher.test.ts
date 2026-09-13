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
import { startClientSettingsWatcher } from "../client-settings-watcher.js";

test("refreshes only for client settings replacements and stops cleanly", async () => {
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let closed = false;
  let refreshes = 0;
  const watcher = startClientSettingsWatcher(
    "/workspace",
    () => {
      refreshes += 1;
    },
    {
      debounceMs: 0,
      watch: (_root, nextListener) => {
        listener = nextListener;
        return {
          on: () => undefined,
          close: () => {
            closed = true;
          },
        };
      },
    },
  );

  assert.ok(listener);
  listener("rename", "runtime.sqlite");
  listener("rename", "settings.json");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 1);

  watcher.stop();
  assert.equal(closed, true);
  listener("rename", "settings.json");
  watcher.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 1);
});
