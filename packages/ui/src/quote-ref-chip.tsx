import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { TextQuote, X } from './icons.js';
import { cn } from './utils.js';
import type { QuoteRef } from '@maka/core';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/** Display-only: strip a leading ATX heading marker (`### Title`) from chip text. */
export function stripQuoteHeadingMarkers(text: string): string {
  return text.replace(/^#{1,6}[ \t]+/, '');
}

/** Inline quote chip for the composer (removable) and sent user messages (read-only). */
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
  const a11yLabel = canExpand
    ? (expanded ? copy.quoteCollapseAriaLabel : copy.quoteExpandAriaLabel)
    : full;

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
      <Button
        ref={textRef}
        type="button"
        variant="ghost"
        size="sm"
        label={a11yLabel}
        className={cn(
          'maka-quote-chip-text',
          expanded ? 'maka-quote-chip-text-expanded' : 'maka-quote-chip-text-clipped',
        )}
        tabIndex={canExpand ? undefined : -1}
        aria-expanded={canExpand ? expanded : undefined}
        onClick={canExpand ? () => setExpanded((open) => !open) : undefined}
      >
        {label ? <span className="maka-quote-chip-label">{label} </span> : null}
        {displayText}
      </Button>
      {props.onRemove ? (
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          label={copy.removeQuoteAriaLabel}
          icon={<X aria-hidden="true" />}
          className="maka-quote-chip-remove"
          onClick={props.onRemove}
        />
      ) : null}
    </span>
  );
}
