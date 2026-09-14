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

import type { TurnTimelineItem } from './materialize.js';

/**
 * Groups adjacent reasoning and tools for their shared layout spacing.
 *
 * The turn timeline model (`TurnTimelineItem`) stays FLAT — every
 * timeline-rewriting pass (overlayLiveTurn, projectTurnTools, shell-run
 * folding) operates on the raw thinking/text/tools sequence and never has to
 * maintain a nesting invariant. This module derives the folded view right
 * before rendering:
 *
 *  - answer `text` and inserted `user` entries stay in place and bound groups;
 *  - every thinking/tools run becomes one `processing` sequence, preserving
 *    the run's interleaved order as `children`. This wrapper has no disclosure;
 *    reasoning and tool components own their individual expansion states.
 *
 * Each block carries a stable `id` derived from the preceding text or inserted
 * user entry's messageId (`'start'` when the block opens the turn). Between two boundaries there
 * is at most one block, so the id is unique per turn — and, unlike a key
 * guessed from the first child, it survives the first tool being projected
 * away (shell-run folding) without remounting the disclosure or dropping its
 * expansion state. A remaining reasoning entry keeps the same wrapper even
 * when the last tool disappears.
 */

/** An entry folded inside a processing block: reasoning or a tool group. */
export type FoldedTimelineChild = Extract<TurnTimelineItem, { kind: 'thinking' | 'tools' }>;

export interface ProcessingFold {
  kind: 'processing';
  /** Stable identity: `'start'` or the preceding text/user boundary's messageId. */
  id: string;
  children: FoldedTimelineChild[];
}

export type FoldedTimelineEntry = Extract<TurnTimelineItem, { kind: 'user' | 'text' }> | ProcessingFold;

export function foldTimeline(items: readonly TurnTimelineItem[]): FoldedTimelineEntry[] {
  const out: FoldedTimelineEntry[] = [];
  let anchor = 'start';
  let buffer: FoldedTimelineChild[] | null = null;
  const flush = (): void => {
    if (buffer && buffer.length > 0) {
      out.push({ kind: 'processing', id: anchor, children: buffer });
    }
    buffer = null;
  };
  for (const item of items) {
    if (item.kind === 'thinking' || item.kind === 'tools') {
      (buffer ??= []).push(item);
    } else {
      flush();
      out.push(item);
      anchor = item.messageId;
    }
  }
  flush();
  return out;
}
