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

import {
  cleanup,
  computed,
  effect,
  type ListRef,
  type Signal,
  signal,
  untracked,
  type ViewRef,
} from 'nsh';
import {
  TextView,
  type TextViewHeading,
  type TextViewHeadingsEvent,
  type TextViewRef,
  type TextViewVisibleBlocksEvent,
} from 'nsh/base';
import {
  type PartVisibleBlocks,
  pickActiveHeading,
  pickViewedTurn,
  type TocHeadingItem,
  type TocLayoutMode,
  type TurnViewportSpan,
  tocLayoutMode,
} from './markdownTocModel';
import { markdownExtensions } from './SpecView';
import { splitSpecMarkdown } from './spec/session.ts';

export type TextViewTocBinding = {
  onRef(ref: TextViewRef | null | undefined): void;
  onHeadingsChange(event: TextViewHeadingsEvent): void;
  onVisibleBlocksChange(event: TextViewVisibleBlocksEvent): void;
  dispose(): void;
};

export type BindTextViewToc = (partKey: string, order: number) => TextViewTocBinding;

export type LogicalOutputSource = {
  readonly keyPrefix: string;
  readonly text: string;
  readonly streaming: boolean;
};

export type TurnTocEntry = TocHeadingItem & {
  readonly rowKey: string;
  readonly partKey: string;
  readonly blockIndex: number;
};

type RegisteredPart = {
  readonly rowKey: string;
  readonly partKey: string;
  readonly order: number;
  ref: TextViewRef | null;
  headingsLoaded: boolean;
  headings: readonly TextViewHeading[];
  firstBlock: number | null;
  lastBlock: number | null;
};

type RowInstance = {
  readonly rowKey: string;
  node: ViewRef | null;
  height: number | null;
  layoutSeq: number;
  visibleSeq: number;
  readonly parts: Map<string, RegisteredPart>;
};

type ResolvedPart = {
  readonly rowKey: string;
  readonly partKey: string;
  readonly headings: readonly TextViewHeading[];
  readonly mounted: RegisteredPart | null;
};

type PendingJump = {
  readonly epoch: number;
  readonly turnKey: string;
  readonly rowKey: string;
  readonly partKey: string;
  readonly blockIndex: number;
  inFlight: boolean;
};

export type TurnTocRowBinding = {
  readonly onRef: (node: ViewRef | null | undefined) => void;
  readonly onHeight: (height: number) => void;
  readonly bindTextView: BindTextViewToc;
  readonly dispose: () => void;
};

export type TurnTocController = {
  readonly mode: () => TocLayoutMode;
  readonly turnKey: () => string | null;
  readonly items: () => readonly TurnTocEntry[];
  readonly activeId: () => string | null;
  readonly shown: () => boolean;
  bindRow(rowKey: string): TurnTocRowBinding;
  onVisibleRowsChange(rowKeys: readonly string[]): void;
  onScroll(): void;
  onViewportChange(): void;
  jumpTo(id: string): void;
  cancelPendingJump(): void;
};

const OVERFLOW_SLOP = 4;
const OUTLINE_CACHE_MAX = 256;

export function createTurnToc(opts: {
  readonly enabled: () => boolean;
  readonly listRef: () => ListRef | undefined;
  readonly listWidth: () => number;
  readonly viewportHeight: () => number;
  readonly railInset: () => number;
  readonly atBottom: () => boolean;
  readonly isTerminal: () => boolean;
  readonly rowTurnKey: (rowKey: string) => string | null;
  readonly turnOutputRowKeys: (turnKey: string) => readonly string[];
  readonly rowOutputSources: (rowKey: string) => readonly LogicalOutputSource[];
  readonly scrollToRow: (rowKey: string) => boolean;
  readonly onBeforeJump: () => void;
}): TurnTocController {
  // Virtualized Lists can keep an orphaned spare cell mounted while another
  // live cell already renders the same rowKey. Tracking each mounted row
  // instance separately prevents spare cells (never laid out / never visible)
  // from clobbering the live cell's height, ViewRef, or TextViewRef.
  const rowsByKey = new Map<string, Set<RowInstance>>();
  const outlineCache = new Map<
    string,
    {
      readonly text: string;
      readonly streaming: boolean;
      readonly headings: readonly TextViewHeading[];
    }
  >();

  const viewedTurn = signal<string | null>(null);
  const headingsRev = signal(0);
  const visibleRev = signal(0);
  const layoutRev = signal(0);

  let seq = 0;
  let visibleRowKeys: readonly string[] = [];
  let visibleRowKeySet = new Set<string>();
  let measureQueued = false;
  let measureInFlight = false;
  let measureEpoch = 0;
  let jumpEpoch = 0;
  let pendingJump: PendingJump | null = null;
  let lastActiveTurn: string | null = null;
  let lastActiveId: string | null = null;

  const bump = (sig: Signal<number>) => sig.set(sig() + 1);

  const setViewedTurn = (next: string | null) => {
    if (next !== null && pendingJump && pendingJump.turnKey !== next) {
      pendingJump = null;
    }
    if (next !== viewedTurn()) {
      viewedTurn.set(next);
    }
  };

  const liveRow = (rowKey: string): RowInstance | null => {
    const instances = rowsByKey.get(rowKey);
    if (!instances || instances.size === 0) return null;
    if (instances.size === 1) return instances.values().next().value ?? null;
    let best: RowInstance | null = null;
    let bestScore = -1;
    for (const row of instances) {
      let hasVisible = false;
      for (const part of row.parts.values()) {
        if (part.firstBlock !== null) {
          hasVisible = true;
          break;
        }
      }
      const score = hasVisible ? 2 : row.height !== null ? 1 : 0;
      if (
        best === null ||
        score > bestScore ||
        (score === bestScore &&
          (row.visibleSeq > best.visibleSeq ||
            (row.visibleSeq === best.visibleSeq && row.layoutSeq > best.layoutSeq)))
      ) {
        best = row;
        bestScore = score;
      }
    }
    return best;
  };

  const notifyLiveTransition = (
    rowKey: string,
    instance: RowInstance,
    prevLive: RowInstance | null,
    ownBump: () => void,
  ) => {
    const nextLive = liveRow(rowKey);
    if (nextLive !== prevLive) {
      bump(headingsRev);
      bump(layoutRev);
      bump(visibleRev);
      scheduleOverlapMeasure();
    } else if (nextLive === instance) {
      ownBump();
    }
  };

  const mode = computed<TocLayoutMode>(() => {
    if (!opts.enabled()) return { kind: 'hidden' };
    return tocLayoutMode({
      listWidth: opts.listWidth(),
      railInset: opts.railInset(),
      terminal: opts.isTerminal(),
    });
  });

  const visibleTurnKeys = (): string[] => {
    const seen = new Set<string>();
    const turns: string[] = [];
    for (const rowKey of visibleRowKeys) {
      const turnKey = opts.rowTurnKey(rowKey);
      if (turnKey === null || seen.has(turnKey)) continue;
      seen.add(turnKey);
      turns.push(turnKey);
    }
    return turns;
  };

  const turnHasHeadings = (turnKey: string): boolean => {
    for (const part of resolvedPartsForTurn(turnKey)) {
      if (part.headings.length > 0) return true;
    }
    return false;
  };

  const needsOverlapMeasure = (): boolean => {
    if (!opts.enabled() || mode().kind === 'hidden') return false;
    const turns = visibleTurnKeys();
    return turns.length > 1 && turns.some(turnHasHeadings);
  };

  const runOverlapMeasure = async () => {
    if (measureInFlight) {
      measureQueued = true;
      return;
    }
    measureQueued = false;
    if (!needsOverlapMeasure()) return;
    const list = opts.listRef();
    if (!list) return;
    const snapshot: { rowKey: string; turnKey: string; node: ViewRef }[] = [];
    for (const rowKey of visibleRowKeys) {
      const turnKey = opts.rowTurnKey(rowKey);
      if (turnKey === null) continue;
      const node = liveRow(rowKey)?.node;
      if (node) snapshot.push({ rowKey, turnKey, node });
    }
    if (snapshot.length === 0) return;

    measureInFlight = true;
    const epoch = ++measureEpoch;
    try {
      const [listBox, ...rowBoxes] = await Promise.all([
        list.measure(),
        ...snapshot.map((entry) => entry.node.measure()),
      ]);
      if (epoch !== measureEpoch || !listBox) return;
      const spansByTurn = new Map<string, { top: number; bottom: number }>();
      for (let i = 0; i < snapshot.length; i += 1) {
        const box = rowBoxes[i];
        if (!box) continue;
        const top = box.pagePosition.y;
        const bottom = top + box.bounds.size.height;
        const turnKey = snapshot[i]!.turnKey;
        const prev = spansByTurn.get(turnKey);
        if (prev) {
          if (top < prev.top) prev.top = top;
          if (bottom > prev.bottom) prev.bottom = bottom;
        } else {
          spansByTurn.set(turnKey, { top, bottom });
        }
      }
      const spans: TurnViewportSpan[] = [];
      for (const [turnKey, span] of spansByTurn) {
        spans.push({ turnKey, top: span.top, bottom: span.bottom });
      }
      const viewportTop = listBox.pagePosition.y;
      const picked = pickViewedTurn(
        spans,
        viewportTop,
        viewportTop + listBox.bounds.size.height,
        viewedTurn(),
      );
      if (picked !== null) setViewedTurn(picked);
    } catch {
      // List or row unmounted mid-measure.
    } finally {
      measureInFlight = false;
      if (measureQueued) queueMicrotask(() => void runOverlapMeasure());
    }
  };

  const scheduleOverlapMeasure = () => {
    if (!needsOverlapMeasure()) return;
    if (measureQueued) return;
    measureQueued = true;
    if (!measureInFlight) queueMicrotask(() => void runOverlapMeasure());
  };

  const cachedHeadings = (
    rowKey: string,
    partKey: string,
    text: string,
    streaming: boolean,
  ): readonly TextViewHeading[] => {
    const cacheKey = `${rowKey}\0${partKey}`;
    const hit = outlineCache.get(cacheKey);
    if (hit && hit.text === text && hit.streaming === streaming) {
      return hit.headings;
    }
    const headings = TextView.headings(
      text,
      streaming ? { streaming: true, preserveLineBreaks: true } : { preserveLineBreaks: true },
      [...markdownExtensions],
    );
    if (outlineCache.size >= OUTLINE_CACHE_MAX) {
      const oldest = outlineCache.keys().next().value;
      if (oldest !== undefined) outlineCache.delete(oldest);
    }
    outlineCache.set(cacheKey, { text, streaming, headings });
    return headings;
  };

  // Combines live headings from mounted TextViews with native-parsed headings
  // for output rows of the same turn currently virtualized off-screen.
  const resolvedPartsForTurn = (turnKey: string): ResolvedPart[] => {
    const resolved: ResolvedPart[] = [];
    for (const rowKey of opts.turnOutputRowKeys(turnKey)) {
      const row = liveRow(rowKey);
      if (row && row.parts.size > 0) {
        let allLoaded = true;
        for (const part of row.parts.values()) {
          if (!part.headingsLoaded) {
            allLoaded = false;
            break;
          }
        }
        if (allLoaded) {
          const sorted = [...row.parts.values()].sort((a, b) => a.order - b.order);
          for (const part of sorted) {
            resolved.push({
              rowKey,
              partKey: part.partKey,
              headings: part.headings,
              mounted: part,
            });
          }
          continue;
        }
      }
      for (const source of opts.rowOutputSources(rowKey)) {
        for (const seg of splitSpecMarkdown(source.text)) {
          if (seg.kind !== 'markdown') continue;
          const partKey = `${source.keyPrefix}${seg.key}`;
          const mounted = row?.parts.get(partKey) ?? null;
          const headings = mounted?.headingsLoaded
            ? mounted.headings
            : cachedHeadings(rowKey, partKey, seg.text, source.streaming);
          resolved.push({ rowKey, partKey, headings, mounted });
        }
      }
    }
    return resolved;
  };

  const sameEntries = (a: readonly TurnTocEntry[], b: readonly TurnTocEntry[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i]!;
      const right = b[i]!;
      if (
        left.id !== right.id ||
        left.level !== right.level ||
        left.title !== right.title ||
        left.blockIndex !== right.blockIndex
      ) {
        return false;
      }
    }
    return true;
  };

  let lastEntries: readonly TurnTocEntry[] = [];
  const items = computed<readonly TurnTocEntry[]>(() => {
    headingsRev();
    if (!opts.enabled() || mode().kind === 'hidden') {
      lastEntries = [];
      return lastEntries;
    }
    const turnKey = viewedTurn();
    if (!turnKey) {
      lastEntries = [];
      return lastEntries;
    }
    const entries: TurnTocEntry[] = [];
    for (const part of resolvedPartsForTurn(turnKey)) {
      for (const h of part.headings) {
        entries.push({
          id: `${part.rowKey}:${part.partKey}:${h.blockIndex}`,
          level: h.level,
          title: h.text,
          rowKey: part.rowKey,
          partKey: part.partKey,
          blockIndex: h.blockIndex,
        });
      }
    }
    if (sameEntries(lastEntries, entries)) return lastEntries;
    lastEntries = entries;
    return entries;
  });

  const overflows = computed<boolean>(() => {
    layoutRev();
    if (!opts.enabled() || mode().kind === 'hidden') return false;
    const turnKey = viewedTurn();
    const viewport = opts.viewportHeight();
    if (!turnKey || viewport <= 0) return false;
    const rowKeys = opts.turnOutputRowKeys(turnKey);
    if (rowKeys.length === 0) return false;
    let totalHeight = 0;
    let mountedCount = 0;
    for (const rowKey of rowKeys) {
      const row = liveRow(rowKey);
      if (row) {
        mountedCount += 1;
        totalHeight += row.height ?? 0;
      }
    }
    if (totalHeight > viewport + OVERFLOW_SLOP) return true;
    // If some output rows of the viewed turn are mounted while others are
    // virtualized out of the outer List window, the turn overflows.
    return mountedCount > 0 && mountedCount < rowKeys.length;
  });

  const shown = computed(() => overflows() && items().length > 0);

  const activeId = computed<string | null>(() => {
    visibleRev();
    if (!shown()) return null;
    const list = items();
    if (list.length === 0) return null;
    const turnKey = viewedTurn();
    if (!turnKey) return list[0]!.id;
    const parts: PartVisibleBlocks[] = resolvedPartsForTurn(turnKey).map((part) => {
      const rowVisible = visibleRowKeySet.has(part.rowKey);
      return {
        partKey: `${part.rowKey}\0${part.partKey}`,
        firstBlock: rowVisible ? (part.mounted?.firstBlock ?? null) : null,
        lastBlock: rowVisible ? (part.mounted?.lastBlock ?? null) : null,
      };
    });
    const refs = list.map((item) => ({
      id: item.id,
      partKey: `${item.rowKey}\0${item.partKey}`,
      blockIndex: item.blockIndex,
    }));
    const fallback = lastActiveTurn === turnKey ? lastActiveId : null;
    const next = pickActiveHeading(refs, parts, opts.atBottom(), fallback);
    lastActiveTurn = turnKey;
    lastActiveId = next;
    return next;
  });

  const scrollPartToBlock = (part: RegisteredPart, blockIndex: number): Promise<boolean> => {
    if (!part.ref || !part.headingsLoaded) return Promise.resolve(false);
    return part.ref.scrollToBlock(blockIndex, {
      viewPosition: 0,
      viewOffset: opts.isTerminal() ? 0 : 16,
      animated: false,
    });
  };

  const tryResolvePendingJump = (rowKey: string) => {
    const target = pendingJump;
    if (!target || target.rowKey !== rowKey || target.inFlight) return;
    if (!visibleRowKeySet.has(rowKey)) return;
    const row = liveRow(rowKey);
    const part = row?.parts.get(target.partKey) ?? null;
    if (!part?.ref || !part.headingsLoaded) return;
    target.inFlight = true;
    void scrollPartToBlock(part, target.blockIndex).then(
      (ok) => {
        if (pendingJump !== target) return;
        if (ok) {
          pendingJump = null;
        } else {
          target.inFlight = false;
        }
      },
      () => {
        if (pendingJump === target) target.inFlight = false;
      },
    );
  };

  const bindRow = (rowKey: string): TurnTocRowBinding => {
    const instance: RowInstance = {
      rowKey,
      node: null,
      height: null,
      layoutSeq: 0,
      visibleSeq: 0,
      parts: new Map(),
    };
    let set = rowsByKey.get(rowKey);
    if (!set) {
      set = new Set();
      rowsByKey.set(rowKey, set);
    }
    set.add(instance);

    const bindTextView: BindTextViewToc = (partKey, order) => {
      const part: RegisteredPart = {
        rowKey,
        partKey,
        order,
        ref: null,
        headingsLoaded: false,
        headings: [],
        firstBlock: null,
        lastBlock: null,
      };
      instance.parts.set(partKey, part);
      return {
        onRef(ref) {
          part.ref = ref ?? null;
          if (part.ref) tryResolvePendingJump(rowKey);
        },
        onHeadingsChange(event) {
          part.headingsLoaded = true;
          part.headings = event.headings;
          if (liveRow(rowKey) === instance) bump(headingsRev);
          tryResolvePendingJump(rowKey);
        },
        onVisibleBlocksChange(event) {
          const first = event.firstBlock ?? null;
          const last = event.lastBlock ?? null;
          if (part.firstBlock === first && part.lastBlock === last) {
            tryResolvePendingJump(rowKey);
            return;
          }
          const prevLive = liveRow(rowKey);
          part.firstBlock = first;
          part.lastBlock = last;
          if (first !== null) {
            instance.visibleSeq = ++seq;
          }
          notifyLiveTransition(rowKey, instance, prevLive, () => bump(visibleRev));
          tryResolvePendingJump(rowKey);
        },
        dispose() {
          const prevLive = liveRow(rowKey);
          const hadHeadings = part.headings.length > 0;
          const hadVisible = part.firstBlock !== null;
          instance.parts.delete(partKey);
          const nextLive = liveRow(rowKey);
          if (nextLive !== prevLive) {
            bump(headingsRev);
            bump(layoutRev);
            bump(visibleRev);
            scheduleOverlapMeasure();
          } else if (prevLive === instance) {
            if (hadHeadings) bump(headingsRev);
            if (hadVisible) bump(visibleRev);
          }
        },
      };
    };

    const onRef = (node: ViewRef | null | undefined) => {
      instance.node = node ?? null;
      if (instance.node && liveRow(rowKey) === instance) scheduleOverlapMeasure();
    };

    const onHeight = (height: number) => {
      if (instance.height !== null && Math.abs(height - instance.height) < 0.5) return;
      const prevLive = liveRow(rowKey);
      instance.height = height;
      instance.layoutSeq = ++seq;
      notifyLiveTransition(rowKey, instance, prevLive, () => {
        bump(layoutRev);
        if (visibleTurnKeys().length > 1) scheduleOverlapMeasure();
      });
    };

    const dispose = () => {
      const prevLive = liveRow(rowKey);
      const hadHeight = instance.height !== null;
      const hadParts = instance.parts.size > 0;
      instance.node = null;
      instance.parts.clear();
      const bucket = rowsByKey.get(rowKey);
      if (bucket) {
        bucket.delete(instance);
        if (bucket.size === 0) rowsByKey.delete(rowKey);
      }
      if (prevLive === instance && (hadHeight || hadParts)) {
        bump(headingsRev);
        bump(layoutRev);
        bump(visibleRev);
      }
    };

    return { onRef, onHeight, bindTextView, dispose };
  };

  const reconcileViewedTurn = () => {
    const turns = visibleTurnKeys();
    if (!opts.enabled() || mode().kind === 'hidden' || turns.length === 0) {
      measureEpoch += 1;
      setViewedTurn(null);
      return;
    }
    if (turns.length === 1 || !turns.some(turnHasHeadings)) {
      measureEpoch += 1;
      setViewedTurn(turns[0]!);
      return;
    }
    const current = viewedTurn();
    if (current === null || !turns.includes(current)) {
      setViewedTurn(turns[turns.length - 1]!);
    }
    scheduleOverlapMeasure();
  };

  const onVisibleRowsChange = (rowKeys: readonly string[]) => {
    const changed =
      rowKeys.length !== visibleRowKeySet.size || rowKeys.some((key) => !visibleRowKeySet.has(key));
    visibleRowKeys = rowKeys;
    if (changed) {
      visibleRowKeySet = new Set(rowKeys);
      bump(visibleRev);
      bump(layoutRev);
    }
    reconcileViewedTurn();
    if (pendingJump && visibleRowKeySet.has(pendingJump.rowKey)) {
      tryResolvePendingJump(pendingJump.rowKey);
    }
  };

  const onScroll = () => {
    scheduleOverlapMeasure();
  };

  const onViewportChange = () => {
    scheduleOverlapMeasure();
  };

  const armPendingJump = (epoch: number, turnKey: string | null, entry: TurnTocEntry) => {
    if (turnKey !== null) {
      pendingJump = {
        epoch,
        turnKey,
        rowKey: entry.rowKey,
        partKey: entry.partKey,
        blockIndex: entry.blockIndex,
        inFlight: false,
      };
    }
    opts.scrollToRow(entry.rowKey);
    tryResolvePendingJump(entry.rowKey);
  };

  const jumpTo = (id: string) => {
    const entry = items().find((item) => item.id === id);
    if (!entry) return;
    const turnKey = viewedTurn();
    const epoch = ++jumpEpoch;
    opts.onBeforeJump();
    pendingJump = null;
    const row = liveRow(entry.rowKey);
    const part = row?.parts.get(entry.partKey) ?? null;
    if (visibleRowKeySet.has(entry.rowKey) && part?.ref && part.headingsLoaded) {
      void scrollPartToBlock(part, entry.blockIndex).then(
        (ok) => {
          if (ok || epoch !== jumpEpoch) return;
          armPendingJump(epoch, turnKey, entry);
        },
        () => {
          if (epoch !== jumpEpoch) return;
          armPendingJump(epoch, turnKey, entry);
        },
      );
      return;
    }
    armPendingJump(epoch, turnKey, entry);
  };

  const cancelPendingJump = () => {
    jumpEpoch += 1;
    pendingJump = null;
  };

  effect(() => {
    mode();
    untracked(reconcileViewedTurn);
  });

  cleanup(() => {
    measureEpoch += 1;
    pendingJump = null;
    rowsByKey.clear();
    outlineCache.clear();
  });

  return {
    mode,
    turnKey: viewedTurn,
    items,
    activeId,
    shown,
    bindRow,
    onVisibleRowsChange,
    onScroll,
    onViewportChange,
    jumpTo,
    cancelPendingJump,
  };
}
