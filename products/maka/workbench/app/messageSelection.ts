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

import { cleanup, signal } from 'nsh';

export type SelectionPressHandlers = {
  onPressDown(): void;
  onPressUp(): void;
  onPress(): void;
};

/** Explicit selection state owned by a single rendered message row. */
export type MessageSelection = {
  /** Live non-blank selection in this message, preserving original whitespace. */
  current(): string | null;
  /** Record a selection update from one body source inside this message. */
  set(text: string, source: string): void;
  /** Capture the live passage, or one cleared by the same mouse-down turn. */
  captureForPress(): string | null;
  /** Discard any active or pending selection once a command consumes it. */
  clear(): void;
  /** Bind a button so mouse-down captures the passage before mouse-up fires `onPress`. */
  bindPress(run: (passage: string | null) => void): SelectionPressHandlers;
};

export function createMessageSelection(
  registerCleanup: (fn: () => void) => void = cleanup,
): MessageSelection {
  const live = signal<{ source: string; text: string } | null>(null);
  // A button mouse-down clears text selection immediately before firing
  // `onPressDown` in the same event turn. Hold that just-cleared text only
  // until the end of the turn so a real click-away clears immediately.
  let justCleared: string | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  const dropJustCleared = () => {
    justCleared = null;
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  };
  registerCleanup(dropJustCleared);

  const captureForPress = () => {
    const value = live()?.text ?? justCleared;
    dropJustCleared();
    return value;
  };

  return {
    current: () => live()?.text ?? null,
    set(text: string, source: string) {
      if (text.trim()) {
        dropJustCleared();
        live.set({ source, text });
        return;
      }
      const current = live();
      if (current !== null && current.source === source) {
        live.set(null);
        justCleared = current.text;
        if (clearTimer !== null) clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
          clearTimer = null;
          justCleared = null;
        }, 0);
      }
    },
    captureForPress,
    clear() {
      dropJustCleared();
      live.set(null);
    },
    bindPress(run) {
      let captured: string | null | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | null = null;
      const reset = () => {
        captured = undefined;
        if (releaseTimer !== null) {
          clearTimeout(releaseTimer);
          releaseTimer = null;
        }
      };
      registerCleanup(reset);
      return {
        onPressDown() {
          if (releaseTimer !== null) {
            clearTimeout(releaseTimer);
            releaseTimer = null;
          }
          captured = captureForPress();
        },
        onPressUp() {
          if (releaseTimer !== null) clearTimeout(releaseTimer);
          releaseTimer = setTimeout(() => {
            releaseTimer = null;
            captured = undefined;
          }, 0);
        },
        onPress() {
          const selected = captured !== undefined ? captured : captureForPress();
          reset();
          run(selected);
        },
      };
    },
  };
}
