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

export type TocHeadingItem = {
  readonly id: string;
  readonly level: number;
  readonly title: string;
};

export type TocLayoutMode =
  | { readonly kind: 'docked'; readonly width: number; readonly left: number }
  | { readonly kind: 'compact'; readonly railLeft: number; readonly popoverWidth: number }
  | { readonly kind: 'hidden' };

export type TurnViewportSpan = {
  readonly turnKey: string;
  readonly top: number;
  readonly bottom: number;
};

export type PartVisibleBlocks = {
  readonly partKey: string;
  readonly firstBlock: number | null;
  readonly lastBlock: number | null;
};

export type PartHeadingRef = {
  readonly id: string;
  readonly partKey: string;
  readonly blockIndex: number;
};

const READING_COLUMN_MAX_WIDTH = 800;
const DOCKED_MIN_MARGIN = 196;
const DOCKED_MAX_WIDTH = 220;
const DOCKED_EDGE_INSET = 12;
const DOCKED_COLUMN_GAP = 12;
const COMPACT_MIN_MARGIN = 32;
const COMPACT_RAIL_WIDTH = 20;
const COMPACT_POPOVER_WIDTH = 220;

export function tocLayoutMode(input: {
  readonly listWidth: number;
  readonly railInset: number;
  readonly terminal: boolean;
}): TocLayoutMode {
  const { listWidth, railInset, terminal } = input;
  if (listWidth <= 0) return { kind: 'hidden' };
  const contentWidth = Math.max(0, listWidth - railInset * 2);
  const readingColumnLeft = railInset + Math.max(0, (contentWidth - READING_COLUMN_MAX_WIDTH) / 2);
  if (readingColumnLeft >= DOCKED_MIN_MARGIN) {
    const width = Math.min(
      DOCKED_MAX_WIDTH,
      Math.floor(readingColumnLeft - DOCKED_EDGE_INSET - DOCKED_COLUMN_GAP),
    );
    return { kind: 'docked', width, left: DOCKED_EDGE_INSET };
  }
  if (!terminal && readingColumnLeft >= COMPACT_MIN_MARGIN) {
    const railLeft = Math.max(
      4,
      Math.min(DOCKED_EDGE_INSET, Math.floor((readingColumnLeft - COMPACT_RAIL_WIDTH) / 2)),
    );
    return { kind: 'compact', railLeft, popoverWidth: COMPACT_POPOVER_WIDTH };
  }
  return { kind: 'hidden' };
}

export function pickViewedTurn(
  turns: readonly TurnViewportSpan[],
  viewportTop: number,
  viewportBottom: number,
  preferredTurnKey: string | null = null,
): string | null {
  if (turns.length === 0 || viewportBottom <= viewportTop) return null;
  let bestKey: string | null = null;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = Math.max(
      0,
      Math.min(turn.bottom, viewportBottom) - Math.max(turn.top, viewportTop),
    );
    if (overlap <= 0) continue;
    if (
      overlap > bestOverlap + 1 ||
      (Math.abs(overlap - bestOverlap) <= 1 && turn.turnKey === preferredTurnKey)
    ) {
      bestOverlap = overlap;
      bestKey = turn.turnKey;
    }
  }
  return bestKey;
}

export function pickActiveHeading(
  items: readonly PartHeadingRef[],
  partsInOrder: readonly PartVisibleBlocks[],
  atBottom: boolean,
  fallbackId: string | null = null,
): string | null {
  if (items.length === 0) return null;
  const partOrder = new Map<string, number>();
  let firstVisibleOrder = -1;
  let firstVisibleBlock = -1;
  let lastVisibleOrder = -1;
  let lastVisibleBlock = -1;

  for (let i = 0; i < partsInOrder.length; i += 1) {
    const part = partsInOrder[i]!;
    partOrder.set(part.partKey, i);
    if (part.firstBlock !== null && firstVisibleOrder < 0) {
      firstVisibleOrder = i;
      firstVisibleBlock = part.firstBlock;
    }
    if (part.lastBlock !== null) {
      lastVisibleOrder = i;
      lastVisibleBlock = part.lastBlock;
    }
  }

  if (atBottom && lastVisibleOrder >= 0) {
    const lastItem = items[items.length - 1]!;
    const itemOrder = partOrder.get(lastItem.partKey) ?? -1;
    if (
      itemOrder >= 0 &&
      (itemOrder < lastVisibleOrder ||
        (itemOrder === lastVisibleOrder && lastItem.blockIndex <= lastVisibleBlock))
    ) {
      return lastItem.id;
    }
  }

  if (firstVisibleOrder < 0) {
    if (atBottom) return items[items.length - 1]!.id;
    if (fallbackId !== null && items.some((item) => item.id === fallbackId)) return fallbackId;
    return items[0]!.id;
  }

  let active = items[0]!.id;
  for (const item of items) {
    const order = partOrder.get(item.partKey) ?? -1;
    if (order < 0) continue;
    if (
      order < firstVisibleOrder ||
      (order === firstVisibleOrder && item.blockIndex <= firstVisibleBlock)
    ) {
      active = item.id;
    } else {
      break;
    }
  }
  return active;
}
