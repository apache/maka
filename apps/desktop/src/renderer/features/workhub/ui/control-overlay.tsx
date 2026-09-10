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

import { useEffect, useRef, useState } from "react";
import type {
  WorkHubControlSnapshot,
} from "../../../../shared/workhub-control.js";
import { AssistantCursor } from "./cursor.js";
import { useWorkHubServices } from '../services.js';

/** Input feedback belongs to the controlled main window, independent of the WorkHub view. */
export function WorkHubControlOverlay() {
  const { control: bridge } = useWorkHubServices();
  const [snapshot, setSnapshot] = useState<WorkHubControlSnapshot>({
    revision: -1,
    phase: "idle",
    canUndo: false,
  });
  const state = useRef(snapshot);
  state.current = snapshot;
  useEffect(() => {
    let mounted = true;
    const update = (next: WorkHubControlSnapshot) => {
      if (mounted)
        setSnapshot((previous) =>
          next.revision >= previous.revision ? next : previous,
        );
    };
    const release = bridge.subscribe(update);
    void bridge.getSnapshot().then(update).catch(console.error);
    return () => {
      mounted = false;
      release();
    };
  }, [bridge]);
  useEffect(() => {
    let stopping = false;
    let expected:
      | {
          x?: number;
          y?: number;
          key?: string;
          wheel?: boolean;
          until: number;
        }
      | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      document.documentElement.classList.remove("desktopAssistantInput");
      void bridge
        .stop()
        .catch(console.error)
        .finally(() => {
          stopping = false;
        });
    };
    const onInput = (event: Event) => {
      if (event instanceof CustomEvent)
        expected = {
          ...event.detail,
          until: performance.now() + 300,
        };
    };
    const key = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      if (expected?.key === event.key && performance.now() <= expected.until) {
        expected = undefined;
        return;
      }
      if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
      if (state.current.cursor) stop();
    };
    const takeover = (event: Event) => {
      if (!state.current.cursor || !event.isTrusted) return;
      if (
        event instanceof WheelEvent &&
        expected?.wheel &&
        performance.now() <= expected.until
      ) {
        expected = undefined;
        return;
      }
      if (
        event instanceof PointerEvent &&
        expected &&
        performance.now() <= expected.until &&
        Math.abs(event.clientX - (expected.x ?? NaN)) <= 1 &&
        Math.abs(event.clientY - (expected.y ?? NaN)) <= 1
      ) {
        expected = undefined;
        return;
      }
      stop();
    };
    window.addEventListener("maka-assistant:input", onInput);
    window.addEventListener("keydown", key, true);
    for (const type of ["pointerdown", "wheel"])
      window.addEventListener(type, takeover, true);
    return () => {
      window.removeEventListener("maka-assistant:input", onInput);
      window.removeEventListener("keydown", key, true);
      for (const type of ["pointerdown", "wheel"])
        window.removeEventListener(type, takeover, true);
      document.documentElement.classList.remove("desktopAssistantInput");
    };
  }, [bridge]);
  return snapshot.cursor ? <AssistantCursor cursor={snapshot.cursor} /> : null;
}
