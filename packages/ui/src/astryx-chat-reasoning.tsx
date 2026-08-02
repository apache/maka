// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT

/**
 * Astryx ChatReasoning 0.1.9, ejected from the official lab package.
 *
 * Source: packages/lab/src/ChatReasoning/ChatReasoning.tsx at Astryx v0.1.9
 * (commit c9fe437). The lab package is canary-only and declares an exact
 * canary core peer even though this release is the stable 0.1.9 source. Maka
 * therefore uses Astryx's supported swizzle/eject seam instead of forcing an
 * invalid dependency tree. DOM, state, keyboard behavior, icons, and compiled
 * StyleX atoms below are the official component; only the build-time StyleX
 * call has already been compiled, matching the published package output.
 *
 * Product dialect lives in chat-message.css (cursor default, hover wash,
 * chevron size). This file keeps the ejected lab DOM/behavior.
 */
import { useCallback, useState, type HTMLAttributes, type ReactNode } from 'react';
import { mergeProps, themeProps } from '@astryxdesign/core/utils';

export interface ChatReasoningProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  label?: string;
  duration?: string;
  isStreaming?: boolean;
  isExpanded?: boolean;
  defaultIsExpanded?: boolean;
  onExpandedChange?: (isExpanded: boolean) => void;
}

function ThinkingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
      <circle cx="5.5" cy="7" r="0.75" fill="currentColor" />
      <circle cx="8.5" cy="7" r="0.75" fill="currentColor" />
    </svg>
  );
}

/** Match Astryx Icon `size="xsm"` (12px) used by ChatToolCalls chevrons. */
function ChevronDownIcon() {
  // The attributes carry the size. There used to be a `0.75rem` inline style
  // beside them, which disagreed with them (9.75px) for as long as the root
  // was pinned to 13px; the type-scale convergence removed that pin, so the
  // duplicate is now merely redundant instead of wrong. Drop it either way.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChatReasoning(props: ChatReasoningProps) {
  const {
    children,
    label = 'Thinking',
    duration,
    isStreaming = false,
    isExpanded: controlledExpanded,
    defaultIsExpanded = false,
    onExpandedChange,
    className,
    style,
    ...rest
  } = props;
  const [internalExpanded, setInternalExpanded] = useState(defaultIsExpanded);
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;
  const toggle = useCallback(() => {
    const next = !isExpanded;
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  }, [isExpanded, isControlled, onExpandedChange]);
  const previewText = typeof children === 'string' ? children : null;

  return (
    <div
      {...mergeProps(
        themeProps('chat-reasoning', {
          expanded: isExpanded ? 'expanded' : null,
          streaming: isStreaming ? 'streaming' : null,
        }),
        { className: 'x78zum5 xdt5ytf xtbrsbv' },
        className,
        style,
      )}
      {...rest}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        className="x78zum5 x6s0dn4 x1s4dlld x1ypdohk x87ps6o xjwf9q1 x13f7esw"
      >
        <span className="x3nfvp2 x6s0dn4 xl56j7k x2lah0s x1kky2od xlup9mm xv1l7n4">
          <ThinkingIcon />
        </span>
        <div className="x78zum5 x6s0dn4 xzye2dw xeuugli xb3r6kr">
          <span
            className={
              isStreaming
                ? 'x141an7d x1ltkj2j x9ynric x1e4wzip xuxw1ft x2lah0s xct3ic7 xakli9p x1ta4xzc x19co3pv x3mlza6 xeaay5l x1esw782 xa4qsjk'
                : 'x141an7d x1ltkj2j x9ynric x1e4wzip xv1l7n4 xuxw1ft x2lah0s'
            }
          >
            {label}
          </span>
          {duration != null && !isStreaming ? (
            <>
              <span className="x141an7d xnbbluu x2lah0s">·</span>
              <span className="x141an7d x1ltkj2j x9ynric xnbbluu xuxw1ft x2lah0s">{duration}</span>
            </>
          ) : null}
          {!isExpanded && previewText && !isStreaming ? (
            <>
              <span className="x141an7d xnbbluu x2lah0s">—</span>
              <span className="x141an7d x1ltkj2j x9ynric xnbbluu xuxw1ft xb3r6kr xlyipyv xeuugli">{previewText}</span>
            </>
          ) : null}
        </div>
        <span
          className={
            isExpanded
              // xvc5jky = margin-inline-start:auto (ChatToolCalls callDetailChevron)
              ? 'x3nfvp2 x6s0dn4 xl56j7k x2lah0s x6jxa94 x1v9usgg xnbbluu x1ob6yzd x19jd1h0 xvc5jky'
              : 'x3nfvp2 x6s0dn4 xl56j7k x2lah0s x6jxa94 x1v9usgg xnbbluu x1ob6yzd xvc5jky'
          }
        >
          <ChevronDownIcon />
        </span>
      </div>
      <div className={isExpanded ? 'xrvj5dj xb0j27v x1tu4anv' : 'xrvj5dj xihq33y xb0j27v'}>
        <div className="xb3r6kr x2lwn1j">
          <div className="x1xye8es x1f43n9v x141an7d x1ltkj2j x9ynric xv1l7n4">{children}</div>
        </div>
      </div>
    </div>
  );
}

ChatReasoning.displayName = 'ChatReasoning';
