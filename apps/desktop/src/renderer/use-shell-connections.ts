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

import { useLayoutEffect, useRef, useState } from 'react';
import type { ConnectionEvent } from '@maka/core/connections';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopConnectionSnapshot } from '../shared/desktop-connection-snapshot.js';
import type { DesktopNewTaskHostRef } from '../preload/bridge-contract.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
};

const EMPTY_SNAPSHOT: DesktopConnectionSnapshot = {
  connections: [],
  defaultConnection: null,
  chatModelChoices: [],
};

const DEFAULT_HOST_KEY = 'default';
const NO_HOST_KEY = 'none';

type ShellConnectionTarget =
  | { readonly kind: 'default' }
  | { readonly kind: 'new-task'; readonly host?: DesktopNewTaskHostRef }
  | { readonly kind: 'session'; readonly sessionId?: string };

/**
 * Stale-while-revalidate (#4611): a refresh keeps serving the last ready
 * snapshot until the new read lands. Emptying the projection mid-refresh made
 * the composer flash "no model connection" and block send on every
 * `connection_list_changed` — and a failed refresh left it there permanently.
 * The staleness window is one IPC round-trip; anything the stale catalog still
 * names is re-validated by the Host on use (`NO_REAL_CONNECTION` path).
 *
 * `hostId` records which Host produced the snapshot. Session and new-task
 * targets key by hostId, so their identity is stable per key — but the
 * 'default' target uses one constant key while the Host behind it can change
 * (profile switch). Carrying Host A's catalog into Host B's read window would
 * let users act on connections that belong to the previous Host, so a default
 * refresh whose resolved identity differs drops the old snapshot instead.
 */
type StoredShellConnectionProjection =
  | {
      readonly status: 'refreshing';
      readonly snapshot?: DesktopConnectionSnapshot;
      readonly hostId?: string;
    }
  | {
      readonly status: 'ready';
      readonly snapshot: DesktopConnectionSnapshot;
      readonly hostId?: string;
    };

export type ShellConnectionProjection =
  | { readonly status: 'unrequested' }
  | StoredShellConnectionProjection;

/**
 * Owns one Host's atomic connection projection and refresh lifecycle.
 */
export function useShellConnections(options: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  target: ShellConnectionTarget;
}): {
  snapshot: DesktopConnectionSnapshot;
  projection: ShellConnectionProjection;
  seedSnapshot: (next: DesktopConnectionSnapshot) => void;
  refreshConnections: () => Promise<void>;
  handleConnectionEvent: (event: ConnectionEvent) => void;
} {
  const { toastApi, uiLocale } = options;
  const copy = getShellRemainingCopy(uiLocale).connections;
  const snapshotKey = connectionTargetKey(options.target);
  const currentKey = useRef(snapshotKey);
  useLayoutEffect(() => {
    currentKey.current = snapshotKey;
  }, [snapshotKey]);
  const [projections, setProjections] = useState(
    () => new Map<string, StoredShellConnectionProjection>(),
  );
  const refreshSequence = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    if (snapshotKey !== NO_HOST_KEY) void refreshConnections();
  }, [snapshotKey]);

  function seedSnapshot(next: DesktopConnectionSnapshot) {
    // Seed into any entry that has no snapshot yet — including an in-flight
    // first refresh. The mount layout effect writes `{status:'refreshing'}`
    // before the shell's passive seed effect can run, so guarding on key
    // existence alone made the startup snapshot dead code and left the
    // first-paint / failed-first-refresh windows reading EMPTY (#4611). A
    // successful refresh still overwrites the seed; an entry that already has
    // a snapshot (ready or stale-while-revalidate) keeps it.
    setProjections((previous) =>
      previous.get(snapshotKey)?.snapshot !== undefined
        ? previous
        : new Map(previous).set(snapshotKey, { status: 'ready', snapshot: next }),
    );
  }

  async function refreshConnections() {
    const target = options.target;
    const key = connectionTargetKey(target);
    if (key === NO_HOST_KEY) return;
    const sequence = (refreshSequence.current.get(key) ?? 0) + 1;
    refreshSequence.current.set(key, sequence);
    // A refresh means the Host catalog may already have changed, so the read
    // must land before its result is trusted — but the previous snapshot stays
    // visible while it flies (#4611, see the type above). Only a successful
    // current read replaces what consumers see. Session/new-task targets key
    // by hostId, so the carry is always same-Host there; the default target
    // gets its identity inside the read below.
    const markRefreshing = (hostId?: string): void => {
      setProjections((previous) => {
        const prior = previous.get(key);
        const carrySnapshot =
          prior?.snapshot !== undefined &&
          (hostId === undefined || prior.hostId === undefined || prior.hostId === hostId);
        return new Map(previous).set(key, {
          status: 'refreshing',
          ...(carrySnapshot ? { snapshot: prior.snapshot } : {}),
          ...(hostId === undefined ? {} : { hostId }),
        });
      });
    };
    try {
      let next: DesktopConnectionSnapshot;
      let nextHostId: string | undefined;
      if (target.kind === 'session' && target.sessionId) {
        markRefreshing();
        next = await window.maka.connections.getSnapshot(target.sessionId);
      } else if (target.kind === 'new-task' && target.host) {
        markRefreshing();
        next = await window.maka.newTasks.getConnections(target.host);
      } else if (target.kind === 'default') {
        // The constant 'default' key outlives the Host behind it (profile
        // switch), so the refreshing write waits for the resolved identity:
        // a snapshot the previous default Host produced must not survive into
        // the new one's read window (#4611 review). If the resolve itself
        // fails, no refreshing write happens and the last snapshot stays put;
        // the catch below toasts either way. A snapshot with unknown
        // provenance (the startup seed) is still carried: it is the boot-time
        // default catalog, and dropping it would reopen the first-paint flash.
        const result = await runOnDefaultRuntimeHost(async (host) => {
          markRefreshing(host.hostId);
          return window.maka.connections.getSnapshot(undefined, host);
        });
        next = result.value;
        nextHostId = result.host.hostId;
      } else return;
      if (refreshSequence.current.get(key) !== sequence) return;
      setProjections((previous) =>
        new Map(previous).set(key, {
          status: 'ready',
          snapshot: next,
          ...(nextHostId === undefined ? {} : { hostId: nextHostId }),
        }),
      );
    } catch (error) {
      if (
        refreshSequence.current.get(key) !== sequence ||
        currentKey.current !== key
      ) return;
      const diagnosticTarget = target.kind === 'session' && target.sessionId
        ? { sessionId: target.sessionId }
        : target.kind === 'new-task' && target.host
          ? { profileId: target.host.profileId }
          : defaultRuntimeHostDiagnosticTarget(error);
      toastApi.error(
        copy.refreshFailed,
        localizedShellErrorMessage(error, copy.refreshFallback, uiLocale),
        undefined,
        diagnosticTarget,
      );
    }
  }

  function handleConnectionEvent(event: ConnectionEvent) {
    switch (event.type) {
      case 'connection_list_changed':
        void refreshConnections();
        break;
    }
  }

  const projection = projections.get(snapshotKey) ?? { status: 'unrequested' as const };
  return {
    snapshot:
      projection.status === 'unrequested'
        ? EMPTY_SNAPSHOT
        : (projection.snapshot ?? EMPTY_SNAPSHOT),
    projection,
    seedSnapshot,
    refreshConnections,
    handleConnectionEvent,
  };
}

function connectionTargetKey(target: ShellConnectionTarget): string {
  switch (target.kind) {
    case 'default':
      return DEFAULT_HOST_KEY;
    case 'new-task':
      return target.host?.hostId ?? NO_HOST_KEY;
    case 'session':
      return target.sessionId
        ? parseDesktopSessionKey(target.sessionId).hostId
        : NO_HOST_KEY;
  }
}
