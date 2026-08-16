import { useRef, useState } from 'react';
import type { ConnectionEvent } from '@maka/core/connections';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopConnectionSnapshot } from '../shared/desktop-connection-snapshot.js';
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

function connectionsEqual(
  a: DesktopConnectionSnapshot['connections'],
  b: DesktopConnectionSnapshot['connections'],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].slug !== b[i].slug || a[i].updatedAt !== b[i].updatedAt) return false;
  }
  return true;
}

/**
 * Owns one Host's atomic connection projection and refresh lifecycle.
 */
export function useShellConnections(options: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  activeSessionId?: string;
}): {
  snapshot: DesktopConnectionSnapshot;
  setSnapshot: (next: DesktopConnectionSnapshot) => void;
  refreshConnections: (sessionId?: string) => Promise<void>;
  clearConnections: () => void;
  handleConnectionEvent: (event: ConnectionEvent) => void;
} {
  const { toastApi, uiLocale } = options;
  const copy = getShellRemainingCopy(uiLocale).connections;
  const [snapshot, setSnapshot] = useState<DesktopConnectionSnapshot>(EMPTY_SNAPSHOT);
  const refreshSequence = useRef(0);

  async function refreshConnections(sessionId?: string) {
    const sequence = ++refreshSequence.current;
    try {
      const next = await window.maka.connections.getSnapshot(sessionId);
      if (refreshSequence.current !== sequence) return;
      setSnapshot((previous) =>
        previous.defaultConnection === next.defaultConnection &&
        connectionsEqual(previous.connections, next.connections)
          ? previous
          : next,
      );
    } catch (error) {
      if (refreshSequence.current !== sequence) return;
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

  function clearConnections() {
    refreshSequence.current += 1;
    setSnapshot(EMPTY_SNAPSHOT);
  }

  return {
    snapshot,
    setSnapshot,
    refreshConnections,
    clearConnections,
    handleConnectionEvent,
  };
}
