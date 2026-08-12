import { useEffect, useState } from 'react';
import { formatAbsoluteTimestamp } from './chat-display-helpers.js';
import { formatRelativeTimestamp, nextRelativeRefreshDelay } from '@maka/core/relative-time';
import { cn } from './utils.js';
import { useUiLocale } from './locale-context.js';

/**
 * PR-RELATIVE-TIME-0: a self-refreshing relative-time label. Sidebar +
 * message rows stay correct even when the window has been open for
 * hours without re-rendering on their own. The tick cadence comes from
 * `nextRelativeRefreshDelay` so we tick every second within the first
 * minute, every minute within the first hour, then every 10 minutes;
 * past the 7-day horizon we stop ticking and show the absolute date.
 */
export function RelativeTime(props: { ts: number; className?: string; suppressTitle?: boolean }) {
  const locale = useUiLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const delay = nextRelativeRefreshDelay(props.ts);
    if (delay === null) return;
    const id = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(id);
  });
  return (
    <small
      className={cn('tabular-nums', props.className ?? 'maka-message-time')}
      aria-hidden="true"
      title={props.suppressTitle ? undefined : formatAbsoluteTimestamp(props.ts, locale)}
    >
      {formatRelativeTimestamp(props.ts, Date.now(), locale)}
    </small>
  );
}
