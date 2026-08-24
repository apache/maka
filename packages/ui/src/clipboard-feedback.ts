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

/**
 * Shared clipboard-copy feedback hook + tri-state phase type.
 *
 * PR-UI-LIB-EXTRACT-7 (WAWQAQ msg `510fef52`, round 8/10): pulled
 * out of `components.tsx`. The hook is consumed at three sites
 * inside `@maka/ui` (message metadata copy, ToolActivity, and the
 * explore-agent preview); the `phase` type
 * is also referenced by `TurnFooterActions` which keeps its own
 * inline copy-feedback state. None of these are part of the
 * public API.
 *
 * byte-for-byte equivalent; behavior unchanged.
 *
 * Why this seam:
 *   1. The hook is the single chokepoint for clipboard writes —
 *      it carries the `redactSecrets` opt-out, the
 *      `copyMountedRef` setState-after-unmount guard (PR-UI-Cx
 *      `3c01e901`), the StrictMode-safe `useEffect` cleanup, and
 *      the 1.4s feedback-reset window. Each of those rules was
 *      buried 5000+ lines deep in `components.tsx`; lifting them
 *      to a leaf module makes them findable and unit-testable
 *      without booting the whole renderer.
 *   2. This leaf keeps the remaining product copy actions from
 *      depending on the legacy mega-module.
 */

import { useEffect, useRef, useState } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { redactSecrets } from './redact.js';

export type ClipboardCopyPhase = 'pending' | 'copied' | 'failed';

export function useClipboardCopyFeedback(resetDelay = 1400, options: { redact?: boolean } = {}) {
  const [copyState, setCopyState] = useState<{ key: string; phase: ClipboardCopyPhase } | null>(null);
  const pendingCopyRef = useRef<string | null>(null);
  const copyMountedRef = useMountedRef();
  const resetTimerRef = useRef<number | null>(null);

  function clearResetTimer() {
    if (resetTimerRef.current === null) return;
    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }

  useEffect(() => {
    return () => {
      clearResetTimer();
    };
  }, []);

  function settle(key: string, phase: Exclude<ClipboardCopyPhase, 'pending'>) {
    if (!copyMountedRef.current) return;
    setCopyState({ key, phase });
    resetTimerRef.current = window.setTimeout(() => {
      if (!copyMountedRef.current) return;
      setCopyState((current) => current?.key === key ? null : current);
      resetTimerRef.current = null;
    }, resetDelay);
  }

  async function attempt(key: string, operation: () => Promise<void>): Promise<boolean> {
    if (pendingCopyRef.current) return false;
    pendingCopyRef.current = key;
    clearResetTimer();
    setCopyState({ key, phase: 'pending' });
    try {
      await operation();
      settle(key, 'copied');
      return true;
    } catch {
      settle(key, 'failed');
      return false;
    } finally {
      pendingCopyRef.current = null;
    }
  }

  async function copy(key: string, text: string) {
    if (text.length === 0) return;
    const output = options.redact === false ? text : redactSecrets(text);
    await attempt(key, () => navigator.clipboard.writeText(output));
  }

  function phaseFor(key: string): ClipboardCopyPhase | null {
    return copyState?.key === key ? copyState.phase : null;
  }

  return {
    copy,
    attempt,
    phaseFor,
    isPending: copyState?.phase === 'pending',
  };
}
