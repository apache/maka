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

import { context, platform, signal, Storage } from 'nsh';

export type ComposerToolbarWidget = 'permissions' | 'workspace' | 'usage' | 'context' | 'model';
export type ComposerToolbarSlot = ComposerToolbarWidget | 'spacer';
export type ContextUsageDisplay = 'always' | 'high' | 'off';

export const DEFAULT_COMPOSER_TOOLBAR_LAYOUT: readonly ComposerToolbarSlot[] = [
  'permissions',
  'workspace',
  'spacer',
  'usage',
  'context',
  'model',
];

export const NARROW_COMPOSER_TOOLBAR_WIDTH = 520;

const VALID_SLOTS = new Set<string>(DEFAULT_COMPOSER_TOOLBAR_LAYOUT);
const VALID_CONTEXT_MODES = new Set<string>(['always', 'high', 'off']);

export function normalizeComposerToolbarLayout(raw: unknown): ComposerToolbarSlot[] {
  if (!Array.isArray(raw)) return [...DEFAULT_COMPOSER_TOOLBAR_LAYOUT];
  const seen = new Set<ComposerToolbarSlot>();
  const kept: ComposerToolbarSlot[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !VALID_SLOTS.has(entry)) continue;
    const slot = entry as ComposerToolbarSlot;
    if (seen.has(slot)) continue;
    seen.add(slot);
    kept.push(slot);
  }
  if (!kept.length) return [...DEFAULT_COMPOSER_TOOLBAR_LAYOUT];
  for (const slot of DEFAULT_COMPOSER_TOOLBAR_LAYOUT) {
    if (!seen.has(slot)) kept.push(slot);
  }
  return kept;
}

export function moveComposerToolbarSlot(
  layout: readonly ComposerToolbarSlot[],
  widget: ComposerToolbarWidget,
  targetIndex: number,
): ComposerToolbarSlot[] {
  const from = layout.indexOf(widget);
  if (from === -1) return [...layout];
  const next = [...layout];
  next.splice(from, 1);
  const adjusted = targetIndex > from ? targetIndex - 1 : targetIndex;
  next.splice(Math.max(0, Math.min(next.length, adjusted)), 0, widget);
  return next;
}

export function stepComposerToolbarSlot(
  layout: readonly ComposerToolbarSlot[],
  widget: ComposerToolbarWidget,
  delta: -1 | 1,
): ComposerToolbarSlot[] {
  const from = layout.indexOf(widget);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= layout.length) return [...layout];
  const next = [...layout];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

export function isDefaultComposerToolbarLayout(layout: readonly ComposerToolbarSlot[]): boolean {
  return (
    layout.length === DEFAULT_COMPOSER_TOOLBAR_LAYOUT.length &&
    layout.every((slot, index) => slot === DEFAULT_COMPOSER_TOOLBAR_LAYOUT[index])
  );
}

export type SlotBounds = { left: number; width: number };
export type ToolbarDragPoint = { pageX: number; pageY: number };

export type MeasuredToolbarTrack = {
  left: number;
  top: number;
  width: number;
  height: number;
  slots: SlotBounds[];
  spacer: SlotBounds | null;
};

export type ToolbarDragPreview = {
  widget: ComposerToolbarWidget;
  targetIndex: number;
  indicatorX: number;
  overSpacer: boolean;
};

const DROP_TRACK_SLOP_X = 16;
const DROP_TRACK_SLOP_Y = 24;

function isInsideDropTrack(point: ToolbarDragPoint, track: MeasuredToolbarTrack): boolean {
  return (
    point.pageX >= track.left - DROP_TRACK_SLOP_X &&
    point.pageX <= track.left + track.width + DROP_TRACK_SLOP_X &&
    point.pageY >= track.top - DROP_TRACK_SLOP_Y &&
    point.pageY <= track.top + track.height + DROP_TRACK_SLOP_Y
  );
}

export function computeDropSlot(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  items: readonly SlotBounds[],
): { index: number; indicatorX: number } {
  let index = items.length;
  let indicatorX = Math.max(0, trackWidth - 2);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (clientX < item.left + item.width / 2) {
      return { index: i, indicatorX: Math.max(0, item.left - trackLeft - 2) };
    }
    indicatorX = Math.min(Math.max(0, trackWidth - 2), item.left + item.width - trackLeft + 1);
  }
  return { index, indicatorX };
}

export function createToolbarDragController(callbacks: {
  onPreview(preview: ToolbarDragPreview | null): void;
  onCommit(widget: ComposerToolbarWidget, targetIndex: number): void;
}) {
  let generation = 0;
  let active: {
    id: number;
    widget: ComposerToolbarWidget;
    latestPoint: ToolbarDragPoint;
    released: boolean;
    measured: MeasuredToolbarTrack | null;
  } | null = null;

  const project = (
    widget: ComposerToolbarWidget,
    point: ToolbarDragPoint,
    track: MeasuredToolbarTrack,
  ): ToolbarDragPreview | null => {
    if (!isInsideDropTrack(point, track)) return null;
    const { index, indicatorX } = computeDropSlot(
      point.pageX,
      track.left,
      track.width,
      track.slots,
    );
    const overSpacer =
      track.spacer !== null &&
      point.pageX >= track.spacer.left - 6 &&
      point.pageX <= track.spacer.left + track.spacer.width + 6;
    return { widget, targetIndex: index, indicatorX, overSpacer };
  };

  const commitIfReady = () => {
    if (!active || !active.released || !active.measured) return;
    const { widget, latestPoint, measured } = active;
    active = null;
    callbacks.onPreview(null);
    if (!measured.slots.length) return;
    const preview = project(widget, latestPoint, measured);
    if (preview) callbacks.onCommit(widget, preview.targetIndex);
  };

  return {
    start(
      widget: ComposerToolbarWidget,
      initialIndex: number,
      point: ToolbarDragPoint,
      measure: Promise<MeasuredToolbarTrack | null>,
    ) {
      const id = ++generation;
      active = { id, widget, latestPoint: point, released: false, measured: null };
      callbacks.onPreview({ widget, targetIndex: initialIndex, indicatorX: 0, overSpacer: false });
      void measure
        .then((track) => {
          if (!active || active.id !== id) return;
          if (!track || !track.slots.length) {
            active = null;
            callbacks.onPreview(null);
            return;
          }
          active.measured = track;
          if (active.released) commitIfReady();
          else callbacks.onPreview(project(active.widget, active.latestPoint, track));
        })
        .catch(() => {
          if (active && active.id === id) {
            active = null;
            callbacks.onPreview(null);
          }
        });
    },
    move(point: ToolbarDragPoint) {
      if (!active || active.released) return;
      active.latestPoint = point;
      if (active.measured) callbacks.onPreview(project(active.widget, point, active.measured));
    },
    release(point?: ToolbarDragPoint) {
      if (!active) return;
      if (point) active.latestPoint = point;
      active.released = true;
      if (active.measured) commitIfReady();
      else callbacks.onPreview(null);
    },
    cancel() {
      generation++;
      active = null;
      callbacks.onPreview(null);
    },
  };
}

const STORAGE_KEY = 'composer-toolbar';
type Field = 'layout' | 'contextUsage' | 'usageLimits';

function createComposerToolbarOwner() {
  const supported = platform.idiom !== 'terminal';
  const layout = signal<ComposerToolbarSlot[]>([...DEFAULT_COMPOSER_TOOLBAR_LAYOUT]);
  const contextUsage = signal<ContextUsageDisplay>('always');
  const usageLimits = signal(false);

  const dirty = new Set<Field>();
  let loading: Promise<void> | null = null;
  let initialized = false;
  let saving: Promise<void> | null = null;
  let queued = false;

  const persist = () => {
    queued = true;
    if (saving) return;
    saving = Promise.resolve().then(async () => {
      try {
        if (loading) await loading;
        while (queued) {
          queued = false;
          const payload = JSON.stringify({
            layout: layout(),
            contextUsage: contextUsage(),
            usageLimits: usageLimits(),
          });
          try {
            await Storage.setItem(STORAGE_KEY, payload);
          } catch {
            continue;
          }
        }
      } finally {
        saving = null;
      }
    });
  };

  const setLayout = (next: readonly ComposerToolbarSlot[]) => {
    dirty.add('layout');
    layout.set(normalizeComposerToolbarLayout(next));
    persist();
  };

  return {
    supported,
    layout: () => layout(),
    contextUsage: () => contextUsage(),
    usageLimits: () => usageLimits(),
    setLayout,
    moveWidget(widget: ComposerToolbarWidget, targetIndex: number) {
      setLayout(moveComposerToolbarSlot(layout(), widget, targetIndex));
    },
    stepWidget(widget: ComposerToolbarWidget, delta: -1 | 1) {
      setLayout(stepComposerToolbarSlot(layout(), widget, delta));
    },
    resetLayout() {
      setLayout(DEFAULT_COMPOSER_TOOLBAR_LAYOUT);
    },
    chooseContextUsage(mode: ContextUsageDisplay) {
      if (!VALID_CONTEXT_MODES.has(mode)) return;
      dirty.add('contextUsage');
      contextUsage.set(mode);
      persist();
    },
    setUsageLimits(enabled: boolean) {
      dirty.add('usageLimits');
      usageLimits.set(enabled);
      persist();
    },
    whenIdle: () => saving ?? Promise.resolve(),
    initialize() {
      if (initialized || !supported) return;
      initialized = true;
      loading = Storage.getItem(STORAGE_KEY)
        .then((raw) => {
          if (!raw) return;
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object') return;
          if (!dirty.has('layout') && 'layout' in parsed) {
            layout.set(normalizeComposerToolbarLayout(parsed.layout));
          }
          if (
            !dirty.has('contextUsage') &&
            typeof parsed.contextUsage === 'string' &&
            VALID_CONTEXT_MODES.has(parsed.contextUsage)
          ) {
            contextUsage.set(parsed.contextUsage as ContextUsageDisplay);
          }
          if (!dirty.has('usageLimits') && typeof parsed.usageLimits === 'boolean') {
            usageLimits.set(parsed.usageLimits);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          loading = null;
        });
    },
  };
}

// Independent UI bundles share the window owner, including its in-flight reads and writes.
const OWNER = Symbol.for('maka.composerToolbar');
const shared = globalThis as { [OWNER]?: ReturnType<typeof createComposerToolbarOwner> };
export const composerToolbar = (shared[OWNER] ??= createComposerToolbarOwner());
export const initializeComposerToolbar = composerToolbar.initialize;

const COMPACT_CONTEXT = Symbol.for('maka.composerToolbarCompact');
const sharedCompact = globalThis as {
  [COMPACT_CONTEXT]?: ReturnType<typeof context<() => boolean>>;
};
const toolbarCompactContext = (sharedCompact[COMPACT_CONTEXT] ??= context<() => boolean>(
  () => false,
));
export const ToolbarCompactProvider = toolbarCompactContext.Provider;
export function useToolbarCompact(): boolean {
  return toolbarCompactContext()();
}
