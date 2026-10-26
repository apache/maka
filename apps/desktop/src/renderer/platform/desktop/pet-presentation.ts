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

import type { PersonalAssistantPort } from "../../features/personal-assistant/index.js";
import type { DesktopTranscriptHandle } from "../../../preload/transcript-contract.js";
import { DesktopTranscriptRangeStore } from "./desktop-transcript-range-store.js";

export function createDesktopPetPresentation(): NonNullable<
  PersonalAssistantPort["pet"]
> {
  return {
    ...window.maka.petDesktop,
    observeMessages(sessionId, failed) {
      let live = true;
      let initialized = false;
      let handle: DesktopTranscriptHandle | undefined;
      let cancel: (() => void) | undefined;
      const range = new DesktopTranscriptRangeStore(sessionId);
      const seen = new Set<string>();
      let retry: ReturnType<typeof setTimeout> | undefined;
      let generation = 0;
      const open = () => {
        const ticket = ++generation;
        void window.maka.transcripts
        .open(
          sessionId,
          (batch) => {
            if (!live || ticket !== generation || !range.accept(batch) || !range.snapshot().ready)
              return;
            const messages = range
              .snapshot()
              .messages.filter((m) => m.type === "assistant");
            const added = messages.filter((m) => !seen.has(m.id));
            for (const message of messages) seen.add(message.id);
            // Initial history is not a notification. Reconnects retain the same seen set.
            if (initialized && added.length)
              window.maka.petDesktop.publish({
                kind: "messages",
                sessionId,
                messages: added.map((m) => ({
                  id: m.id,
                  text: m.text,
                  summary: m.summary,
                })),
              });
            initialized = true;
          },
          (fn) => {
            if (!live || ticket !== generation) fn();
            else cancel = fn;
          },
          "tail",
        )
        .then((result) => {
          if (!live || ticket !== generation) void result.close();
          else if (result.generation.startsWith('cached:')) {
            // Preload's successful offline fallback owns no live IPC listener.
            // Reopen here, rather than remounting the observer and losing seen IDs.
            ++generation;
            cancel?.();
            cancel = undefined;
            void result.close();
            retry = setTimeout(() => { retry = undefined; if (live) open(); }, 1000);
          } else handle = result;
        })
        .catch(() => {
          if (live && ticket === generation) failed();
        });
      };
      open();
      return () => {
        live = false;
        ++generation;
        if (retry !== undefined) clearTimeout(retry);
        cancel?.();
        void handle?.close();
      };
    },
  };
}
