import { useEffect, useState } from 'react';
import { formatAbsoluteTimestamp } from './chat-display-helpers.js';
import {
  formatCompactTimestamp,
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
} from '@maka/core/relative-time';
import { cn } from './utils.js';
import { useUiLocale } from './locale-context.js';

/**
 * PR-RELATIVE-TIME-0: a self-refreshing relative-time label. Sidebar +
 * message rows stay correct even when the window has been open for
 * hours without re-rendering on their own. The tick cadence comes from
 * `nextRelativeRefreshDelay` so we tick every second within the first
 * minute, every minute within the first hour, then every 10 minutes;
 * past the 7-day horizon we stop ticking and show the absolute date.
 *
 * `variant="compact"` swaps the past-horizon fallback for a date-only label
 * ("6月20日"), which is what `formatCompactTimestamp` exists for: the wide
 * medium-date-plus-time fallback crushes a 260px rail row's title. The ticker is
 * the same either way — a visible timestamp inside a memoized row is exactly the
 * case that goes stale without it, and the rail's rows are memoized.
 */
export function RelativeTime(props: {
  ts: number;
  className?: string;
  suppressTitle?: boolean;
  variant?: 'relative' | 'compact';
}) {
  const locale = useUiLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const delay = nextRelativeRefreshDelay(props.ts);
    if (delay === null) return;
    const id = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(id);
  });
  const format = props.variant === 'compact' ? formatCompactTimestamp : formatRelativeTimestamp;
  return (
    <small
      className={cn('tabular-nums', props.className ?? 'maka-message-time')}
      aria-hidden="true"
      title={props.suppressTitle ? undefined : formatAbsoluteTimestamp(props.ts, locale)}
    >
      {format(props.ts, Date.now(), locale)}
    </small>
  );
}
