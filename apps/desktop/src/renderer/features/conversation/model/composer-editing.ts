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

import type { RefObject } from 'react';
import type { ComposerHandle } from '@maka/ui';

/**
 * Named edits other regions may make to the main Composer, in place of the
 * editor handle itself. None of them reads a draft back.
 */
export interface ComposerEditingCommands {
  /** Prompt suggestions, Module Hub and skills add text after the visible draft. */
  appendText(text: string): void;
  /** `maka://compose` replaces the visible draft; the user still sends it. */
  replaceText(text: string): void;
  focus(): void;
  openModelPicker(): void;
  /** Work Board writes a new-task draft before navigation shows it. */
  seedDraft(draftKey: string, text: string): void;
  /** A Guest's settled turn request takes its text out of that Session's draft. */
  discardDraft(draftKey: string): void;
  /**
   * A claim on the editor showing now, for an append that lands later; it is
   * current only while the same editor stays mounted. Undefined with no editor.
   */
  claimVisibleDraft(): { isCurrent(): boolean; append(text: string): void } | undefined;
}

export function createComposerEditing(composer: RefObject<ComposerHandle | null>): ComposerEditingCommands {
  return {
    appendText: (text) => composer.current?.appendText(text),
    replaceText: (text) => composer.current?.setText(text),
    focus: () => composer.current?.focus(),
    openModelPicker: () => composer.current?.openModelPicker(),
    seedDraft: (draftKey, text) => composer.current?.setDraft(draftKey, text),
    discardDraft: (draftKey) => composer.current?.clearDraft(draftKey),
    claimVisibleDraft: () => {
      const handle = composer.current;
      if (!handle) return undefined;
      return {
        isCurrent: () => composer.current === handle,
        append: (text) => handle.appendText(text),
      };
    },
  };
}
