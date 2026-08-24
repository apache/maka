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

import { useEffect, useState } from 'react';
import { formatAbsoluteTimestamp } from './chat-display-helpers.js';
import {
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  formatSidebarTimestamp,
  nextSidebarRefreshDelay,
} from '@maka/core/relative-time';
import { cn } from './utils.js';
import { useUiLocale } from './locale-context.js';

/**
 * Self-refreshing relative-time label: stays on the just-now label for the
 * first minute, then ticks every minute, then every 10 minutes (see
 * `nextRelativeRefreshDelay`), stopping past the 7-day horizon to show the
 * absolute date. `variant="sidebar"` uses abbreviated relative units and
 * refreshes at the next visible bucket for space-starved sidebar rows.
 */
export function RelativeTime(props: {
  ts: number;
  className?: string;
  suppressTitle?: boolean;
  variant?: 'relative' | 'sidebar';
}) {
  const locale = useUiLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const delay =
      props.variant === 'sidebar'
        ? nextSidebarRefreshDelay(props.ts)
        : nextRelativeRefreshDelay(props.ts);
    if (delay === null) return;
    const id = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(id);
  });
  const format = props.variant === 'sidebar' ? formatSidebarTimestamp : formatRelativeTimestamp;
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
