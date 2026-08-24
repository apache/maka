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

/**
 * Composer prompt-history navigation hook (issue #1044).
 *
 * Owns the up/down-arrow recall state that used to live inline in
 * `composer.tsx`: the in-memory mirror of the global input history plus the
 * "mid-navigation" index/savedDraft pair. The pure state machine
 * (`navigateComposerHistory`, `reconcileHistorySync`,
 * `rememberComposerHistoryEntry`) stays in `composer-helpers.ts` and the
 * localStorage seam in `input-history.ts` — both unit-tested there. This hook
 * is the React seam that applies navigation results through the input's
 * `ComposerTextPort`.
 *
 * `ChatComposerInput` ships its own arrow-key recall, but that history is
 * in-memory per mount, unconditional on the draft, and has no deletion story.
 * Ours is persisted across reloads, shared with every other input surface,
 * clearable from Settings · 数据, and refuses to hijack the caret inside a
 * multi-line draft — so the composer mounts the input with `hasHistory={false}`
 * and keeps this.
 */

import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { ComposerTextPort } from './chat-input-behavior.js';
import {
  type ComposerHistoryState,
  navigateComposerHistory,
  reconcileHistorySync,
  rememberComposerHistoryEntry,
} from './composer-helpers.js';
import {
  readGlobalInputHistory,
  saveGlobalInputHistoryEntry,
  subscribeGlobalInputHistory,
} from './input-history.js';

export interface ComposerHistoryApi {
  /**
   * Drop back to "not navigating" (index -1, no saved draft). Any real edit,
   * send, or programmatic text set calls this so the next arrow-up starts
   * from the newest entry again.
   */
  resetNavigation(): void;
  /**
   * Record a successfully-sent prompt into both the in-memory list and the
   * persisted global history (shared across input surfaces, survives reloads).
   */
  rememberSentEntry(text: string): void;
  /**
   * PR-GLOBAL-INPUT-HISTORY: up/down arrow navigates the global input
   * history. Bare arrow keys only start navigation when the input is empty,
   * or when the user is already mid-navigation (index >= 0); in a multi-line
   * draft the caret keeps moving so editing isn't hijacked. Ctrl/Cmd +
   * ArrowUp/ArrowDown is an explicit shortcut that always navigates history
   * regardless of the current draft.
   *
   * Returns true when the keystroke was consumed (a navigation applied, or
   * deliberately swallowed because history is empty) and the caller must
   * stop further key handling.
   */
  handleArrowKey(event: KeyboardEvent<Element>): boolean;
}

export function useComposerHistory(input: {
  text: ComposerTextPort;
  /** Persist the applied value under the active draft key. */
  saveCurrentDraft(value?: string): void;
}): ComposerHistoryApi {
  const promptHistoryRef = useRef<ComposerHistoryState>({ entries: readGlobalInputHistory() ?? [], index: -1, savedDraft: '' });
  // The subscription is registered once, so anything it calls must be reached
  // through the latest render rather than captured from the first. Today the
  // pieces that matter happen to be ref-backed — the text port is created once
  // and the draft key is read from a ref at call time — but that is a property
  // of the current draft hook, not of this subscription, and it is not a
  // property this file can see changing.
  const applyValueRef = useRef((value: string) => {
    input.text.setValue(value);
    input.saveCurrentDraft(value);
  });
  useEffect(() => {
    applyValueRef.current = applyValue;
  });

  useEffect(() => subscribeGlobalInputHistory(() => {
    // Through `reconcileHistorySync`, not a bare `entries` swap: the whole
    // state has to agree with storage, and a clear is exactly when it would
    // not. Mid-navigation the index still pointed into a list that no longer
    // has those entries, so the composer went on showing a prompt the user had
    // just deleted, with their own draft stranded in `savedDraft` until an
    // arrow key happened to reconcile it. The pure state machine already knows
    // all of this — including when the draft is owed back.
    const { state, restoreDraft } = reconcileHistorySync(
      promptHistoryRef.current,
      readGlobalInputHistory(),
    );
    promptHistoryRef.current = state;
    if (restoreDraft) applyValueRef.current(state.savedDraft);
  }), []);

  function resetNavigation() {
    promptHistoryRef.current = {
      entries: promptHistoryRef.current.entries,
      index: -1,
      savedDraft: '',
    };
  }

  function rememberSentEntry(text: string) {
    // Save to both local ref and global persistence so the history
    // survives page reloads and is shared across all input surfaces.
    saveGlobalInputHistoryEntry(text);
    promptHistoryRef.current = {
      entries: rememberComposerHistoryEntry(promptHistoryRef.current.entries, text),
      index: -1,
      savedDraft: '',
    };
  }

  function applyValue(value: string) {
    input.text.setValue(value);
    input.saveCurrentDraft(value);
  }

  function handleArrowKey(event: KeyboardEvent<Element>): boolean {
    const explicit = Boolean(event.ctrlKey || event.metaKey);
    const plainArrow = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (!plainArrow && !explicit) return false;
    const current = input.text.getValue();
    const isNavigatingHistory = promptHistoryRef.current.index >= 0;
    const canStartHistory = !current.trim();
    if (!(explicit || isNavigatingHistory || canStartHistory)) return false;
    // Re-read global history from localStorage on every navigation so
    // a clear from Settings (an overlay that keeps the Composer
    // mounted) is picked up immediately, and a transient storage
    // failure does not clobber the in-memory history.
    // reconcileHistorySync restores the saved draft if a clear happened
    // mid-navigation (so the user doesn't lose what they were typing).
    const synced = readGlobalInputHistory();
    const { state, restoreDraft } = reconcileHistorySync(promptHistoryRef.current, synced);
    promptHistoryRef.current = state;
    if (restoreDraft) {
      applyValue(state.savedDraft);
    }
    // Nothing to navigate when history was cleared (synced empty) — the
    // keystroke is swallowed so it can't fall through to other handlers.
    // When the storage read failed (synced === null), keep navigating
    // with the in-memory entries.
    if (synced !== null && synced.length === 0) return true;
    const next = navigateComposerHistory(
      promptHistoryRef.current,
      event.key === 'ArrowUp' ? 'previous' : 'next',
      current,
    );
    if (!next.changed) return false;
    event.preventDefault();
    promptHistoryRef.current = next.state;
    applyValue(next.value);
    return true;
  }

  return { resetNavigation, rememberSentEntry, handleArrowKey };
}
