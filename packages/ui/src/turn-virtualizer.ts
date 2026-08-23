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

export interface TurnVirtualLayout {
  readonly turnIds: readonly string[];
  readonly offsets: readonly number[];
  readonly totalHeight: number;
  readonly gap: number;
}

export interface TurnVirtualWindow {
  readonly start: number;
  readonly end: number;
  readonly beforeHeight: number;
  readonly afterHeight: number;
}

export interface TurnVirtualWindowOptions {
  readonly overscanPx?: number;
  readonly preferredTurns?: number;
  readonly maxTurns?: number;
  readonly ensureIndex?: number;
  readonly retainRange?: { readonly start: number; readonly end: number };
}

export const DEFAULT_TURN_ESTIMATED_HEIGHT = 280;
export const DEFAULT_TURN_GAP = 16;
export const DEFAULT_TURN_OVERSCAN_PX = 1_000;
export const DEFAULT_TURN_WINDOW_SIZE = 60;
export const MAX_TURN_WINDOW_SIZE = 100;
export const INITIAL_TURN_WINDOW_SIZE = 2;
export const MIN_TURN_WINDOW_SIZE = 2;
const TURN_WINDOW_SHIFT_SIZE = 8;

export function estimatedTurnHeight(heights: ReadonlyMap<string, number> | undefined): number {
  if (!heights || heights.size === 0) return DEFAULT_TURN_ESTIMATED_HEIGHT;
  let total = 0;
  for (const height of heights.values()) total += height;
  return (DEFAULT_TURN_ESTIMATED_HEIGHT + total) / (heights.size + 1);
}

export function turnVirtualizationRequired(
  layout: TurnVirtualLayout,
  viewportHeight: number | undefined,
  renderedHeight = 0,
): boolean {
  if (layout.turnIds.length > MAX_TURN_WINDOW_SIZE) return true;
  if (viewportHeight === undefined || viewportHeight <= 0) return false;
  return Math.max(layout.totalHeight, renderedHeight)
    > viewportHeight + (2 * DEFAULT_TURN_OVERSCAN_PX);
}

export function buildTurnVirtualLayout(
  turnIds: readonly string[],
  heights: ReadonlyMap<string, number> | undefined,
  options: { estimatedHeight?: number; gap?: number } = {},
): TurnVirtualLayout {
  const estimatedHeight = positive(options.estimatedHeight, DEFAULT_TURN_ESTIMATED_HEIGHT);
  const gap = nonNegative(options.gap, DEFAULT_TURN_GAP);
  const offsets = new Array<number>(turnIds.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < turnIds.length; index += 1) {
    const measured = heights?.get(turnIds[index]!);
    const height = positive(measured, estimatedHeight);
    offsets[index + 1] = offsets[index]! + height + (index + 1 < turnIds.length ? gap : 0);
  }
  return { turnIds, offsets, totalHeight: offsets.at(-1) ?? 0, gap };
}

export function initialTurnVirtualWindow(
  layout: TurnVirtualLayout,
  count = INITIAL_TURN_WINDOW_SIZE,
  ensureIndex?: number,
): TurnVirtualWindow {
  if (layout.turnIds.length === 0) return windowFor(layout, 0, 0);
  const size = Math.min(layout.turnIds.length, Math.max(1, Math.floor(count)));
  if (ensureIndex === undefined) {
    return windowFor(layout, layout.turnIds.length - size, layout.turnIds.length);
  }
  const start = clamp(Math.floor(ensureIndex) - Math.floor(size / 2), 0, layout.turnIds.length - size);
  return windowFor(layout, start, start + size);
}

export function turnVirtualWindowForRange(
  layout: TurnVirtualLayout,
  start: number,
  end: number,
): TurnVirtualWindow {
  return windowFor(layout, start, end);
}

export function turnVirtualWindowForViewport(
  layout: TurnVirtualLayout,
  viewport: { scrollTop: number; clientHeight: number },
  options: TurnVirtualWindowOptions = {},
): TurnVirtualWindow {
  const length = layout.turnIds.length;
  if (length === 0) return windowFor(layout, 0, 0);
  const scrollTop = clamp(viewport.scrollTop, 0, layout.totalHeight);
  const clientHeight = Math.max(0, viewport.clientHeight);
  const overscan = nonNegative(options.overscanPx, DEFAULT_TURN_OVERSCAN_PX);
  const visibleStart = indexAtOffset(layout, scrollTop);
  const visibleEnd = Math.max(visibleStart + 1, indexAfterOffset(layout, scrollTop + clientHeight));
  let start = indexAtOffset(layout, Math.max(0, scrollTop - overscan));
  let end = indexAfterOffset(layout, Math.min(layout.totalHeight, scrollTop + clientHeight + overscan));

  const preferred = Math.max(1, Math.floor(options.preferredTurns ?? DEFAULT_TURN_WINDOW_SIZE));
  const hardMax = hardMaxTurns(options, preferred);
  const retained = retainedRange(options, length);
  ({ start, end } = includeRange(start, end, retained));
  ({ start, end } = expandRange(start, end, preferred, length));

  if (end - start > hardMax) {
    const requiredStart = Math.min(visibleStart, retained?.start ?? visibleStart);
    const requiredEnd = Math.max(visibleEnd, retained?.end ?? visibleEnd);
    const requiredSize = requiredEnd - requiredStart;
    const size = Math.min(length, hardMax);
    const center = requiredSize <= hardMax
      ? (requiredStart + requiredEnd) / 2
      : (visibleStart + visibleEnd) / 2;
    start = clamp(Math.round(center - size / 2), 0, length - size);
    end = start + size;
  }

  return windowFor(layout, start, end);
}

export function stableTurnVirtualWindowForViewport(
  layout: TurnVirtualLayout,
  current: TurnVirtualWindow,
  viewport: { scrollTop: number; clientHeight: number },
  options: TurnVirtualWindowOptions = {},
): TurnVirtualWindow {
  const minimumSize = Math.min(layout.turnIds.length, MIN_TURN_WINDOW_SIZE);
  if (current.end - current.start < minimumSize) {
    return turnVirtualWindowForViewport(layout, viewport, options);
  }
  if (
    current.start === 0
    && current.end === layout.turnIds.length
    && current.end - current.start > minimumSize
  ) {
    const bounded = turnVirtualWindowForViewport(layout, viewport, options);
    if (bounded.end - bounded.start < current.end - current.start) return bounded;
  }
  const overscan = nonNegative(options.overscanPx, DEFAULT_TURN_OVERSCAN_PX);
  const scrollTop = clamp(viewport.scrollTop, 0, layout.totalHeight);
  const requiredStart = Math.max(0, scrollTop - overscan);
  const requiredEnd = Math.min(
    layout.totalHeight,
    scrollTop + Math.max(0, viewport.clientHeight) + overscan,
  );
  const retained = retainedRange(options, layout.turnIds.length);
  const retainsTarget = retained === undefined
    || (retained.start >= current.start && retained.end <= current.end);
  if (
    current.end > current.start
    && retainsTarget
    && requiredStart >= layout.offsets[current.start]!
    && requiredEnd <= layout.offsets[current.end]!
  ) {
    return turnVirtualWindowForRange(layout, current.start, current.end);
  }
  if (current.end > current.start && retainsTarget) {
    const size = current.end - current.start;
    const shiftSize = Math.min(TURN_WINDOW_SHIFT_SIZE, size);
    if (
      requiredStart >= layout.offsets[current.start]!
      && requiredEnd > layout.offsets[current.end]!
    ) {
      let end = current.end;
      while (end < layout.turnIds.length && layout.offsets[end]! < requiredEnd) {
        end = Math.min(layout.turnIds.length, end + shiftSize);
      }
      const shifted = { start: Math.max(0, end - size), end };
      const inclusive = includeRange(shifted.start, shifted.end, retained);
      if (
        inclusive.end - inclusive.start <= hardMaxTurns(options)
        && requiredStart >= layout.offsets[inclusive.start]!
        && requiredEnd <= layout.offsets[inclusive.end]!
      ) {
        return windowFor(layout, inclusive.start, inclusive.end);
      }
    }
    if (
      requiredStart < layout.offsets[current.start]!
      && requiredEnd <= layout.offsets[current.end]!
    ) {
      let start = current.start;
      while (start > 0 && layout.offsets[start]! > requiredStart) {
        start = Math.max(0, start - shiftSize);
      }
      const shifted = { start, end: Math.min(layout.turnIds.length, start + size) };
      const inclusive = includeRange(shifted.start, shifted.end, retained);
      if (
        inclusive.end - inclusive.start <= hardMaxTurns(options)
        && requiredStart >= layout.offsets[inclusive.start]!
        && requiredEnd <= layout.offsets[inclusive.end]!
      ) {
        return windowFor(layout, inclusive.start, inclusive.end);
      }
    }
  }
  return turnVirtualWindowForViewport(layout, viewport, options);
}

export function reconcileTurnVirtualWindow(
  previousIds: readonly string[],
  nextLayout: TurnVirtualLayout,
  previous: TurnVirtualWindow,
  ensureIndex?: number,
  retainRange?: { readonly start: number; readonly end: number },
): TurnVirtualWindow {
  const nextIds = nextLayout.turnIds;
  if (nextIds.length === 0) return windowFor(nextLayout, 0, 0);
  if (previousIds.length === 0 || previous.end <= previous.start) {
    return initialTurnVirtualWindow(nextLayout, MIN_TURN_WINDOW_SIZE, ensureIndex);
  }
  const firstId = previousIds[previous.start];
  const lastId = previousIds[previous.end - 1];
  let start = firstId === undefined ? -1 : nextIds.indexOf(firstId);
  const last = lastId === undefined ? -1 : nextIds.indexOf(lastId);
  if (start < 0 || last < start) {
    return initialTurnVirtualWindow(nextLayout, MIN_TURN_WINDOW_SIZE, ensureIndex);
  }
  let end = last + 1;
  const retained = retainedRange({ ensureIndex, retainRange }, nextIds.length);
  ({ start, end } = includeRange(start, end, retained));
  ({ start, end } = expandRange(
    start,
    end,
    Math.min(nextIds.length, MIN_TURN_WINDOW_SIZE),
    nextIds.length,
  ));
  if (end - start > MAX_TURN_WINDOW_SIZE) {
    const focus = ensureIndex ?? (retained === undefined
      ? Math.floor((start + end) / 2)
      : Math.floor((retained.start + retained.end) / 2));
    start = clamp(focus - Math.floor(MAX_TURN_WINDOW_SIZE / 2), 0, nextIds.length - MAX_TURN_WINDOW_SIZE);
    end = Math.min(nextIds.length, start + MAX_TURN_WINDOW_SIZE);
  }
  return windowFor(nextLayout, start, end);
}

function windowFor(layout: TurnVirtualLayout, start: number, end: number): TurnVirtualWindow {
  const boundedStart = clamp(start, 0, layout.turnIds.length);
  const boundedEnd = clamp(end, boundedStart, layout.turnIds.length);
  return {
    start: boundedStart,
    end: boundedEnd,
    beforeHeight: boundedStart === 0 ? 0 : Math.max(0, layout.offsets[boundedStart]! - layout.gap),
    afterHeight: boundedEnd === layout.turnIds.length
      ? 0
      : Math.max(0, layout.totalHeight - layout.offsets[boundedEnd]!),
  };
}

function indexAtOffset(layout: TurnVirtualLayout, offset: number): number {
  let low = 0;
  let high = layout.turnIds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (layout.offsets[middle + 1]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, layout.turnIds.length - 1));
}

function indexAfterOffset(layout: TurnVirtualLayout, offset: number): number {
  let low = 0;
  let high = layout.turnIds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (layout.offsets[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return clamp(low, 1, layout.turnIds.length);
}

function retainedRange(
  options: TurnVirtualWindowOptions,
  length: number,
): { start: number; end: number } | undefined {
  let start = length;
  let end = 0;
  if (options.ensureIndex !== undefined && options.ensureIndex >= 0 && options.ensureIndex < length) {
    start = options.ensureIndex;
    end = options.ensureIndex + 1;
  }
  if (options.retainRange !== undefined) {
    const rangeStart = clamp(Math.floor(options.retainRange.start), 0, length);
    const rangeEnd = clamp(Math.ceil(options.retainRange.end), rangeStart, length);
    if (rangeEnd > rangeStart) {
      start = Math.min(start, rangeStart);
      end = Math.max(end, rangeEnd);
    }
  }
  return end > start ? { start, end } : undefined;
}

function hardMaxTurns(
  options: TurnVirtualWindowOptions,
  preferred = Math.max(1, Math.floor(options.preferredTurns ?? DEFAULT_TURN_WINDOW_SIZE)),
): number {
  return Math.max(preferred, Math.floor(options.maxTurns ?? MAX_TURN_WINDOW_SIZE));
}

function includeRange(
  start: number,
  end: number,
  retained: { readonly start: number; readonly end: number } | undefined,
) {
  if (retained === undefined) return { start, end };
  return { start: Math.min(start, retained.start), end: Math.max(end, retained.end) };
}

function expandRange(start: number, end: number, size: number, length: number) {
  if (end - start >= size || end - start >= length) return { start, end };
  const missing = Math.min(size, length) - (end - start);
  const before = Math.min(start, Math.floor(missing / 2));
  start -= before;
  end = Math.min(length, end + missing - before);
  start = Math.max(0, end - Math.min(size, length));
  return { start, end };
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
