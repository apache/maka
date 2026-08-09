import { runThreadSearch } from './search/thread-search.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';
import {
  handleReconnectableRead,
  readWithFallback,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

interface RuntimeHostSearchIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: Pick<
    DesktopRuntimeHostClient,
    'listSessions' | 'openSession' | 'queryRuntimePolicy'
  >;
}

export function registerRuntimeHostSearchIpc(
  deps: RuntimeHostSearchIpcDeps,
): void {
  handleReconnectableRead(deps.ipcMain, 'search:thread', (_event, request: unknown) =>
    runThreadSearch(request, {
      listSessions: async () =>
        (await deps.client.listSessions()).map(toDesktopHostSessionSummary),
      readMessages: (sessionId) =>
        readWithFallback(async () => {
          const session = await deps.client.openSession(sessionId);
          try {
            return await session.transcript;
          } finally {
            await session.close();
          }
        }, null),
      getPrivacyContext: async () => ({
        incognitoActive: (await deps.client.queryRuntimePolicy()).policy.privacy
          .incognitoActive,
      }),
    }),
  );
}
