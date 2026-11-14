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

import { cleanup, computed, effect, signal, untracked } from 'nsh';
import type { UiSubscription } from '../../../../packages/plugin-sdk/src/workbench.js';

import type {
  ComputerStageSnapshot,
  ComputerStageTarget,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';

export type ComputerTarget = ComputerStageTarget;
export type ComputerSnapshot = Omit<Required<ComputerStageSnapshot>, 'targets'> & {
  targets: Readonly<ComputerStageSnapshot['targets']>;
};

/** Identity includes the source, Host and binding; never reuse it across owners. */
export interface ComputerStageSource {
  sessionId: string;
  subscribe(): Promise<UiSubscription<ComputerSnapshot>>;
}

export function createComputerStage(props: {
  source(): ComputerStageSource | null;
  visible(): boolean;
  report(reason: unknown): void;
}) {
  const retry = signal(0);
  let lastBinding: string | null | undefined;
  const snapshot = signal<ComputerSnapshot | null>(null);
  const chosen = signal<string | null>(null);
  const pinned = signal(false);
  const hidden = signal(false);
  const fault = signal<unknown | null>(null);
  const selected = computed(() => {
    const value = snapshot();
    if (!value) return null;
    const has = (id: string | null) => value.targets.some((target) => target.id === id);
    if (has(chosen())) return chosen();
    if (has(value.activeTargetId)) return value.activeTargetId;
    return value.targets[0]?.id ?? null;
  });
  // Keep existing slots stable. Active and pinned targets are retained at the cap.
  const slots = signal<readonly string[]>([]);
  const targets = computed(() => {
    const value = snapshot();
    if (!value) return [];
    const byId = new Map(value.targets.map((target) => [target.id, target]));
    return slots().flatMap((id) => {
      const target = byId.get(id);
      return target ? [target] : [];
    });
  });
  effect(() => {
    props.source();
    untracked(() => {
      lastBinding = undefined;
      chosen.set(null);
      pinned.set(false);
      hidden.set(false);
      snapshot.set(null);
      slots.set([]);
      fault.set(null);
    });
  });
  effect(() => {
    const source = props.source();
    const visible = props.visible();
    retry();
    snapshot.set(null);
    slots.set([]);
    fault.set(null);
    if (!source || !visible) return;
    let current = true;
    let stream: UiSubscription<ComputerSnapshot> | null = null;
    const close = () => {
      const owned = stream;
      stream = null;
      if (owned) void owned.close().catch(props.report);
    };
    cleanup(() => {
      current = false;
      close();
      snapshot.set(null);
      slots.set([]);
    });
    void (async () => {
      const opened = await source.subscribe();
      if (!current) {
        await opened.close();
        return;
      }
      stream = opened;
      for (;;) {
        const next = await opened.next();
        if (!current) return;
        if (next === null) {
          snapshot.set(null);
          slots.set([]);
          close();
          return;
        }
        if (next.sessionId !== source.sessionId) throw new Error('Computer stage owner mismatch');
        untracked(() => {
          const previous = snapshot();
          if (
            previous &&
            previous.bindingId === next.bindingId &&
            next.revision < previous.revision
          )
            return;
          if (lastBinding !== undefined && lastBinding !== next.bindingId) {
            chosen.set(null);
            pinned.set(false);
            slots.set([]);
          }
          lastBinding = next.bindingId;
          if (!next.targets.some((target) => target.id === chosen())) {
            chosen.set(null);
            pinned.set(false);
          }
          if (!pinned() && previous?.activeTargetId !== next.activeTargetId)
            chosen.set(next.activeTargetId);
          snapshot.set(next);
          const available = new Set(next.targets.map((target) => target.id));
          const stable = [...slots().filter((id) => available.has(id))];
          for (const target of next.targets)
            if (!stable.includes(target.id)) stable.push(target.id);
          const keep = new Set([selected(), next.activeTargetId]);
          while (stable.length > 5) {
            let index = stable.length - 1;
            while (index >= 0 && keep.has(stable[index]!)) index--;
            stable.splice(index, 1);
          }
          slots.set(stable);
        });
      }
    })().catch((reason) => {
      close();
      if (!current) return;
      snapshot.set(null);
      slots.set([]);
      fault.set(reason);
      props.report(reason);
    });
  });
  return {
    retry() {
      retry.set(retry() + 1);
    },
    snapshot,
    selected,
    targets,
    pinned,
    hidden,
    fault,
    select(id: string) {
      chosen.set(id);
    },
    togglePin() {
      if (pinned()) {
        pinned.set(false);
        chosen.set(snapshot()?.activeTargetId ?? null);
      } else {
        chosen.set(selected());
        pinned.set(true);
      }
    },
    follow() {
      pinned.set(false);
      chosen.set(snapshot()?.activeTargetId ?? null);
    },
  };
}
export type ComputerStageController = ReturnType<typeof createComputerStage>;
