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

import { watch as watchDirectory } from "node:fs";
import { basename } from "node:path";

export interface ClientSettingsWatcher {
  stop(): void;
}

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

interface ClientSettingsWatcherDependencies {
  readonly watch?: (
    workspaceRoot: string,
    listener: WatchListener,
  ) => WatchHandle;
  readonly debounceMs?: number;
  readonly onError?: (error: unknown) => void;
}

const SETTINGS_FILE = "settings.json";
const DEFAULT_DEBOUNCE_MS = 300;

interface WatchHandle {
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
}

export function startClientSettingsWatcher(
  workspaceRoot: string,
  onChanged: () => void,
  dependencies: ClientSettingsWatcherDependencies = {},
): ClientSettingsWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: WatchHandle | undefined;

  const stop = (): void => {
    watcher?.close();
    watcher = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChanged();
    }, dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  };

  try {
    watcher = (dependencies.watch ?? watchDirectory)(
      workspaceRoot,
      (_eventType, filename) => {
        if (!watcher) return;
        if (filename && basename(filename.toString()) !== SETTINGS_FILE) return;
        schedule();
      },
    );
    watcher.on("error", (error) => {
      dependencies.onError?.(error);
      stop();
    });
  } catch (error) {
    dependencies.onError?.(error);
  }

  return { stop };
}
