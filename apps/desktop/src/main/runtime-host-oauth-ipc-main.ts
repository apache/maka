import { randomUUID } from 'node:crypto';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import {
  OAUTH_LOGIN_PROVIDERS,
  type OAuthLoginProjection,
  type OAuthLoginProvider,
} from '@maka/runtime-host/protocol';
import { INTERACTIVE_OAUTH_CONNECTION_SLUGS } from './oauth-connection-identities.js';
import {
  disableRuntimeHostAccountConnection,
  ensureRuntimeHostAccountConnection,
  findRuntimeHostAccountConnection,
  runtimeHostAccountCredential,
  synchronizeRuntimeHostAccountConnection,
  type RuntimeHostAccountConnectionClient,
} from './runtime-host-account-connection.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import type {
  OAuthExternalPresentation,
  RuntimeHostOAuthPresentation,
} from './runtime-host-oauth-presentation.js';

const OAUTH_POLL_INTERVAL_MS = 250;
const SHARED_OAUTH_IPC_OPERATIONS = [
  'get-auth-url',
  'open-auth-url',
  'complete-authorization',
  'cancel-authorization',
  'get-account-state',
  'refresh-tokens',
  'logout',
] as const;
export const RUNTIME_HOST_OAUTH_IPC_CHANNELS = Object.freeze([
  ...OAUTH_LOGIN_PROVIDERS.flatMap((provider) =>
    SHARED_OAUTH_IPC_OPERATIONS.map((operation) => `${provider}:${operation}`),
  ),
]);

type OAuthClient = RuntimeHostAccountConnectionClient & Pick<
  DesktopRuntimeHostClient,
  | 'cancelOAuthLogin'
  | 'queryOAuthLogin'
  | 'startOAuthLogin'
>;

export interface RuntimeHostOAuthIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: OAuthClient;
  readonly presentation: RuntimeHostOAuthPresentation;
  readonly emitConnectionListChanged: () => void;
}

interface ActiveOAuthAttempt {
  readonly provider: OAuthLoginProvider;
}

/** Adapts the existing Desktop OAuth UI to the Host's provider-neutral OAuth operations. */
export function registerRuntimeHostOAuthIpc(deps: RuntimeHostOAuthIpcDeps): void {
  const activeAttempts = new Map<string, ActiveOAuthAttempt>();

  for (const provider of OAUTH_LOGIN_PROVIDERS) {
    const channel = (operation: string) => `${provider}:${operation}`;
    deps.ipcMain.handle(channel('get-auth-url'), async () => {
      // No local enrollment gate. Whether this provider may enroll is the
      // selected Host's answer, and only the Host has it: a remote Host that
      // enabled Copilot must not be refused because this Desktop process
      // happens not to set the same variable. The start below carries the
      // question, and `operation_unavailable` is the answer.
      //
      // Drop any Desktop-tracked attempt for this provider so a re-click does
      // not race a stale completeAuthorization waiter against a new start.
      await cancelProviderAttempts(deps, activeAttempts, provider);
      const connection = await ensureRuntimeHostAccountConnection(deps.client, {
        providerType: provider,
        slug: INTERACTIVE_OAUTH_CONNECTION_SLUGS[provider],
      });
      const attemptId = randomUUID();
      const expectation = deps.presentation.expect(attemptId);
      try {
        const started = await deps.client.startOAuthLogin(attemptId, connection.connectionId);
        if (isTerminal(started)) throw new Error(describeTerminal(started));
        const presented = await waitForPresentation(deps.client, attemptId, expectation.presented);
        activeAttempts.set(attemptId, {
          provider,
        });
        return { authRequestId: attemptId, stateHint: presented.stateHint };
      } catch (error) {
        expectation.cancel(error);
        await deps.client.cancelOAuthLogin(attemptId).catch(() => undefined);
        // Prefer the host's message when present so "already in progress" is not
        // flattened into a generic 鉴权失败 for the toast classifier.
        const detail =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Unable to start OAuth authorization';
        // The Host refuses an enrollment this install has not opted into with
        // `operation_unavailable`; keep that as its own reason so the renderer
        // can say so instead of reporting a generic authorization failure.
        return actionFailure(
          detail,
          error instanceof RuntimeHostOperationError && error.code === 'operation_unavailable'
            ? 'experimental_disabled'
            : 'unknown',
        );
      }
    });
    deps.ipcMain.handle(channel('open-auth-url'), (_event, attemptId: unknown) => {
      return isProviderAttempt(activeAttempts, attemptId, provider)
        ? { ok: true as const }
        : actionFailure('OAuth authorization is not active', 'authorization_pending');
    });
    deps.ipcMain.handle(
      channel('complete-authorization'),
      async (_event, attemptId: unknown) => {
        if (typeof attemptId !== 'string') {
          return actionFailure('OAuth authorization is not active', 'authorization_pending');
        }
        if (!providerAttempt(activeAttempts, attemptId, provider)) {
          return actionFailure('OAuth authorization is not active', 'authorization_pending');
        }
        try {
          const terminal = await waitForTerminal(deps.client, attemptId);
          activeAttempts.delete(attemptId);
          if (terminal.phase !== 'authenticated') {
            return actionFailure(describeTerminal(terminal), terminalFailureReason(terminal));
          }
          // Authentication is authoritative once the Host commits the credential.
          // Catalog discovery is useful follow-up work, but a transient discovery
          // failure must not turn a committed login into a false UI failure.
          await synchronizeRuntimeHostAccountConnection(deps.client, provider).catch(
            () => undefined,
          );
          deps.emitConnectionListChanged();
          return { ok: true as const };
        } catch {
          activeAttempts.delete(attemptId);
          return actionFailure('Unable to complete OAuth authorization');
        }
      },
    );
    deps.ipcMain.handle(channel('cancel-authorization'), async (_event, attemptId: unknown) => {
      if (isProviderAttempt(activeAttempts, attemptId, provider)) {
        activeAttempts.delete(attemptId);
        deps.presentation.cancel(attemptId);
        await deps.client.cancelOAuthLogin(attemptId).catch(() => undefined);
      }
      return { ok: true as const };
    });
    handleReconnectableRead(deps.ipcMain, channel('get-account-state'), async () => {
      const connection = findRuntimeHostAccountConnection(
        await deps.client.loadConnectionCatalog(),
        provider,
      );
      if (!connection) return accountState(provider, 'not_logged_in');
      const credential = await deps.client.queryCredential(
        runtimeHostAccountCredential(connection),
      );
      if (credential?.configured) {
        return accountState(provider, 'authenticated');
      }
      const authorizing = [...activeAttempts.values()].some(
        (attempt) => attempt.provider === provider,
      );
      return accountState(provider, authorizing ? 'authorizing' : 'not_logged_in');
    });
    deps.ipcMain.handle(channel('refresh-tokens'), async () => {
      const connection = findRuntimeHostAccountConnection(
        await deps.client.loadConnectionCatalog(),
        provider,
      );
      if (!connection) return actionFailure('OAuth account is not connected', 'refresh_failed');
      const credential = await deps.client.queryCredential(
        runtimeHostAccountCredential(connection),
      );
      if (!credential?.configured) {
        return actionFailure('OAuth account is not connected', 'refresh_failed');
      }
      const refreshed = await deps.client.fetchConnectionModels(connection.connectionId);
      return refreshed.kind === 'committed'
        ? { ok: true as const }
        : actionFailure('Unable to refresh OAuth account', 'refresh_failed');
    });
    deps.ipcMain.handle(channel('logout'), async () => {
      await cancelProviderAttempts(deps, activeAttempts, provider);
      try {
        await disableRuntimeHostAccountConnection(deps.client, provider);
      } catch {
        return actionFailure('Unable to remove OAuth account');
      }
      deps.emitConnectionListChanged();
      return { ok: true as const };
    });
  }
}

async function waitForPresentation(
  client: OAuthClient,
  attemptId: string,
  presented: Promise<OAuthExternalPresentation>,
): Promise<OAuthExternalPresentation> {
  while (true) {
    const outcome = await Promise.race([
      presented.then((value) => ({ kind: 'presented' as const, value })),
      delay(OAUTH_POLL_INTERVAL_MS).then(() => ({ kind: 'poll' as const })),
    ]);
    if (outcome.kind === 'presented') return outcome.value;
    const projection = await client.queryOAuthLogin(attemptId);
    if (isTerminal(projection)) throw new Error(describeTerminal(projection));
  }
}

async function waitForTerminal(client: OAuthClient, attemptId: string): Promise<OAuthLoginProjection> {
  while (true) {
    const projection = await client.queryOAuthLogin(attemptId);
    if (isTerminal(projection)) return projection;
    await delay(OAUTH_POLL_INTERVAL_MS);
  }
}

async function cancelProviderAttempts(
  deps: RuntimeHostOAuthIpcDeps,
  activeAttempts: Map<string, ActiveOAuthAttempt>,
  provider: OAuthLoginProvider,
): Promise<void> {
  const attemptIds = [...activeAttempts]
    .filter(([, attempt]) => attempt.provider === provider)
    .map(([attemptId]) => attemptId);
  await Promise.all(
    attemptIds.map(async (attemptId) => {
      activeAttempts.delete(attemptId);
      deps.presentation.cancel(attemptId);
      await deps.client.cancelOAuthLogin(attemptId).catch(() => undefined);
    }),
  );
}

function isTerminal(projection: OAuthLoginProjection): boolean {
  return (
    projection.phase === 'authenticated' ||
    projection.phase === 'cancelled' ||
    projection.phase === 'failed'
  );
}

function describeTerminal(projection: OAuthLoginProjection): string {
  if (projection.phase === 'authenticated') return 'OAuth authorization completed';
  if (projection.phase === 'cancelled') return 'OAuth authorization was cancelled';
  return `OAuth authorization failed: ${projection.failure ?? 'internal_failure'}`;
}

function terminalFailureReason(
  projection: OAuthLoginProjection,
): 'authorization_cancelled' | 'authorization_denied' | 'unknown' {
  if (projection.phase === 'cancelled') return 'authorization_cancelled';
  return projection.failure === 'provider_rejected' ? 'authorization_denied' : 'unknown';
}

function providerAttempt(
  attempts: ReadonlyMap<string, ActiveOAuthAttempt>,
  attemptId: unknown,
  provider: OAuthLoginProvider,
): ActiveOAuthAttempt | undefined {
  if (typeof attemptId !== 'string') return undefined;
  const attempt = attempts.get(attemptId);
  return attempt?.provider === provider ? attempt : undefined;
}

function isProviderAttempt(
  attempts: ReadonlyMap<string, ActiveOAuthAttempt>,
  attemptId: unknown,
  provider: OAuthLoginProvider,
): attemptId is string {
  return providerAttempt(attempts, attemptId, provider) !== undefined;
}

function accountState(
  provider: OAuthLoginProvider,
  runtimeState: 'not_logged_in' | 'authorizing' | 'authenticated',
) {
  return { provider, runtimeState };
}

function actionFailure(
  message: string,
  reason:
    | 'authorization_pending'
    | 'authorization_cancelled'
    | 'authorization_denied'
    | 'refresh_failed'
    | 'experimental_disabled'
    | 'unknown' = 'unknown',
) {
  return { ok: false as const, reason, message };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
