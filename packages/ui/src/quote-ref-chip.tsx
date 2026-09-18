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
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { MetadataList, MetadataListItem, Text, VStack } from '@astryxdesign/core';
import { MessageSquareQuote, MessagesSquare, TextQuote, X } from './icons.js';
import { cn } from './utils.js';
import type { UiLocale } from '@maka/core/ui-locale';
import type { QuoteRef } from '@maka/core/events';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/** Display-only: strip a leading ATX heading marker (`### Title`) from chip text. */
export function stripQuoteHeadingMarkers(text: string): string {
  return text.replace(/^#{1,6}[ \t]+/, '');
}

/** Human-readable provenance kept with a cross-session snapshot QuoteRef. */
export function quoteProvenanceSummary(quote: QuoteRef, locale: UiLocale): string | undefined {
  if (!quote.sourceSessionId || quote.sourceCapturedAt === undefined) return undefined;
  if (!Number.isFinite(quote.sourceCapturedAt) || quote.sourceCapturedAt < 0 || quote.sourceCapturedAt > 8.64e15) return undefined;
  const capturedAt = new Date(quote.sourceCapturedAt).toISOString();
  return getConversationCopy(locale).messages.sessionSnapshotCaptured(capturedAt, quote.sourceTruncated === true);
}

/**
 * The structured read of a quote: what was selected, then what the user said
 * about it. Shared by the staged token in the composer and the chip on a sent
 * message so neither surface can drift from the other.
 *
 * Rendered on a HoverCard — a normal reading surface where the two prose
 * tiers are legal. The excerpt clamps to a preview; the note never does,
 * because a sent message offers no other place to read it in full.
 */
export function QuoteHoverCardContent(props: { quote: QuoteRef }) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).messages;
  const provenance = quoteProvenanceSummary(props.quote, locale);
  return (
    <VStack gap={2} className="maka-quote-hover-card">
      <MetadataList columns="single" label={{ position: 'top' }}>
        <MetadataListItem label={copy.quoteSelectedTextLabel}>
          <Text maxLines={4} textWrap="wrap">
            {stripQuoteHeadingMarkers(props.quote.text)}
          </Text>
        </MetadataListItem>
        {props.quote.comment ? (
          <MetadataListItem label={copy.quoteCommentLabel}>
            <Text>{props.quote.comment}</Text>
          </MetadataListItem>
        ) : null}
      </MetadataList>
      {provenance ? <Text type="supporting">{provenance}</Text> : null}
    </VStack>
  );
}

/** Inline quote chip for the composer (removable) and sent user messages (read-only). */
export function QuoteRefChip(props: {
  quote: QuoteRef;
  onRemove?: () => void;
  className?: string;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).messages;
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  // Measure the clipped text node itself — Astryx Button wraps children in an
  // internal label span, so Button.root scrollWidth no longer reflects ellipsis.
  const measureRef = useRef<HTMLSpanElement>(null);
  const label = props.quote.sourceSessionId && props.quote.sourceSessionName
    ? copy.sessionSnapshotLabel(props.quote.sourceSessionName)
    : props.quote.label;
  const displayText = stripQuoteHeadingMarkers(props.quote.text);
  const full = label ? `${label}: ${displayText}` : displayText;
  const provenance = quoteProvenanceSummary(props.quote, locale);
  const fullWithProvenance = provenance ? `${full} · ${provenance}` : full;

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el || expanded) return;
    setClipped(el.scrollWidth > el.clientWidth + 1);
  }, [expanded, displayText, label, provenance]);

  const canExpand = clipped || expanded;
  // A collapsed chip shows one line of its excerpt, so naming the control after
  // that line keeps two quotes in one message from reading as the same button.
  const a11yLabel = canExpand
    ? `${expanded ? copy.quoteCollapseAriaLabel : copy.quoteExpandAriaLabel}: ${fullWithProvenance}`
    : fullWithProvenance;
  const SourceIcon = props.quote.sourceSessionId ? MessagesSquare : TextQuote;

  const chip = (
    <span
      className={cn(
        'maka-quote-chip',
        expanded ? 'maka-quote-chip-expanded' : 'maka-quote-chip-collapsed',
        props.onRemove ? 'maka-quote-chip-removable' : 'maka-quote-chip-readonly',
        props.className,
      )}
    >
      <SourceIcon
        className={cn('maka-quote-chip-icon', expanded && 'maka-quote-chip-icon-expanded')}
        aria-hidden="true"
      />
      {/* Marks that the excerpt carries a note. The note itself lives in the
          hover card and the model-facing content, not in the chip's own line. */}
      {props.quote.comment ? (
        <MessageSquareQuote className="maka-quote-chip-comment-icon" aria-hidden="true" />
      ) : null}
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
          {provenance ? <span className="maka-quote-chip-provenance"> · {provenance}</span> : null}
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

  // An expanded chip already shows the excerpt in full; a hover card over it
  // would only repeat what is on screen.
  if (expanded) return chip;
  return (
    <HoverCard
      content={<QuoteHoverCardContent quote={props.quote} />}
      focusTrigger="always"
    >
      {chip}
    </HoverCard>
  );
}
