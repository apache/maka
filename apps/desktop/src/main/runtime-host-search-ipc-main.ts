import type { IpcMain } from 'electron';
import { runThreadSearch } from './search/thread-search.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';

interface RuntimeHostSearchIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: Pick<
    DesktopRuntimeHostClient,
    'listSessions' | 'openSession' | 'queryRuntimePolicy'
  >;
}

export function registerRuntimeHostSearchIpc(
  deps: RuntimeHostSearchIpcDeps,
): void {
  deps.ipcMain.handle('search:thread', (_event, request: unknown) =>
    runThreadSearch(request, {
      listSessions: async () =>
        (await deps.client.listSessions()).map(toDesktopHostSessionSummary),
      readMessages: async (sessionId) => {
        const session = await deps.client.openSession(sessionId);
        try {
          return await session.transcript;
        } finally {
          await session.close();
        }
      },
      getPrivacyContext: async () => ({
        incognitoActive: (await deps.client.queryRuntimePolicy()).policy.privacy
          .incognitoActive,
      }),
    }),
  );
}
