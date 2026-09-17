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

import { useCallback, useRef, useState } from 'react';

export interface PendingSelection {
  /**
   * The value to render: the just-picked value while its write is unsettled,
   * otherwise the authoritative value.
   */
  value: string;
  /**
   * Show `next` at once and fire the write; the pick clears when that write
   * settles — by when the authoritative `value` has caught up on success, or
   * falling back to it on failure.
   */
  onChange(next: string): void;
}

/**
 * Reflect a just-picked value immediately and hold it until the caller's write
 * settles, then defer to the authoritative `value`. No spinner and no lag: the
 * pick shows from the click and clears the moment `onValueChange` resolves (by
 * when `value` has caught up) or rejects (rolling back to `value`).
 *
 * A monotonic token makes the latest pick win, so a slower earlier write's
 * settle cannot wipe a newer pick. The state is deliberately local and
 * write-scoped: it carries no cross-read generation and no state that outlives
 * the component, so reopening the surface always starts clean.
 *
 * Limitation: the pick clears when the write settles, not when `authoritative`
 * is confirmed to carry it — so if the write resolves but the caller never
 * lands the new value into `authoritative` (e.g. its refresh is silently
 * dropped), the trigger falls back to the prior `authoritative` until the
 * caller next updates it, self-healing on that next update and never wrong
 * durably.
 */
export function usePendingSelection(
  authoritative: string,
  onValueChange: (next: string) => void | Promise<void>,
): PendingSelection {
  const [pending, setPending] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const onChange = useCallback(
    (next: string) => {
      const token = (tokenRef.current += 1);
      setPending(next);
      // Clear on either outcome — success (authoritative caught up) or failure
      // (roll back to authoritative) — and only if this is still the latest
      // pick. Two-arg `then` (not `finally`) so a rejected write is consumed
      // here rather than surfacing as an unhandled rejection.
      const settle = () => {
        if (tokenRef.current === token) setPending(null);
      };
      Promise.resolve(onValueChange(next)).then(settle, settle);
    },
    [onValueChange],
  );
  return { value: pending ?? authoritative, onChange };
}
