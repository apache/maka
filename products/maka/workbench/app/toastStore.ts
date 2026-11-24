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

export type ToastTone = 'danger' | 'warning' | 'info';

export interface ToastAction {
  readonly label: string;
  readonly onPress: () => void;
  /** Defaults to true; set false for persistent or in-place actions such as Retry. */
  readonly dismissOnPress?: boolean;
  readonly primary?: boolean;
}

export interface ToastDetails {
  readonly label?: string;
  readonly text: string;
}

export interface ToastInput {
  readonly id?: string;
  readonly tone?: ToastTone;
  readonly title?: string;
  readonly message: string;
  readonly persistent?: boolean;
  readonly durationMs?: number;
  readonly actions?: readonly ToastAction[];
  readonly details?: ToastDetails;
  readonly dismissible?: boolean;
}

export interface ToastRecord {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title?: string;
  readonly message: string;
  readonly persistent: boolean;
  readonly durationMs: number;
  readonly actions: readonly ToastAction[];
  readonly details?: ToastDetails;
  readonly dismissible: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly order: number;
}

export type ToastListener = () => void;

export interface ToastStore {
  show(input: ToastInput): string;
  upsert(id: string, input: Omit<ToastInput, 'id'>): string;
  dismiss(id: string): void;
  clear(options?: { includePersistent?: boolean }): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  snapshot(): readonly ToastRecord[];
  subscribe(listener: ToastListener): () => void;
  dispose(): void;
}

export interface ToastStoreOptions {
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export const DEFAULT_TOAST_DURATION_MS = 3500;
export const ACTION_TOAST_DURATION_MS = 8000;

interface Entry {
  record: ToastRecord;
  remainingMs: number;
  deadline: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function compareRecords(a: ToastRecord, b: ToastRecord): number {
  if (a.persistent !== b.persistent) return a.persistent ? -1 : 1;
  return b.order - a.order;
}

function resolveDuration(input: ToastInput, persistent: boolean): number {
  if (persistent) return 0;
  if (input.durationMs !== undefined) return Math.max(0, input.durationMs);
  const interactive = (input.actions?.length ?? 0) > 0 || input.details !== undefined;
  return interactive ? ACTION_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS;
}

export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));

  const entries = new Map<string, Entry>();
  const listeners = new Set<ToastListener>();
  let paused = false;
  let nextId = 1;
  let nextOrder = 1;
  let cachedSnapshot: readonly ToastRecord[] = Object.freeze([]);

  const rebuildSnapshot = () => {
    const ordered = Array.from(entries.values(), (entry) => entry.record).sort(compareRecords);
    cachedSnapshot = Object.freeze(ordered);
  };

  const emit = () => {
    rebuildSnapshot();
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const clearEntryTimer = (entry: Entry) => {
    if (entry.timer !== null) {
      cancel(entry.timer);
      entry.timer = null;
    }
    entry.deadline = null;
  };

  const armEntryTimer = (entry: Entry) => {
    clearEntryTimer(entry);
    if (entry.record.persistent || entry.record.durationMs <= 0 || paused) return;
    const wait = Math.max(0, entry.remainingMs);
    entry.deadline = now() + wait;
    entry.timer = schedule(() => {
      entry.timer = null;
      entry.deadline = null;
      if (entries.get(entry.record.id) !== entry) return;
      entries.delete(entry.record.id);
      emit();
    }, wait);
  };

  const show = (input: ToastInput): string => {
    const id = input.id ?? `toast-${nextId++}`;
    const existing = entries.get(id);
    const persistent = input.persistent ?? false;
    const durationMs = resolveDuration(input, persistent);
    const actions = input.actions ? Object.freeze([...input.actions]) : Object.freeze([]);
    const timestamp = now();

    if (existing) {
      clearEntryTimer(existing);
      const bumpOrder = !persistent || !existing.record.persistent;
      existing.record = Object.freeze({
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        message: input.message,
        persistent,
        durationMs,
        actions,
        details: input.details,
        dismissible: input.dismissible ?? !persistent,
        createdAt: existing.record.createdAt,
        updatedAt: timestamp,
        order: bumpOrder ? nextOrder++ : existing.record.order,
      });
      existing.remainingMs = durationMs;
      armEntryTimer(existing);
      emit();
      return id;
    }

    const record: ToastRecord = Object.freeze({
      id,
      tone: input.tone ?? 'info',
      title: input.title,
      message: input.message,
      persistent,
      durationMs,
      actions,
      details: input.details,
      dismissible: input.dismissible ?? !persistent,
      createdAt: timestamp,
      updatedAt: timestamp,
      order: nextOrder++,
    });
    const entry: Entry = {
      record,
      remainingMs: durationMs,
      deadline: null,
      timer: null,
    };
    entries.set(id, entry);
    armEntryTimer(entry);
    emit();
    return id;
  };

  const upsert = (id: string, input: Omit<ToastInput, 'id'>): string => show({ ...input, id });

  const dismiss = (id: string): void => {
    const existing = entries.get(id);
    if (!existing) return;
    clearEntryTimer(existing);
    entries.delete(id);
    emit();
  };

  const clear = (clearOptions?: { includePersistent?: boolean }): void => {
    const includePersistent = clearOptions?.includePersistent ?? false;
    let changed = false;
    for (const [id, entry] of [...entries.entries()]) {
      if (!includePersistent && entry.record.persistent) continue;
      clearEntryTimer(entry);
      entries.delete(id);
      changed = true;
    }
    if (changed) emit();
  };

  const pause = (): void => {
    if (paused) return;
    paused = true;
    const current = now();
    for (const entry of entries.values()) {
      if (entry.deadline !== null) {
        entry.remainingMs = Math.max(0, entry.deadline - current);
      }
      clearEntryTimer(entry);
    }
  };

  const resume = (): void => {
    if (!paused) return;
    paused = false;
    let expiredAny = false;
    for (const [id, entry] of [...entries.entries()]) {
      if (entry.record.persistent || entry.record.durationMs <= 0) continue;
      if (entry.remainingMs <= 0) {
        clearEntryTimer(entry);
        entries.delete(id);
        expiredAny = true;
      } else {
        armEntryTimer(entry);
      }
    }
    if (expiredAny) emit();
  };

  const dispose = (): void => {
    for (const entry of entries.values()) {
      clearEntryTimer(entry);
    }
    entries.clear();
    listeners.clear();
    paused = false;
    cachedSnapshot = Object.freeze([]);
  };

  return {
    show,
    upsert,
    dismiss,
    clear,
    pause,
    resume,
    isPaused: () => paused,
    snapshot: () => cachedSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };
}

export const GLOBAL_TOAST_STORE_KEY = Symbol.for('maka.workbench.toastStore');

type GlobalWithToastStore = typeof globalThis & {
  [GLOBAL_TOAST_STORE_KEY]?: ToastStore;
};

/**
 * Shared singleton across independently bundled Workbench plugins running inside the same QuickJS VM.
 */
export function getToastStore(): ToastStore {
  const host = globalThis as GlobalWithToastStore;
  if (!host[GLOBAL_TOAST_STORE_KEY]) {
    host[GLOBAL_TOAST_STORE_KEY] = createToastStore();
  }
  return host[GLOBAL_TOAST_STORE_KEY]!;
}

export const toast = {
  show: (input: ToastInput) => getToastStore().show(input),
  upsert: (id: string, input: Omit<ToastInput, 'id'>) => getToastStore().upsert(id, input),
  dismiss: (id: string) => getToastStore().dismiss(id),
  clear: (options?: { includePersistent?: boolean }) => getToastStore().clear(options),
  pause: () => getToastStore().pause(),
  resume: () => getToastStore().resume(),
  snapshot: () => getToastStore().snapshot(),
  subscribe: (listener: ToastListener) => getToastStore().subscribe(listener),
};
