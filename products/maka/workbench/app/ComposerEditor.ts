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

import type { ComposerInputRef } from 'maka/host';
import { keymap } from 'nsh';
import type { InputRef, ViewRef } from 'nsh';

export type EditorKeyOptions = { repeat?: boolean; fallback?: boolean };

/** All offsets and replacement expectations refer to the original draft's UTF-16 text. */
export interface ComposerEditor {
  readonly anchor: ViewRef;
  focus(): void;
  blur(): void;
  composing(): boolean;
  replaceRange: ComposerInputRef['replaceRange'];
  bindKey(key: string, action: () => void, options?: EditorKeyOptions): () => void;
}

export interface ControlledInputState {
  value(): string;
  setValue(value: string): void;
  selection(): { start: number; end: number };
  setSelection(selection: { start: number; end: number }): void;
  composing(): boolean;
}

/** Ordinary query fields use their native input and keyboard scope. */
export function inputEditor(node: InputRef, state: ControlledInputState): ComposerEditor {
  return {
    anchor: node,
    focus: () => node.focus(),
    blur: () => node.blur(),
    composing: state.composing,
    replaceRange: async (request) => {
      if (state.composing()) return false;
      const current = state.value();
      const selection = state.selection();
      if (
        current !== request.expectedText ||
        selection.start !== request.expectedSelection.start ||
        selection.end !== request.expectedSelection.end ||
        request.start > request.end ||
        request.end > current.length
      ) {
        return false;
      }
      const next = current.slice(0, request.start) + request.text + current.slice(request.end);
      const caret = request.start + request.text.length;
      state.setValue(next);
      state.setSelection({ start: caret, end: caret });
      node.setSelection(caret, caret);
      return true;
    },
    bindKey: (key, action, options) =>
      keymap.bind(key, action, { when: 'always', within: node, ...options }),
  };
}
