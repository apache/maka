/**
 * Composer `@` file / `/` skill mention-popup state machine (issue #1044).
 *
 * Owns the trigger detection + popup state that used to live inline in
 * `composer.tsx`: the active trigger + query, the filtered items, the
 * highlighted index, and the post-insertion suppression snapshot. The popup
 * overlay itself stays presentational (`composer-mention-popup.tsx`); the
 * keyboard routing (arrows / Enter / Tab / Esc) stays in Composer's
 * onTextareaKeyDown, which drives this hook's API — that ordering is pinned
 * by the composer-mention contract.
 *
 * The whole hook stays inert unless the matching provider prop is present
 * (`onSearchMentionFiles` for `@`, `mentionSkills` for `/`), so the SSR
 * contracts (minimal props) render nothing here. See
 * docs/archive/composer-mentions-spec-2026-07-14.md for the v1 plain-text
 * model.
 */

import { useEffect, useId, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  detectMentionTrigger,
  mentionQueryMatches,
  skillMentionQuery,
  type MentionTrigger,
} from './chat-input-behavior.js';
import type { MentionItem } from './composer-mention-popup.js';

export interface ComposerMentionApi {
  /** The active trigger + query + trigger-char index; null when closed. */
  mention: MentionTrigger | null;
  /** Items shown in the popup for the active trigger. */
  mentionItems: readonly MentionItem[];
  /** Highlighted row; wrap-around navigation lives in Composer's keydown. */
  mentionActiveIndex: number;
  setMentionActiveIndex: Dispatch<SetStateAction<number>>;
  /** True while the debounced `@` file search is in flight. */
  mentionLoading: boolean;
  /** Listbox id the textarea's aria-controls / aria-activedescendant point at. */
  mentionListboxId: string;
  /** Derived: a trigger is active and the popup is rendered. */
  mentionPopupOpen: boolean;
  /**
   * Re-detect the active mention trigger from the live textarea value +
   * caret. Called on input, keyup, and document selectionchange so clicking
   * elsewhere (or moving the caret out of a trigger) closes the popup.
   */
  recomputeMention(): void;
  /** Close the popup and clear its transient state. */
  closeMention(): void;
  /** Splice the chosen item's plain-text token into the textarea. */
  selectMention(index: number): void;
}

export function useMentionPopup(input: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** ENABLED skills offered by the `/` popup; undefined disables that popup. */
  mentionSkills?: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
  /** Workspace-file search backing the `@` popup; undefined disables it. */
  onSearchMentionFiles?(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
  /** Persist the post-insertion value under the active draft key. */
  saveCurrentDraft(value?: string): void;
  /** Re-measure the textarea after the insertion changes its height. */
  autoResize(): void;
  /** Inserting a mention is an edit: history navigation restarts. */
  resetPromptHistoryNavigation(): void;
  /** Structured Skill selection; unlike file mentions it is not serialized into text. */
  onSelectSkill?(skill: { ref?: string; id: string; name: string }): void;
}): ComposerMentionApi {
  // Mention popup state (@ file / skill). `mention` holds the active trigger +
  // query + trigger-char index; items/loading/activeIndex drive the popup. The
  // whole block stays inert unless the matching provider prop is present, so
  // the SSR contracts (minimal props) render nothing here.
  const [mention, setMention] = useState<MentionTrigger | null>(null);
  const [mentionItems, setMentionItems] = useState<readonly MentionItem[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionLoading, setMentionLoading] = useState(false);
  const mentionListboxId = useId();
  // Exact post-insertion snapshot: after we splice in a token the value can
  // still parse as a valid trigger (e.g. `@file.txt ` — one trailing space),
  // which would immediately re-open the popup. Suppress detection for that one
  // state only; any further edit or caret move clears it and detection resumes.
  const mentionSuppressRef = useRef<{ value: string; caret: number } | null>(null);
  const recomputeMentionRef = useRef<() => void>(() => {});
  const mentionPopupOpen = mention !== null;

  function closeMention() {
    setMention(null);
    setMentionItems([]);
    setMentionActiveIndex(0);
    setMentionLoading(false);
  }

  function recomputeMention() {
    const el = input.textareaRef.current;
    if (!el) return;
    // Only the focused textarea drives the popup — a selectionchange from
    // another field, or a blur, should close it.
    if (typeof document !== 'undefined' && document.activeElement !== el) {
      if (mentionPopupOpen) closeMention();
      return;
    }
    const caret = el.selectionEnd ?? el.value.length;
    const suppress = mentionSuppressRef.current;
    if (suppress && suppress.value === el.value && suppress.caret === caret) {
      if (mentionPopupOpen) closeMention();
      return;
    }
    mentionSuppressRef.current = null;
    const result = detectMentionTrigger(el.value, caret);
    // Gate on provider presence so the feature no-ops when a popup has nothing
    // to render (keeps the SSR/minimal-props path inert).
    if (!result
      || (result.trigger === '@' && !input.onSearchMentionFiles)
      || (result.trigger === '/' && input.mentionSkills === undefined)) {
      if (mentionPopupOpen) closeMention();
      return;
    }
    setMention((prev) =>
      prev && prev.trigger === result.trigger && prev.query === result.query && prev.start === result.start
        ? prev
        : result,
    );
  }
  recomputeMentionRef.current = recomputeMention;

  function selectMention(index: number) {
    const el = input.textareaRef.current;
    const current = mention;
    if (!el || !current) return;
    const item = mentionItems[index];
    if (!item) return;
    const value = el.value;
    const caret = el.selectionEnd ?? value.length;
    if (item.type === 'skill') {
      const nextValue = `${value.slice(0, current.start)}${value.slice(caret)}`;
      input.resetPromptHistoryNavigation();
      el.value = nextValue;
      el.setSelectionRange(current.start, current.start);
      closeMention();
      input.onSelectSkill?.({
        ...(item.ref ? { ref: item.ref } : {}),
        id: item.id,
        name: item.name,
      });
      input.saveCurrentDraft(nextValue);
      input.autoResize();
      el.focus();
      return;
    }
    const insertion = `@${item.relativePath} `;
    // Replace [start, caret): the trigger char (at `start`) through the caret,
    // i.e. the `@query` / `/query` the user typed, with the plain-text token.
    const nextValue = value.slice(0, current.start) + insertion + value.slice(caret);
    const nextCaret = current.start + insertion.length;
    input.resetPromptHistoryNavigation();
    el.value = nextValue;
    el.setSelectionRange(nextCaret, nextCaret);
    mentionSuppressRef.current = { value: nextValue, caret: nextCaret };
    closeMention();
    input.saveCurrentDraft(nextValue);
    input.autoResize();
    el.focus();
  }

  // Populate the popup for the active trigger: skills filter synchronously from
  // props; files search through the (debounced) IPC-backed callback.
  useEffect(() => {
    if (!mention) {
      setMentionItems([]);
      setMentionLoading(false);
      return;
    }
    if (mention.trigger === '/') {
      const skills = input.mentionSkills ?? [];
      const query = skillMentionQuery(mention.query);
      const items: MentionItem[] = skills
        .filter((skill) =>
          mentionQueryMatches(query, `${skill.id} ${skill.name} ${skill.description ?? ''}`),
        )
        .slice(0, 50)
        .map((skill) => ({
          type: 'skill',
          ...(skill.ref ? { ref: skill.ref } : {}),
          id: skill.id,
          name: skill.name,
          description: skill.description,
        }));
      setMentionItems(items);
      setMentionActiveIndex(0);
      setMentionLoading(false);
      return undefined;
    }
    const search = input.onSearchMentionFiles;
    if (!search) {
      setMentionItems([]);
      setMentionLoading(false);
      return undefined;
    }
    let cancelled = false;
    setMentionLoading(true);
    setMentionActiveIndex(0);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const files = await search(mention.query);
          if (cancelled) return;
          const items: MentionItem[] = files
            .filter((file) => mentionQueryMatches(mention.query, file.relativePath))
            .slice(0, 50)
            .map((file) => ({ type: 'file', relativePath: file.relativePath }));
          setMentionItems(items);
        } catch {
          // Fail soft: an IPC error just yields an empty list (未找到文件).
          if (!cancelled) setMentionItems([]);
        } finally {
          if (!cancelled) setMentionLoading(false);
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention, input.mentionSkills, input.onSearchMentionFiles]);

  // Caret-move detection: a plain click or arrow that moves the caret out of a
  // trigger fires selectionchange (not input), so listen for it while mounted.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onSelectionChange = () => recomputeMentionRef.current();
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  return {
    mention,
    mentionItems,
    mentionActiveIndex,
    setMentionActiveIndex,
    mentionLoading,
    mentionListboxId,
    mentionPopupOpen,
    recomputeMention,
    closeMention,
    selectMention,
  };
}
