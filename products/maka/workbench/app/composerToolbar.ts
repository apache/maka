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

export const COMPOSER_TOOLBAR_WIDGETS: readonly ComposerToolbarWidget[] = [
  'permissions',
  'workspace',
  'usage',
  'context',
  'model',
];

export const DEFAULT_COMPOSER_TOOLBAR_LAYOUT: readonly ComposerToolbarSlot[] = [
  'permissions',
  'workspace',
  'spacer',
  'usage',
  'context',
  'model',
];

export const contextUsageDisplays: readonly ContextUsageDisplay[] = ['always', 'high', 'off'];

export const NARROW_COMPOSER_TOOLBAR_WIDTH = 520;

const VALID_SLOTS = new Set<string>(DEFAULT_COMPOSER_TOOLBAR_LAYOUT);
const VALID_CONTEXT_MODES = new Set<string>(contextUsageDisplays);

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

export function splitComposerToolbarLayout(layout: readonly ComposerToolbarSlot[]): {
  left: ComposerToolbarWidget[];
  right: ComposerToolbarWidget[];
} {
  const spacer = layout.indexOf('spacer');
  if (spacer === -1) {
    return {
      left: layout.filter((slot): slot is ComposerToolbarWidget => slot !== 'spacer'),
      right: [],
    };
  }
  return {
    left: layout.slice(0, spacer) as ComposerToolbarWidget[],
    right: layout.slice(spacer + 1) as ComposerToolbarWidget[],
  };
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
  const clamped = Math.max(0, Math.min(next.length, adjusted));
  next.splice(clamped, 0, widget);
  return next;
}

export function stepComposerToolbarSlot(
  layout: readonly ComposerToolbarSlot[],
  widget: ComposerToolbarWidget,
  delta: -1 | 1,
): ComposerToolbarSlot[] {
  const from = layout.indexOf(widget);
  if (from === -1) return [...layout];
  const to = from + delta;
  if (to < 0 || to >= layout.length) return [...layout];
  const next = [...layout];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function isDefaultComposerToolbarLayout(layout: readonly ComposerToolbarSlot[]): boolean {
  return (
    layout.length === DEFAULT_COMPOSER_TOOLBAR_LAYOUT.length &&
    layout.every((slot, index) => slot === DEFAULT_COMPOSER_TOOLBAR_LAYOUT[index])
  );
}

export type SlotBounds = { left: number; width: number };

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
    const midpoint = item.left + item.width / 2;
    if (clientX < midpoint) {
      index = i;
      indicatorX = Math.max(0, item.left - trackLeft - 2);
      break;
    }
    indicatorX = Math.min(Math.max(0, trackWidth - 2), item.left + item.width - trackLeft + 1);
  }
  return { index, indicatorX };
}

const LAYOUT_KEY = 'composer-toolbar-layout';
const CONTEXT_USAGE_KEY = 'composer-context-usage';
const USAGE_LIMITS_KEY = 'composer-usage-limits';
type StorageKey = typeof LAYOUT_KEY | typeof CONTEXT_USAGE_KEY | typeof USAGE_LIMITS_KEY;

type Initialization =
  | { kind: 'uninitialized'; pending: Set<StorageKey> }
  | { kind: 'loading'; pending: Set<StorageKey> }
  | { kind: 'ready' };
type Persistence =
  | { kind: 'idle' }
  | { kind: 'saving'; pending: Map<StorageKey, string>; completion: Promise<void> };

function createComposerToolbarOwner() {
  const supported = platform.idiom !== 'terminal';
  const layout = signal<ComposerToolbarSlot[]>([...DEFAULT_COMPOSER_TOOLBAR_LAYOUT]);
  const contextUsage = signal<ContextUsageDisplay>('always');
  const usageLimits = signal(false);

  let initialization: Initialization = {
    kind: 'uninitialized',
    pending: new Set([LAYOUT_KEY, CONTEXT_USAGE_KEY, USAGE_LIMITS_KEY]),
  };
  let persistence: Persistence = { kind: 'idle' };

  const selected = (key: StorageKey) => {
    if (initialization.kind !== 'ready') initialization.pending.delete(key);
  };

  const persist = (key: StorageKey, value: string) => {
    if (persistence.kind === 'saving') {
      persistence.pending.set(key, value);
      return;
    }
    const pending = new Map<StorageKey, string>([[key, value]]);
    const completion = Promise.resolve().then(async () => {
      for (;;) {
        const next = pending.entries().next();
        if (next.done) break;
        const [entryKey, entryValue] = next.value;
        pending.delete(entryKey);
        try {
          await Storage.setItem(entryKey, entryValue);
        } catch {
          continue;
        }
      }
      persistence = { kind: 'idle' };
    });
    persistence = { kind: 'saving', pending, completion };
  };

  const restore = (key: StorageKey, apply: (value: string | null) => void) => {
    if (initialization.kind === 'ready' || !initialization.pending.has(key))
      return Promise.resolve();
    return Storage.getItem(key)
      .then((value) => {
        if (initialization.kind === 'loading' && initialization.pending.delete(key)) apply(value);
      })
      .catch(() => undefined);
  };

  const setLayout = (next: readonly ComposerToolbarSlot[]) => {
    const normalized = normalizeComposerToolbarLayout(next);
    selected(LAYOUT_KEY);
    layout.set(normalized);
    persist(LAYOUT_KEY, JSON.stringify(normalized));
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
      selected(CONTEXT_USAGE_KEY);
      contextUsage.set(mode);
      persist(CONTEXT_USAGE_KEY, mode);
    },
    setUsageLimits(enabled: boolean) {
      selected(USAGE_LIMITS_KEY);
      usageLimits.set(enabled);
      persist(USAGE_LIMITS_KEY, enabled ? '1' : '0');
    },
    saving: () => persistence.kind === 'saving',
    whenIdle: () => (persistence.kind === 'saving' ? persistence.completion : Promise.resolve()),
    initialize() {
      if (initialization.kind !== 'uninitialized' || !supported) return;
      initialization = { kind: 'loading', pending: initialization.pending };
      void Promise.all([
        restore(LAYOUT_KEY, (value) => {
          if (value === null) return;
          try {
            layout.set(normalizeComposerToolbarLayout(JSON.parse(value)));
          } catch {
            return;
          }
        }),
        restore(CONTEXT_USAGE_KEY, (value) => {
          if (value !== null && VALID_CONTEXT_MODES.has(value)) {
            contextUsage.set(value as ContextUsageDisplay);
          }
        }),
        restore(USAGE_LIMITS_KEY, (value) => {
          if (value === '1' || value === 'true') usageLimits.set(true);
          else if (value === '0' || value === 'false') usageLimits.set(false);
        }),
      ]).then(() => {
        initialization = { kind: 'ready' };
      });
    },
  };
}

// Independent UI bundles share the window owner, including its in-flight reads and writes.
const OWNER = Symbol.for('maka.composerToolbar');
const shared = globalThis as { [OWNER]?: ReturnType<typeof createComposerToolbarOwner> };
export const composerToolbar = (shared[OWNER] ??= createComposerToolbarOwner());
export const initializeComposerToolbar = composerToolbar.initialize;

const toolbarCompactContext = context<() => boolean>(() => false);
export const ToolbarCompactProvider = toolbarCompactContext.Provider;
export function useToolbarCompact(): boolean {
  return toolbarCompactContext()();
}
