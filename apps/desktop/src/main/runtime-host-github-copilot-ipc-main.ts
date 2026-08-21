import {
  importGitHubCopilotLocalCredential,
  type ImportedGitHubCopilotCredential,
} from './oauth/github-copilot-local-credential.js';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import { INTERACTIVE_OAUTH_CONNECTION_SLUGS } from './oauth-connection-identities.js';
import {
  ensureRuntimeHostAccountConnection,
  setRuntimeHostAccountCredential,
  synchronizeRuntimeHostAccountConnection,
  type RuntimeHostAccountConnectionClient,
} from './runtime-host-account-connection.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

const PROVIDER = 'github-copilot';
const CONNECTION_SLUG = INTERACTIVE_OAUTH_CONNECTION_SLUGS[PROVIDER];

type GitHubCopilotClient = RuntimeHostAccountConnectionClient &
  Pick<DesktopRuntimeHostClient, 'setCredential'>;

export interface RuntimeHostGitHubCopilotIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: GitHubCopilotClient;
  readonly emitConnectionListChanged: () => void;
  readonly importExistingLogin?: () => Promise<ImportedGitHubCopilotCredential>;
}

/**
 * Desktop owns exactly one thing for GitHub Copilot: importing a credential
 * that already exists on this machine (`gh` / a compatible PAT). Interactive
 * enrollment is not here — the device grant runs through the Host's OAuth
 * coordinator like every other account login, so there is one authority that
 * serializes starts, owns supersede and cancellation, keeps the Host resident
 * while polling, uses the configured network transport, verifies the account
 * reaches a Copilot model, and commits the credential atomically. Account
 * state, refresh, and sign-out ride the same shared `github-copilot:*` channels
 * the coordinator's IPC adapter registers.
 */
export function registerRuntimeHostGitHubCopilotIpc(deps: RuntimeHostGitHubCopilotIpcDeps): void {
  const importExistingLogin = deps.importExistingLogin ?? importGitHubCopilotLocalCredential;

  deps.ipcMain.handle('github-copilot:connect-existing-login', async () => {
    const imported = await importExistingLogin();
    if (!imported.result.ok) return imported.result;
    if (!imported.secret) return storageFailure('GitHub Copilot login produced no credential');
    try {
      const connection = await ensureRuntimeHostAccountConnection(
        deps.client,
        { providerType: PROVIDER, slug: CONNECTION_SLUG },
        imported.result.models.map(({ id }) => id),
      );
      await setRuntimeHostAccountCredential(deps.client, connection, imported.secret);
      await synchronizeRuntimeHostAccountConnection(deps.client, PROVIDER).catch(() => undefined);
      deps.emitConnectionListChanged();
      return { ok: true as const };
    } catch {
      return storageFailure('GitHub Copilot login could not be committed to Runtime Host');
    }
  });
}

function storageFailure(message: string) {
  return { ok: false as const, reason: 'storage_failed' as const, message };
}
