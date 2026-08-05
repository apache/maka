import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { QuotaSnapshot } from '@maka/core';
import { isOAuthEnrollmentProviderEnabled } from '@maka/runtime';
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
import type {
  OAuthExternalPresentation,
  RuntimeHostOAuthPresentation,
} from './runtime-host-oauth-presentation.js';

const OAUTH_POLL_INTERVAL_MS = 250;

type OAuthClient = RuntimeHostAccountConnectionClient & Pick<
  DesktopRuntimeHostClient,
  | 'cancelOAuthLogin'
  | 'fetchOAuthAccountUsage'
  | 'queryOAuthLogin'
  | 'startOAuthLogin'
>;

export interface RuntimeHostOAuthIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: OAuthClient;
  readonly presentation: RuntimeHostOAuthPresentation;
  readonly emitConnectionListChanged: () => void;
  readonly isProviderEnabled?: (provider: OAuthLoginProvider) => boolean;
}

interface ActiveOAuthAttempt {
  readonly provider: OAuthLoginProvider;
  readonly presentationMethod: OAuthExternalPresentation['method'];
}

/** Adapts the existing Desktop OAuth UI to the Host's provider-neutral OAuth operations. */
export function registerRuntimeHostOAuthIpc(deps: RuntimeHostOAuthIpcDeps): void {
  const activeAttempts = new Map<string, ActiveOAuthAttempt>();
  const accountUsage = new Map<OAuthLoginProvider, QuotaSnapshot>();
  const providerEnabled = deps.isProviderEnabled ?? isOAuthEnrollmentProviderEnabled;

  for (const provider of OAUTH_LOGIN_PROVIDERS) {
    const channel = (operation: string) => `${provider}:${operation}`;
    deps.ipcMain.handle(channel('is-experimental-enabled'), () => providerEnabled(provider));
    deps.ipcMain.handle(channel('get-auth-url'), async () => {
      if (!providerEnabled(provider)) return providerDisabled();
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
          presentationMethod: presented.method,
        });
        return { authRequestId: attemptId, stateHint: presented.stateHint };
      } catch (error) {
        expectation.cancel(error);
        await deps.client.cancelOAuthLogin(attemptId).catch(() => undefined);
        return actionFailure('Unable to start OAuth authorization');
      }
    });
    deps.ipcMain.handle(channel('open-auth-url'), (_event, attemptId: unknown) => {
      return isProviderAttempt(activeAttempts, attemptId, provider)
        ? { ok: true as const }
        : actionFailure('OAuth authorization is not active', 'authorization_pending');
    });
    deps.ipcMain.handle(
      channel('complete-authorization'),
      async (_event, attemptId: unknown, authorizationCode: unknown) => {
        if (typeof attemptId !== 'string') {
          return actionFailure('OAuth authorization is not active', 'authorization_pending');
        }
        const attempt = providerAttempt(activeAttempts, attemptId, provider);
        if (!attempt) {
          return actionFailure('OAuth authorization is not active', 'authorization_pending');
        }
        if (attempt.presentationMethod === 'request_authorization_code') {
          if (typeof authorizationCode !== 'string' || authorizationCode.length === 0) {
            return actionFailure('OAuth authorization code is required', 'invalid_paste_code');
          }
          if (!deps.presentation.submitAuthorizationCode(attemptId, authorizationCode)) {
            return actionFailure('OAuth authorization is not active', 'authorization_pending');
          }
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
    deps.ipcMain.handle(channel('get-account-state'), async () => {
      const connection = findRuntimeHostAccountConnection(
        await deps.client.loadConnectionCatalog(),
        provider,
      );
      if (!connection) return accountState(provider, 'not_logged_in');
      const credential = await deps.client.queryCredential(
        runtimeHostAccountCredential(connection),
      );
      if (credential?.configured) {
        return accountState(provider, 'authenticated', accountUsage.get(provider));
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
    if (provider === 'claude-subscription') {
      deps.ipcMain.handle(channel('refresh-quota'), async () => {
        const connection = findRuntimeHostAccountConnection(
          await deps.client.loadConnectionCatalog(),
          provider,
        );
        if (!connection) return actionFailure('OAuth account is not connected');
        const result = await deps.client.fetchOAuthAccountUsage(connection.connectionId);
        if (result.kind !== 'available') {
          return actionFailure(`OAuth account usage is unavailable: ${result.reason}`);
        }
        accountUsage.set(provider, result.quota);
        return { ok: true as const };
      });
    }
    deps.ipcMain.handle(channel('logout'), async () => {
      await cancelProviderAttempts(deps, activeAttempts, provider);
      try {
        await disableRuntimeHostAccountConnection(deps.client, provider);
      } catch {
        return actionFailure('Unable to remove OAuth account');
      }
      accountUsage.delete(provider);
      deps.emitConnectionListChanged();
      return { ok: true as const };
    });
  }
  registerUnavailableAntigravityIpc(deps.ipcMain);
}

function registerUnavailableAntigravityIpc(ipcMain: Pick<IpcMain, 'handle'>): void {
  const prefix = 'antigravity-subscription';
  const unavailable = () =>
    actionFailure(
      'Google Antigravity account access is not available in Runtime Host',
      'experimental_disabled',
    );
  ipcMain.handle(`${prefix}:is-experimental-enabled`, async () => false);
  ipcMain.handle(`${prefix}:get-auth-url`, unavailable);
  ipcMain.handle(`${prefix}:open-auth-url`, unavailable);
  ipcMain.handle(`${prefix}:complete-authorization`, unavailable);
  ipcMain.handle(`${prefix}:cancel-authorization`, async () => ({ ok: true as const }));
  ipcMain.handle(`${prefix}:get-account-state`, async () => ({
    provider: prefix,
    status: 'preview' as const,
    runtimeState: 'not_logged_in' as const,
  }));
  ipcMain.handle(`${prefix}:refresh-tokens`, unavailable);
  ipcMain.handle(`${prefix}:logout`, async () => ({ ok: true as const }));
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
  quota?: QuotaSnapshot,
) {
  return { provider, runtimeState, ...(quota ? { quota } : {}) };
}

function providerDisabled() {
  return actionFailure('OAuth enrollment is disabled for this provider', 'experimental_disabled');
}

function actionFailure(
  message: string,
  reason:
    | 'invalid_paste_code'
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
