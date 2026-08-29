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
 * The one hole `overflow-anchor: auto` leaves: the browser declines to anchor
 * while the scroller sits at zero, which is exactly where earlier history is
 * asked for. This is the compensation for that single call point and nothing
 * else — everywhere else, native anchoring already does this continuously and
 * for free.
 *
 * The anchor is an element, not a height. `scrollHeight` deltas count growth
 * below the reader too, and count a load that returned nothing as a push.
 * Measuring one turn's box before and after answers only the question asked:
 * how far did the content the reader is looking at move.
 */

export interface ChatScrollAnchor {
  readonly turnId: string;
  readonly top: number;
}

export function captureChatScrollAnchor(root: HTMLElement): ChatScrollAnchor | undefined {
  // The first turn the reader can actually see, not the first one mounted. The
  // virtual window mounts turns above the viewport too, and those are exactly
  // the ones it is free to drop while the load lands — an anchor it unmounted
  // can no longer be measured, and the compensation silently does nothing.
  const rootTop = root.getBoundingClientRect().top;
  for (const turn of root.querySelectorAll<HTMLElement>('[data-turn-id]')) {
    if (turn.getBoundingClientRect().bottom <= rootTop) continue;
    const turnId = turn.dataset.turnId;
    if (!turnId) continue;
    return { turnId, top: turn.getBoundingClientRect().top };
  }
  return undefined;
}

export function restoreChatScrollAnchor(
  root: HTMLElement,
  anchor: ChatScrollAnchor | undefined,
): boolean {
  if (!anchor) return false;
  const turn = root.querySelector<HTMLElement>(
    `[data-turn-id="${CSS.escape(anchor.turnId)}"]`,
  );
  if (!turn) return false;
  root.scrollTop += turn.getBoundingClientRect().top - anchor.top;
  return true;
}
