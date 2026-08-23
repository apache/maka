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
 * Owns one Host's atomic connection projection and refresh lifecycle.
 */
export function useShellConnections(options: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  target: ShellConnectionTarget;
}): {
  snapshot: DesktopConnectionSnapshot;
  hasSnapshot: boolean;
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
  const [snapshots, setSnapshots] = useState(
    () => new Map<string, DesktopConnectionSnapshot>(),
  );
  const refreshSequence = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    if (snapshotKey !== NO_HOST_KEY) void refreshConnections();
  }, [snapshotKey]);

  function seedSnapshot(next: DesktopConnectionSnapshot) {
    setSnapshots((previous) =>
      previous.has(snapshotKey) ? previous : new Map(previous).set(snapshotKey, next),
    );
  }

  async function refreshConnections() {
    const target = options.target;
    const key = connectionTargetKey(target);
    if (key === NO_HOST_KEY) return;
    const sequence = (refreshSequence.current.get(key) ?? 0) + 1;
    refreshSequence.current.set(key, sequence);
    try {
      let next: DesktopConnectionSnapshot;
      if (target.kind === 'session' && target.sessionId) {
        next = await window.maka.connections.getSnapshot(target.sessionId);
      } else if (target.kind === 'new-task' && target.host) {
        next = await window.maka.newTasks.getConnections(target.host);
      } else if (target.kind === 'default') {
        next = (
          await runOnDefaultRuntimeHost((host) =>
            window.maka.connections.getSnapshot(undefined, host),
          )
        ).value;
      } else return;
      if (refreshSequence.current.get(key) !== sequence) return;
      setSnapshots((previous) => new Map(previous).set(key, next));
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

  return {
    snapshot: snapshots.get(snapshotKey) ?? EMPTY_SNAPSHOT,
    hasSnapshot: snapshots.has(snapshotKey),
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
