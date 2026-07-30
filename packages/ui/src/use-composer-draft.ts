/**
 * Composer draft-persistence hook (issue #1044).
 *
 * Owns the per-session unsent-draft store that used to live inline in
 * `composer.tsx`: a bounded Map keyed by `draftKey`, the active key, and the
 * `hasDraftText` flag that gates the send button. The pure store operations
 * (remember / read, with the 120k-char and 32-entry bounds) stay in
 * `composer-helpers.ts` — this hook is the React seam that wires them to the
 * uncontrolled textarea.
 *
 * The swap effect preserves the exact pre-extraction semantics: when the host
 * switches `draftKey` (e.g. the first send in the home composer creates a
 * session and the surface re-keys), the textarea value is remembered under
 * the OLD key, the draft for the NEW key is swapped in, and the caret lands
 * at the end. `onDraftKeyChange` lets the composer reset sibling state
 * machines (prompt-history navigation) at the same moment without this hook
 * depending on them.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  appendPromptContextDraft,
  readComposerDraft,
  rememberComposerDraft,
} from './composer-helpers.js';

export interface ComposerDraftApi {
  /** True while the active draft holds non-whitespace text (gates Send). */
  hasDraftText: boolean;
  /**
   * Persist the current (or given) textarea value under the active draft key
   * and refresh `hasDraftText`.
   */
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
  /** The key the current textarea content is persisted under. */
  activeDraftKey(): string | undefined;
}

export function useComposerDraft(input: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Runtime-only key used to keep unsent drafts isolated per session. */
  draftKey: string | undefined;
  /** Re-measure the textarea after a programmatic value swap. */
  autoResize(): void;
  /** Fired after the active key swaps so sibling state machines can reset. */
  onDraftKeyChange(): void;
}): ComposerDraftApi {
  const [hasDraftText, setHasDraftText] = useState(false);
  const draftStoreRef = useRef<Map<string, string>>(new Map());
  const activeDraftKeyRef = useRef<string | undefined>(input.draftKey);

  function saveCurrentDraft(value?: string) {
    const nextValue = value ?? input.textareaRef.current?.value ?? '';
    rememberComposerDraft(draftStoreRef.current, activeDraftKeyRef.current, nextValue);
    setHasDraftText(Boolean(nextValue.trim()));
  }

  function clearDraft(key: string | undefined) {
    rememberComposerDraft(draftStoreRef.current, key, '');
  }

  function setDraft(key: string | undefined, value: string) {
    rememberComposerDraft(draftStoreRef.current, key, value);
    if (activeDraftKeyRef.current === key) setHasDraftText(Boolean(value.trim()));
  }

  function appendDraft(key: string | undefined, value: string) {
    const current =
      activeDraftKeyRef.current === key
        ? (input.textareaRef.current?.value ?? '')
        : readComposerDraft(draftStoreRef.current, key);
    const next = appendPromptContextDraft(current, value);
    setDraft(key, next);
    return next;
  }

  function activeDraftKey() {
    return activeDraftKeyRef.current;
  }

  useEffect(() => {
    const el = input.textareaRef.current;
    const previousKey = activeDraftKeyRef.current;
    const nextKey = input.draftKey;

    if (previousKey !== nextKey) {
      rememberComposerDraft(draftStoreRef.current, previousKey, el?.value ?? '');
      activeDraftKeyRef.current = nextKey;
      input.onDraftKeyChange();
      if (el) {
        const nextDraft = readComposerDraft(draftStoreRef.current, nextKey);
        el.value = nextDraft;
        setHasDraftText(Boolean(nextDraft.trim()));
        input.autoResize();
        const length = el.value.length;
        el.setSelectionRange(length, length);
      }
    }
  }, [input.draftKey]);

  return {
    hasDraftText,
    saveCurrentDraft,
    clearDraft,
    setDraft,
    appendDraft,
    activeDraftKey,
  };
}
