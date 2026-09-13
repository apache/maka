/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { TextQuote, X } from './icons.js';
import { cn } from './utils.js';
import type { QuoteRef } from '@maka/core/events';
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
  // Measure the clipped text node itself — Astryx Button wraps children in an
  // internal label span, so Button.root scrollWidth no longer reflects ellipsis.
  const measureRef = useRef<HTMLSpanElement>(null);
  const label = props.quote.label;
  const displayText = stripQuoteHeadingMarkers(props.quote.text);
  const full = label ? `${label}: ${displayText}` : displayText;

  useLayoutEffect(() => {
    const el = measureRef.current;
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
        type="button"
        variant="ghost"
        size="sm"
        label={a11yLabel}
        className={cn(
          'maka-quote-chip-text',
          expanded && 'maka-quote-chip-text-expanded',
        )}
        tabIndex={canExpand ? undefined : -1}
        aria-expanded={canExpand ? expanded : undefined}
        onClick={canExpand ? () => setExpanded((open) => !open) : undefined}
      >
        <span
          ref={measureRef}
          className={cn(
            'maka-quote-chip-text-body',
            !expanded && 'maka-quote-chip-text-clipped',
          )}
        >
          {label ? <span className="maka-quote-chip-label">{label} </span> : null}
          {displayText}
        </span>
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
