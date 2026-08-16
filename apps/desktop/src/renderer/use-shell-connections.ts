import { useLayoutEffect, useRef, useState } from 'react';
import type { ConnectionEvent } from '@maka/core/connections';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopConnectionSnapshot } from '../shared/desktop-connection-snapshot.js';
import type { DesktopNewTaskHostRef } from '../preload/bridge-contract.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

const EMPTY_SNAPSHOT: DesktopConnectionSnapshot = {
  connections: [],
  defaultConnection: null,
  chatModelChoices: [],
};

const NO_HOST_KEY = 'none';

/**
 * Owns one Host's atomic connection projection and refresh lifecycle.
 */
export function useShellConnections(options: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  activeSessionId?: string;
  newTaskHost?: DesktopNewTaskHostRef;
}): {
  snapshot: DesktopConnectionSnapshot;
  hasSnapshot: boolean;
  seedSnapshot: (next: DesktopConnectionSnapshot) => void;
  refreshConnections: (sessionId?: string) => Promise<void>;
  handleConnectionEvent: (event: ConnectionEvent) => void;
} {
  const { toastApi, uiLocale } = options;
  const copy = getShellRemainingCopy(uiLocale).connections;
  const snapshotKey = options.activeSessionId
    ? parseDesktopSessionKey(options.activeSessionId).hostId
    : options.newTaskHost?.hostId ?? NO_HOST_KEY;
  const currentKey = useRef(snapshotKey);
  useLayoutEffect(() => {
    currentKey.current = snapshotKey;
  }, [snapshotKey]);
  const [snapshots, setSnapshots] = useState(
    () => new Map<string, DesktopConnectionSnapshot>(),
  );
  const refreshSequence = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    if (!options.activeSessionId && options.newTaskHost) {
      void refreshConnections();
    }
  }, [options.activeSessionId, options.newTaskHost?.hostId]);

  function seedSnapshot(next: DesktopConnectionSnapshot) {
    setSnapshots((previous) =>
      previous.has(snapshotKey) ? previous : new Map(previous).set(snapshotKey, next),
    );
  }

  async function refreshConnections(sessionId?: string) {
    const newTaskHost = options.newTaskHost;
    const key = sessionId
      ? parseDesktopSessionKey(sessionId).hostId
      : newTaskHost?.hostId ?? NO_HOST_KEY;
    if (!sessionId && !newTaskHost) return;
    const sequence = (refreshSequence.current.get(key) ?? 0) + 1;
    refreshSequence.current.set(key, sequence);
    try {
      let next: DesktopConnectionSnapshot;
      if (sessionId) {
        next = await window.maka.connections.getSnapshot(sessionId);
      } else if (newTaskHost) {
        next = await window.maka.newTasks.getConnections(newTaskHost);
      } else {
        return;
      }
      if (refreshSequence.current.get(key) !== sequence) return;
      setSnapshots((previous) => new Map(previous).set(key, next));
    } catch (error) {
      if (
        refreshSequence.current.get(key) !== sequence ||
        currentKey.current !== key
      ) return;
      toastApi.error(copy.refreshFailed, localizedShellErrorMessage(error, copy.refreshFallback, uiLocale));
    }
  }

  function handleConnectionEvent(event: ConnectionEvent) {
    switch (event.type) {
      case 'connection_list_changed':
        void refreshConnections(options.activeSessionId);
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
