import { useLayoutEffect, useRef, useState } from 'react';
import { TextQuote, X } from './icons.js';
import { cn } from './utils.js';
import type { QuoteRef } from '@maka/core';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/**
 * Inline quoted-excerpt chip, shown inside the composer (removable) and inside
 * a sent user message (read-only). A single-line pill rather than a card: a
 * quote is a *reference*, so it should read as one token beside the message
 * instead of competing with it for vertical space.
 *
 * An excerpt too long for the pill stays clipped until the user asks for it —
 * clicking expands the chip in place to the full text. The model receives the
 * excerpt verbatim either way (formatTextWithInlineRefs); this is presentation
 * only. Expandability is measured, not guessed from a character count, so it
 * holds for CJK and latin alike.
 *
 * Keeping the chip on the sent message is deliberate — a quote the user can
 * see before sending but not afterwards makes the turn unauditable.
 */

/**
 * Strip a leading ATX heading marker from a quoted excerpt for display
 * (#2213).
 *
 * A quote can carry markdown source verbatim (selection capture keeps the raw
 * text), so a heading line such as `### Description` would render in the chip
 * as cramped literal hashes. The selection capture normalizes whitespace into
 * a single line, so an ATX marker can survive at the start of the excerpt
 * (other line prefixes like `- `, `> `, `1. ` survive too but are out of
 * scope); mid-text `#` runs are treated as content and left alone.
 *
 * Presentation only — the model still receives `quote.text` verbatim via
 * formatTextWithInlineRefs. CommonMark allows up to six `#` and requires a
 * space (or end of line) after the marker; `###Description` (no space) is not
 * a heading and is preserved.
 */
export function stripQuoteHeadingMarkers(text: string): string {
  return text.replace(/^#{1,6}[ \t]+/, '');
}

export function QuoteRefChip(props: {
  quote: QuoteRef;
  onRemove?: () => void;
  className?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLButtonElement>(null);
  const label = props.quote.label;
  const displayText = stripQuoteHeadingMarkers(props.quote.text);
  const full = label ? `${label}: ${displayText}` : displayText;

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    setClipped(el.scrollWidth > el.clientWidth + 1);
  }, [expanded, displayText, label]);

  const canExpand = clipped || expanded;
  return (
    <span
      className={cn(
        'maka-quote-chip',
        expanded ? 'maka-quote-chip-expanded' : 'maka-quote-chip-collapsed',
        props.onRemove ? 'maka-quote-chip-removable' : 'maka-quote-chip-readonly',
        props.className,
      )}
      title={expanded ? undefined : full}
    >
      <TextQuote
        className={cn('maka-quote-chip-icon', expanded && 'maka-quote-chip-icon-expanded')}
        aria-hidden="true"
      />
      <button
        ref={textRef}
        type="button"
        {...(canExpand
          ? {
              onClick: () => setExpanded((open) => !open),
              'aria-expanded': expanded,
              'aria-label': expanded ? copy.quoteCollapseAriaLabel : copy.quoteExpandAriaLabel,
            }
          : { tabIndex: -1 })}
        className={cn(
          'maka-quote-chip-text',
          expanded ? 'maka-quote-chip-text-expanded' : 'maka-quote-chip-text-clipped',
        )}
      >
        {label ? <span className="maka-quote-chip-label">{label} </span> : null}
        {displayText}
      </button>
      {props.onRemove && (
        <button
          type="button"
          onClick={props.onRemove}
          className="maka-quote-chip-remove"
          aria-label={copy.removeQuoteAriaLabel}
        >
          <X />
        </button>
      )}
    </span>
  );
}
