/**
 * Composer Skills button (PR-COMPOSER-TOOLBAR-SPLIT) — the standalone toolbar
 * affordance for choosing Skills. Until now Skills were reachable only by
 * typing `/` in the textarea, which is discoverable once you know it exists
 * and invisible otherwise. This button surfaces the same structured selection
 * the `/` popup produces (`useComposerSkillDraft` chips), so both paths
 * converge on one draft state instead of a second selection model.
 *
 * The panel is an ABSOLUTE overlay anchored to its own trigger wrapper and
 * bottom-anchored above it, so it never grows the composer box
 * (composer-constant-footprint-contract), same discipline as the mention popup.
 *
 * Interaction: click the trigger to open, type to filter, click a row to
 * toggle, Esc or an outside click to close. Rows are `role="checkbox"`
 * buttons — multi-select with no implicit send, matching the human-in-the-loop
 * rule the `/` popup already follows.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconButton } from '@astryxdesign/core';
import { Check, Search, Sparkles } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface ComposerSkillOption {
  /** Stable scope-aware ref; falls back to `id` for older catalog entries. */
  ref?: string;
  id: string;
  name: string;
  description?: string;
}

/** Selection identity — the same `ref ?? id` key the skill draft dedupes on. */
export function composerSkillKey(skill: { ref?: string; id: string }): string {
  return (skill.ref ?? skill.id).toLowerCase();
}

/** Case-insensitive id/name/description filter for the panel's search field. */
export function filterComposerSkills<T extends ComposerSkillOption>(
  skills: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...skills];
  return skills.filter((skill) =>
    `${skill.id} ${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(needle),
  );
}

export function ComposerSkillPicker(props: {
  skills: readonly ComposerSkillOption[];
  selected: readonly { ref?: string; id: string; name: string }[];
  disabled?: boolean;
  onToggle(skill: ComposerSkillOption, selected: boolean): void;
  /** Select every skill currently visible under the search filter. */
  onSelectAll(skills: readonly ComposerSkillOption[]): void;
  onClearAll(): void;
}) {
  const copy = getConversationCopy(useUiLocale()).composer.skillPicker;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Stop here so Esc closing the panel can't also interrupt a stream or
      // clear an unrelated overlay behind it.
      event.stopPropagation();
      setOpen(false);
      // Focus came from the trigger and must go back to it — otherwise a
      // keyboard user lands at the top of the document after dismissing.
      triggerRef.current?.focus();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const selectedKeys = useMemo(
    () => new Set(props.selected.map(composerSkillKey)),
    [props.selected],
  );
  const visible = useMemo(
    () => filterComposerSkills(props.skills, query),
    [props.skills, query],
  );
  const selectedCount = props.selected.length;
  const allVisibleSelected =
    visible.length > 0 && visible.every((skill) => selectedKeys.has(composerSkillKey(skill)));

  return (
    <div className="maka-composer-skill-picker" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        variant="ghost"
        type="button"
        size="sm"
        className="maka-composer-skill-trigger"
        data-open={open ? 'true' : undefined}
        data-selected={selectedCount > 0 ? 'true' : undefined}
        isDisabled={props.disabled}
        label={copy.label}
        tooltip={selectedCount > 0 ? copy.selectedCount(selectedCount) : copy.title}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        icon={<Sparkles size={15} aria-hidden="true" />}
      />
      {selectedCount > 0 ? (
        <span className="maka-composer-skill-trigger-count" aria-hidden="true">
          {selectedCount}
        </span>
      ) : null}
      {open ? (
        <div
          id={panelId}
          // A labelled group, NOT role="dialog": dialog semantics belong to
          // the Astryx Dialog primitive that owns focus trapping, Escape and
          // the top layer (dialog-source-contract). This is a disclosure the
          // trigger's aria-expanded/aria-controls already describe.
          role="group"
          aria-label={copy.panelAriaLabel}
          className="maka-composer-skill-panel z-[var(--z-overlay)] rounded-md bg-popover text-popover-foreground shadow-maka-panel"
        >
          <div className="maka-composer-skill-panel-header">
            <span className="maka-composer-skill-panel-hint">{copy.autoHint}</span>
            <div className="maka-composer-skill-panel-actions">
              <button
                type="button"
                className="maka-composer-skill-panel-action"
                disabled={visible.length === 0 || allVisibleSelected}
                onClick={() => props.onSelectAll(visible)}
              >
                {copy.selectAll}
              </button>
              <button
                type="button"
                className="maka-composer-skill-panel-action"
                disabled={selectedCount === 0}
                onClick={() => props.onClearAll()}
              >
                {copy.clearAll}
              </button>
            </div>
          </div>
          <div className="maka-composer-skill-panel-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              className="maka-composer-skill-panel-search-input"
              placeholder={copy.searchPlaceholder}
              aria-label={copy.searchPlaceholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          {/* The list carries no aria-label of its own — the group above
              already names the region, and a second identical label doubles
              the announcement on entry. */}
          {visible.length === 0 ? (
            <div className="maka-composer-skill-panel-status">
              {props.skills.length === 0 ? copy.empty : copy.noMatches}
            </div>
          ) : (
            <ul className="maka-composer-skill-panel-list">
              {visible.map((skill) => {
                const key = composerSkillKey(skill);
                const checked = selectedKeys.has(key);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      data-checked={checked ? 'true' : undefined}
                      className="maka-composer-skill-panel-option"
                      onClick={() => props.onToggle(skill, !checked)}
                    >
                      <span className="maka-composer-skill-panel-box" aria-hidden="true">
                        {checked ? <Check size={11} aria-hidden="true" /> : null}
                      </span>
                      <span className="maka-composer-skill-panel-text">
                        <span className="maka-composer-skill-panel-name">{skill.name}</span>
                        <span className="maka-composer-skill-panel-secondary">
                          {skill.description ?? skill.id}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
