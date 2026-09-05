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
 * Render-layer fold for the collapsed "Processing" block (#1307).
 *
 * The turn timeline model (`TurnTimelineItem`) stays FLAT — every
 * timeline-rewriting pass (overlayLiveTurn, projectTurnTools, shell-run
 * folding) operates on the raw thinking/text/tools sequence and never has to
 * maintain a nesting invariant. This module derives the folded view right
 * before rendering:
 *
 *  - answer `text` and inserted `user` entries stay in place and bound groups;
 *  - a maximal thinking+tools run between two texts folds into ONE
 *    `processing` block when it contains at least one tools group, preserving
 *    the run's interleaved order as `children`;
 *  - a pure-thinking run stays bare (the 深度思考 disclosure renders it
 *    directly — wrapping a lone reasoning block would just double the fold).
 *
 * Each block carries a stable `id` derived from the preceding text or inserted
 * user entry's messageId (`'start'` when the block opens the turn). Between two boundaries there
 * is at most one block, so the id is unique per turn — and, unlike a key
 * guessed from the first child, it survives the first tool being projected
 * away (shell-run folding) without remounting the disclosure or dropping a
 * manual open/close. When projection removes a block's LAST tools group the
 * block itself dissolves (the remaining run is pure thinking), so the bare
 * 深度思考 entries remount and any manual open state inside is reset — the
 * accepted cost of deriving block existence at render time instead of
 * representing a tools-less block in the model.
 */

/** An entry folded inside a processing block: reasoning or a tool group. */
export type FoldedTimelineChild = Extract<TurnTimelineItem, { kind: 'thinking' | 'tools' }>;

export interface ProcessingFold {
  kind: 'processing';
  /** Stable identity: `'start'` or the preceding text/user boundary's messageId. */
  id: string;
  children: FoldedTimelineChild[];
}

export type FoldedTimelineEntry = TurnTimelineItem | ProcessingFold;

export function foldTimeline(items: readonly TurnTimelineItem[]): FoldedTimelineEntry[] {
  const out: FoldedTimelineEntry[] = [];
  let anchor = 'start';
  let buffer: FoldedTimelineChild[] | null = null;
  const flush = (): void => {
    if (buffer && buffer.length > 0) {
      if (buffer.some((child) => child.kind === 'tools')) {
        out.push({ kind: 'processing', id: anchor, children: buffer });
      } else {
        out.push(...buffer);
      }
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
