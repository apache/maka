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

import { keymap } from 'nsh';
import type { InputRef, ViewRef } from 'nsh';

export type EditorKeyOptions = { repeat?: boolean; fallback?: boolean };

/** All offsets and replacement expectations refer to the original draft's UTF-16 text. */
export interface ComposerEditor {
  readonly anchor: ViewRef;
  focus(): void;
  blur(): void;
  composing(): boolean;
  replaceRange: InputRef['replaceRange'];
  bindKey(key: string, action: () => void, options?: EditorKeyOptions): () => void;
}

/** Ordinary query fields use their native input and keyboard scope. */
export function inputEditor(node: InputRef, composing: () => boolean): ComposerEditor {
  return {
    anchor: node,
    focus: () => node.focus(),
    blur: () => node.blur(),
    composing,
    replaceRange: (request) => node.replaceRange(request),
    bindKey: (key, action, options) =>
      keymap.bind(key, action, { when: 'always', within: node, ...options }),
  };
}
