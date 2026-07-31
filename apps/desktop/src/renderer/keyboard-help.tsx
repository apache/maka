// apps/desktop/src/renderer/keyboard-help.tsx
//
// Discoverable keyboard cheat sheet. Modal triggered by `?` (when no input is
// focused) or `⌘/` / `Ctrl+/`. Lists every shortcut the renderer reacts to so
// users don't need to scrape the README. Routed through Base UI Dialog
// (DialogRoot + DialogContent) so focus trapping, Esc, and focus restoration
// are handled by the same shell as SearchModal / Permission (#520 PR7).

import { useEffect, useState } from 'react';
import { Keyboard } from '@maka/ui/icons';
import { DialogContent, DialogHeader, DialogRoot, Kbd, useUiLocale } from '@maka/ui';
import { getShellCopy } from './locales/shell-copy';

/**
 * Manages the global key listener that opens and closes the help modal.
 * Returned tuple gives callers the current open state and an imperative
 * close function for the rendered modal.
 */
/**
 * Manages the global key listener that opens and closes the help modal.
 *
 * PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
 * `2844f64f`): the `openHelp` third tuple element added in commit
 * 2 is RETAINED — the Command Palette `查看快捷键` entry uses it
 * to open the modal without dispatching synthetic KeyboardEvent's.
 * The sidebar chip that originally needed it is removed; the
 * Command Palette is the new caller.
 */
export function useKeyboardHelp(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) {
        if (event.key === '/' || event.key === '?') {
          event.preventDefault();
          setOpen((prev) => !prev);
        }
        return;
      }
      if (event.key !== '?') return;
      // Skip if the user is typing in a text field so `?` still types.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return [open, () => setOpen(false), () => setOpen(true)];
}

export function KeyboardHelpModal(props: { onClose(): void }) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).keyboardHelp;
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="maka-help-modal"
        width={560}
        maxHeight="calc(100dvh - 96px)"
      >
        <DialogHeader
          icon={<Keyboard aria-hidden="true" />}
          title={copy.title}
          onClose={props.onClose}
        />
        <div className="maka-help-body">
          {copy.sections.map((section) => (
            <section key={section.heading} className="maka-help-section">
              <h3>{section.heading}</h3>
              <dl>
                {section.rows.map((row) => (
                  <div key={row.description}>
                    <dt>{row.description}</dt>
                    <dd>
                      {row.keys.map((key, index) => (
                        <span key={`${row.description}:${key}:${index}`}>
                          {index > 0 && (
                            <span className="maka-help-plus" aria-hidden="true">
                              +
                            </span>
                          )}
                          <Kbd>{key}</Kbd>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
