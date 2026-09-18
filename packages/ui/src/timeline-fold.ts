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

/** The timeline stays flat in storage and live projections. Only presentation
 * groups the work before the last reply; inserted user messages are boundaries
 * so a steering instruction can never disappear inside an assistant disclosure.
 */
export type FoldedTimelineChild = Exclude<TurnTimelineItem, { kind: 'user' }>;

export interface ProcessingFold {
  kind: 'processing';
  /** Stable across streamed steps and tool projections within this segment. */
  id: string;
  children: FoldedTimelineChild[];
}

export type FoldedTimelineEntry = Extract<TurnTimelineItem, { kind: 'user' | 'text' }> | ProcessingFold;

export function foldTimeline(items: readonly TurnTimelineItem[]): {
  entries: FoldedTimelineEntry[];
  finalReply: Extract<TurnTimelineItem, { kind: 'text' }> | undefined;
} {
  const out: FoldedTimelineEntry[] = [];
  let finalReply: Extract<TurnTimelineItem, { kind: 'text' }> | undefined;
  let anchor = 'start';
  let buffer: FoldedTimelineChild[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    // Imported transcripts can record reasoning after the visible reply.
    // Ignore that trailing reasoning when locating the answer, but stop at
    // tool activity: text before tools is still process commentary.
    const replyIndex = buffer.findLastIndex((item) => item.kind !== 'thinking');
    const candidate = buffer[replyIndex];
    const answer = candidate?.kind === 'text' ? candidate : undefined;
    if (answer) buffer.splice(replyIndex, 1);
    finalReply = answer;
    if (buffer.length > 0) {
      out.push({ kind: 'processing', id: anchor, children: buffer });
    }
    if (answer) out.push(answer);
    buffer = [];
  };
  for (const item of items) {
    if (item.kind === 'user') {
      flush();
      out.push(item);
      anchor = item.messageId;
      finalReply = undefined;
    } else if (item.kind === 'text' && item.interrupted) {
      buffer.push(item);
      flush();
      anchor = item.messageId;
    } else {
      buffer.push(item);
    }
  }
  flush();
  return { entries: out, finalReply };
}
