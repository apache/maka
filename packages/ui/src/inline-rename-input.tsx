import { useEffect, useRef } from 'react';

/**
 * The rename-in-place text field: focus-and-select on mount, Enter commits,
 * Escape cancels, blur commits.
 *
 * Its one caller is the titlebar breadcrumb — renaming from the sidebar goes
 * through a dialog instead, because a `SideNavItem` row is a single `<button>`
 * that no text field may live inside. It stays a component of its own for the
 * two non-obvious parts, which are the whole reason this is not four lines of
 * JSX at the call site:
 *
 * - `escapeCancelledRef` — Escape moves focus off the field, so the blur
 *   handler would fire right behind the cancel and commit the very edit that
 *   was just abandoned. The flag lets the blur that Escape caused pass through
 *   without committing, and is cleared so a later real blur still commits.
 * - the `isComposing` / `'Process'` guard — a Chinese, Japanese, or Korean IME
 *   sends Enter to accept its candidate. Without the guard that keystroke
 *   commits a half-typed name and closes the field mid-word.
 *
 * Uncontrolled by design: the value belongs to the DOM for the life of the
 * edit, and the caller only ever hears the final string. There is no state to
 * synchronize and no re-render per keystroke.
 */
export function InlineRenameInput(props: {
  defaultValue: string;
  ariaLabel: string;
  /**
   * How the edit ended. The caller needs it to decide where focus goes: a
   * keyboard exit should hand focus back to the control that opened the field,
   * but a click-away already put it somewhere the user chose, and taking it
   * back would be the field fighting the click.
   */
  /** The field's whole appearance: it draws nothing of its own. */
  className: string;
  onCommit(name: string, via: 'keyboard' | 'blur'): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className={props.className}
      defaultValue={props.defaultValue}
      maxLength={80}
      aria-label={props.ariaLabel}
      onBlur={(event) => {
        if (escapeCancelledRef.current) {
          escapeCancelledRef.current = false;
          return;
        }
        props.onCommit(event.currentTarget.value.trim(), 'blur');
      }}
      onKeyDown={(event) => {
        // The sidebar and the titlebar both sit under keyboard shortcuts that
        // would otherwise read these keystrokes as navigation.
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.key === 'Process') return;
        if (event.key === 'Enter') {
          event.preventDefault();
          props.onCommit(event.currentTarget.value.trim(), 'keyboard');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          escapeCancelledRef.current = true;
          props.onCancel();
        }
      }}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
