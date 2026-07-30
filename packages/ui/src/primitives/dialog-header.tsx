// packages/ui/src/primitives/dialog-header.tsx
//
// Shared header recipe for TITLED DialogContent modals (keyboard-help,
// search modal, and any other DialogContent that carried an ad-hoc header).
// One language everywhere:
//   - a single title row: optional leading icon (16px, muted ink),
//     title text (--font-size-ui, semibold, --foreground), a spacer, and
//     exactly one close button.
//   - the close button is the SAME quiet icon-sm Button + X icon with
//     aria-label="关闭" — NO border box, no eyebrow, no second title.
//
// Palette-style modals whose input row IS the header (command-palette) do
// NOT use this — they are intentionally headerless. `subtitle` covers
// modals with one line of instructional copy under the title (wechat QR
// login); high-density in-flow prompts keep their own compact headers.
//
// Self-contained styling: the header is styled with Tailwind utility classes
// so the primitive is portable across packages and needs no consumer CSS.

import type { ReactNode } from 'react';
import { X } from '../icons.js';
import { Button } from '../ui.js';
import { useUiLocale } from '../locale-context.js';
import { getShellControlsCopy } from '../shell-controls-copy.js';

export interface DialogHeaderProps {
  /** Optional leading glyph, rendered at 16px in muted ink. */
  icon?: ReactNode;
  /** Title text. Rendered as an <h2> at --font-size-ui, semibold. */
  title: ReactNode;
  /** Id applied to the title <h2> so DialogContent aria-labelledby can point at it. */
  titleId?: string;
  /** Optional single-line instructional copy under the title (muted, --font-size-ui). */
  subtitle?: ReactNode;
  /** Close handler wired to the quiet icon-sm close button. */
  onClose(): void;
  /** Accessible label for the close button. Defaults to the shared "关闭". */
  closeLabel?: string;
}

export function DialogHeader({ icon, title, titleId, subtitle, onClose, closeLabel }: DialogHeaderProps) {
  const copy = getShellControlsCopy(useUiLocale());
  return (
    <header
      className="flex items-start gap-2 border-b border-border px-4 py-2.5"
      data-slot="dialog-header"
    >
      {icon != null && (
        <span
          className="flex h-5 shrink-0 items-center text-muted-foreground [&>svg]:h-4 [&>svg]:w-4"
          aria-hidden="true"
          data-slot="dialog-header-icon"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1" data-slot="dialog-header-copy">
        <h2
          id={titleId}
          className="min-w-0 truncate text-[length:var(--font-size-ui)] font-semibold leading-5 text-foreground"
          data-slot="dialog-header-title"
        >
          {title}
        </h2>
        {subtitle != null && (
          <p
            className="mt-0.5 text-[length:var(--font-size-ui)] leading-normal text-muted-foreground"
            data-slot="dialog-header-subtitle"
          >
            {subtitle}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        aria-label={closeLabel ?? copy.shared.close}
        onClick={onClose}
        data-slot="dialog-header-close"
      >
        <X aria-hidden="true" />
      </Button>
    </header>
  );
}
