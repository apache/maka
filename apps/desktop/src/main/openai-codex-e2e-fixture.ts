import type { OpenAiCodexService } from './oauth/openai-codex-service.js';

/**
 * Deterministic loopback OAuth service for the `oauth-relogin` Electron E2E.
 *
 * This seam is selected only through the dev-only MAKA_E2E_FIXTURE gate in
 * main.ts. It drives the production preload, IPC handlers, shared renderer
 * login hook, connection store, and connection event bus without opening a
 * browser or contacting OpenAI.
 */
export function createOpenAiCodexE2eFixtureService(): OpenAiCodexService {
  const authRequestId = 'e2e-codex-auth-request';
  let runtimeState: 'not_logged_in' | 'authorizing' | 'authenticated' = 'not_logged_in';

  const service = {
    async getAuthorizationUrl() {
      return { authRequestId, stateHint: 'e2e-state' };
    },
    async openAuthorizationUrl(requestId: string) {
      if (requestId !== authRequestId) {
        return {
          ok: false as const,
          reason: 'authorization_pending' as const,
          message: 'E2E authorization session does not exist.',
        };
      }
      runtimeState = 'authorizing';
      return { ok: true as const };
    },
    async completeAuthorization(requestId: string) {
      if (requestId !== authRequestId || runtimeState !== 'authorizing') {
        return {
          ok: false as const,
          reason: 'authorization_pending' as const,
          message: 'E2E authorization is not pending.',
        };
      }
      runtimeState = 'authenticated';
      return { ok: true as const };
    },
    cancelAuthorization(requestId?: string) {
      if (!requestId || requestId === authRequestId) runtimeState = 'not_logged_in';
    },
    async getAccountState() {
      return runtimeState === 'authenticated'
        ? {
            provider: 'openai-codex' as const,
            runtimeState,
            accountId: 'e2e-openai-account',
            email: 'oauth-refresh@maka.test',
          }
        : { provider: 'openai-codex' as const, runtimeState };
    },
    async refreshTokens() {
      return runtimeState === 'authenticated'
        ? { ok: true as const }
        : {
            ok: false as const,
            reason: 'refresh_failed' as const,
            message: 'E2E account is not authenticated.',
          };
    },
    async logout() {
      runtimeState = 'not_logged_in';
      return { ok: true as const };
    },
    async getAccessTokenInternal() {
      return runtimeState === 'authenticated' ? 'e2e-codex-access-token' : null;
    },
    async hasStoredCredential() {
      return runtimeState === 'authenticated';
    },
  };

  // OpenAiCodexService is a class with private implementation state, while
  // this fixture intentionally implements only the public surface consumed by
  // main. Keep the cast at this single dev-only boundary.
  return service as unknown as OpenAiCodexService;
}
