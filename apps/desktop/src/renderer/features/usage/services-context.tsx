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
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMountedRef, useToast } from '@maka/ui';
import type { UsageRange, UsageStats } from '@maka/core/settings';
import type { UsageServices } from './ports.js';

interface UsageSnapshot {
  readonly range: UsageRange;
  readonly value: UsageStats | null;
}

interface UsageReloadLane {
  tail: Promise<void>;
}

/**
 * Imperative handle the legacy surface uses to fence Usage synchronously the
 * instant the selected Host changes — before React re-renders the new
 * `targetKey`. This closes the window where an in-flight old-Host load could
 * resolve and land between the Host event and the commit.
 */
export interface UsageScopeHandle {
  fenceTarget(): void;
}

interface UsageScopeValue {
  readonly services: UsageServices;
  readonly snapshot: UsageSnapshot | null;
  /** The current Host generation (`host:epoch`); changes when the target does. */
  readonly targetKey: string;
  reload(range: UsageRange): Promise<void>;
}

const UsageScopeContext = createContext<UsageScopeValue | null>(null);

/**
 * Persistent, feature-owned scope for the Usage surface (issue #4425).
 *
 * The host mounts this above the settings loading/error gate and hands it a
 * `targetKey` (`host:epoch`). That placement is the whole point: it lets the
 * loaded snapshot survive a Skeleton/Banner state or a section change (the view
 * below unmounts, the scope does not). A Host/generation change is signalled by
 * `targetKey` changing — the scope clears its snapshot and invalidates any
 * in-flight load *without remounting*, so the rest of the settings surface is
 * untouched (using a React `key` here would remount every settings page).
 * Mounting is wired by the legacy settings surface; the snapshot, the reload
 * lane, unmount isolation, target invalidation, and load-failure reporting are
 * owned here, so the disposable view only reads them through `useUsageStats`.
 *
 * It keeps a single tagged `{ range, value }` snapshot (not a per-range cache):
 * the previous surface held exactly one current snapshot, so returning to a
 * range visited earlier reloads rather than resurrecting stale data.
 */
export const UsageFeatureScope = forwardRef<
  UsageScopeHandle,
  {
    /** Selected Host generation (`host:epoch`); a change resets the snapshot. */
    readonly targetKey: string;
    readonly services: UsageServices;
    /** Toast title for a failed stats load (injected; the feature holds no legacy copy). */
    readonly loadErrorTitle: string;
    /** Localize a load failure for the toast body (injected by the legacy wrapper). */
    describeError(error: unknown): string;
    readonly children?: ReactNode;
  }
>(function UsageFeatureScope(props, ref) {
  const toast = useToast();
  const mountedRef = useMountedRef();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [renderedTargetKey, setRenderedTargetKey] = useState(props.targetKey);
  const reloadTicketRef = useRef(0);
  const reloadLanesRef = useRef(new Map<string, UsageReloadLane>());
  const { targetKey, services, loadErrorTitle, describeError } = props;

  // Reset on a target (Host generation) change without remounting the subtree:
  // drop the previous Host's snapshot and invalidate its in-flight load so it
  // neither lingers nor lands. This is the documented "adjust state during
  // render" pattern; it runs once because `renderedTargetKey` then matches.
  if (targetKey !== renderedTargetKey) {
    setRenderedTargetKey(targetKey);
    setSnapshot(null);
    reloadTicketRef.current += 1;
  }

  // Serialize reloads for one Host generation so rapid range changes cannot
  // consume multiple snapshot reservations on the same connection. Waiting
  // reloads remain last-write-wins: a superseded ticket is skipped before it
  // reaches the service, while an already-started load finishes and releases
  // its reservation before the latest queued range begins. Lanes are keyed by
  // Host generation, so different connections can load independently while an
  // A → B → A switch still queues behind A's unfinished request. Settled lanes
  // are removed when no newer task has joined them. Because the scope outlives
  // the view, a reload started before the view unmounts still lands here (its
  // result is visible on return).
  const reload = useCallback(
    (range: UsageRange): Promise<void> => {
      const ticket = ++reloadTicketRef.current;
      const lanes = reloadLanesRef.current;
      let lane = lanes.get(targetKey);
      if (!lane) {
        lane = { tail: Promise.resolve() };
        lanes.set(targetKey, lane);
      }
      const task = lane.tail.then(async () => {
        if (ticket !== reloadTicketRef.current) return;
        try {
          const value = await services.loadUsageStats(range);
          if (mountedRef.current && ticket === reloadTicketRef.current) {
            setSnapshot({ range, value });
          }
        } catch (error) {
          if (mountedRef.current && ticket === reloadTicketRef.current) {
            toast.error(loadErrorTitle, describeError(error));
          }
        }
      });
      lane.tail = task;
      const deleteSettledLane = () => {
        if (lanes.get(targetKey) === lane && lane.tail === task) lanes.delete(targetKey);
      };
      void task.then(deleteSettledLane, deleteSettledLane);
      return task;
    },
    [targetKey, services, loadErrorTitle, describeError, toast, mountedRef],
  );

  // Fence synchronously when the host signals a target change, before React
  // re-renders the new `targetKey` — mirrors the previous surface, which bumped
  // the reload ticket and cleared the snapshot inside the Host-change handler.
  // The render-time reset above still runs on the following render; this only
  // closes the event→commit window where an old-Host load could still land.
  useImperativeHandle(
    ref,
    () => ({
      fenceTarget: () => {
        reloadTicketRef.current += 1;
        setSnapshot(null);
      },
    }),
    [],
  );

  const value = useMemo<UsageScopeValue>(
    () => ({ services, snapshot, targetKey, reload }),
    [services, snapshot, targetKey, reload],
  );

  return <UsageScopeContext.Provider value={value}>{props.children}</UsageScopeContext.Provider>;
});

function useUsageScope(): UsageScopeValue {
  const value = useContext(UsageScopeContext);
  if (!value) throw new Error('UsageFeatureScope is missing');
  return value;
}

/** Persistence port for the current-range settings update (used by the draft). */
export function useUsageServices(): UsageServices {
  return useUsageScope().services;
}

/**
 * Read the stats for `range` plus the scope's `reload` and `targetKey`. Stats are
 * surfaced only when the held snapshot was loaded for the requested range; during
 * a range switch (or after a late/failed load, or a target change) the tagged
 * range no longer matches, so the caller reads `null` (loading/empty) instead of
 * a stale range's numbers. `targetKey` is returned so the view can retrigger a
 * load when the Host generation changes (the previous surface reloaded on epoch).
 */
export function useUsageStats(range: UsageRange): {
  readonly stats: UsageStats | null;
  readonly targetKey: string;
  reload(range: UsageRange): Promise<void>;
} {
  const { snapshot, targetKey, reload } = useUsageScope();
  const stats = snapshot && snapshot.range === range ? snapshot.value : null;
  return { stats, targetKey, reload };
}
