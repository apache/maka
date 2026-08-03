/**
 * Composer draft-persistence hook (issue #1044).
 *
 * Owns the per-session unsent-draft store that used to live inline in
 * `composer.tsx`: a bounded Map keyed by `draftKey` and the active key.
 * The pure store operations
 * (remember / read, with the 120k-char and 32-entry bounds) stay in
 * `composer-helpers.ts` — this hook is the React seam that wires them to the
 * input's `ComposerTextPort`.
 *
 * The swap effect preserves the exact pre-extraction semantics: when the host
 * switches `draftKey` (e.g. the first send in the home composer creates a
 * session and the surface re-keys), the current text is remembered under the
 * OLD key and the draft for the NEW key is swapped in. `onDraftKeyChange` lets
 * the composer reset sibling state machines (prompt-history navigation) at the
 * same moment without this hook depending on them.
 */

import { useEffect, useRef } from 'react';
import type { ComposerTextPort } from './chat-input-behavior.js';
import {
  appendPromptContextDraft,
  readComposerDraft,
  rememberComposerDraft,
} from './composer-helpers.js';

export interface ComposerDraftApi {
  /** Persist the current (or given) input value under the active draft key. */
  saveCurrentDraft(value?: string): void;
  /**
   * Clear the draft stored under an explicit key. A successful send clears
   * the key it was submitted from (which may no longer be the active key
   * after a new-session swap) in addition to the active draft.
   */
  clearDraft(key: string | undefined): void;
  /** Persist text under an explicit session key before the host switches it. */
  setDraft(key: string | undefined, value: string): void;
  /** Append text under an explicit session key without overwriting its draft. */
  appendDraft(key: string | undefined, value: string): string;
  /** The key the current input content is persisted under. */
  activeDraftKey(): string | undefined;
}

export function useComposerDraft(input: {
  text: ComposerTextPort;
  /** Runtime-only key used to keep unsent drafts isolated per session. */
  draftKey: string | undefined;
  /** Fired after the active key swaps so sibling state machines can reset. */
  onDraftKeyChange(): void;
}): ComposerDraftApi {
  const draftStoreRef = useRef<Map<string, string>>(new Map());
  const activeDraftKeyRef = useRef<string | undefined>(input.draftKey);

  function saveCurrentDraft(value?: string) {
    const nextValue = value ?? input.text.getValue();
    rememberComposerDraft(draftStoreRef.current, activeDraftKeyRef.current, nextValue);
  }

  function clearDraft(key: string | undefined) {
    rememberComposerDraft(draftStoreRef.current, key, '');
  }

  function setDraft(key: string | undefined, value: string) {
    rememberComposerDraft(draftStoreRef.current, key, value);
  }

  function appendDraft(key: string | undefined, value: string) {
    const current =
      activeDraftKeyRef.current === key
        ? input.text.getValue()
        : readComposerDraft(draftStoreRef.current, key);
    const next = appendPromptContextDraft(current, value);
    setDraft(key, next);
    return next;
  }

  function activeDraftKey() {
    return activeDraftKeyRef.current;
  }

  useEffect(() => {
    const previousKey = activeDraftKeyRef.current;
    const nextKey = input.draftKey;
    if (previousKey === nextKey) return;

    rememberComposerDraft(draftStoreRef.current, previousKey, input.text.getValue());
    activeDraftKeyRef.current = nextKey;
    input.onDraftKeyChange();
    const nextDraft = readComposerDraft(draftStoreRef.current, nextKey);
    input.text.setValue(nextDraft);
  }, [input.draftKey]);

  return {
    saveCurrentDraft,
    clearDraft,
    setDraft,
    appendDraft,
    activeDraftKey,
  };
}
