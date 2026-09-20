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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkbarServices } from '../services-context.js';

/**
 * How long this session's PTY must be silent before the branch is re-read. Long
 * enough that a command's output burst settles into one read, short enough that
 * the chip has caught up by the time a person looks at it.
 */
const PTY_QUIET_MS = 400;

export interface ComposerGitBranch {
  readonly name?: string;
  readonly shortSha?: string;
}

/**
 * The branch the active Session's working tree is on, for the composer's branch
 * chip. `undefined` whenever there is nothing to show — no session, not a
 * repository, a failed read — so the chip renders nothing rather than an empty
 * husk.
 *
 * The read is re-taken, not frozen: a branch changes under the app, including
 * from the Desktop's own integrated terminal, so a value read once would go
 * silently stale — and a stale status readout is worse than an absent one,
 * because it still looks like a good value.
 *
 * Three triggers, because a branch changes in three places:
 *  - the app was left and returned to (`focus`, `visibilitychange`);
 *  - a command ran in this session's INTEGRATED terminal, which lives in the
 *    same document — so neither window event fires. That terminal is a long-lived
 *    PTY: `git checkout` produces no new shell run and no session event, only
 *    output. The signal is therefore the output going quiet — a command has
 *    finished when the PTY has been silent for a beat — and only for a run
 *    belonging to THIS session.
 *  - `sessionId` changing (a different session is a different working tree).
 *
 * `subscribeSessionEvents` would not cover the middle case: it carries the
 * model's transcript events (`tool_start`/`tool_result`), and a command typed by
 * a person is not one of those.
 *
 * The re-read is driven through refs, not through a state token: a busy terminal
 * spawns one read per quiet gap, and most of those answer the same branch. A
 * token held in state would repaint the composer on every one of them even when
 * nothing changed, so reads go through `read()` and a state update happens only
 * when the value actually differs.
 */
export function useComposerGitBranch(
  sessionId: string | undefined,
): ComposerGitBranch | undefined {
  const { review, terminal } = useWorkbarServices();
  const [branch, setBranch] = useState<ComposerGitBranch | undefined>(undefined);
  // The last applied value, readable from a trigger without re-subscribing, and
  // the session the in-flight read belongs to (a late answer for a session the
  // user has left must not land).
  const branchRef = useRef<ComposerGitBranch | undefined>(undefined);
  const sessionRef = useRef<string | undefined>(sessionId);
  sessionRef.current = sessionId;

  // Set state only on a real change. Returning the caller is not enough on its
  // own here because these reads are not the render's own dependency; the guard
  // is what keeps an unchanged branch from repainting the composer.
  const apply = useCallback((next: ComposerGitBranch | undefined) => {
    const current = branchRef.current;
    if (current?.name === next?.name && current?.shortSha === next?.shortSha) return;
    branchRef.current = next;
    setBranch(next);
  }, []);

  const read = useCallback(() => {
    const id = sessionRef.current;
    if (!id) {
      apply(undefined);
      return;
    }
    void review
      .branch(id)
      .then((result) => {
        if (sessionRef.current !== id) return;
        apply(
          result.ok
            ? {
                ...(result.snapshot.branch !== null ? { name: result.snapshot.branch } : {}),
                ...(result.snapshot.branch === null && result.snapshot.shortSha !== null
                  ? { shortSha: result.snapshot.shortSha }
                  : {}),
              }
            : undefined,
        );
      })
      .catch(() => {
        if (sessionRef.current === id) apply(undefined);
      });
  }, [review, apply]);

  // The session's own read, taken whenever the session changes.
  useEffect(() => {
    if (!sessionId) {
      branchRef.current = undefined;
      setBranch(undefined);
      return;
    }
    read();
  }, [sessionId, read]);

  // Returning to the app is a branch change we cannot observe directly.
  useEffect(() => {
    const onFocus = () => read();
    // `visibilitychange` alone is enough: returning to a tab fires it, and the
    // hidden->visible transition is the only direction that can have missed a
    // change. Gating on `document.visibilityState` would trust a property some
    // embedders do not populate, and the extra read on a hide is harmless.
    const onVisibility = () => read();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [read]);

  // The integrated terminal: a persistent PTY in this same document, so a typed
  // command fires no window event and creates no shell run. Its OUTPUT is the
  // signal, debounced so a burst costs one read rather than one per chunk, and
  // scoped to this session so another session's terminal cannot move this chip.
  useEffect(() => {
    if (!sessionId) return;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = terminal.subscribePtyData((event) => {
      if (event.sessionId !== sessionId) return;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        quietTimer = undefined;
        read();
      }, PTY_QUIET_MS);
    });
    return () => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      unsubscribe();
    };
  }, [sessionId, terminal, read]);

  return branch;
}
