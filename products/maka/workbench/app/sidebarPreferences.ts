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

import { platform, signal, Storage } from 'nsh';

export type SidebarFeature = 'bot' | 'automations' | 'rooms' | 'discovery';
export type SidebarSortMode = 'project' | 'time';

export const ALL_SIDEBAR_FEATURES: readonly SidebarFeature[] = [
  'bot',
  'automations',
  'rooms',
  'discovery',
];
export const DEFAULT_PINNED_SIDEBAR_FEATURES: readonly SidebarFeature[] = ['bot', 'automations'];

const VALID_FEATURES = new Set<string>(ALL_SIDEBAR_FEATURES);
const VALID_SORT_MODES = new Set<string>(['project', 'time']);

export function normalizePinnedSidebarFeatures(raw: unknown): SidebarFeature[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PINNED_SIDEBAR_FEATURES];
  const seen = new Set<SidebarFeature>();
  for (const entry of raw) {
    if (typeof entry === 'string' && VALID_FEATURES.has(entry)) {
      seen.add(entry as SidebarFeature);
    }
  }
  return ALL_SIDEBAR_FEATURES.filter((feature) => seen.has(feature));
}

export function normalizeSidebarSortMode(raw: unknown): SidebarSortMode {
  return typeof raw === 'string' && VALID_SORT_MODES.has(raw)
    ? (raw as SidebarSortMode)
    : 'project';
}

export function toggleSidebarFeature(
  current: readonly SidebarFeature[],
  feature: SidebarFeature,
): SidebarFeature[] {
  const next = new Set(current);
  if (!next.delete(feature)) next.add(feature);
  return ALL_SIDEBAR_FEATURES.filter((item) => next.has(item));
}

const STORAGE_KEY = 'sidebar-preferences';
type Field = 'pinnedFeatures' | 'sortMode';

function createSidebarPreferencesOwner() {
  const supported = platform.idiom !== 'terminal';
  const pinnedFeatures = signal<SidebarFeature[]>([...DEFAULT_PINNED_SIDEBAR_FEATURES]);
  const sortMode = signal<SidebarSortMode>('project');

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
            pinnedFeatures: pinnedFeatures(),
            sortMode: sortMode(),
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

  return {
    pinnedFeatures: () => pinnedFeatures(),
    isPinned: (feature: SidebarFeature) => pinnedFeatures().includes(feature),
    sortMode: () => sortMode(),
    toggleFeature(feature: SidebarFeature) {
      dirty.add('pinnedFeatures');
      pinnedFeatures.set(toggleSidebarFeature(pinnedFeatures(), feature));
      persist();
    },
    setSortMode(mode: SidebarSortMode) {
      if (mode === sortMode()) return;
      dirty.add('sortMode');
      sortMode.set(mode);
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
          if (!dirty.has('pinnedFeatures') && 'pinnedFeatures' in parsed) {
            pinnedFeatures.set(normalizePinnedSidebarFeatures(parsed.pinnedFeatures));
          }
          if (!dirty.has('sortMode') && 'sortMode' in parsed) {
            sortMode.set(normalizeSidebarSortMode(parsed.sortMode));
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
const OWNER = Symbol.for('maka.sidebarPreferences');
const shared = globalThis as {
  [OWNER]?: ReturnType<typeof createSidebarPreferencesOwner>;
};
export const sidebarPreferences = (shared[OWNER] ??= createSidebarPreferencesOwner());
export const initializeSidebarPreferences = sidebarPreferences.initialize;
