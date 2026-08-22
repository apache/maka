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
 * Pure ARIA listbox keyboard helpers for the ArtifactPane artifact list.
 *
 * Extracted from `artifact-pane.tsx` so the transition logic is testable
 * without a DOM. Per @kenji's
 * a11y review on PR108b: the artifact list MUST be a single tab stop with
 * ArrowUp/Down navigation + Enter to focus the preview area. Without this
 * helper the list would either (a) tab through every artifact row, or (b)
 * miss arrow-key navigation entirely. Activation opens the selected file in
 * the pane's preview state; the helper stays independent of that view model.
 *
 * Each helper takes only the data needed to compute the transition. The
 * caller is responsible for `event.preventDefault()` so the keys don't
 * scroll the surrounding aside.
 */

const SELECTION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);
const ACTIVATION_KEYS = new Set(['Enter', ' ']);

export type ArtifactListAction =
  | { kind: 'select'; targetId: string }
  | { kind: 'activate'; targetId: string }
  | { kind: 'dismiss' }
  | { kind: 'noop' };

/**
 * Resolve the next selected artifact id from a list-keyboard event. The
 * helper handles five concerns:
 *
 *  - ArrowDown / ArrowUp / Home / End → `select` (wraps at ends; if no
 *    selection yet, ArrowDown starts at 0 and ArrowUp at the last item)
 *  - Enter / Space on a selected row → `activate` (caller opens preview)
 *  - Escape → `dismiss` (caller closes pane or returns focus to chat)
 *  - Any other key → `noop` (do not preventDefault)
 *
 * If `visibleIds` is empty, every key returns `noop` so a stale focus on
 * an empty list doesn't fire spurious actions.
 */
export function nextArtifactListAction(input: {
  currentSelectedId: string | undefined;
  visibleIds: readonly string[];
  key: string;
}): ArtifactListAction {
  const { currentSelectedId, visibleIds, key } = input;
  if (visibleIds.length === 0) return { kind: 'noop' };

  if (key === 'Escape') return { kind: 'dismiss' };

  if (ACTIVATION_KEYS.has(key)) {
    const targetId = currentSelectedId && visibleIds.includes(currentSelectedId)
      ? currentSelectedId
      : visibleIds[0]!;
    return { kind: 'activate', targetId };
  }

  if (!SELECTION_KEYS.has(key)) return { kind: 'noop' };

  const currentIndex = currentSelectedId === undefined
    ? -1
    : visibleIds.indexOf(currentSelectedId);
  const total = visibleIds.length;
  let nextIndex: number;
  switch (key) {
    case 'ArrowDown':
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % total;
      break;
    case 'ArrowUp':
      nextIndex = currentIndex < 0 ? total - 1 : (currentIndex - 1 + total) % total;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = total - 1;
      break;
    default:
      return { kind: 'noop' };
  }
  const targetId = visibleIds[nextIndex];
  if (!targetId) return { kind: 'noop' };
  return { kind: 'select', targetId };
}
