import { useState } from 'react';
import type { ConnectionEvent } from '@maka/core/connections';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

function connectionsEqual(a: LlmConnection[], b: LlmConnection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].slug !== b[i].slug || a[i].updatedAt !== b[i].updatedAt) return false;
  }
  return true;
}

/**
 * Owns the LLM-connection cluster: the connection list, the default
 * connection slug, and the fire-and-forget refresh glue. `setConnections`
 * and `setDefaultConnection` are returned so the onboarding-snapshot seed
 * (which lives in AppShell so it can also seed sessions) can prime them
 * before the first `connections:list` round-trip. `refreshConnections`
 * dedups via `connectionsEqual` so an unchanged list never churns the
 * dozen derived model/thinking selectors that read `connections`.
 */
export function useShellConnections(options: { toastApi: ToastApi; uiLocale: UiLocale }): {
  connections: LlmConnection[];
  defaultConnection: string | null;
  setConnections: (updater: LlmConnection[] | ((prev: LlmConnection[]) => LlmConnection[])) => void;
  setDefaultConnection: (next: string | null) => void;
  refreshConnections: () => Promise<void>;
  handleConnectionEvent: (event: ConnectionEvent) => void;
} {
  const { toastApi, uiLocale } = options;
  const copy = getShellRemainingCopy(uiLocale).connections;
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultConnection, setDefaultConnection] = useState<string | null>(null);

  async function refreshConnections() {
    try {
      const [next, nextDefault] = await Promise.all([
        window.maka.connections.list(),
        window.maka.connections.getDefault(),
      ]);
      setConnections((prev) => connectionsEqual(prev, next) ? prev : next);
      setDefaultConnection(nextDefault);
    } catch (error) {
      toastApi.error(copy.refreshFailed, localizedShellErrorMessage(error, copy.refreshFallback, uiLocale));
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
    connections,
    defaultConnection,
    setConnections,
    setDefaultConnection,
    refreshConnections,
    handleConnectionEvent,
  };
}
