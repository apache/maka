/**
 * Composer `@` file / `/` skill mention popup — a presentational overlay
 * rendered by Composer while a trigger is active. See
 * docs/archive/composer-mentions-spec-2026-07-14.md for the v1 plain-text model.
 *
 * All state (which trigger, the filtered items, the highlighted index) lives in
 * Composer; this component only paints the list and forwards hover/click to
 * select. Keyboard navigation (arrows / Enter / Tab / Esc) is handled in
 * Composer's onTextareaKeyDown so it can intercept before the send branch.
 *
 * It is an ABSOLUTE overlay anchored to the composer inner container
 * (bottom-anchored above the textarea) so it never grows the composer box
 * (composer-constant-footprint-contract). a11y follows the search modal's
 * listbox/option pattern: the popup is role="listbox", each row role="option"
 * with a stable id, and Composer points the textarea's aria-activedescendant at
 * the active row while open.
 */

import { FileText, Sparkles } from './icons.js';
import { cn } from './utils.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface MentionFileItem {
  type: 'file';
  relativePath: string;
}

export interface MentionSkillItem {
  type: 'skill';
  ref?: string;
  id: string;
  name: string;
  description?: string;
}

export type MentionItem = MentionFileItem | MentionSkillItem;

export function mentionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}

export function ComposerMentionPopup(props: {
  trigger: '@' | '/';
  items: ReadonlyArray<MentionItem>;
  activeIndex: number;
  loading?: boolean;
  listboxId: string;
  /** Fired when a row is clicked (mouse select). */
  onSelect(index: number): void;
  /** Fired when the pointer moves over a row so hover tracks the highlight. */
  onHover(index: number): void;
}) {
  const { trigger, items, activeIndex, loading, listboxId } = props;
  const copy = getConversationCopy(useUiLocale()).mentions;
  const emptyLabel = trigger === '@' ? copy.noFiles : copy.noSkills;

  return (
    <div
      className={cn(
        'maka-composer-mention-popup',
        'z-[var(--z-overlay)] rounded-md bg-popover text-popover-foreground shadow-maka-panel',
      )}
      role="listbox"
      id={listboxId}
      aria-label={trigger === '@' ? copy.filesAriaLabel : copy.skillsAriaLabel}
    >
      {loading ? (
        <div className="maka-composer-mention-status">{copy.loading}</div>
      ) : items.length === 0 ? (
        <div className="maka-composer-mention-status">{emptyLabel}</div>
      ) : (
        <ul className="maka-composer-mention-list">
          {items.map((item, index) => {
            const active = index === activeIndex;
            const key = item.type === 'file' ? `f:${item.relativePath}` : `s:${item.ref ?? item.id}`;
            return (
              <li key={key}>
                {/* Row is a plain div (not a button) so a click never submits
                    the form or steals focus from the textarea — Composer keeps
                    the caret and splices the insertion itself. */}
                <div
                  id={mentionOptionId(listboxId, index)}
                  role="option"
                  aria-selected={active}
                  data-active={active ? 'true' : undefined}
                  className="maka-composer-mention-option"
                  // Use onMouseDown (not onClick) with preventDefault so the
                  // textarea never blurs before we splice the value.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    props.onSelect(index);
                  }}
                  onMouseMove={() => {
                    if (!active) props.onHover(index);
                  }}
                >
                  {item.type === 'file' ? (
                    <FileText size={14} aria-hidden="true" className="maka-composer-mention-icon" />
                  ) : (
                    <Sparkles size={14} aria-hidden="true" className="maka-composer-mention-icon" />
                  )}
                  <span className="maka-composer-mention-text">
                    <span className="maka-composer-mention-name">
                      {item.type === 'file' ? fileBasename(item.relativePath) : item.name}
                    </span>
                    <span className="maka-composer-mention-secondary">
                      {item.type === 'file'
                        ? item.relativePath
                        : `${item.id}${item.description ? ` · ${item.description}` : ''}`}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Last path segment of a POSIX-style relative path for the primary row label. */
function fileBasename(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}
